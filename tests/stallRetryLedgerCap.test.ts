import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  executeAgentPrompt: vi.fn(),
  requireDurableChangeHandoff: vi.fn(),
  persistOpenSpecAuthoringContent: vi.fn(async () => ["proposal.md", "tasks.md"]),
  drainOperationWriters: vi.fn(async () => ({ quiescent: true })),
  operationControlCheckpoint: vi.fn(async () => undefined),
}));

vi.mock("../src/workers/agentPrompt.js", () => ({
  executeAgentPrompt: mocks.executeAgentPrompt,
}));

vi.mock("../src/operations/changeHandoff.js", () => ({
  requireDurableChangeHandoff: mocks.requireDurableChangeHandoff,
}));

vi.mock("../src/operations/control.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/operations/control.js")>();
  return { ...actual, drainOperationWriters: mocks.drainOperationWriters };
});

vi.mock("../src/operations/state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/operations/state.js")>();
  return { ...actual, operationControlCheckpoint: mocks.operationControlCheckpoint };
});

vi.mock("../src/spec/openspec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/spec/openspec.js")>();
  return { ...actual, persistOpenSpecAuthoringContentV1: mocks.persistOpenSpecAuthoringContent };
});

import { runSpecManagerUntilReady } from "../src/operations/change.js";
import {
  STALL_RETRY_MAX_ATTEMPTS_PER_PHASE,
  loadStallRetryStalls,
  recordStallRetryStall,
} from "../src/operations/stallRetryBudget.js";
import type { WorkerSession } from "../src/core/types.js";

async function specInput(operationId: string, controlRoot: string) {
  return {
    root: "/root",
    controlRoot,
    config: {},
    operationId,
    payload: { request: "Add FAREWELL export.", files: [], domains: [], risk: "low" },
    bootstrapContract: {
      version: 1,
      task: { id: "CHANGE-1", title: "t" },
      scope: { allowed: ["**"], forbidden: [], frozen: [] },
      routing: { intent: "change", domains: [], risk: "low", route: "FORMAL_SDD", assurance: "ELEVATED" },
      constraints: { breakingApiChanges: false, newDependencies: false, schemaChanges: false },
    },
    selection: { role: "Spec Manager", logicalAgent: "spec-manager", transport: "paseo" },
    changeName: "add-farewell",
    taskId: "CHANGE-1",
    title: "Add FAREWELL",
    triageReasons: ["formal"],
    inputs: [],
  } as never;
}

/** Ambiguous session: neither stall proof (no killReason/timeout/124) nor clean proof (exit != 0). */
function ambiguousSession(id: string): WorkerSession {
  return {
    id,
    exitCode: 1,
    stdout: "some output",
    stderr: "some failure",
    status: "failed",
    transport: "paseo-sdk",
  } as unknown as WorkerSession;
}

describe("RED: ledger cap enforcement (ru/ledger-cap-12)", () => {
  beforeEach(() => {
    mocks.executeAgentPrompt.mockReset();
    mocks.requireDurableChangeHandoff.mockReset();
    mocks.persistOpenSpecAuthoringContent.mockClear();
    mocks.persistOpenSpecAuthoringContent.mockResolvedValue(["proposal.md", "tasks.md"]);
  });

  it("RED-A: recordStallRetryStall refuses increment at/over cap (ledger NEVER exceeds 2)", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-ledger-cap-"));
    const operationId = "CAP-RED-A";
    expect(await recordStallRetryStall(controlRoot, operationId, "spec-manager")).toBe(1);
    expect(await recordStallRetryStall(controlRoot, operationId, "spec-manager")).toBe(2);
    // Third increment must refuse with phase EXHAUSTED, no increment.
    await expect(recordStallRetryStall(controlRoot, operationId, "spec-manager")).rejects.toThrow(
      /SPEC_MANAGER_STALL_BUDGET_EXHAUSTED/,
    );
    expect(await loadStallRetryStalls(controlRoot, operationId, "spec-manager")).toBe(
      STALL_RETRY_MAX_ATTEMPTS_PER_PHASE,
    );
  });

  it("RED-B: same-invocation incomplete retry exits with EXHAUSTED once ledger hits cap (no 2nd attempt)", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-ledger-cap-"));
    const operationId = "CAP-RED-B";
    // Pre-fill ledger to cap-1: one stall already consumed by a prior drive.
    expect(await recordStallRetryStall(controlRoot, operationId, "spec-manager")).toBe(1);

    // Every attempt fails ambiguous (counts) with an incomplete-retryable error.
    mocks.executeAgentPrompt
      .mockResolvedValueOnce(ambiguousSession("amb-1"))
      .mockResolvedValueOnce(ambiguousSession("amb-2"));
    mocks.requireDurableChangeHandoff
      .mockRejectedValueOnce(new Error("SPEC_MANAGER_INCOMPLETE_RESULT: READY missing tasks"))
      .mockRejectedValueOnce(new Error("SPEC_MANAGER_INCOMPLETE_RESULT: READY missing tasks"));

    await expect(runSpecManagerUntilReady(await specInput(operationId, controlRoot))).rejects.toThrow(
      /SPEC_MANAGER_STALL_BUDGET_EXHAUSTED/,
    );
    // Loop must exit BEFORE the 2nd attempt once the ledger hits its limit.
    expect(mocks.executeAgentPrompt).toHaveBeenCalledTimes(1);
    // Single invariant: ledger count NEVER exceeds cap.
    expect(await loadStallRetryStalls(controlRoot, operationId, "spec-manager")).toBe(
      STALL_RETRY_MAX_ATTEMPTS_PER_PHASE,
    );
  });
});
