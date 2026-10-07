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

import { runDiscovery, runPlanning, runSpecManagerUntilReady, isDiscoveryPlanningStallKill } from "../src/operations/change.js";
import { isSupervisorConsolidationStallKill } from "../src/operations/supervisor.js";
import {
  STALL_RETRY_MAX_ATTEMPTS_PER_PHASE,
  loadStallRetryStalls,
  recordStallRetryStall,
  stallRetryBudgetFile,
} from "../src/operations/stallRetryBudget.js";
import { stalledFirstActivityError } from "../src/paseo/firstActivityDeadline.js";
import type { TaskContract, WorkerSession } from "../src/core/types.js";

const contract = {
  version: 1,
  task: { id: "CHANGE-STALL-LEDGER-1", title: "t" },
  scope: { allowed: ["**"], forbidden: [], frozen: [] },
  routing: { intent: "implement", domains: [], risk: "low", route: "FORMAL_SDD", assurance: "ELEVATED" },
  constraints: { breakingApiChanges: false, newDependencies: false, schemaChanges: false },
  requirements: [],
} as unknown as TaskContract;

const selection = { role: "Explorer", logicalAgent: "explorer", transport: "paseo" } as never;
const plannerSelection = { role: "Planner", logicalAgent: "planner", transport: "paseo" } as never;
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

function specInput(controlRoot: string, operationId: string) {
  return {
    root: "/root",
    controlRoot,
    config: {},
    operationId,
    payload: { request: "Add FAREWELL export.", files: [], domains: [], risk: "low" },
    bootstrapContract: contract,
    selection: { role: "Spec Manager", logicalAgent: "spec-manager", transport: "paseo" },
    changeName: "add-farewell",
    taskId: operationId,
    title: "Add FAREWELL",
    triageReasons: ["formal"],
    inputs: [],
  } as never;
}

