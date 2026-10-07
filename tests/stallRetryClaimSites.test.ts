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

vi.mock("../src/spec/openspec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/spec/openspec.js")>();
  return { ...actual, persistOpenSpecAuthoringContentV1: mocks.persistOpenSpecAuthoringContent };
});

import { runDiscovery, runPlanning, runSpecManagerUntilReady } from "../src/operations/change.js";
import { loadStallRetryStalls, stallRetryPendingFile } from "../src/operations/stallRetryBudget.js";
import { stalledFirstActivityError } from "../src/paseo/firstActivityDeadline.js";
import type { TaskContract, WorkerSession } from "../src/core/types.js";

/**
 * RED for Luna B1 (round 6): no production caller uses claimStallRetryAttempt
 * before attempts — change.ts discovery (~L721-735) loads count, runs the
 * agent, then records after the stall. A crash after a counted attempt but
 * before record leaves nothing, so a fresh invocation regains budget.
 *
 * Expected post-fix contract: every call site that consumes budget claims
 * BEFORE running the counted agent attempt (discovery, planning,
 * spec-manager here; consolidation in the supervisor suite below via the same
 * ledger), and reconciles (clears/supersedes) on completion.
 */
const contract = {
  version: 1,
  task: { id: "CHANGE-STALL-CLAIMSITE-1", title: "t" },
  scope: { allowed: ["**"], forbidden: [], frozen: [] },
  routing: { intent: "implement", domains: [], risk: "low", route: "FORMAL_SDD", assurance: "ELEVATED" },
  constraints: { breakingApiChanges: false, newDependencies: false, schemaChanges: false },
  requirements: [],
} as unknown as TaskContract;

const selection = { role: "Explorer", logicalAgent: "explorer", transport: "paseo" } as never;
const plannerSelection = { role: "Planner", logicalAgent: "planner", transport: "paseo" } as never;
const payload = { request: "Add the FAREWELL export.", files: [], domains: [], risk: "low" } as never;

const specInputBase = {
  root: "/root",
  config: {},
  operationId: "CHANGE-CLAIMSITE-SPEC-1",
  payload: { request: "Add FAREWELL export.", files: [], domains: [], risk: "low" },
  bootstrapContract: {
    version: 1,
    task: { id: "CHANGE-CLAIMSITE-SPEC-1", title: "t" },
    scope: { allowed: ["**"], forbidden: [], frozen: [] },
    routing: { intent: "change", domains: [], risk: "low", route: "FORMAL_SDD", assurance: "ELEVATED" },
    constraints: { breakingApiChanges: false, newDependencies: false, schemaChanges: false },
  },
  selection: { role: "Spec Manager", logicalAgent: "spec-manager", transport: "paseo" },
  changeName: "add-farewell",
  taskId: "CHANGE-CLAIMSITE-SPEC-1",
  title: "Add FAREWELL",
  triageReasons: ["formal"],
  inputs: [],
} as never;

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

function okSession(id: string): WorkerSession {
  return {
    id,
    exitCode: 0,
    stdout: "AEH_RESULT_JSON={}",
    stderr: "",
    status: "idle",
    transport: "paseo-sdk",
    activityCounts: { updatesObserved: 3, toolEvents: 1, assistantDelta: true },
  } as unknown as WorkerSession;
}

async function markerExists(controlRoot: string, operationId: string, phase: "discovery" | "planning" | "spec-manager"): Promise<boolean> {
  try {
    await fs.stat(stallRetryPendingFile(controlRoot, operationId, phase));
    return true;
  } catch {
    return false;
  }
}

