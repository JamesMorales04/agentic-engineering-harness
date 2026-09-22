import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fsSync from "node:fs";
import readline from "node:readline";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import { SERENA_HEADLESS_ARGS } from "../context/repository/serena.js";

/** Read-only Serena surface used by AEH-managed explorer/planner/reviewer clients. */
export const SERENA_READ_ONLY_TOOLS = [
  "initial_instructions",
  "get_symbols_overview",
  "find_symbol",
  "find_referencing_symbols",
  "find_implementations",
  "find_declaration",
  "get_diagnostics_for_file",
  "list_dir",
  "find_file",
  "search_for_pattern",
  "read_memory",
  "list_memories"
] as const;

const READ_ONLY_TOOL_SET = new Set<string>(SERENA_READ_ONLY_TOOLS);

export interface SerenaProxyOptions {
  command?: string;
  root?: string;
  allowEdits?: boolean;
  allowedTools?: readonly string[];
}

export interface SerenaPoolIdentityV1 {
  projectId: string;
  canonicalRoot: string;
  workspaceId: string;
  serenaVersion: string;
}

interface SerenaWriterLeaseFileV1 {
  version: 1;
  tokenDigest: string;
  projectId: string;
  workspaceId: string;
  canonicalRoot: string;
  ownerId: string;
  expiresAt: string;
}

export function createSerenaWriterLeaseSync(input: { canonicalRoot: string; projectId: string; workspaceId: string; ownerId: string; ttlMs?: number }): { token: string; filePath: string } {
  const canonicalRoot = path.resolve(input.canonicalRoot);
  const token = randomBytes(32).toString("base64url");
  const directory = path.join(canonicalRoot, ".harness", "runtime", "serena-leases");
  fsSync.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filePath = path.join(directory, `${createHash("sha256").update(`${input.projectId}\0${input.workspaceId}\0${input.ownerId}\0${token}`).digest("hex")}.json`);
  const lease: SerenaWriterLeaseFileV1 = { version: 1, tokenDigest: createHash("sha256").update(token).digest("hex"), projectId: input.projectId, workspaceId: input.workspaceId, canonicalRoot, ownerId: input.ownerId, expiresAt: new Date(Date.now() + (input.ttlMs ?? 30 * 60_000)).toISOString() };
  fsSync.writeFileSync(filePath, `${JSON.stringify(lease)}\n`, { encoding: "utf8", mode: 0o600 });
  return { token, filePath };
}

export function serenaPoolSocketPath(input: SerenaPoolIdentityV1): string {
  const canonicalRoot = path.resolve(input.canonicalRoot);
  const digest = createHash("sha256").update([input.projectId, canonicalRoot, input.workspaceId, input.serenaVersion].join("\0")).digest("hex").slice(0, 40);
  // Unix-domain socket paths have a small platform-dependent limit. Keep the
  // socket in a private temp directory while retaining the full working-copy
  // identity in the digest.
  return path.join(os.tmpdir(), "aeh-serena-pools", `${digest}.sock`);
}

/**
 * Run a line-oriented MCP stdio proxy in front of Serena.
 *
 * The proxy intentionally filters both tools/list and tools/call. Hiding the
 * schemas reduces the reader's attack surface; rejecting calls is the actual
 * enforcement boundary when a client attempts to bypass discovery.
 */
