import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX = path.resolve(REPO_ROOT, "node_modules", ".bin", "tsx");
const ENTRY = path.resolve(REPO_ROOT, "src", "entry.ts");

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/**
 * D21 (HIGH correctness): the context-retrieval MCP server must serve
 * isolated participant worktrees. Worktrees are git-based checkouts without
 * the gitignored .harness/ directory; loading the project config from the
 * participant root crashed the server with ENOENT before the MCP handshake,
 * and the opencode runtime surfaced only "MCP error -32000: Connection
 * closed" — every implementer spawn with this server failed deterministically
 * before repository inspection. The config is control-plane authority and now
 * loads from AEH_CONTEXT_CONTROL_ROOT; a missing control config fails each
 * request closed with a JSON-RPC error while the server stays alive.
 * Spawns the real server entry as a child (client perspective, no mocks).
 */
async function runServer(
  env: Record<string, string>,
  requests: Array<Record<string, unknown>>,
): Promise<{ exitCode: number | null; responses: JsonRpcResponse[]; stderr: string }> {
  const child = spawn(process.execPath, [TSX, ENTRY, "context", "mcp"], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const responses: JsonRpcResponse[] = [];
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as JsonRpcResponse;
        if (parsed.id !== undefined && !responses.some((r) => r.id === parsed.id)) responses.push(parsed);
      } catch {
        // Partial line; wait for more data.
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  const deadline = Date.now() + 15_000;
  while (responses.length < requests.length && Date.now() < deadline) {
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.stdin.end();
  const exitCode: number | null = await new Promise((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.on("close", resolve);
    setTimeout(() => {
      child.kill("SIGKILL");
      resolve(child.exitCode);
    }, 10_000);
  });
  return { exitCode, responses, stderr };
}

function serverEnv(root: string, controlRoot: string): Record<string, string> {
  return {
    AEH_CONTEXT_ROOT: root,
    AEH_CONTEXT_CONTROL_ROOT: controlRoot,
    AEH_CONTEXT_OPERATION_ID: "OP-D21",
    AEH_CONTEXT_PARTICIPANT_ID: "participant:d21",
    AEH_LOGICAL_AGENT: "implementer",
    AEH_CONTEXT_PHASE: "work",
  };
}

describe("D21 context MCP server worktree roots", () => {
  it("serves the handshake from a worktree root without .harness when the control root is configured", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-d21-work-"));
    roots.push(root);
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-d21-ctrl-"));
    roots.push(controlRoot);
    await fs.mkdir(path.join(controlRoot, ".harness"), { recursive: true });
    await fs.writeFile(
      path.join(controlRoot, ".harness", "project.yaml"),
      "version: 1\nproject:\n  name: d21-ctrl\n",
      "utf8",
    );
    const { exitCode, responses } = await runServer(serverEnv(root, controlRoot), [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "ping", params: {} },
    ]);
    expect(responses.find((r) => r.id === 1)?.result).toMatchObject({ protocolVersion: "2025-06-18" });
    expect(responses.find((r) => r.id === 2)?.result).toEqual({});
    expect(responses.some((r) => r.error)).toBe(false);
    expect(exitCode).toBe(0);
  }, 30_000);

  it("fails requests closed with JSON-RPC errors (no pre-handshake crash) when no config exists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-d21-nowhere-"));
    roots.push(root);
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-d21-noctrl-"));
    roots.push(controlRoot);
    const { exitCode, responses } = await runServer(serverEnv(root, controlRoot), [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "ping", params: {} },
    ]);
    expect(responses).toHaveLength(2);
    for (const response of responses) {
      expect(response.error?.code).toBe(-32603);
      expect(typeof response.error?.message).toBe("string");
    }
    expect(exitCode).toBe(0);
  }, 30_000);
});
