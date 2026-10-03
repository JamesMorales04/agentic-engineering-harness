import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const operationMocks = vi.hoisted(() => ({
  startDetachedOperation: vi.fn(),
  realStartDetachedOperation: null as unknown,
  spawnOperationMonitor: vi.fn(),
  inspectPaseoNativeAgent: vi.fn(),
  loadOperationPortfolio: vi.fn()
}));

vi.mock("../src/operations/controller.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/operations/controller.js")>();
  operationMocks.realStartDetachedOperation = actual.startDetachedOperation;
  operationMocks.startDetachedOperation.mockImplementation(actual.startDetachedOperation);
  return { ...actual, startDetachedOperation: operationMocks.startDetachedOperation };
});

vi.mock("../src/operations/monitorProcess.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/operations/monitorProcess.js")>();
  return { ...actual, spawnOperationMonitor: operationMocks.spawnOperationMonitor };
});

vi.mock("../src/paseo/native.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/paseo/native.js")>();
  return { ...actual, inspectPaseoNativeAgent: operationMocks.inspectPaseoNativeAgent };
});

vi.mock("../src/operations/portfolio.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/operations/portfolio.js")>();
  return { ...actual, loadOperationPortfolio: operationMocks.loadOperationPortfolio.mockImplementation(actual.loadOperationPortfolio) };
});

import { handleOperationMcpRequest } from "../src/operations/mcp.js";
import { persistOperationToolDiagnosticV2, resolveOperationToolDiagnosticV2 } from "../src/operations/toolDiagnostics.js";
import type { OperationKind, OperationPayload } from "../src/operations/state.js";
import type { StartOperationOptions } from "../src/operations/controller.js";
import { loadOperation } from "../src/operations/state.js";

