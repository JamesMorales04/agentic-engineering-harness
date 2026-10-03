import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIntentDecision, intentDecisionFromLeadOperationIntent } from "../src/audit/intentDecision.js";
import { startDetachedOperation } from "../src/operations/controller.js";
import { handleOperationMcpRequest } from "../src/operations/mcp.js";
import { resolveOperationToolDiagnosticV2 } from "../src/operations/toolDiagnostics.js";

const roots: string[] = [];
const previousRoot = process.env.AEH_CONTROL_ROOT;
const previousAgent = process.env.PASEO_AGENT_ID;
afterEach(async () => {
  if (previousRoot === undefined) delete process.env.AEH_CONTROL_ROOT; else process.env.AEH_CONTROL_ROOT = previousRoot;
  if (previousAgent === undefined) delete process.env.PASEO_AGENT_ID; else process.env.PASEO_AGENT_ID = previousAgent;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Lead operation tool contract", () => {
  it("makes controller-owned delivery and route effects absent from provider-facing start schemas", async () => {
    const listed = await handleOperationMcpRequest({ method: "tools/list" });
    const tools = (listed.tools as Array<{ name: string; inputSchema: Record<string, unknown> }>);
    const starts = [
      ["aeh_operation_start_audit", ["request", "operationIntent"]],
      ["aeh_operation_start_change", ["request", "operationIntent"]],
      ["aeh_operation_start_run", ["taskId", "operationIntent"]]
    ] as const;
    for (const [name, required] of starts) {
      const tool = tools.find((item) => item.name === name)!;
      const schema = tool.inputSchema;
      expect(schema.required).toEqual(required);
      expect(JSON.stringify(schema)).not.toMatch(/deliver|effects|userTurnId|source/);
      const properties = schema.properties as Record<string, unknown>;
      const intent = properties.operationIntent as { properties: Record<string, unknown>; additionalProperties: boolean };
      expect(intent.additionalProperties).toBe(false);
      expect(Object.keys(intent.properties)).toEqual(["version", "requestedOutcome", "continuation", "constraints"]);
      expect(intent.properties).not.toHaveProperty("effects");
      expect(intent.properties).not.toHaveProperty("userTurnId");
    }
    const informational = tools.find((item) => item.name === "aeh_informational_context")!;
    expect(informational.inputSchema.required).toEqual(["request"]);
    expect(informational.inputSchema.properties).not.toHaveProperty("intentDecision");
  });

  it("preserves delivery request intent while deriving route effects with deliver false", () => {
    const decision = intentDecisionFromLeadOperationIntent("change", {
      version: 1,
      requestedOutcome: "Implement the requested fix, commit it, push the branch, and open a PR.",
      constraints: ["Commit, push and PR are requested outcomes; the controller retains delivery authority."]
    }, "paseo-user-turn:lead-1:2026-10-03T03:00:00.000Z");

    expect(decision.requestedOutcome).toContain("push the branch");
    expect(decision.constraints).toContain("Commit, push and PR are requested outcomes; the controller retains delivery authority.");
    expect(decision.userTurnId).toMatch(/^paseo-user-turn:/);
    expect(decision.effects).toEqual({ evaluate: false, mutateRepository: true, executePreparedTask: false, deliver: false });
  });

  it("returns structured recovery metadata and creates no operation for malformed start input", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-operation-tool-contract-"));
    roots.push(root);
    process.env.AEH_CONTROL_ROOT = root;
    process.env.PASEO_AGENT_ID = "lead-contract-test";
    const result = await handleOperationMcpRequest({
      jsonrpc: "2.0",
      id: "malformed-start",
      method: "tools/call",
      params: {
        name: "aeh_operation_start_change",
        arguments: {
          request: "Request a change and delivery.",
          operationIntent: { version: 1, requestedOutcome: "", effects: { deliver: true } }
        }
      }
    });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(result.isError).toBe(true);
    expect(structured).toMatchObject({ version: 1, category: "INPUT_CONTRACT", operationCreated: false, recoverable: true, retryDisposition: "CORRECT_INPUT", requiresHuman: false, skillRef: "aeh-operation-control#START" });
    expect(structured).toHaveProperty("path", "operationIntent");
    const diagnostic = await resolveOperationToolDiagnosticV2(root, structured.diagnosticRef as string);
    expect(diagnostic).toMatchObject({ errorCode: "INVALID_INTENT_DECISION", failureClass: "INPUT" });
    expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text" })]));
    await expect(fs.readdir(path.join(root, ".harness", "operations"))).rejects.toMatchObject({ code: "ENOENT" });

    const missingRequest = await handleOperationMcpRequest({
      jsonrpc: "2.0", id: "missing-request", method: "tools/call",
      params: { name: "aeh_operation_start_change", arguments: { operationIntent: { version: 1, requestedOutcome: "Implement a safe fix." } } }
    });
    expect(missingRequest.structuredContent).toMatchObject({ version: 1, code: "OPERATION_INPUT_INVALID", category: "INPUT_CONTRACT", path: "request", operationCreated: false, retryDisposition: "CORRECT_INPUT" });
    await expect(fs.readdir(path.join(root, ".harness", "operations"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not mistake another Lead's matching JSON-RPC id for an operation created by this request", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-operation-tool-correlation-"));
    roots.push(root);
    process.env.AEH_CONTROL_ROOT = root;
    process.env.PASEO_AGENT_ID = "lead-current";
    const otherLeadOperation = await startDetachedOperation(root, "audit", {
      request: "An unrelated request owned by another Lead.",
      intentDecision: createIntentDecision("audit", "Review this unrelated request.", "lead-semantic")
    }, {
      nodeExecutable: process.execPath, entryFile: "/pkg/dist/main.js",
      initiator: { kind: "LEAD", agentId: "lead-other", userTurnId: "other-owner-turn", requestEventId: "lead-other:jsonrpc:collision" },
      spawnProcess: (() => ({ pid: 4321, unref: () => undefined })) as never
    });
    const sameLeadOldRequest = await startDetachedOperation(root, "audit", {
      request: "A prior request from this Lead reused the same JSON-RPC id.",
      intentDecision: createIntentDecision("audit", "Review this prior request.", "lead-semantic")
    }, {
      nodeExecutable: process.execPath, entryFile: "/pkg/dist/main.js",
      initiator: { kind: "LEAD", agentId: "lead-current", userTurnId: "prior-owner-turn", requestEventId: "lead-current:jsonrpc:collision" },
      spawnProcess: (() => ({ pid: 4322, unref: () => undefined })) as never
    });

    const result = await handleOperationMcpRequest({
      jsonrpc: "2.0", id: "collision", method: "tools/call",
      params: { name: "aeh_operation_start_change", arguments: { request: "Malformed new request", operationIntent: { version: 1, requestedOutcome: "" } } }
    });
    expect(result.structuredContent).toMatchObject({ version: 1, category: "INPUT_CONTRACT", operationCreated: false, retryDisposition: "CORRECT_INPUT" });
    const durableOperationFiles = (await fs.readdir(path.join(root, ".harness", "operations"))).filter((file) => /^[A-Z][A-Za-z0-9_-]+\.json$/.test(file));
    expect(durableOperationFiles).toContain(`${otherLeadOperation.id}.json`);
    expect(durableOperationFiles).toContain(`${sameLeadOldRequest.id}.json`);
    expect(durableOperationFiles).toHaveLength(2);
  });

  it("classifies ENOENT as not found only for an explicit operation lookup", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-operation-tool-not-found-"));
    roots.push(root);
    process.env.AEH_CONTROL_ROOT = root;
    const result = await handleOperationMcpRequest({
      jsonrpc: "2.0", id: "missing-operation", method: "tools/call",
      params: { name: "aeh_operation_digest", arguments: { operationId: "CHANGE-MISSING" } }
    });
    expect(result.structuredContent).toMatchObject({ version: 1, code: "OPERATION_NOT_FOUND", category: "NOT_FOUND", path: "operationId", operationCreated: false });
  });

  it("classifies invalid status detail as a trusted input contract error", async () => {
    const result = await handleOperationMcpRequest({
      jsonrpc: "2.0", id: "invalid-detail", method: "tools/call",
      params: { name: "aeh_operation_status", arguments: { operationId: "CHANGE-1", detail: "verbose" } }
    });
    expect(result.structuredContent).toMatchObject({ version: 1, code: "OPERATION_INPUT_INVALID", category: "INPUT_CONTRACT", path: "detail", operationCreated: false, recoverable: true, retryDisposition: "CORRECT_INPUT" });
  });
});
