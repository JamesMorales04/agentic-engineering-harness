import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  executeAgentPrompt: vi.fn(),
  requireDurableChangeHandoff: vi.fn(),
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

import {
  runDiscovery,
  runPlanning,
  isDiscoveryPlanningStallKill,
  shouldRetryDiscoveryPlanningStall,
  DISCOVERY_PLANNING_STALL_MAX_ATTEMPTS,
  DISCOVERY_PLANNING_STALL_MAX_RETRIES,
} from "../src/operations/change.js";
import { stalledFirstActivityError } from "../src/paseo/firstActivityDeadline.js";
import type { TaskContract, WorkerSession } from "../src/core/types.js";

/** Fail-closed ledger needs a real writable control root per test (never a shared fake). */
async function freshControlRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-migrate-"));
}

const contract = {
  version: 1,
  task: { id: "CHANGE-TEST-1", title: "t" },
  scope: { allowed: ["**"], forbidden: [], frozen: [] },
  routing: { intent: "implement", domains: [], risk: "low", route: "FORMAL_SDD", assurance: "ELEVATED" },
  constraints: { breakingApiChanges: false, newDependencies: false, schemaChanges: false },
  requirements: [],
} as unknown as TaskContract;

const selection = {
  role: "Explorer",
  logicalAgent: "explorer",
  transport: "paseo",
} as never;

const plannerSelection = {
  role: "Planner",
  logicalAgent: "planner",
  transport: "paseo",
} as never;

const payload = {
  request: "Add the FAREWELL export.",
  files: [],
  domains: [],
  risk: "low",
} as never;

function stallSession(id: string): WorkerSession {
  return {
    id,
    exitCode: 124,
    stdout: "",
    stderr: stalledFirstActivityError(1_500_000, 1_800_000, {
      updatesObserved: 0,
      toolEvents: 0,
      assistantDelta: false,
    }),
    killReason: "STALLED_FIRST_ACTIVITY",
    status: "timeout",
    transport: "paseo-sdk",
  } as unknown as WorkerSession;
}

function timeoutSession(id: string): WorkerSession {
  return {
    id,
    exitCode: 124,
    stdout: "",
    stderr: "provider turn deadline expired after 1800000ms (timeout)",
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
  } as unknown as WorkerSession;
}

