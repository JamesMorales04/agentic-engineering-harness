import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ContextBudgetGateway } from "../../src/context/gateway.js";
import { authorizeRetrieval } from "../../src/context/retrieval/authorization.js";
import { ContextRetrievalGateway } from "../../src/context/retrieval/gateway.js";
import { notifyOperationCompletion, registerOperationCompletionTarget } from "../../src/operations/completion.js";
import { acknowledgeOperationLead, loadOperation, markTerminalDelivered, patchOperationMetadata, registerOperationAgent, registerSupervisorGeneration, saveOperation, transitionOperationToTerminal, updateSupervisorGeneration, type OperationRecord } from "../../src/operations/state.js";

const config = { version: 1 as const, project: { name: "concurrency-campaign" }, telemetry: { enabled: false }, context: { mode: "enforce" as const, compression: { provider: "none" as const }, retrieval: { maxRequestsPerTurn: 4, maxTokensPerRequest: 100, maxTotalTokensPerTurn: 400 } } };

function operation(root: string, id: string, status: "QUEUED" | "RUNNING" = "RUNNING"): OperationRecord {
  const now = new Date(0).toISOString();
  return { version: 2, id, kind: "run", status, phase: status.toLowerCase(), root, payload: { taskId: `TASK-${id}` }, revision: 1, createdAt: now, updatedAt: now, lastProgressAt: now, supervision: { required: false, materialized: false, generations: [] }, stages: {}, participants: {}, progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 }, notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 } };
}

function barrier(count: number): { wait: () => Promise<void>; release: () => void } {
  let arrived = 0;
  let open!: () => void;
  const released = new Promise<void>((resolve) => { open = resolve; });
  return { wait: async () => { arrived += 1; if (arrived === count) open(); await released; }, release: open };
}

async function tempRoot(prefix: string): Promise<string> { return fs.mkdtemp(path.join(os.tmpdir(), prefix)); }
async function cleanup(root: string): Promise<void> { await fs.rm(root, { recursive: true, force: true }); }

