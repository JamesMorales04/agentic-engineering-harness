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

import { runDiscovery } from "../src/operations/change.js";
import {
  STALL_RETRY_MAX_ATTEMPTS_PER_PHASE,
  loadStallRetryStalls,
  stallRetryBudgetFile,
  transactStallRetrySpend,
} from "../src/operations/stallRetryBudget.js";
import { stalledFirstActivityError } from "../src/paseo/firstActivityDeadline.js";
import type { TaskContract, WorkerSession } from "../src/core/types.js";

/**
 * RED-first regression for the fail-closed stall-retry ledger (Luna blockers B1–B2).
 *
 * B1 taxonomy: file ABSENT → 0 (only zero-source); file present but
 * unreadable/corrupt/unparseable → THROW fail-closed; WRITE failure → THROW
 * fail-closed (no degrade-to-local, no swallow at call sites).
 *
 * B2 atomicity: single locked transact {load, budget-check, increment,
 * write} BEFORE acting (launch/retry). Crash before transact = nothing
 * spent; crash after = count spent (safe direction). Never
 * increment-after-kill. MECHANISM: DETERMINISTIC (file-backed counters).
 */

const contract = {
  version: 1,
  task: { id: "CHANGE-STALL-LEDGER-1", title: "t" },
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

beforeEach(() => {
  mocks.executeAgentPrompt.mockReset();
  mocks.requireDurableChangeHandoff.mockReset();
  delete process.env.AEH_OPERATION_STATE_REDIRECT;
  delete process.env.AEH_OPERATION_ID;
  delete process.env.AEH_CONTROL_ROOT;
});

describe("B: durable budget stays bounded across invocations (base behavior is unbounded)", () => {
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
    ).rejects.toThrow(/STALL_BUDGET_EXHAUSTED/);
    expect(mocks.executeAgentPrompt).toHaveBeenCalledTimes(2);
  });
});

describe("B1: ledger taxonomy fails closed (only ABSENT reads as zero)", () => {
  it("absent file reads as 0 (legitimate first run)", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-ledger-"));
    expect(await loadStallRetryStalls(controlRoot, "OP-NEW", "discovery")).toBe(0);
  });

  it("present-but-corrupt file THROWS (never reads as zero)", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-ledger-"));
    const operationId = "OP-CORRUPT";
    const file = stallRetryBudgetFile(controlRoot, operationId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "this is not json{{{");
    await expect(loadStallRetryStalls(controlRoot, operationId, "discovery")).rejects.toThrow(/STALL_RETRY_LEDGER_CORRUPT/);
  });

  it("present-but-unreadable file THROWS (never reads as zero)", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-ledger-"));
    const operationId = "OP-UNREADABLE";
    const file = stallRetryBudgetFile(controlRoot, operationId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ version: 1, operationId, stalls: { discovery: 1 }, updatedAt: new Date().toISOString() }));
    await fs.chmod(file, 0o000);
    try {
      await expect(loadStallRetryStalls(controlRoot, operationId, "discovery")).rejects.toThrow(/STALL_RETRY_LEDGER_/);
    } finally {
      await fs.chmod(file, 0o644);
    }
  });

  it("write failure THROWS fail-closed (no degrade-to-local, no silent zero)", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-ledger-"));
    const operationId = "OP-WRITEFAIL";
    // Block the ledger path with a regular file so mkdir/write cannot succeed.
    const stateDir = path.resolve(controlRoot, ".harness", "operations");
    await fs.mkdir(path.dirname(stateDir), { recursive: true });
    await fs.writeFile(stateDir, "blocking file");
    await expect(transactStallRetrySpend(controlRoot, operationId, "discovery")).rejects.toThrow(/STALL_RETRY_LEDGER_/);
  });

  it("ledger write failure in runDiscovery fails the drive closed with zero attempts (never unbounded retry)", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-ledger-"));
    const operationId = "OP-DRIVEFAIL";
    const stateDir = path.resolve(controlRoot, ".harness", "operations");
    await fs.mkdir(path.dirname(stateDir), { recursive: true });
    await fs.writeFile(stateDir, "blocking file");
    mocks.executeAgentPrompt.mockImplementation(async () => stallSession("stall-1"));
    await expect(
      runDiscovery("/root", controlRoot, {} as never, contract, selection, operationId, payload, []),
    ).rejects.toThrow(/STALL_RETRY_LEDGER_/);
    expect(mocks.executeAgentPrompt).not.toHaveBeenCalled();
  });
});

describe("B2: atomic decide-and-spend before acting (never increment-after-kill)", () => {
  it("spend happens BEFORE the attempt: a non-stall terminal failure still counts as spent (safe direction)", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-ledger-"));
    const operationId = "OP-PRESPEND";
    mocks.executeAgentPrompt.mockResolvedValueOnce(stallSession("ok-shape"));
    mocks.requireDurableChangeHandoff.mockRejectedValueOnce(new Error("EXPLORER_RESULT_INVALID: schema rejected payload"));
    await expect(
      runDiscovery("/root", controlRoot, {} as never, contract, selection, operationId, payload, []),
    ).rejects.toThrow(/EXPLORER_RESULT_INVALID/);
    // The attempt was spent upfront even though it did not stall-kill: a crash
    // after transact counts as spent (safe direction), never as free.
    expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(1);
  });

  it("per-operation keying: one operation exhausting its budget never affects another", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-ledger-"));
    expect(STALL_RETRY_MAX_ATTEMPTS_PER_PHASE).toBe(2);
    expect(await transactStallRetrySpend(controlRoot, "OP-A", "discovery")).toBe(1);
    expect(await transactStallRetrySpend(controlRoot, "OP-A", "discovery")).toBe(2);
    await expect(transactStallRetrySpend(controlRoot, "OP-A", "discovery")).rejects.toThrow(/STALL_BUDGET_EXHAUSTED/);
    expect(await loadStallRetryStalls(controlRoot, "OP-B", "discovery")).toBe(0);
    expect(await transactStallRetrySpend(controlRoot, "OP-B", "discovery")).toBe(1);
    expect(await loadStallRetryStalls(controlRoot, "OP-A", "planning")).toBe(0);
  });
});