describe("discovery/planning stall-kill bounded retry", () => {
  beforeEach(() => {
    mocks.executeAgentPrompt.mockReset();
    mocks.requireDurableChangeHandoff.mockReset();
  });

  it("caps the retry budget at two attempts total (mirrors repair budget)", () => {
    expect(DISCOVERY_PLANNING_STALL_MAX_ATTEMPTS).toBe(2);
    expect(DISCOVERY_PLANNING_STALL_MAX_RETRIES).toBe(1);
  });

  it("classifies stall-kill and transport timeout as retryable, INVALID as terminal", () => {
    expect(isDiscoveryPlanningStallKill(new Error("EXPLORER_FAILED: STALLED_FIRST_ACTIVITY: zero activity"), stallSession("s1"))).toBe(true);
    expect(isDiscoveryPlanningStallKill(new Error("EXPLORER_FAILED: exit=124 timeout"), timeoutSession("s2"))).toBe(true);
    expect(
      isDiscoveryPlanningStallKill(
        new Error("EXPLORER_RESULT_INVALID: schema rejected payload"),
        okSession("s3"),
      ),
    ).toBe(false);
    expect(
      isDiscoveryPlanningStallKill(
        new Error("EXPLORER_RESULT_ARTIFACT_MISSING: no artifact"),
        okSession("s4"),
      ),
    ).toBe(false);
    expect(isDiscoveryPlanningStallKill(new Error("SOME_OTHER_FAILURE: boom"), okSession("s5"))).toBe(false);
    expect(shouldRetryDiscoveryPlanningStall(new Error("EXPLORER_FAILED: STALLED_FIRST_ACTIVITY"), 0, stallSession("s1"))).toBe(true);
    expect(shouldRetryDiscoveryPlanningStall(new Error("EXPLORER_FAILED: STALLED_FIRST_ACTIVITY"), 1, stallSession("s1"))).toBe(false);
    expect(shouldRetryDiscoveryPlanningStall(new Error("EXPLORER_RESULT_INVALID: bad"), 0, okSession("s3"))).toBe(false);
  });

  it("runDiscovery retries once with identical inputs after a stall-kill then succeeds", async () => {
    mocks.executeAgentPrompt
      .mockResolvedValueOnce(stallSession("stall-1"))
      .mockResolvedValueOnce(okSession("ok-2"));
    mocks.requireDurableChangeHandoff
      .mockRejectedValueOnce(new Error("EXPLORER_FAILED: STALLED_FIRST_ACTIVITY: zero activity"))
      .mockResolvedValueOnce({ payload: { version: 1 }, artifact: "a", sha256: "b" });
    const controlRoot = await freshControlRoot();
    const result = await runDiscovery("/root", controlRoot, {} as never, contract, selection, "CHANGE-DR1", payload, []);
    expect(result).toEqual({ payload: { version: 1 }, artifact: "a", sha256: "b" });
    expect(mocks.executeAgentPrompt).toHaveBeenCalledTimes(2);
    const firstPrompt = mocks.executeAgentPrompt.mock.calls[0]?.[4] as string;
    const secondPrompt = mocks.executeAgentPrompt.mock.calls[1]?.[4] as string;
    expect(secondPrompt).toBe(firstPrompt);
    expect(secondPrompt).toContain("AEH_RESULT_JSON=");
  });

  it("runDiscovery rethrows the original class after two consecutive kills", async () => {
    mocks.executeAgentPrompt
      .mockResolvedValueOnce(stallSession("stall-1"))
      .mockResolvedValueOnce(stallSession("stall-2"));
    mocks.requireDurableChangeHandoff
      .mockRejectedValueOnce(new Error("EXPLORER_FAILED: STALLED_FIRST_ACTIVITY: zero activity"))
      .mockRejectedValueOnce(new Error("EXPLORER_FAILED: STALLED_FIRST_ACTIVITY: zero activity"));
    await expect(
      runDiscovery("/root", await freshControlRoot(), {} as never, contract, selection, "CHANGE-DR2", payload, []),
    ).rejects.toThrow(/EXPLORER_FAILED/);
    expect(mocks.executeAgentPrompt).toHaveBeenCalledTimes(2);
  });

  it("runDiscovery does NOT retry INVALID payload rejections", async () => {
    mocks.executeAgentPrompt.mockResolvedValueOnce(okSession("ok-1"));
    mocks.requireDurableChangeHandoff.mockRejectedValueOnce(
      new Error("EXPLORER_RESULT_INVALID: schema rejected payload"),
    );
    await expect(
      runDiscovery("/root", await freshControlRoot(), {} as never, contract, selection, "CHANGE-DR2", payload, []),
    ).rejects.toThrow(/EXPLORER_RESULT_INVALID/);
    expect(mocks.executeAgentPrompt).toHaveBeenCalledTimes(1);
  });

  it("runPlanning retries once after a transport timeout then succeeds", async () => {
    mocks.executeAgentPrompt
      .mockResolvedValueOnce(timeoutSession("t-1"))
      .mockResolvedValueOnce(okSession("ok-2"));
    mocks.requireDurableChangeHandoff
      .mockRejectedValueOnce(new Error("PLANNER_FAILED: exit=124 timeout"))
      .mockResolvedValueOnce({ payload: { version: 1 }, artifact: "a", sha256: "b" });
    const result = await runPlanning(
      "/root",
      await freshControlRoot(),
      {} as never,
      contract,
      plannerSelection,
      "CHANGE-DR4",
      payload,
      undefined,
      [],
    );
    expect(result).toEqual({ payload: { version: 1 }, artifact: "a", sha256: "b" });
    expect(mocks.executeAgentPrompt).toHaveBeenCalledTimes(2);
    const firstPrompt = mocks.executeAgentPrompt.mock.calls[0]?.[4] as string;
    const secondPrompt = mocks.executeAgentPrompt.mock.calls[1]?.[4] as string;
    expect(secondPrompt).toBe(firstPrompt);
  });

  it("runPlanning rethrows after two consecutive kills and never retries INVALID", async () => {
    mocks.executeAgentPrompt
      .mockResolvedValueOnce(stallSession("stall-1"))
      .mockResolvedValueOnce(stallSession("stall-2"));
    mocks.requireDurableChangeHandoff
      .mockRejectedValueOnce(new Error("PLANNER_FAILED: STALLED_FIRST_ACTIVITY"))
      .mockRejectedValueOnce(new Error("PLANNER_FAILED: STALLED_FIRST_ACTIVITY"));
    await expect(
      runPlanning("/root", await freshControlRoot(), {} as never, contract, plannerSelection, "CHANGE-DR5", payload, undefined, []),
    ).rejects.toThrow(/PLANNER_FAILED/);
    expect(mocks.executeAgentPrompt).toHaveBeenCalledTimes(2);

    mocks.executeAgentPrompt.mockReset();
    mocks.requireDurableChangeHandoff.mockReset();
    mocks.executeAgentPrompt.mockResolvedValueOnce(okSession("ok-1"));
    mocks.requireDurableChangeHandoff.mockRejectedValueOnce(
      new Error("PLANNER_RESULT_INVALID: schema rejected payload"),
    );
    await expect(
      runPlanning("/root", await freshControlRoot(), {} as never, contract, plannerSelection, "CHANGE-DR5b", payload, undefined, []),
    ).rejects.toThrow(/PLANNER_RESULT_INVALID/);
    expect(mocks.executeAgentPrompt).toHaveBeenCalledTimes(1);
  });
});
