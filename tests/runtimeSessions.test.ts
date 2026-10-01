import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareCodexThread, prepareOpenCodeSession } from "../src/workers/runtimeSessions.js";

describe("runtime session preparation", () => {
  it("creates and confirms an idle OpenCode session through the server API", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-opencode-session-"));
    try {
      const home = path.join(root, "isolated-home");
      const executable = path.join(root, "fake-opencode");
      const requestsFile = path.join(root, "requests.txt");
      await fs.mkdir(home, { recursive: true });
      await fs.writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const server = http.createServer((request, response) => {
  fs.appendFileSync(process.env.AEH_TEST_REQUESTS_FILE, request.method + " " + request.url + "\\n");
  response.setHeader("content-type", "application/json");
  if (request.method === "GET" && request.url === "/global/health") { response.end(JSON.stringify({ healthy: true })); return; }
  if (request.method === "POST" && request.url === "/session") { response.end(JSON.stringify({ id: "opencode-provider-session" })); return; }
  if (request.method === "GET" && request.url === "/session/opencode-provider-session") { response.end(JSON.stringify({ id: "opencode-provider-session" })); return; }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "not found" }));
});
server.listen(port, "127.0.0.1");
`);
      await fs.chmod(executable, 0o755);

      const sessionId = await prepareOpenCodeSession({
        cwd: root,
        environment: { PATH: process.env.PATH ?? "", AEH_TEST_REQUESTS_FILE: requestsFile },
        home: { directory: home },
        timeoutMs: 5_000,
        executable
      });

      expect(sessionId).toBe("opencode-provider-session");
      const requests = await fs.readFile(requestsFile, "utf8");
      expect(requests).toContain("POST /session");
      expect(requests).toContain("GET /session/opencode-provider-session");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("starts Codex app-server over stdio and freezes its returned durable thread id", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-codex-session-"));
    try {
      const home = path.join(root, "isolated-home");
      const executable = path.join(root, "fake-codex");
      const requestsFile = path.join(root, "requests.jsonl");
      await fs.mkdir(home, { recursive: true });
      await fs.writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf("\\n");
    if (end < 0) break;
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    const request = JSON.parse(line);
    fs.appendFileSync(process.env.AEH_TEST_REQUESTS_FILE, line + "\\n");
    if (request.id === undefined) continue;
    const result = request.method === "thread/start" ? { thread: { id: "provider-thread-7" } } : {};
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
  }
});
`);
      await fs.chmod(executable, 0o755);

      const sessionId = await prepareCodexThread({
        cwd: root,
        environment: { PATH: process.env.PATH ?? "", AEH_TEST_REQUESTS_FILE: requestsFile },
        home: { directory: home },
        timeoutMs: 5_000,
        executable,
        model: "gpt-test",
        modelProvider: "openai",
        sandbox: "read-only",
        approvalPolicy: "never"
      });

      expect(sessionId).toBe("provider-thread-7");
      const requests = (await fs.readFile(requestsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(requests[0]).toMatchObject({ jsonrpc: "2.0", id: "1", method: "initialize" });
      expect(requests[1]).toMatchObject({ jsonrpc: "2.0", method: "initialized" });
      expect(requests[2]).toMatchObject({
        jsonrpc: "2.0",
        id: "2",
        method: "thread/start",
        params: { model: "gpt-test", modelProvider: "openai", cwd: root, approvalPolicy: "never", sandbox: "read-only", ephemeral: false }
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when Codex app-server returns no durable thread id", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-codex-session-missing-"));
    try {
      const home = path.join(root, "isolated-home");
      const executable = path.join(root, "fake-codex");
      await fs.mkdir(home, { recursive: true });
      await fs.writeFile(executable, `#!/usr/bin/env node
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf("\\n");
    if (end < 0) break;
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    const result = request.method === "thread/start" ? { thread: {} } : {};
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
  }
});
`);
      await fs.chmod(executable, 0o755);

      await expect(prepareCodexThread({
        cwd: root,
        environment: { PATH: process.env.PATH ?? "" },
        home: { directory: home },
        timeoutMs: 5_000,
        executable,
        model: "gpt-test",
        sandbox: "read-only",
        approvalPolicy: "never"
      })).rejects.toThrow("RUNTIME_SESSION_ID_MISSING");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