const roots: string[] = [];
const previousRoot = process.env.AEH_CONTROL_ROOT;
const previousAgent = process.env.PASEO_AGENT_ID;
const previousXdgStateHome = process.env.XDG_STATE_HOME;
afterEach(async () => {
  if (previousRoot === undefined) delete process.env.AEH_CONTROL_ROOT; else process.env.AEH_CONTROL_ROOT = previousRoot;
  if (previousAgent === undefined) delete process.env.PASEO_AGENT_ID; else process.env.PASEO_AGENT_ID = previousAgent;
  if (previousXdgStateHome === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previousXdgStateHome;
  vi.restoreAllMocks();
  operationMocks.startDetachedOperation.mockReset();
  operationMocks.spawnOperationMonitor.mockReset();
  operationMocks.inspectPaseoNativeAgent.mockReset();
  operationMocks.loadOperationPortfolio.mockReset();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function configurePrivateStateHome(): Promise<string> {
  const stateHome = await fs.mkdtemp(path.join(process.cwd(), ".tmp-operation-tool-state-"));
  roots.push(stateHome);
  process.env.XDG_STATE_HOME = stateHome;
  return stateHome;
}

function diagnosticDirectory(stateHome: string): string {
  return path.join(stateHome, "aeh", "operation-tool-diagnostics", "v2");
}

describe("operation MCP error provenance", () => {
  it("keeps stdio tools/call responses valid JSON-RPC and returns a reference only after diagnostic persistence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-operation-tool-stdio-"));
    roots.push(root);
    const stateHome = await configurePrivateStateHome();
    await fs.mkdir(path.join(root, ".harness"), { recursive: true });
    await fs.writeFile(path.join(root, ".harness", "project.yaml"), "invalid: [yaml\n");
    const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts", "operation", "mcp"], {
      cwd: process.cwd(),
      env: { ...process.env, AEH_CONTROL_ROOT: root, XDG_STATE_HOME: stateHome, AEH_INTERACTIVE_LEAD: "1", AEH_ORCHESTRATION_ALLOWED: "1" },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: "stdio-diagnostic", method: "tools/call", params: { name: "aeh_operation_portfolio", arguments: {} } })}\n`);
    const [exitCode] = await once(child, "close") as [number | null, NodeJS.Signals | null];
    expect(exitCode, stderr).toBe(0);
    const response = JSON.parse(stdout.trim()) as { jsonrpc: string; id: string; result: { isError: boolean; structuredContent: { diagnosticRef?: string } } };
    const ref = response.result.structuredContent.diagnosticRef!;
    expect(response).toMatchObject({ jsonrpc: "2.0", id: "stdio-diagnostic", result: { isError: true, structuredContent: { diagnosticRef: expect.stringMatching(/^aeh-diagnostic:v2\/[0-9a-f-]{36}$/) } } });
    await expect(resolveOperationToolDiagnosticV2(root, ref)).resolves.toMatchObject({ tool: "aeh_operation_portfolio" });
  });

  it("persists correlated private diagnostics for pre-create start and portfolio exceptions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-operation-tool-diagnostic-"));
    roots.push(root);
    const stateHome = await configurePrivateStateHome();
    await fs.mkdir(path.join(root, ".harness"), { recursive: true });
    await fs.writeFile(path.join(root, ".harness", "project.yaml"), "version: 1\nproject:\n  name: demo\norchestration:\n  provider: paseo\n");
    process.env.AEH_CONTROL_ROOT = root;
    process.env.PASEO_AGENT_ID = "lead-diagnostics";
    operationMocks.inspectPaseoNativeAgent.mockResolvedValue({ lastUserMessageAt: "2026-10-03T12:00:00.000Z" });
    operationMocks.startDetachedOperation.mockRejectedValueOnce(new Error("start broke token=secret-start"));
    operationMocks.loadOperationPortfolio.mockRejectedValueOnce(new Error("portfolio broke token=secret-portfolio"));

    const start = await handleOperationMcpRequest({
      jsonrpc: "2.0", id: "start-diagnostic", method: "tools/call",
      params: { name: "aeh_operation_start_change", arguments: { request: "Implement a repair.", operationIntent: { version: 1, requestedOutcome: "Complete the repair." } } }
    });
    const portfolio = await handleOperationMcpRequest({ jsonrpc: "2.0", id: "portfolio-diagnostic", method: "tools/call", params: { name: "aeh_operation_portfolio", arguments: {} } });
    expect(start.structuredContent).toHaveProperty("diagnosticRef", expect.any(String));
    expect(portfolio.structuredContent).toHaveProperty("diagnosticRef", expect.any(String));
    const diagnosticDir = diagnosticDirectory(stateHome);
    const names = await fs.readdir(diagnosticDir);
    expect(names).toHaveLength(2);
    const records = await Promise.all(names.map(async (name) => JSON.parse(await fs.readFile(path.join(diagnosticDir, name), "utf8")) as Record<string, unknown>));
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: "aeh_operation_start_change", exceptionClass: "Error", messageOmitted: true, stackFrames: expect.any(Array), requestCorrelationId: expect.any(String) }),
      expect.objectContaining({ tool: "aeh_operation_portfolio", exceptionClass: "Error", messageOmitted: true, stackFrames: expect.any(Array), requestCorrelationId: expect.any(String) })
    ]));
    expect(JSON.stringify(records)).not.toMatch(/secret-start|secret-portfolio|Implement a repair/);
    expect(start.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.not.stringContaining("secret-start") })]));
    if (process.platform !== "win32") {
      const fileStat = await fs.stat(path.join(diagnosticDir, names[0]!));
      expect(fileStat.mode & 0o777).toBe(0o600);
      expect((await fs.stat(diagnosticDir)).mode & 0o777).toBe(0o700);
    }
  });

  it("does not write diagnostics through a control-root symlink", async () => {
    if (process.platform === "win32") return;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-operation-tool-symlink-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-operation-tool-outside-"));
    roots.push(root, outside);
    await configurePrivateStateHome();
    await fs.mkdir(path.join(root, ".harness"), { recursive: true });
    await fs.writeFile(path.join(root, ".harness", "project.yaml"), "version: 1\nproject:\n  name: demo\norchestration:\n  provider: paseo\n");
    await fs.writeFile(path.join(outside, "sentinel"), "outside stays unchanged");
    await fs.symlink(outside, path.join(root, ".harness", "diagnostics"), "dir");
    process.env.AEH_CONTROL_ROOT = root;
    operationMocks.loadOperationPortfolio.mockRejectedValueOnce(new Error("portfolio unavailable"));

    const result = await handleOperationMcpRequest({ jsonrpc: "2.0", id: "symlink-diagnostic", method: "tools/call", params: { name: "aeh_operation_portfolio", arguments: {} } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toHaveProperty("diagnosticRef", expect.any(String));
    expect(await fs.readFile(path.join(outside, "sentinel"), "utf8")).toBe("outside stays unchanged");
    expect(await fs.readdir(outside)).toEqual(["sentinel"]);
  });

  it("omits arbitrary exception text, class, code, frame names, and raw exception paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-operation-tool-secret-text-"));
    roots.push(root);
    const stateHome = await configurePrivateStateHome();
    await fs.mkdir(path.join(root, ".harness"), { recursive: true });
    await fs.writeFile(path.join(root, ".harness", "project.yaml"), "version: 1\nproject:\n  name: demo\norchestration:\n  provider: paseo\n");
    process.env.AEH_CONTROL_ROOT = root;
    const unsafeError = Object.assign(new Error('provider response {"credential":"structured-secret-934"}'), {
      name: "UNTRUSTED_NAME_SECRET",
      code: "TOKEN_SECRET_934",
      path: "/private/path/credential-secret.txt"
    });
    unsafeError.stack = `${unsafeError.stack}\n    at invoke (/pkg/runtime/credential-secret.ts:42:9)\n{"apiSecret":"unknown-secret-241"}`;
    operationMocks.loadOperationPortfolio.mockRejectedValueOnce(unsafeError);

    const result = await handleOperationMcpRequest({ jsonrpc: "2.0", id: "secret-text", method: "tools/call", params: { name: "aeh_operation_portfolio", arguments: {} } });
    const structured = result.structuredContent as Record<string, unknown>;
    const ref = structured.diagnosticRef as string;
    const record = await resolveOperationToolDiagnosticV2(root, ref);
    expect(record).toMatchObject({ exceptionClass: "Error", messageOmitted: true, stackFrames: expect.any(Array) });
    expect(JSON.stringify(record)).not.toMatch(/structured-secret-934|unknown-secret-241|provider response|UNTRUSTED_NAME_SECRET|TOKEN_SECRET_934|credential-secret/);
    expect(JSON.stringify(result)).not.toMatch(/TOKEN_SECRET_934|credential-secret|structured-secret-934|unknown-secret-241/);
    expect(structured.code).toBe("OPERATION_TOOL_CALL_FAILED");
    expect(structured).not.toHaveProperty("path");
    expect(await fs.readdir(diagnosticDirectory(stateHome))).toHaveLength(1);
  });

  it("resolves an opaque reference after process restart and rejects a different control root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-operation-tool-ref-root-"));
    const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-operation-tool-ref-other-"));
    const stateHome = await configurePrivateStateHome();
    roots.push(root, otherRoot);
    await Promise.all([root, otherRoot].map((directory) => fs.mkdir(path.join(directory, ".harness"), { recursive: true })));
    const ref = await persistOperationToolDiagnosticV2({
      root, requestCorrelationId: "request-correlation-1", tool: "aeh_operation_portfolio", error: Object.assign(new Error("private message"), { code: "ENOENT" })
    });
    expect(ref).toMatch(/^aeh-diagnostic:v2\/[0-9a-f-]{36}$/);

    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import { resolveOperationToolDiagnosticV2 } from './src/operations/toolDiagnostics.ts'; const value = await resolveOperationToolDiagnosticV2(process.env.AEH_CONTROL_ROOT, process.env.AEH_DIAGNOSTIC_REF); process.stdout.write(JSON.stringify(value));`], {
      cwd: process.cwd(), env: { ...process.env, AEH_CONTROL_ROOT: root, XDG_STATE_HOME: stateHome, AEH_DIAGNOSTIC_REF: ref }, stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const [exitCode] = await once(child, "close") as [number | null, NodeJS.Signals | null];
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ tool: "aeh_operation_portfolio", requestCorrelationId: "request-correlation-1" });
    await expect(resolveOperationToolDiagnosticV2(otherRoot, ref)).resolves.toBeUndefined();
  });

  it("enforces diagnostic count and age retention", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-operation-tool-concurrent-root-"));
    const stateHome = await configurePrivateStateHome();
    roots.push(root);
    await fs.mkdir(path.join(root, ".harness"), { recursive: true });
    for (let index = 0; index < 104; index += 1) {
      await persistOperationToolDiagnosticV2({ root, requestCorrelationId: `bounded-retention-${index}`, tool: "aeh_operation_portfolio", error: new Error(String(index)) });
    }
    const directory = diagnosticDirectory(stateHome);
    const files = (await fs.readdir(directory)).filter((name) => /^[0-9a-f-]{36}\.json$/.test(name));
    expect(files).toHaveLength(100);
    const records = await Promise.all(files.map(async (name) => JSON.parse(await fs.readFile(path.join(directory, name), "utf8")) as Record<string, unknown>));
    expect(records.every((record) => record.version === 2 && record.controlRootFingerprint && record.requestCorrelationId)).toBe(true);
    const sizes = await Promise.all(files.map(async (name) => (await fs.stat(path.join(directory, name))).size));
    expect(Math.max(...sizes)).toBeLessThanOrEqual(16 * 1024);

    const oldest = records[0]!;
    const oldestFile = path.join(directory, `${oldest.id}.json`);
    const oldDate = new Date("2000-01-01T00:00:00.000Z");
    await fs.utimes(oldestFile, oldDate, oldDate);
    await expect(resolveOperationToolDiagnosticV2(root, `aeh-diagnostic:v2/${String(oldest.id)}`)).resolves.toBeUndefined();
    await persistOperationToolDiagnosticV2({ root, requestCorrelationId: "retention-trigger", tool: "aeh_operation_portfolio", error: new Error("retention") });
    const retained = (await fs.readdir(directory)).filter((name) => /^[0-9a-f-]{36}\.json$/.test(name));
    expect(retained).toHaveLength(100);
    expect(retained).not.toContain(path.basename(oldestFile));
  }, 15_000);

  it("does not let a writable control-root ancestor redirect diagnostic rename or pruning", async () => {
    if (process.platform !== "linux") return;
    const workspace = await fs.mkdtemp(path.join(process.cwd(), ".tmp-operation-tool-writable-parent-"));
    const writableParent = path.join(workspace, "writable-parent");
    const root = path.join(writableParent, "control-root");
    const outside = path.join(workspace, "outside");
    roots.push(workspace);
    await fs.mkdir(writableParent);
    await fs.mkdir(outside);
    await fs.chmod(writableParent, 0o777);
    await fs.mkdir(path.join(root, ".harness"), { recursive: true });
    await configurePrivateStateHome();
    process.env.AEH_CONTROL_ROOT = root;
    operationMocks.loadOperationPortfolio.mockRejectedValueOnce(new Error("safe diagnostic"));
    const realRename = fs.rename.bind(fs);
    let raced = false;
    vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      if (!raced && typeof source === "string" && source.includes(`${path.sep}.harness${path.sep}`)) {
        raced = true;
        await fs.rename(path.join(root, ".harness"), path.join(root, ".harness-moved"));
        await fs.symlink(outside, path.join(root, ".harness"), "dir");
        await fs.writeFile(path.join(outside, path.basename(String(target))), "outside sentinel");
      }
      return realRename(source, target);
    });
    const result = await handleOperationMcpRequest({ jsonrpc: "2.0", id: "ancestor-race", method: "tools/call", params: { name: "aeh_operation_portfolio", arguments: {} } });
    expect(raced).toBe(false);
    expect(result.structuredContent).toHaveProperty("diagnosticRef", expect.any(String));
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("retains the created operation identity when a post-create start step throws ENOENT", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-operation-tool-postcreate-"));
    roots.push(root);
    await fs.mkdir(path.join(root, ".harness"), { recursive: true });
    await fs.writeFile(path.join(root, ".harness", "project.yaml"), "version: 1\nproject:\n  name: demo\norchestration:\n  provider: paseo\n");
    process.env.AEH_CONTROL_ROOT = root;
    process.env.PASEO_AGENT_ID = "lead-postcreate";
    operationMocks.inspectPaseoNativeAgent.mockResolvedValue({ lastUserMessageAt: "2026-10-03T12:00:00.000Z" });
    operationMocks.spawnOperationMonitor.mockRejectedValue(Object.assign(new Error("monitor entry disappeared"), { code: "ENOENT" }));

    const realStart = operationMocks.realStartDetachedOperation as typeof import("../src/operations/controller.js").startDetachedOperation;
    operationMocks.startDetachedOperation.mockImplementationOnce((
      startRoot: string,
      kind: OperationKind,
      payload: OperationPayload,
      options: StartOperationOptions
    ) => realStart(startRoot, kind, payload, {
      ...options,
      spawnProcess: (() => ({ pid: 9876, once: () => undefined, unref: () => undefined })) as never
    }));

    const result = await handleOperationMcpRequest({
      jsonrpc: "2.0", id: "reused-jsonrpc-id", method: "tools/call",
      params: {
        name: "aeh_operation_start_audit",
        arguments: {
          request: "Review the operation runtime behavior.",
          operationIntent: { version: 1, requestedOutcome: "Produce a bounded audit result." }
        }
      }
    });

    const structured = result.structuredContent as Record<string, unknown>;
    expect(result.isError).toBe(true);
    expect(structured).toMatchObject({
      version: 1,
      code: "OPERATION_START_FAILED_AFTER_CREATE",
      category: "CONTROLLER_STATE",
      path: "operationId",
      operationCreated: true,
      relationship: "CURRENT_OPERATION",
      recoverable: false,
      retryDisposition: "DO_NOT_RETRY",
      relatedOperationId: expect.any(String)
    });
    const operationId = structured.relatedOperationId as string;
    await expect(loadOperation(root, operationId)).resolves.toMatchObject({ id: operationId });
  });
});
