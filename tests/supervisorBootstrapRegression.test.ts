import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const workers = vi.hoisted(() => ({
  materializeAgentPrompt: vi.fn(),
  dispatchMaterializedAgentPrompt: vi.fn(),
  executeAgentPrompt: vi.fn()
}));
vi.mock("../src/workers/agentPrompt.js", () => workers);

import { ensureOperationSupervisor } from "../src/operations/supervisor.js";
import { loadOperation, saveOperation, type OperationRecordV2 } from "../src/operations/state.js";

let root = "";
afterEach(async () => {
  delete process.env.AEH_OPERATION_ID;
  delete process.env.AEH_CONTROL_ROOT;
  workers.materializeAgentPrompt.mockReset();
  workers.dispatchMaterializedAgentPrompt.mockReset();
  workers.executeAgentPrompt.mockReset();
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = "";
});

const config = { version: 1, project: { name: "demo" }, orchestration: { provider: "paseo" } } as never;
const contract = { task: { id: "AUDIT-BOOT" } } as never;
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
      permissions: {}, skills: [], mcps: []
    }
  }
} as never;

describe("supervisor bootstrap regression", () => {
  it("persists the provider agent id before the initialization turn is dispatched", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-supervisor-bootstrap-"));
    const now = new Date().toISOString();
    const record: OperationRecordV2 = {
      version: 2, id: "AUDIT-BOOT", kind: "audit", status: "RUNNING", phase: "supervision", root,
      payload: { request: "audit" }, revision: 1, createdAt: now, updatedAt: now, lastProgressAt: now,
      supervision: { required: true, materialized: false, generations: [] }, stages: {}, participants: {},
      progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
      notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 }
    };
    await saveOperation(root, record);
    process.env.AEH_OPERATION_ID = "AUDIT-BOOT";
    process.env.AEH_CONTROL_ROOT = root;

    workers.materializeAgentPrompt.mockResolvedValue({ id: "supervisor-1", exitCode: 0, stdout: "", stderr: "", status: "idle", transport: "paseo-sdk" });
    workers.dispatchMaterializedAgentPrompt.mockImplementation(async () => {
      const durable = await loadOperation(root, "AUDIT-BOOT");
      expect(durable.supervision.materialized).toBe(true);
      expect(durable.supervision.activeGeneration).toBe(1);
      expect(durable.supervision.generations[0]).toEqual(expect.objectContaining({ agentId: "supervisor-1", status: "ACTIVE" }));
      return { id: "supervisor-1", exitCode: 0, stdout: "initialized", stderr: "", status: "idle", transport: "paseo-sdk" };
    });

    const handle = await ensureOperationSupervisor(root, config, contract, topology, { required: true, forceMaterialize: true });
    expect(handle?.agentId).toBe("supervisor-1");
    expect(workers.executeAgentPrompt).not.toHaveBeenCalled();
  });
});