describe("stall-retry claim-before-attempt (Luna B1)", () => {
  beforeEach(() => {
    mocks.executeAgentPrompt.mockReset();
    mocks.requireDurableChangeHandoff.mockReset();
    mocks.persistOpenSpecAuthoringContent.mockClear();
    mocks.persistOpenSpecAuthoringContent.mockResolvedValue(["proposal.md", "tasks.md"]);
  });

  it("discovery claims BEFORE running the counted agent attempt", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-claimsite-"));
    const operationId = "CLAIMSITE-DISC-1";
    const seen: boolean[] = [];
    try {
      mocks.executeAgentPrompt.mockImplementation(async () => {
        seen.push(await markerExists(controlRoot, operationId, "discovery"));
        return stallSession(`stall-${seen.length}`);
      });
      mocks.requireDurableChangeHandoff.mockRejectedValue(
        new Error("EXPLORER_FAILED: STALLED_FIRST_ACTIVITY: zero activity"),
      );
      await expect(
        runDiscovery("/root", controlRoot, {} as never, contract, selection, operationId, payload, []),
      ).rejects.toThrow(/STALLED_FIRST_ACTIVITY/);
      expect(mocks.executeAgentPrompt).toHaveBeenCalledTimes(2);
      // No attempt runs unclaimed: the marker must already be durable on every
      // counted attempt, including the first and the retry.
      expect(seen).toEqual([true, true]);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("planning claims BEFORE running the counted agent attempt", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-claimsite-"));
    const operationId = "CLAIMSITE-PLAN-1";
    const seen: boolean[] = [];
    try {
      mocks.executeAgentPrompt.mockImplementation(async () => {
        seen.push(await markerExists(controlRoot, operationId, "planning"));
        return stallSession(`stall-${seen.length}`);
      });
      mocks.requireDurableChangeHandoff.mockRejectedValue(
        new Error("PLANNER_FAILED: STALLED_FIRST_ACTIVITY: zero activity"),
      );
      await expect(
        runPlanning("/root", controlRoot, {} as never, contract, plannerSelection, operationId, payload, undefined, []),
      ).rejects.toThrow(/STALLED_FIRST_ACTIVITY/);
      expect(mocks.executeAgentPrompt).toHaveBeenCalledTimes(2);
      expect(seen).toEqual([true, true]);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("spec-manager claims BEFORE running the counted agent attempt", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-claimsite-"));
    const operationId = "CLAIMSITE-SPEC-1";
    const seen: boolean[] = [];
    try {
      mocks.executeAgentPrompt.mockImplementation(async () => {
        seen.push(await markerExists(controlRoot, operationId, "spec-manager"));
        return stallSession(`stall-${seen.length}`);
      });
      mocks.requireDurableChangeHandoff.mockRejectedValue(
        new Error("SPEC_MANAGER_FAILED: STALLED_FIRST_ACTIVITY: zero activity"),
      );
      await expect(runSpecManagerUntilReady({ ...specInputBase, controlRoot, operationId } as never)).rejects.toThrow(
        /STALLED_FIRST_ACTIVITY/,
      );
      expect(mocks.executeAgentPrompt).toHaveBeenCalledTimes(2);
      expect(seen).toEqual([true, true]);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("discovery success reconciles the claim without consuming budget", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-claimsite-"));
    const operationId = "CLAIMSITE-DISC-OK";
    try {
      mocks.executeAgentPrompt.mockResolvedValue(okSession("ok-1"));
      mocks.requireDurableChangeHandoff.mockResolvedValue({ artifact: "a", sha256: "b", payload: {} });
      await runDiscovery("/root", controlRoot, {} as never, contract, selection, operationId, payload, []);
      await expect(fs.stat(stallRetryPendingFile(controlRoot, operationId, "discovery"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(0);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("discovery non-stall failure reconciles the claim without consuming budget", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-claimsite-"));
    const operationId = "CLAIMSITE-DISC-NONSTALL";
    try {
      mocks.executeAgentPrompt.mockResolvedValue(okSession("ok-1"));
      mocks.requireDurableChangeHandoff.mockRejectedValue(new Error("EXPLORER_RESULT_INVALID: schema rejected"));
      await expect(
        runDiscovery("/root", controlRoot, {} as never, contract, selection, operationId, payload, []),
      ).rejects.toThrow(/EXPLORER_RESULT_INVALID/);
      await expect(fs.stat(stallRetryPendingFile(controlRoot, operationId, "discovery"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(0);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });
});
