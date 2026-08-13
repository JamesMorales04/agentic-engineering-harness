import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { completionPrompt } from "../src/operations/completion.js";
import { buildOperationDigest } from "../src/operations/digest.js";
import { evaluateOperationWake, operationLivenessPolicy, runOperationLivenessCheck } from "../src/operations/liveness.js";
import { acknowledgeOperationRevision, operationToolResult, readOperationStatus } from "../src/operations/mcp.js";
import { bindOperationLead, loadOperation, saveOperation, setOperationStage, type OperationRecordV2 } from "../src/operations/state.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-thin-lead-"));
  roots.push(root);
  return root;
}

function operation(root: string): OperationRecordV2 {
  const now = new Date().toISOString();
  return {
    version: 2,
    id: "AUDIT-THIN",
    kind: "audit",
    status: "RUNNING",
    phase: "reviewing",
    root,
    payload: { request: "x".repeat(10_000), domains: ["architecture", "security"] },
    revision: 1,
    createdAt: now,
    updatedAt: now,
    lastProgressAt: now,
    intent: { request: "x".repeat(10_000), classification: "AUDIT", risk: "medium" },
    supervision: { required: true, materialized: false, generations: [] },
    stages: { reviewing: { name: "reviewing", status: "RUNNING", revision: 1, startedAt: now } },
    participants: {},
    progress: { expected: 4, registered: 0, running: 4, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 }
  };
}

const config = {
  version: 1,
  project: { name: "demo" },
  orchestration: { provider: "paseo" }
} as never;

describe("thin lead token efficiency", () => {
  it("keeps healthy unseen progress controller-owned instead of waking the lead", async () => {
    const root = await tempRoot();
    await saveOperation(root, operation(root));
    let current = await bindOperationLead(root, "AUDIT-THIN", "lead-1", "test");
    current = await setOperationStage(root, "AUDIT-THIN", "reviewing", "RUNNING");
    const now = Date.parse(current.lastProgressAt) + 60_000;
    const decision = evaluateOperationWake(current, operationLivenessPolicy(config), now);
    expect(decision.target).toBe("none");
    expect(decision.reason).toBeUndefined();
    expect(decision.message).toContain("lead wake suppressed");

    const dispatch = vi.fn();
    const executed = await runOperationLivenessCheck(root, config, "AUDIT-THIN", {
      now: () => now,
      dispatch: dispatch as never,
      trace: vi.fn(async () => undefined) as never
    });
    expect(executed.target).toBe("none");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("returns a bounded digest by default and reserves the full record for explicit diagnostics", async () => {
    const root = await tempRoot();
    await saveOperation(root, operation(root));
    await bindOperationLead(root, "AUDIT-THIN", "lead-1", "test");

    const compact = await readOperationStatus(root, "AUDIT-THIN");
    expect(compact).toEqual(expect.objectContaining({ operationId: "AUDIT-THIN", status: "RUNNING", phase: "reviewing" }));
    expect(compact).not.toHaveProperty("payload");
    expect(compact).not.toHaveProperty("intent");
    expect(compact).not.toHaveProperty("stages");
    expect(JSON.stringify(compact).length).toBeLessThan(1_500);

    const full = await readOperationStatus(root, "AUDIT-THIN", "full");
    expect(full).toHaveProperty("payload");
    expect(JSON.stringify(full).length).toBeGreaterThan(JSON.stringify(compact).length * 5);
  });

  it("does not acknowledge on reads and requires an exact bound-lead ACK", async () => {
    const root = await tempRoot();
    await saveOperation(root, operation(root));
    let current = await bindOperationLead(root, "AUDIT-THIN", "lead-1", "test");
    const acknowledgedAtBind = current.lead?.acknowledgedRevision ?? 0;
    current = await setOperationStage(root, "AUDIT-THIN", "reviewing", "RUNNING");
    expect(current.revision).toBeGreaterThan(acknowledgedAtBind);

    await readOperationStatus(root, "AUDIT-THIN");
    await readOperationStatus(root, "AUDIT-THIN", "full");
    expect((await loadOperation(root, "AUDIT-THIN")).lead?.acknowledgedRevision).toBe(acknowledgedAtBind);

    await expect(acknowledgeOperationRevision(root, "AUDIT-THIN", current.revision, {
      PASEO_AGENT_ID: "worker-1",
      AEH_MANAGED_AGENT: "1",
      AEH_INTERACTIVE_LEAD: "0"
    })).rejects.toThrow("bound interactive lead");

    await expect(acknowledgeOperationRevision(root, "AUDIT-THIN", current.revision - 1, {
      PASEO_AGENT_ID: "lead-1",
      AEH_MANAGED_AGENT: "1",
      AEH_INTERACTIVE_LEAD: "1"
    })).rejects.toThrow("ACK_REVISION_MISMATCH");

    const ack = await acknowledgeOperationRevision(root, "AUDIT-THIN", current.revision, {
      PASEO_AGENT_ID: "lead-1",
      AEH_MANAGED_AGENT: "1",
      AEH_INTERACTIVE_LEAD: "1"
    });
    expect(ack).toEqual(expect.objectContaining({ acknowledgedRevision: current.revision, currentRevisionAcknowledged: true }));
  });

  it("does not duplicate large structured values into MCP text content", () => {
    const value = { operationId: "AUDIT-THIN", payload: "x".repeat(20_000) };
    const result = operationToolResult(value, "AUDIT-THIN diagnostic available in structuredContent.") as {
      content: Array<{ type: string; text: string }>;
      structuredContent: unknown;
    };
    expect(result.content[0].text.length).toBeLessThan(100);
    expect(result.content[0].text).not.toContain("xxxxxxxx");
    expect(result.structuredContent).toBe(value);
  });

  it("keeps completion wakes compact even when the durable result is large", () => {
    const current = operation("/repo");
    const terminal: OperationRecordV2 = {
      ...current,
      status: "SUCCEEDED",
      phase: "finished",
      revision: 42,
      result: { report: ".harness/audits/AUDIT-THIN.json", raw: "x".repeat(50_000) }
    };
    const prompt = completionPrompt(terminal);
    expect(prompt.length).toBeLessThan(1_500);
    expect(prompt).toContain(".harness/audits/AUDIT-THIN.json");
    expect(prompt).toContain("aeh_operation_ack");
    expect(prompt).toContain("revision 42");
    expect(prompt).not.toContain("xxxxxxxx");
  });

  it("builds a digest without copying request bodies or participant detail", () => {
    const digest = buildOperationDigest(operation("/repo"));
    expect(digest).toEqual(expect.objectContaining({
      operationId: "AUDIT-THIN",
      attention: "none",
      requiresLeadAction: false,
      progress: expect.objectContaining({ expected: 4, running: 4 })
    }));
    expect(digest).not.toHaveProperty("payload");
    expect(digest).not.toHaveProperty("participants");
  });
});
