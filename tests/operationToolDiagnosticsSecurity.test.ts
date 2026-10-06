import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const portfolioMock = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("../src/operations/portfolio.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/operations/portfolio.js")>();
  return { ...actual, loadOperationPortfolio: portfolioMock.load };
});

import { handleOperationMcpRequest } from "../src/operations/mcp.js";
import { createTrustedOperationToolError, persistOperationToolDiagnosticV2, resolveOperationToolDiagnosticV2 } from "../src/operations/toolDiagnostics.js";
import { loadOperation, saveOperation } from "../src/operations/state.js";
import type { OperationRecordV2 } from "../src/operations/state.js";

const tempRoots: string[] = [];
const previousControlRoot = process.env.AEH_CONTROL_ROOT;
const previousStateHome = process.env.XDG_STATE_HOME;

afterEach(async () => {
  if (previousControlRoot === undefined) delete process.env.AEH_CONTROL_ROOT;
  else process.env.AEH_CONTROL_ROOT = previousControlRoot;
  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousStateHome;
  vi.restoreAllMocks();
  portfolioMock.load.mockReset();
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<{ base: string; root: string; outside: string }> {
  const base = await fs.mkdtemp(path.join(process.cwd(), ".tmp-operation-tool-"));
  tempRoots.push(base);
  const root = path.join(base, "control-root");
  const outside = path.join(base, "outside");
  await fs.mkdir(path.join(root, ".harness"), { recursive: true });
  await fs.writeFile(path.join(root, ".harness", "project.yaml"), "version: 1\nproject:\n  name: diagnostics-test\norchestration:\n  provider: paseo\n");
  await fs.mkdir(path.join(outside, "diagnostics", "operation-tool-calls"), { recursive: true });
  process.env.AEH_CONTROL_ROOT = root;
  process.env.XDG_STATE_HOME = path.join(base, "state");
  return { base, root, outside };
}

describe("operation MCP diagnostic security", () => {
  it("does not expose provider-controlled exception name, code, frame, or path", async () => {
    const { root } = await makeWorkspace();
    const error = Object.assign(new Error("provider response credential-value-secret"), {
      name: "PROVIDER_NAME_SECRET",
      code: "PROVIDER_CODE_SECRET",
      path: "/credential/path-secret.txt"
    });
    error.stack = `${error.stack}\n    at invoke (/provider/credential-frame-secret.ts:42:9)`;
    portfolioMock.load.mockRejectedValueOnce(error);

    const result = await handleOperationMcpRequest({
      jsonrpc: "2.0", id: "secret-provider-error", method: "tools/call",
      params: { name: "aeh_operation_portfolio", arguments: {} }
    });
    const structured = result.structuredContent as Record<string, unknown>;
    const diagnosticRef = structured.diagnosticRef as string;
    const diagnostic = await resolveOperationToolDiagnosticV2(root, diagnosticRef);

    expect.soft(structured.code).toBe("OPERATION_TOOL_CALL_FAILED");
    expect.soft(JSON.stringify(result)).not.toMatch(/PROVIDER_CODE_SECRET|credential-value-secret|credential-frame-secret|path-secret/);
    expect.soft(diagnostic?.exceptionClass).toBe("Error");
    expect.soft(diagnostic?.errorCode).toBeUndefined();
    expect.soft(JSON.stringify(diagnostic)).not.toMatch(/PROVIDER_NAME_SECRET|PROVIDER_CODE_SECRET|credential-frame-secret|path-secret/);
  });

  it("does not expose provider-supplied related operation identity or forged allowlisted frames", async () => {
    const { base, root } = await makeWorkspace();
    const unrelatedOperationId = "AUDIT-UNRELATED-PERSISTED";
    const unrelatedWorkspace = path.join(base, "unrelated-workspace");
    await fs.mkdir(unrelatedWorkspace);
    const now = new Date().toISOString();
    const unrelatedOperation: OperationRecordV2 = {
      version: 2, id: unrelatedOperationId, kind: "audit", status: "RUNNING", phase: "reviewing", root: unrelatedWorkspace,
      payload: { request: "separate persisted operation" }, revision: 1, createdAt: now, updatedAt: now, lastProgressAt: now,
      supervision: { required: true, materialized: false, generations: [] }, stages: {}, participants: {},
      progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
      notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 }
    };
    await saveOperation(root, unrelatedOperation);
    await expect(loadOperation(root, unrelatedOperationId)).resolves.toMatchObject({ id: unrelatedOperationId });

    const error = Object.assign(new Error("provider failure"), { relatedOperationId: unrelatedOperationId });
    error.stack = `${error.stack}\n    at invoke (${path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", "operations", "mcp.ts")}:999999999999999999999999999999:1)`;
    portfolioMock.load.mockRejectedValueOnce(error);

    const result = await handleOperationMcpRequest({ jsonrpc: "2.0", id: "forged-lineage", method: "tools/call", params: { name: "aeh_operation_portfolio", arguments: {} } });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({ code: "OPERATION_TOOL_CALL_FAILED", relationship: "NONE" });
    expect(structured).not.toHaveProperty("relatedOperationId");
    expect(JSON.stringify(result)).not.toContain(unrelatedOperationId);
    const diagnostic = await resolveOperationToolDiagnosticV2(root, structured.diagnosticRef as string);
    expect(diagnostic?.stackFrames).toEqual([]);
  });

  it("keeps provider owner codes generic while preserving explicitly branded internal authority codes", async () => {
    const { root } = await makeWorkspace();
    portfolioMock.load.mockRejectedValueOnce(Object.assign(new Error("OWNER boundary"), { code: "OPERATION_RECOVERY_OWNER_BOUNDARY", relatedOperationId: "OPERATION_EXISTING_ABC" }));
    const forged = await handleOperationMcpRequest({ jsonrpc: "2.0", id: "forged-owner", method: "tools/call", params: { name: "aeh_operation_portfolio", arguments: {} } });
    expect(forged.structuredContent).toMatchObject({ code: "OPERATION_TOOL_CALL_FAILED", category: "INTERNAL", relationship: "NONE" });
    expect(forged.structuredContent).not.toHaveProperty("relatedOperationId");
    expect(JSON.stringify(forged)).not.toContain("OPERATION_EXISTING_ABC");

    portfolioMock.load.mockRejectedValueOnce(createTrustedOperationToolError("OPERATION_RECOVERY_OWNER_BOUNDARY", "trusted controller boundary"));
    const trusted = await handleOperationMcpRequest({ jsonrpc: "2.0", id: "trusted-owner", method: "tools/call", params: { name: "aeh_operation_portfolio", arguments: {} } });
    expect(trusted.structuredContent).toMatchObject({ code: "OPERATION_RECOVERY_OWNER_BOUNDARY", category: "OWNER_BOUNDARY", retryDisposition: "ESCALATE_TO_OWNER" });
  });

  it("keeps provider AEH-like codes and errno out of public control classification", async () => {
    const { root } = await makeWorkspace();
    for (const forgedCode of ["OPERATION_NOT_FOUND", "OPERATION_RECOVERY_PARENT_REQUIRED", "ENOENT"]) {
      portfolioMock.load.mockRejectedValueOnce(Object.assign(new Error("provider supplied code"), { code: forgedCode }));
      const result = await handleOperationMcpRequest({ jsonrpc: "2.0", id: `forged-${forgedCode}`, method: "tools/call", params: { name: "aeh_operation_portfolio", arguments: {} } });
      expect(result.structuredContent).toMatchObject({ code: "OPERATION_TOOL_CALL_FAILED", category: "INTERNAL", relationship: "NONE" });
      expect(result.structuredContent).not.toHaveProperty("relatedOperationId");
      const ref = (result.structuredContent as { diagnosticRef: string }).diagnosticRef;
      const record = await resolveOperationToolDiagnosticV2(root, ref);
      expect(record?.failureClass).toBe("INTERNAL");
      if (forgedCode === "ENOENT") expect(record?.errorCode).toBe("ENOENT");
      else expect(record?.errorCode).toBeUndefined();
    }
  });

  // Bounded 20s budget (vitest default is 5s): passes quickly in isolation
  // but flakes at ~5010ms under full-suite parallel load (same class as
  // runRepair/fsmonitor/OCI bumps). Spawns real `tsx src/main.ts operation
  // diagnostic inspect` subprocesses with their own I/O handling, so no
  // sleep/poll to mock — budget-only, assertions/body unchanged.
  it("records bounded, distinct stages and supports the read-only CLI inspector", async () => {
    const { root, base } = await makeWorkspace();
    const stateHome = path.join(base, "state");
    const startRef = await persistOperationToolDiagnosticV2({ root, requestCorrelationId: "start", tool: "aeh_operation_start_change", error: new Error("secret") });
    const portfolioRef = await persistOperationToolDiagnosticV2({ root, requestCorrelationId: "portfolio", tool: "aeh_operation_portfolio", error: new Error("secret") });
    const startRecord = await resolveOperationToolDiagnosticV2(root, startRef);
    const portfolioRecord = await resolveOperationToolDiagnosticV2(root, portfolioRef);
    expect(startRecord).toMatchObject({ version: 2, stage: "START", failureClass: "INTERNAL", messageOmitted: true });
    expect(portfolioRecord).toMatchObject({ version: 2, stage: "PORTFOLIO", failureClass: "INTERNAL", messageOmitted: true });
    expect(JSON.stringify(startRecord)).not.toContain("secret");

    const run = (reference: string, directory = root) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts", "operation", "diagnostic", "inspect", reference, directory], { cwd: process.cwd(), env: { ...process.env, XDG_STATE_HOME: stateHome }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = ""; let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (part: string) => { stdout += part; });
      child.stderr.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    const valid = await run(startRef);
    expect(valid.code).toBe(0);
    expect(JSON.parse(valid.stdout)).toMatchObject({ stage: "START" });
    expect((await run(startRef, base)).code).not.toBe(0);
    expect((await run("aeh-diagnostic:v2/../../etc/passwd")).code).not.toBe(0);
  }, 20_000);

  it("does not follow a writable control-root ancestor replacement during diagnostic persistence", async () => {
    if (process.platform !== "linux") return;
    const { base, root, outside } = await makeWorkspace();
    const writableParent = path.dirname(root);
    await fs.chmod(writableParent, 0o777);
    const realRename = fs.rename.bind(fs);
    const realRealpath = fs.realpath.bind(fs);
    let replacedAncestor = false;
    let writeResolvedOutsideControlRoot = false;
    vi.spyOn(fs, "realpath").mockImplementation(async (target, options) => {
      const canonical = await realRealpath(target, options);
      if (!replacedAncestor && path.resolve(String(target)) === root) {
        replacedAncestor = true;
        await realRename(root, `${root}-moved`);
        await fs.symlink(outside, root, "dir");
      }
      return canonical;
    });
    const realWriteFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, "writeFile").mockImplementation(async (filePath, ...args) => {
      if (typeof filePath === "string") {
        const resolvedParent = await realRealpath(path.dirname(filePath)).catch(() => undefined);
        if (resolvedParent === outside || resolvedParent?.startsWith(outside + path.sep)) writeResolvedOutsideControlRoot = true;
      }
      return realWriteFile(filePath, ...args);
    });
    portfolioMock.load.mockRejectedValueOnce(new Error("portfolio failed"));

    const result = await handleOperationMcpRequest({
      jsonrpc: "2.0", id: "ancestor-replacement", method: "tools/call",
      params: { name: "aeh_operation_portfolio", arguments: {} }
    });

    expect(replacedAncestor, `test workspace: ${base}`).toBe(true);
    expect(writeResolvedOutsideControlRoot).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toHaveProperty("diagnosticRef", expect.stringMatching(/^aeh-diagnostic:v2\//));
    expect(await fs.readdir(outside)).toEqual(["diagnostics"]);
  });
});
