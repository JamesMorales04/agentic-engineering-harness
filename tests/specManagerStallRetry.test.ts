import { describe, expect, it, vi, beforeEach } from "vitest";

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

import {
  runSpecManagerUntilReady,
  SPEC_MANAGER_STALL_MAX_ATTEMPTS,
  SPEC_MANAGER_STALL_MAX_RETRIES,
  shouldRetrySpecManagerStall,
} from "../src/operations/change.js";
import { stalledFirstActivityError } from "../src/paseo/firstActivityDeadline.js";
import type { WorkerSession } from "../src/core/types.js";

const baseInput = {
  root: "/root",
  controlRoot: "/control",
  config: {},
  operationId: "CHANGE-1",
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
    activityCounts: { updatesObserved: 0, toolEvents: 0, assistantDelta: false },
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

function readyEvidence() {
  return {
    artifact: ".harness/artifacts/spec.json",
    sha256: "a".repeat(64),
    payload: {
      change: "add-farewell",
      status: "READY",
      validationReady: true,
      decisionRequests: [],
      artifacts: {
        proposal: "# Proposal\nSHALL do X.",
        tasks: "- [ ] 1.1 Do X",
        specs: [{ capability: "farewell", content: "## ADDED Requirements\n### Requirement: Farewell\nText SHALL exist.\n#### Scenario: Happy\nWhen X." }],
      },
    },
  };
}

describe("spec-manager stall-kill bounded retry (A1)", () => {
  beforeEach(() => {
    mocks.executeAgentPrompt.mockReset();
    mocks.requireDurableChangeHandoff.mockReset();
    mocks.persistOpenSpecAuthoringContent.mockClear();
    mocks.persistOpenSpecAuthoringContent.mockResolvedValue(["proposal.md", "tasks.md"]);
  });

  it("caps the stall budget at two attempts total (mirrors repair/discovery budget)", () => {
    expect(SPEC_MANAGER_STALL_MAX_ATTEMPTS).toBe(2);
    expect(SPEC_MANAGER_STALL_MAX_RETRIES).toBe(1);
  });

  it("classifies stall-kill as retryable once, INVALID as terminal", () => {
    expect(shouldRetrySpecManagerStall(new Error("SPEC_MANAGER_FAILED: STALLED_FIRST_ACTIVITY: zero activity"), 0, stallSession("s1"))).toBe(true);
    expect(shouldRetrySpecManagerStall(new Error("SPEC_MANAGER_FAILED: STALLED_FIRST_ACTIVITY: zero activity"), 1, stallSession("s1"))).toBe(false);
    expect(shouldRetrySpecManagerStall(new Error("SPEC_MANAGER_RESULT_INVALID: schema rejected"), 0, okSession("s2"))).toBe(false);
    expect(shouldRetrySpecManagerStall(new Error("SPEC_MANAGER_CHANGE_MISMATCH: expected 'a'"), 0, okSession("s3"))).toBe(false);
  });

  it("retries once with identical inputs after a stall-kill then succeeds", async () => {
    mocks.executeAgentPrompt
      .mockResolvedValueOnce(stallSession("stall-1"))
      .mockResolvedValueOnce(okSession("ok-2"));
    mocks.requireDurableChangeHandoff
      .mockRejectedValueOnce(new Error("SPEC_MANAGER_FAILED: STALLED_FIRST_ACTIVITY: zero activity"))
      .mockResolvedValueOnce(readyEvidence());
    const result = await runSpecManagerUntilReady(baseInput);
    expect(result.payload.status).toBe("READY");
    expect(mocks.executeAgentPrompt).toHaveBeenCalledTimes(2);
    const firstPrompt = mocks.executeAgentPrompt.mock.calls[0]?.[4] as string;
    const secondPrompt = mocks.executeAgentPrompt.mock.calls[1]?.[4] as string;
    expect(secondPrompt).toBe(firstPrompt);
    expect(secondPrompt).toContain("add-farewell");
  });

  it("rethrows the original class after two consecutive stall kills", async () => {
    mocks.executeAgentPrompt
      .mockResolvedValueOnce(stallSession("stall-1"))
      .mockResolvedValueOnce(stallSession("stall-2"));
    mocks.requireDurableChangeHandoff
      .mockRejectedValueOnce(new Error("SPEC_MANAGER_FAILED: STALLED_FIRST_ACTIVITY: zero activity"))
      .mockRejectedValueOnce(new Error("SPEC_MANAGER_FAILED: STALLED_FIRST_ACTIVITY: zero activity"));
    await expect(runSpecManagerUntilReady(baseInput)).rejects.toThrow(/STALLED_FIRST_ACTIVITY/);
    expect(mocks.executeAgentPrompt).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry INVALID payload rejections", async () => {
    mocks.executeAgentPrompt.mockResolvedValueOnce(okSession("ok-1"));
    mocks.requireDurableChangeHandoff.mockRejectedValueOnce(
      new Error("SPEC_MANAGER_RESULT_INVALID: schema rejected payload"),
    );
    await expect(runSpecManagerUntilReady(baseInput)).rejects.toThrow(/SPEC_MANAGER_RESULT_INVALID/);
    expect(mocks.executeAgentPrompt).toHaveBeenCalledTimes(1);
  });
});
