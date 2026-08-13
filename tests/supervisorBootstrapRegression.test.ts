import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const workers = vi.hoisted(() => ({
  materializeAgentPrompt: vi.fn(),
  dispatchMaterializedAgentPrompt: vi.fn(),
  executeAgentPrompt: vi.fn()
}));
vi.mock("../src/workers/agentPrompt.js", () => workers);

import { ensureOperationSupervisor, operationSupervisorInitializationTimeoutSeconds } from "../src/operations/supervisor.js";
import { activeOperationSupervisor, bindOperationLead, initializingOperationSupervisor, loadOperation, saveOperation, type OperationRecordV2 } from "../src/operations/state.js";

let root = "";
const originalEnv = snapshotEnv(["AEH_OPERATION_ID", "AEH_CONTROL_ROOT", "AEH_PARENT_OPERATION_ID"]);
beforeEach(() => clearEnv(Object.keys(originalEnv)));
afterEach(async () => {
  restoreEnv(originalEnv);
  workers.materializeAgentPrompt.mockReset();
  workers.dispatchMaterializedAgentPrompt.mockReset();
  workers.executeAgentPrompt.mockReset();
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = "";
});

const config = { version: 1, project: { name: "demo" }, orchestration: { provider: "paseo" } } as never;
const contract = { task: { id: "AUDIT-BOOT" }, routing: { intent: "audit" } } as never;
const topology = {
  profile: "test",
  routing: [],
  agents: {
    "operation-supervisor": {
      name: "operation-supervisor",
      role: "supervisor",
      runtime: { name: "opencode", adapter: "opencode", paseoProvider: "opencode", defaultArgs: [], capabilities: {} },
      model: { alias: "test", id: "test/supervisor", model: "supervisor", provider: "test" },
      execution: { transport: "paseo" },
      permissions: {},
      skills: ["finding-dedup", "acceptance-traceability", "recovery-classifier", "verification-planning"],
      mcps: []
    }
  }
} as never;

describe("supervisor bootstrap regression", () => {
  it("persists INITIALIZING before a compact skill-free turn barrier and activates only afterwards", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-supervisor-bootstrap-"));
    const now = new Date().toISOString();
    const record: OperationRecordV2 = {
      version: 2, id: "AUDIT-BOOT", kind: "audit", status: "RUNNING", phase: "supervision", root,
      payload: { request: "VERY_LONG_USER_INTENT_MUST_NOT_APPEAR_IN_INIT" }, revision: 1, createdAt: now, updatedAt: now, lastProgressAt: now,
      supervision: { required: true, materialized: false, generations: [] }, stages: {}, participants: {},
      progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
      notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 }
    };
    await saveOperation(root, record);
    await bindOperationLead(root, record.id, "lead-1", "test");
    process.env.AEH_OPERATION_ID = "AUDIT-BOOT";
    process.env.AEH_CONTROL_ROOT = root;

    workers.materializeAgentPrompt.mockResolvedValue({ id: "supervisor-1", exitCode: 0, stdout: "", stderr: "", status: "idle", transport: "paseo-sdk" });
    workers.dispatchMaterializedAgentPrompt.mockImplementation(async (_root, effectiveConfig, _contract, selection, _materialized, prompt, options) => {
      const durable = await loadOperation(root, "AUDIT-BOOT");
      expect(durable.supervision.materialized).toBe(true);
      expect(durable.supervision.activeGeneration).toBeUndefined();
      expect(activeOperationSupervisor(durable)).toBeUndefined();
      expect(initializingOperationSupervisor(durable)).toEqual(expect.objectContaining({
        generation: 1,
        agentId: "supervisor-1",
        status: "INITIALIZING",
        initializationAttempt: 1,
        initializationDispatchedAt: expect.any(String)
      }));
      expect(effectiveConfig.orchestration.worker.timeoutSeconds).toBe(60);
      expect(selection.skills).toEqual([]);
      expect(String(prompt)).toContain("[AEH_SUPERVISOR_INITIALIZE]");
      expect(String(prompt)).toContain("session-readiness turn barrier");
      expect(String(prompt)).not.toContain("VERY_LONG_USER_INTENT_MUST_NOT_APPEAR_IN_INIT");
      expect(String(prompt)).not.toContain("OperationRecord snapshot");
      expect(String(prompt).length).toBeLessThan(700);
      expect(options.parentAgentId).toBeUndefined();
      return { id: "supervisor-1", exitCode: 0, stdout: "initialized", stderr: "", status: "idle", transport: "paseo-sdk" };
    });

    const handle = await ensureOperationSupervisor(root, config, contract, topology, { required: true, forceMaterialize: true });
    expect(handle?.agentId).toBe("supervisor-1");
    expect(workers.materializeAgentPrompt.mock.calls[0]?.[4]).toEqual(expect.objectContaining({ parentAgentId: "lead-1" }));
    const durable = await loadOperation(root, "AUDIT-BOOT");
    expect(activeOperationSupervisor(durable)).toEqual(expect.objectContaining({
      generation: 1,
      agentId: "supervisor-1",
      status: "ACTIVE",
      initializationCompletedAt: expect.any(String),
      initializationEvidence: "paseo-sdk-turn-barrier"
    }));
    expect(initializingOperationSupervisor(durable)).toBeUndefined();
    expect(workers.executeAgentPrompt).not.toHaveBeenCalled();
  });

  it("uses a bounded supervisor initialization timeout", () => {
    expect(operationSupervisorInitializationTimeoutSeconds(config)).toBe(60);
    expect(operationSupervisorInitializationTimeoutSeconds({
      ...config,
      orchestration: { provider: "paseo", operations: { supervision: { initializationTimeoutSeconds: 25 } } }
    } as never)).toBe(25);
  });
});

function snapshotEnv(names: string[]): Record<string, string | undefined> {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}
function clearEnv(names: string[]): void {
  for (const name of names) delete process.env[name];
}
function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