export async function serveSerenaMcpProxy(options: SerenaProxyOptions = {}): Promise<void> {
  const root = options.root ?? process.env.AEH_SERENA_ROOT ?? process.cwd();
  const requestedWrite = options.allowEdits ?? process.env.AEH_SERENA_ACCESS === "write";
  const allowEdits = requestedWrite && hasValidWriterLease(root);
  const configured = options.allowedTools ?? parseToolList(process.env.AEH_SERENA_ALLOWED_TOOLS);
  const allowed = allowEdits ? undefined : new Set(configured ?? READ_ONLY_TOOL_SET);
  const command = options.command ?? process.env.AEH_SERENA_COMMAND ?? "serena";
  const poolSocket = process.env.AEH_SERENA_POOL_SOCKET?.trim();
  if (poolSocket) return serveSerenaPoolClient({ root, command, socketPath: poolSocket, allowed, requestedWrite: allowEdits, leaseFile: process.env.AEH_SERENA_WRITER_LEASE_FILE, leaseToken: process.env.AEH_SERENA_WRITER_LEASE_TOKEN });
  const child = spawn(command, ["start-mcp-server", "--context", "ide-assistant", "--project", root, ...SERENA_HEADLESS_ARGS], {
    cwd: root,
    env: process.env,
    stdio: ["pipe", "pipe", "inherit"]
  });
  const filteredLists = new Set<number | string>();
  const childReader = readline.createInterface({ input: child.stdout });
  const parentReader = readline.createInterface({ input: process.stdin });

  const writeParent = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
  childReader.on("line", (line) => {
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    if (message && filteredLists.has(message.id)) {
      filteredLists.delete(message.id);
      if (message.result && Array.isArray(message.result.tools)) {
        message.result.tools = message.result.tools.filter((tool: { name?: unknown }) => typeof tool.name === "string" && allowed?.has(tool.name));
      }
    }
    writeParent(message);
  });

  const shutdown = () => {
    parentReader.close();
    childReader.close();
    if (child.exitCode === null) child.kill("SIGTERM");
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  child.once("exit", () => process.exitCode = child.exitCode ?? 1);

  for await (const line of parentReader) {
    let message: any;
    try { message = JSON.parse(line); } catch { continue; }
    const method = typeof message?.method === "string" ? message.method : undefined;
    if (method === "tools/list" && message.id !== undefined && allowed) filteredLists.add(message.id);
    if (method === "tools/call" && allowed && typeof message.params?.name === "string" && !allowed.has(message.params.name)) {
      writeParent({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Serena tool '${message.params.name}' is not granted to this read-only client.` } });
      continue;
    }
    if (!child.stdin.write(`${JSON.stringify(message)}\n`)) await onceDrain(child.stdin);
  }
  shutdown();
  await onceExit(child);
}

async function serveSerenaPoolClient(input: { root: string; command: string; socketPath: string; allowed?: Set<string>; requestedWrite: boolean; leaseFile?: string; leaseToken?: string }): Promise<void> {
  const socket = await connectOrStartSerenaPool(input);
  const filteredLists = new Set<number | string>();
  const socketReader = readline.createInterface({ input: socket });
  const parentReader = readline.createInterface({ input: process.stdin });
  const writeParent = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
  socketReader.on("line", (line) => {
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    if (message && filteredLists.has(message.id)) {
      filteredLists.delete(message.id);
      if (message.result && Array.isArray(message.result.tools)) message.result.tools = message.result.tools.filter((tool: { name?: unknown }) => typeof tool.name === "string" && input.allowed?.has(tool.name));
    }
    writeParent(message);
  });
  const shutdown = () => {
    parentReader.close();
    socketReader.close();
    socket.destroy();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  socket.once("close", () => { process.exitCode = process.exitCode ?? 1; parentReader.close(); });
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "aeh/serena-pool/handshake", params: { requestedWrite: input.requestedWrite, leaseFile: input.leaseFile, leaseToken: input.leaseToken } })}\n`);

  for await (const line of parentReader) {
    let message: any;
    try { message = JSON.parse(line); } catch { continue; }
    const method = typeof message?.method === "string" ? message.method : undefined;
    if (method === "tools/list" && message.id !== undefined && input.allowed) filteredLists.add(message.id);
    if (method === "tools/call" && input.allowed && typeof message.params?.name === "string" && !input.allowed.has(message.params.name)) {
      writeParent({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Serena tool '${message.params.name}' is not granted to this read-only client.` } });
      continue;
    }
    if (!socket.write(`${JSON.stringify(message)}\n`)) await onceDrain(socket);
  }
  shutdown();
}

async function connectOrStartSerenaPool(input: { root: string; command: string; socketPath: string }): Promise<net.Socket> {
  try { return await connectUnixSocket(input.socketPath); } catch {
    const entry = process.env.AEH_ENTRY_FILE?.trim() || process.argv[1];
    if (!entry) throw new Error("AEH cannot start the Serena pool without an entrypoint.");
    const child = spawn(process.execPath, [entry, "provider", "serena-pool"], {
      cwd: input.root,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, AEH_SERENA_POOL_SOCKET: input.socketPath, AEH_SERENA_POOL_ROOT: input.root, AEH_SERENA_POOL_COMMAND: input.command }
    });
    child.unref();
    const deadline = Date.now() + 10_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try { return await connectUnixSocket(input.socketPath); } catch (error) { lastError = error; await delay(50); }
    }
    throw new Error(`Serena pool did not become ready at ${input.socketPath}: ${String(lastError)}`);
  }
}

function connectUnixSocket(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const fail = (error: Error) => { socket.destroy(); reject(error); };
    socket.once("connect", () => { socket.off("error", fail); resolve(socket); });
    socket.once("error", fail);
  });
}

export async function serveSerenaPoolServer(): Promise<void> {
  const socketPath = process.env.AEH_SERENA_POOL_SOCKET?.trim();
  const root = process.env.AEH_SERENA_POOL_ROOT?.trim() || process.cwd();
  const command = process.env.AEH_SERENA_POOL_COMMAND?.trim() || "serena";
  if (!socketPath) throw new Error("AEH Serena pool requires AEH_SERENA_POOL_SOCKET.");
  await fsSync.promises.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });

  let server: net.Server | undefined;
  for (;;) {
    server = net.createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => { server?.off("listening", onListening); reject(error); };
        const onListening = () => { server?.off("error", onError); resolve(); };
        server?.once("error", onError);
        server?.once("listening", onListening);
        server?.listen(socketPath);
      });
      break;
    } catch (error) {
      server.removeAllListeners();
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      try { await connectUnixSocket(socketPath); return; } catch { await fsSync.promises.rm(socketPath, { force: true }); }
    }
  }

  const child = spawn(command, ["start-mcp-server", "--context", "ide-assistant", "--project", root, ...SERENA_HEADLESS_ARGS], { cwd: root, env: process.env, stdio: ["pipe", "pipe", "inherit"] });
  const childReader = readline.createInterface({ input: child.stdout });
  const clients = new Set<net.Socket>();
  const pending = new Map<string, { socket: net.Socket; id: number | string }>();
  let clientSequence = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  const close = () => {
    if (idleTimer) clearTimeout(idleTimer);
    for (const client of clients) client.destroy();
    childReader.close();
    if (child.exitCode === null) child.kill("SIGTERM");
    server?.close();
    void fsSync.promises.rm(socketPath, { force: true });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  child.once("exit", close);
  childReader.on("line", (line) => {
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    const id = typeof message?.id === "string" ? message.id : undefined;
    if (!id || !id.startsWith("aeh-pool:")) return;
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    message.id = request.id;
    if (request.socket.writable) request.socket.write(`${JSON.stringify(message)}\n`);
  });
  server.on("connection", (socket) => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
    clients.add(socket);
    const clientId = ++clientSequence;
    let writerAuthorized = false;
    const reader = readline.createInterface({ input: socket });
    reader.on("line", (line) => {
      let message: any;
      try { message = JSON.parse(line); } catch { return; }
      if (message?.method === "aeh/serena-pool/handshake") {
        writerAuthorized = message.params?.requestedWrite === true && hasValidWriterLeaseData(root, message.params?.leaseFile, message.params?.leaseToken);
        return;
      }
      if (!writerAuthorized && message?.method === "tools/call" && typeof message.params?.name === "string" && !READ_ONLY_TOOL_SET.has(message.params.name)) {
        if (message.id !== undefined) socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Serena tool '${message.params.name}' is not granted to this read-only client.` } })}\n`);
        return;
      }
      if (message && message.id !== undefined && message.id !== null) {
        const originalId = message.id as number | string;
        const mapped = `aeh-pool:${clientId}:${String(originalId)}`;
        pending.set(mapped, { socket, id: originalId });
        message.id = mapped;
      }
      if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
    });
    const disconnect = () => {
      reader.close();
      clients.delete(socket);
      for (const [id, request] of pending) if (request.socket === socket) pending.delete(id);
      if (!clients.size && !idleTimer) idleTimer = setTimeout(close, 60_000);
    };
    socket.once("close", disconnect);
    socket.once("error", disconnect);
  });
  await onceExit(child);
}

function parseToolList(value: string | undefined): Set<string> | undefined {
  if (!value?.trim() || value.trim() === "*") return undefined;
  return new Set(value.split(",").map((item) => item.trim()).filter(Boolean));
}

function hasValidWriterLease(root: string): boolean {
  const filePath = process.env.AEH_SERENA_WRITER_LEASE_FILE?.trim();
  const token = process.env.AEH_SERENA_WRITER_LEASE_TOKEN?.trim();
  return hasValidWriterLeaseData(root, filePath, token);
}

function hasValidWriterLeaseData(root: string, filePath?: unknown, token?: unknown): boolean {
  if (typeof filePath !== "string" || typeof token !== "string" || !filePath.trim() || !token.trim()) return false;
  try {
    const lease = JSON.parse(fsSync.readFileSync(filePath, "utf8")) as SerenaWriterLeaseFileV1;
    return lease.version === 1 && path.resolve(lease.canonicalRoot) === path.resolve(root) && Date.parse(lease.expiresAt) > Date.now() && lease.tokenDigest === createHash("sha256").update(token).digest("hex");
  } catch { return false; }
}

function onceDrain(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve) => stream.once("drain", () => resolve()));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function onceExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}
