import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  executeAgentPrompt: vi.fn(),
  requireDurableChangeHandoff: vi.fn(),
  drainOperationWriters: vi.fn(async () => ({ quiescent: true })),
  operationControlCheckpoint: vi.fn(async () => undefined),
}));

vi.mock("../src/workers/agentPrompt.js", () => ({
  executeAgentPrompt: mocks.executeAgentPrompt,
}));

vi.mock("../src/operations/changeHandoff.js", () => ({
  requireDurableChangeHandoff: mocks.requireDurableChangeHandoff,
}));

vi.mock("../src/paseo/launchSpec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/paseo/launchSpec.js")>();
  return {
    ...actual,
    projectedAuthorizedReadRoots: vi.fn(async () => []),
  };
});

vi.mock("../src/operations/control.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/operations/control.js")>();
  return { ...actual, drainOperationWriters: mocks.drainOperationWriters };
});

vi.mock("../src/operations/state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/operations/state.js")>();
  return { ...actual, operationControlCheckpoint: mocks.operationControlCheckpoint };
});

// Crash oracle: the process dies after the counted agent attempt ran but
// before recordStallRetryStall durably lands. The production record is
// replaced with a crash so no post-attempt accounting can run.
vi.mock("../src/operations/stallRetryBudget.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/operations/stallRetryBudget.js")>();
  return {
    ...actual,
    recordStallRetryStall: vi.fn(async () => {
      throw new Error("SIMULATED_CRASH: process died after attempt before record");
    }),
  };
});

import { runDiscovery } from "../src/operations/change.js";
import { loadStallRetryStalls } from "../src/operations/stallRetryBudget.js";
import { stalledFirstActivityError } from "../src/paseo/firstActivityDeadline.js";
import type { TaskContract, WorkerSession } from "../src/core/types.js";

/**
 * RED for Luna B1 crash window (round 6): without a pre-claim before the
 * counted attempt, a crash after the attempt but before record leaves nothing
 * and a fresh invocation regains budget. With the fix, the pre-claim marker
 * is already durable when the attempt runs, so the fresh invocation refuses
 * EXHAUSTED instead of restarting at zero.
 */
const contract = {
  version: 1,
  task: { id: "CHANGE-STALL-CRASH-1", title: "t" },
  scope: { allowed: ["**"], forbidden: [], frozen: [] },
  routing: { intent: "implement", domains: [], risk: "low", route: "FORMAL_SDD", assurance: "ELEVATED" },
  constraints: { breakingApiChanges: false, newDependencies: false, schemaChanges: false },
  requirements: [],
} as unknown as TaskContract;

const selection = { role: "Explorer", logicalAgent: "explorer", transport: "paseo" } as never;
const payload = { request: "Add the FAREWELL export.", files: [], domains: [], risk: "low" } as never;

function stallSession(id: string): WorkerSession {
  return {
    id,
    exitCode: 124,
    stdout: "",
    stderr: stalledFirstActivityError(1_500_000, 1_800_000, { updatesObserved: 0, toolEvents: 0, assistantDelta: false }),
    killReason: "STALLED_FIRST_ACTIVITY",
    status: "timeout",
    transport: "paseo-sdk",
  } as unknown as WorkerSession;
}

describe("stall-retry crash-after-attempt-before-record (Luna B1)", () => {
  beforeEach(() => {
    mocks.executeAgentPrompt.mockReset();
    mocks.requireDurableChangeHandoff.mockReset();
  });

  it("crash after a counted attempt leaves a durable claim: fresh invocation refuses EXHAUSTED, never zero", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-crash-"));
    const operationId = "CRASH-1";
    try {
      mocks.executeAgentPrompt.mockResolvedValue(stallSession("stall-1"));
      mocks.requireDurableChangeHandoff.mockRejectedValue(
        new Error("EXPLORER_FAILED: STALLED_FIRST_ACTIVITY: zero activity"),
      );
      // The counted attempt ran (agent executed) then the process died before
      // any post-attempt accounting could land.
      await expect(
        runDiscovery("/root", controlRoot, {} as never, contract, selection, operationId, payload, []),
      ).rejects.toThrow(/SIMULATED_CRASH/);
      expect(mocks.executeAgentPrompt).toHaveBeenCalledTimes(1);
      // Fresh invocation must NOT restart at zero: the pre-claim survived the
      // crash and fails closed as EXHAUSTED.
      await expect(loadStallRetryStalls(controlRoot, operationId, "discovery")).rejects.toThrow(
        /EXPLORER_STALL_BUDGET_EXHAUSTED/,
      );
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });
});