describe("stall-retry budget durability across invocations (E-NEW-5)", () => {
  beforeEach(() => {
    mocks.executeAgentPrompt.mockReset();
    mocks.requireDurableChangeHandoff.mockReset();
    delete process.env.AEH_OPERATION_STATE_REDIRECT;
    delete process.env.AEH_OPERATION_ID;
    delete process.env.AEH_CONTROL_ROOT;
  });

  it("two runDiscovery invocations against an always-stall stub stay bounded at 2 attempts total", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-ledger-"));
    const operationId = "CHANGE-STALL-LEDGER-1";
    mocks.executeAgentPrompt.mockImplementation(async () => stallSession(`stall-${Math.random()}`));
    mocks.requireDurableChangeHandoff.mockRejectedValue(new Error("EXPLORER_FAILED: STALLED_FIRST_ACTIVITY: zero activity"));

    await expect(
      runDiscovery("/root", controlRoot, {} as never, contract, selection, operationId, payload, []),
    ).rejects.toThrow(/EXPLORER_FAILED/);
    expect(mocks.executeAgentPrompt).toHaveBeenCalledTimes(2);
    expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(2);
    await expect(
      runDiscovery("/root", controlRoot, {} as never, contract, selection, operationId, payload, []),
    ).rejects.toThrow(/EXPLORER_STALL_BUDGET_EXHAUSTED/);
    expect(mocks.executeAgentPrompt).toHaveBeenCalledTimes(2);
  });

  it("two runPlanning invocations against an always-stall stub stay bounded at 2 attempts total", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-ledger-"));
    const operationId = "CHANGE-STALL-LEDGER-2";
    mocks.executeAgentPrompt.mockImplementation(async () => stallSession(`stall-${Math.random()}`));
    mocks.requireDurableChangeHandoff.mockRejectedValue(new Error("PLANNER_FAILED: STALLED_FIRST_ACTIVITY: zero activity"));

    await expect(
      runPlanning("/root", controlRoot, {} as never, contract, plannerSelection, operationId, payload, undefined, []),
    ).rejects.toThrow(/PLANNER_FAILED/);
    expect(mocks.executeAgentPrompt).toHaveBeenCalledTimes(2);
    await expect(
      runPlanning("/root", controlRoot, {} as never, contract, plannerSelection, operationId, payload, undefined, []),
    ).rejects.toThrow(/PLANNER_STALL_BUDGET_EXHAUSTED/);
    expect(mocks.executeAgentPrompt).toHaveBeenCalledTimes(2);
  });

  it("two runSpecManagerUntilReady invocations against an always-stall stub stay bounded at 2 attempts total", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-ledger-"));
    const operationId = "CHANGE-STALL-LEDGER-3";
    mocks.executeAgentPrompt.mockImplementation(async () => stallSession(`stall-${Math.random()}`));
    mocks.requireDurableChangeHandoff.mockRejectedValue(new Error("SPEC_MANAGER_FAILED: STALLED_FIRST_ACTIVITY: zero activity"));

    await expect(runSpecManagerUntilReady(specInput(controlRoot, operationId))).rejects.toThrow(/SPEC_MANAGER_FAILED/);
    expect(mocks.executeAgentPrompt).toHaveBeenCalledTimes(2);
    await expect(runSpecManagerUntilReady(specInput(controlRoot, operationId))).rejects.toThrow(
      /SPEC_MANAGER_STALL_BUDGET_EXHAUSTED/,
    );
    expect(mocks.executeAgentPrompt).toHaveBeenCalledTimes(2);
  });

  it("INVALID payload rejections stay terminal, single-attempt, and never touch the ledger", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-ledger-"));
    const operationId = "CHANGE-STALL-LEDGER-4";
    mocks.executeAgentPrompt.mockResolvedValueOnce(okSession("ok-1"));
    mocks.requireDurableChangeHandoff.mockRejectedValueOnce(
      new Error("EXPLORER_RESULT_INVALID: schema rejected payload"),
    );
    await expect(
      runDiscovery("/root", controlRoot, {} as never, contract, selection, operationId, payload, []),
    ).rejects.toThrow(/EXPLORER_RESULT_INVALID/);
    expect(mocks.executeAgentPrompt).toHaveBeenCalledTimes(1);
    expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(0);
  });

  it("ledger round-trips per phase and budget-exhausted errors stay terminal (never stall-classified)", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-ledger-"));
    const operationId = "CHANGE-STALL-LEDGER-5";
    expect(STALL_RETRY_MAX_ATTEMPTS_PER_PHASE).toBe(2);
    expect(await loadStallRetryStalls(controlRoot, operationId, "consolidation")).toBe(0);
    expect(await recordStallRetryStall(controlRoot, operationId, "consolidation")).toBe(1);
    expect(await recordStallRetryStall(controlRoot, operationId, "consolidation")).toBe(2);
    expect(await loadStallRetryStalls(controlRoot, operationId, "consolidation")).toBe(2);
    expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(0);
    const raw = JSON.parse(await fs.readFile(stallRetryBudgetFile(controlRoot, operationId), "utf8"));
    expect(raw.version).toBe(1);
    expect(isDiscoveryPlanningStallKill(new Error("EXPLORER_STALL_BUDGET_EXHAUSTED: discovery already consumed 2 delayed-kill attempt(s) for operation X; max 2 total across all drives."))).toBe(false);
    expect(isDiscoveryPlanningStallKill(new Error("PLANNER_STALL_BUDGET_EXHAUSTED: planning already consumed 2 delayed-kill attempt(s) for operation X; max 2 total across all drives."))).toBe(false);
    expect(isDiscoveryPlanningStallKill(new Error("SPEC_MANAGER_STALL_BUDGET_EXHAUSTED: spec authoring already consumed 2 delayed-kill attempt(s) for operation X; max 2 total across all drives."))).toBe(false);
    expect(isSupervisorConsolidationStallKill(new Error("AEH_OPERATION_SUPERVISOR_STALL_BUDGET_EXHAUSTED: consolidation already consumed 2 delayed-kill attempt(s); max 2 total across all drives."))).toBe(false);
  });

  it("L1 fail-closed: UNKNOWN ledger (corrupt/unreadable) refuses with EXHAUSTED, only ENOENT-first-ever and affirmative-zero read as 0", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-ledger-"));
    const operationId = "CHANGE-STALL-LEDGER-L1";
    // ENOENT-first-ever (no ledger ever written) may start at zero.
    expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(0);
    // Affirmative-zero (file present, valid, count 0) reads as zero.
    expect(await recordStallRetryStall(controlRoot, operationId, "planning")).toBe(1);
    expect(await loadStallRetryStalls(controlRoot, operationId, "planning")).toBe(1);
    expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(0);
    const file = stallRetryBudgetFile(controlRoot, operationId);
    // Malformed JSON must not regain retries.
    await fs.writeFile(file, "NOT-JSON{{{", "utf8");
    await expect(loadStallRetryStalls(controlRoot, operationId, "discovery")).rejects.toThrow(
      /EXPLORER_STALL_BUDGET_EXHAUSTED.*ledger UNKNOWN/,
    );
    // Version mismatch must not regain retries.
    await fs.writeFile(
      file,
      JSON.stringify({ version: 999, operationId, stalls: { discovery: 0, planning: 0, "spec-manager": 0, consolidation: 0 } }),
      "utf8",
    );
    await expect(loadStallRetryStalls(controlRoot, operationId, "discovery")).rejects.toThrow(
      /EXPLORER_STALL_BUDGET_EXHAUSTED.*ledger UNKNOWN/,
    );
    // OperationId mismatch must not regain retries.
    await fs.writeFile(
      file,
      JSON.stringify({ version: 1, operationId: "OTHER", stalls: { discovery: 0, planning: 0, "spec-manager": 0, consolidation: 0 } }),
      "utf8",
    );
    await expect(loadStallRetryStalls(controlRoot, operationId, "discovery")).rejects.toThrow(
      /EXPLORER_STALL_BUDGET_EXHAUSTED.*ledger UNKNOWN/,
    );
    // Malformed stalls shape must not regain retries.
    await fs.writeFile(
      file,
      JSON.stringify({ version: 1, operationId, stalls: { discovery: "two", planning: 0, "spec-manager": 0, consolidation: 0 } }),
      "utf8",
    );
    await expect(loadStallRetryStalls(controlRoot, operationId, "discovery")).rejects.toThrow(
      /EXPLORER_STALL_BUDGET_EXHAUSTED.*ledger UNKNOWN/,
    );
    // Non-ENOENT read error (ledger path is a directory) must not regain retries.
    await fs.rm(file, { force: true });
    await fs.mkdir(file, { recursive: true });
    await expect(loadStallRetryStalls(controlRoot, operationId, "discovery")).rejects.toThrow(
      /EXPLORER_STALL_BUDGET_EXHAUSTED.*ledger UNKNOWN/,
    );
    // A corrupt ledger must refuse the phase before any attempt (no retry regained).
    mocks.executeAgentPrompt.mockImplementation(async () => stallSession("stall-l1"));
    mocks.requireDurableChangeHandoff.mockRejectedValue(new Error("EXPLORER_FAILED: STALLED_FIRST_ACTIVITY: zero activity"));
    await expect(
      runDiscovery("/root", controlRoot, {} as never, contract, selection, operationId, payload, []),
    ).rejects.toThrow(/EXPLORER_STALL_BUDGET_EXHAUSTED.*ledger UNKNOWN/);
    expect(mocks.executeAgentPrompt).not.toHaveBeenCalled();
    // Record over a corrupt ledger must throw coded, never reset the budget.
    await expect(recordStallRetryStall(controlRoot, operationId, "discovery")).rejects.toThrow(
      /EXPLORER_STALL_BUDGET_EXHAUSTED.*ledger UNKNOWN/,
    );
    await fs.rm(controlRoot, { recursive: true, force: true });
  });

  it("L2 fail-closed: ledger write failure surfaces coded error and consumes no retry", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-ledger-"));
    const operationId = "CHANGE-STALL-LEDGER-L2";
    mocks.executeAgentPrompt.mockImplementation(async () => stallSession("stall-l2"));
    mocks.requireDurableChangeHandoff.mockRejectedValue(new Error("EXPLORER_FAILED: STALLED_FIRST_ACTIVITY: zero activity"));
    const writeErr = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const spy = vi.spyOn(fs, "writeFile").mockRejectedValueOnce(writeErr);
    try {
      await expect(
        runDiscovery("/root", controlRoot, {} as never, contract, selection, operationId, payload, []),
      ).rejects.toThrow(/STALL_RETRY_LEDGER_WRITE_FAILED.*discovery/);
    } finally {
      spy.mockRestore();
    }
    // No retry was consumed without durable accounting. Pre-claim (B1) moved the
    // first durable write to the claim BEFORE the counted attempt, so a
    // claim-write failure fails loudly before the attempt runs: zero attempts
    // ran, nothing consumed, coded error surfaces (pre-claim-3 contract: marker
    // write failure fails without consuming; no attempt runs unclaimed).
    expect(mocks.executeAgentPrompt).not.toHaveBeenCalled();
    // No ledger file was created without durable accounting, and zero is correct
    // here because no counted attempt ever ran (nothing to count).
    await expect(fs.stat(stallRetryBudgetFile(controlRoot, operationId))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(0);
    // The coded write error stays terminal (never stall-classified).
    expect(isDiscoveryPlanningStallKill(new Error("STALL_RETRY_LEDGER_WRITE_FAILED: discovery ledger write failed for operation X (code=EACCES); retry requires durable accounting, attempt failed without consuming a retry."))).toBe(false);
    expect(isSupervisorConsolidationStallKill(new Error("STALL_RETRY_LEDGER_WRITE_FAILED: consolidation ledger write failed for operation X (code=EACCES); retry requires durable accounting, attempt failed without consuming a retry."))).toBe(false);
    await fs.rm(controlRoot, { recursive: true, force: true });
  });
});
