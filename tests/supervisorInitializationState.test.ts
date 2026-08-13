import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeOperationSupervisor,
  initializingOperationSupervisor,
  registerSupervisorGeneration,
  saveOperation,
  updateSupervisorGeneration,
  type OperationRecordV2
} from "../src/operations/state.js";

let root = "";
afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = "";
});

describe("supervisor initialization state", () => {
  it("does not expose a generation as active until initialization completes", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-supervisor-init-state-"));
    const now = new Date().toISOString();
    const operation: OperationRecordV2 = {
      version: 2,
      id: "AUDIT-INIT",
      kind: "audit",
      status: "RUNNING",
      phase: "supervision",
      root,
      payload: { request: "review" },
      revision: 1,
      createdAt: now,
      updatedAt: now,
      lastProgressAt: now,
      supervision: { required: true, materialized: false, generations: [] },
      stages: {},
      participants: {},
      progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
      notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 }
    };
    await saveOperation(root, operation);

    let current = await registerSupervisorGeneration(root, operation.id, {
      agentId: "supervisor-1",
      materialized: true,
      status: "INITIALIZING",
      initializationAttempt: 1
    });
    expect(activeOperationSupervisor(current)).toBeUndefined();
    expect(current.supervision.activeGeneration).toBeUndefined();
    expect(initializingOperationSupervisor(current)?.agentId).toBe("supervisor-1");

    const completedAt = new Date().toISOString();
    current = await updateSupervisorGeneration(root, operation.id, 1, {
      status: "ACTIVE",
      activatedAt: completedAt,
      initializationCompletedAt: completedAt,
      initializationEvidence: "paseo-sdk-turn-barrier"
    });
    expect(initializingOperationSupervisor(current)).toBeUndefined();
    expect(current.supervision.activeGeneration).toBe(1);
    expect(activeOperationSupervisor(current)).toEqual(expect.objectContaining({
      agentId: "supervisor-1",
      status: "ACTIVE",
      initializationEvidence: "paseo-sdk-turn-barrier"
    }));
  });
});
