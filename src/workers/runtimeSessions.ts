import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import readline from "node:readline";
import type { DirectWorkerHome } from "./directProcess.js";
import { registerManagedProcessHandle } from "../utils/process.js";

export interface RuntimeSessionPreparation {
  cwd: string;
  environment: Record<string, string>;
  home: DirectWorkerHome;
  timeoutMs: number;
  executable?: string;
}

/** Create an idle OpenCode session through its local server API without sending a prompt. */
export async function prepareOpenCodeSession(input: RuntimeSessionPreparation): Promise<string> {
  const port = await reserveLoopbackPort();
  const server = spawn(input.executable ?? "opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: input.cwd,
    env: { ...input.environment, HOME: input.home.directory, XDG_CONFIG_HOME: `${input.home.directory}/.config`, XDG_CACHE_HOME: `${input.home.directory}/.cache` },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });
  let spawnError: Error | undefined;
  server.once("error", (error) => { spawnError = error; });
  const unregister = server.pid ? await registerManagedProcessHandle(server.pid) : async () => undefined;
  const diagnostics: string[] = [];
  server.stdout.on("data", (chunk: Buffer) => diagnostics.push(chunk.toString()));
  server.stderr.on("data", (chunk: Buffer) => diagnostics.push(chunk.toString()));
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitForOpenCodeServer(server, base, input.timeoutMs, diagnostics, () => spawnError);
    const created = await requestJson(base, "/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "aeh-prepared-execution" }) });
    const sessionId = recordString(created, "id");
    if (!sessionId) throw new Error("RUNTIME_SESSION_ID_MISSING: OpenCode session creation returned no provider session id.");
    const observed = await requestJson(base, `/session/${encodeURIComponent(sessionId)}`);
    if (recordString(observed, "id") !== sessionId) throw new Error("RUNTIME_SESSION_ID_MISMATCH: OpenCode did not confirm the created provider session id.");
    return sessionId;
  } finally {
    await stopProcess(server);
    await unregister();
  }
}

/** Create an idle persistent Codex app-server thread before the first semantic turn. */
export async function prepareCodexThread(input: RuntimeSessionPreparation & { model: string; modelProvider?: string; sandbox: string; approvalPolicy: string }): Promise<string> {
  const pending = new Map<string, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  let spawnError: Error | undefined;
  const child = spawn(input.executable ?? "codex", ["app-server", "--listen", "stdio://"], {
    cwd: input.cwd,
    env: { ...input.environment, HOME: input.home.directory, CODEX_HOME: input.home.directory },
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.once("error", (error) => {
    spawnError = error;
    for (const waiting of pending.values()) { clearTimeout(waiting.timer); waiting.reject(error); }
    pending.clear();
  });
  const unregister = child.pid ? await registerManagedProcessHandle(child.pid) : async () => undefined;
  const reader = readline.createInterface({ input: child.stdout });
  let nextId = 1;
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  reader.on("line", (line) => {
    let message: Record<string, unknown>;
    try { message = JSON.parse(line) as Record<string, unknown>; }
    catch { return; }
    const id = typeof message.id === "string" || typeof message.id === "number" ? String(message.id) : undefined;
    if (!id) return;
    const waiting = pending.get(id);
    if (!waiting) return;
    pending.delete(id);
    clearTimeout(waiting.timer);
    if (message.error && typeof message.error === "object") waiting.reject(new Error(`CODEX_APP_SERVER_ERROR: ${JSON.stringify(message.error)}`));
    else waiting.resolve(message);
  });
  const request = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (spawnError) return Promise.reject(spawnError);
    if (!child.stdin.writable) return Promise.reject(new Error("CODEX_APP_SERVER_CLOSED: app-server input is not writable."));
    const id = String(nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CODEX_APP_SERVER_TIMEOUT: ${method} did not respond within ${input.timeoutMs}ms.`)); }, input.timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      });
    });
  };
  try {
    await request("initialize", { clientInfo: { name: "agentic-engineering-harness", title: "AEH session preparation", version: "2" }, capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
    const started = await request("thread/start", {
      model: input.model,
      modelProvider: input.modelProvider,
      cwd: input.cwd,
      approvalPolicy: input.approvalPolicy,
      sandbox: input.sandbox,
      ephemeral: false
    });
    const result = started.result;
    const thread = result && typeof result === "object" ? (result as Record<string, unknown>).thread : undefined;
    const sessionId = thread && typeof thread === "object" ? recordString(thread, "id") : undefined;
    if (!sessionId) throw new Error(`RUNTIME_SESSION_ID_MISSING: Codex thread/start returned no durable thread id.${stderr ? ` ${stderr}` : ""}`);
    return sessionId;
  } finally {
    reader.close();
    await stopProcess(child);
    await unregister();
    for (const waiting of pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error("CODEX_APP_SERVER_CLOSED: session preparation ended.")); }
    pending.clear();
  }
}

async function waitForOpenCodeServer(child: ChildProcess, base: string, timeoutMs: number, diagnostics: string[], getSpawnError: () => Error | undefined): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const spawnError = getSpawnError();
    if (spawnError) throw new Error(`OPENCODE_SESSION_API_UNAVAILABLE: unable to start opencode serve: ${String(spawnError)}.`);
    if (child.exitCode !== null) throw new Error(`OPENCODE_SESSION_API_UNAVAILABLE: opencode serve exited ${child.exitCode}.${diagnostics.join(" ")}`);
    try {
      const health = await requestJson(base, "/global/health", {}, 500);
      if (health && typeof health === "object" && (health as Record<string, unknown>).healthy === true) return;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`OPENCODE_SESSION_API_UNAVAILABLE: opencode serve did not become ready.${lastError ? ` ${String(lastError)}` : ""} ${diagnostics.join(" ")}`);
}

async function requestJson(base: string, pathname: string, init: RequestInit = {}, timeoutMs = 2_000): Promise<unknown> {
  const response = await fetch(new URL(pathname, base), { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`OpenCode session API ${pathname} returned HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

async function reserveLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error("OPENCODE_SESSION_API_UNAVAILABLE: unable to reserve a loopback port."); }
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function stopProcess(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch { child.kill("SIGTERM"); }
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 500))]);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch { child.kill("SIGKILL"); }
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 500))]);
  }
}

function recordString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim() ? field : undefined;
}