describe("AEH deterministic concurrency campaign", () => {
  it("serializes competing terminal transitions", async () => {
    const root = await tempRoot("aeh-concurrency-terminal-");
    try {
      await saveOperation(root, operation(root, "TERMINAL-RACE"));
      const gate = barrier(4);
      const outcomes = await Promise.all((["SUCCEEDED", "FAILED", "CANCELLED", "SUCCEEDED"] as const).map(async (status) => { await gate.wait(); return transitionOperationToTerminal(root, "TERMINAL-RACE", { status, phase: status.toLowerCase() }); }));
      const final = await loadOperation(root, "TERMINAL-RACE");
      expect(outcomes.filter((outcome) => outcome.transitioned)).toHaveLength(1);
      expect(["SUCCEEDED", "FAILED", "CANCELLED"]).toContain(final.status);
      expect(final.phase).toBe(final.status.toLowerCase());
    } finally { await cleanup(root); }
  });

  it("preserves every participant registration under concurrent writers", async () => {
    const root = await tempRoot("aeh-concurrency-participants-");
    try {
      await saveOperation(root, operation(root, "PARTICIPANTS"));
      const gate = barrier(8);
      await Promise.all(Array.from({ length: 8 }, (_, index) => (async () => { await gate.wait(); return registerOperationAgent(root, "PARTICIPANTS", { id: `agent-${index}`, role: "reviewer", phase: "review", transport: "direct" }); })()));
      const final = await loadOperation(root, "PARTICIPANTS");
      expect(Object.keys(final.participants)).toHaveLength(8);
      expect(final.progress.registered).toBe(8);
      expect(final.revision).toBe(9);
    } finally { await cleanup(root); }
  });

  it("delivers one completion callback when eight callers race", async () => {
    const root = await tempRoot("aeh-concurrency-completion-");
    try {
      const record = operation(root, "COMPLETION-RACE", "RUNNING"); await saveOperation(root, record); await registerOperationCompletionTarget(root, record.id, "lead", "test", async () => undefined);
      const gate = barrier(8); let dispatchCalls = 0; let releaseDispatch!: () => void; const dispatchReleased = new Promise<void>((resolve) => { releaseDispatch = resolve; });
      const dispatch = async () => { dispatchCalls += 1; if (dispatchCalls === 1) await dispatchReleased; return { exitCode: 0, stdout: "", stderr: "", transport: "sdk" as const }; };
      const calls = Array.from({ length: 8 }, () => (async () => { await gate.wait(); return notifyOperationCompletion(root, record, { dispatch, trace: async () => undefined, retryDelaysMs: [0], sleep: async () => undefined }); })());
      while (dispatchCalls === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      releaseDispatch(); await Promise.all(calls);
      expect(dispatchCalls).toBe(1);
      expect((await loadOperation(root, record.id)).notification.terminalDelivered).toBe(true);
    } finally { await cleanup(root); }
  });

  it("keeps same-content concurrent context persistence byte exact", async () => {
    const root = await tempRoot("aeh-concurrency-context-");
    try {
      const gate = barrier(8); const content = "normative bytes\nline two\n";
      const results = await Promise.all(Array.from({ length: 8 }, (_, index) => (async () => { await gate.wait(); return new ContextBudgetGateway(root, config, { telemetry: false }).prepare({ operationId: "CONTEXT-RACE", logicalAgent: `agent-${index}`, phase: "review", fragments: [{ id: "shared", kind: "normative", preservation: "VERBATIM", priority: 100, content }] }); })()));
      expect(results).toHaveLength(8); expect(results.every((result) => result.envelope.fragments[0]?.content === content)).toBe(true); expect(await fs.readFile(path.join(root, ".harness", "context", "CONTEXT-RACE", "shared.raw"), "utf8")).toBe(content);
    } finally { await cleanup(root); }
  });

  it("rejects every concurrent unauthorized retrieval without consuming budget", async () => {
    const root = await tempRoot("aeh-concurrency-retrieval-");
    try {
      await fs.mkdir(path.join(root, ".harness"), { recursive: true }); await fs.writeFile(path.join(root, ".harness", "other.raw"), "other\n");
      const gateway = new ContextRetrievalGateway(authorizeRetrieval({ root, operationId: "RETRIEVAL-RACE", logicalAgent: "reviewer", allowedFragmentIds: ["own"], fragments: [{ id: "own", kind: "raw-evidence", preservation: "RETRIEVABLE", priority: 1, content: "own", source: { artifact: ".harness/other.raw" } }, { id: "other", kind: "raw-evidence", preservation: "RETRIEVABLE", priority: 1, content: "other", source: { artifact: ".harness/other.raw" } }] }), { maxRequestsPerTurn: 8, maxTokensPerRequest: 100, maxTotalTokensPerTurn: 800 });
      const gate = barrier(8); const failures = await Promise.all(Array.from({ length: 8 }, () => (async () => { await gate.wait(); try { await gateway.retrieve({ fragmentId: "other" }); return false; } catch (error) { expect(String(error)).toContain("CONTEXT_RETRIEVAL_UNAUTHORIZED"); return true; } })()));
      expect(failures.every(Boolean)).toBe(true); expect(gateway.metrics.requests).toBe(0);
    } finally { await cleanup(root); }
  });

  it("keeps supervisor replacement structurally single-active under a late update", async () => {
    const root = await tempRoot("aeh-concurrency-supervisor-");
    try {
      await saveOperation(root, operation(root, "SUPERVISOR-RACE")); const first = await registerSupervisorGeneration(root, "SUPERVISOR-RACE", { agentId: "supervisor-1", materialized: true }); const generation = first.supervision.generations[0]!.generation; const gate = barrier(2);
      await Promise.all([ (async () => { await gate.wait(); return registerSupervisorGeneration(root, "SUPERVISOR-RACE", { agentId: "supervisor-2", materialized: true }); })(), (async () => { await gate.wait(); return updateSupervisorGeneration(root, "SUPERVISOR-RACE", generation, { status: "FAILED", error: "late old generation" }); })() ]);
      const final = await loadOperation(root, "SUPERVISOR-RACE");
      expect(final.supervision.generations.filter((item) => item.status === "ACTIVE")).toHaveLength(1);
      expect(final.supervision.activeGeneration).toBe(final.supervision.generations.find((item) => item.status === "ACTIVE")?.generation);
    } finally { await cleanup(root); }
  });

  it("keeps terminal truth when completion metadata races terminalization", async () => {
    const root = await tempRoot("aeh-concurrency-terminal-completion-");
    try {
      const record = operation(root, "TERMINAL-COMPLETION"); await saveOperation(root, record); await registerOperationCompletionTarget(root, record.id, "lead", "test", async () => undefined); const gate = barrier(2);
      await Promise.all([ (async () => { await gate.wait(); return transitionOperationToTerminal(root, record.id, { status: "SUCCEEDED", phase: "finished" }); })(), (async () => { await gate.wait(); return notifyOperationCompletion(root, record, { dispatch: async () => ({ exitCode: 0, stdout: "", stderr: "", transport: "sdk" as const }), trace: async () => undefined, retryDelaysMs: [0], sleep: async () => undefined }); })() ]);
      const final = await loadOperation(root, record.id); expect(final.status).toBe("SUCCEEDED"); expect(final.finishedAt).toBeDefined();
    } finally { await cleanup(root); }
  });

  it("keeps lead acknowledgement monotonic under concurrent wake consumers", async () => {
    const root = await tempRoot("aeh-concurrency-ack-");
    try {
      await saveOperation(root, operation(root, "ACK-RACE")); const gate = barrier(8);
      await Promise.all(Array.from({ length: 8 }, (_, index) => (async () => { await gate.wait(); return patchOperationMetadata(root, "ACK-RACE", { lead: { agentId: "lead", generation: 1, boundAt: new Date(0).toISOString(), acknowledgedRevision: index + 1 }, notification: { lastLeadWakeRevision: index + 1, terminalDelivered: false, attempts: 0 } }); })()));
      const final = await loadOperation(root, "ACK-RACE"); expect(final.revision).toBe(1); expect(final.lead?.acknowledgedRevision).toBeGreaterThanOrEqual(1); expect(final.notification.lastLeadWakeRevision).toBeGreaterThanOrEqual(1);
    } finally { await cleanup(root); }
  });

  it("keeps terminal delivery durable under duplicate finalization calls", async () => {
    const root = await tempRoot("aeh-concurrency-delivery-");
    try {
      const record = operation(root, "DELIVERY-RACE", "RUNNING"); await saveOperation(root, record); await transitionOperationToTerminal(root, record.id, { status: "FAILED", phase: "failed" }); const gate = barrier(8);
      await Promise.all(Array.from({ length: 8 }, (_, index) => (async () => { await gate.wait(); return markTerminalDelivered(root, record.id, index + 1); })()));
      const final = await loadOperation(root, record.id); expect(final.status).toBe("FAILED"); expect(final.notification.terminalDelivered).toBe(true); expect(final.notification.lastLeadWakeRevision).toBe(final.revision);
    } finally { await cleanup(root); }
  });
});
