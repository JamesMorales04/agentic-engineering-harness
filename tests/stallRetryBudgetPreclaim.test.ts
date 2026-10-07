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
  claimStallRetryAttempt,
  clearStallRetryClaim,
  loadStallRetryStalls,
  recordStallRetryStall,
  stallRetryBudgetFile,
  stallRetryPendingFile,
} from "../src/operations/stallRetryBudget.js";
import { stalledFirstActivityError } from "../src/paseo/firstActivityDeadline.js";
import type { TaskContract, WorkerSession } from "../src/core/types.js";

const contract = {
  version: 1,
  task: { id: "CHANGE-STALL-PRECLAIM-1", title: "t" },
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

describe("stall-retry pre-claim fail-closed", () => {
  beforeEach(() => {
    mocks.executeAgentPrompt.mockReset();
    mocks.requireDurableChangeHandoff.mockReset();
  });

  it("unreconciled pending marker reads as EXHAUSTED, not zero-budget", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-preclaim-"));
    const operationId = "PRECLAIM-1";
    try {
      // First-ever (no ledger, no pending) may start at zero.
      expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(0);
      // Durably claim before the counted attempt (same convention as record).
      await claimStallRetryAttempt(controlRoot, operationId, "discovery");
      expect(stallRetryPendingFile(controlRoot, operationId, "discovery")).toBe(
        `${stallRetryBudgetFile(controlRoot, operationId)}.discovery.pending`,
      );
      // Unreconciled pending must fail closed as EXHAUSTED, never zero.
      await expect(loadStallRetryStalls(controlRoot, operationId, "discovery")).rejects.toThrow(
        /EXPLORER_STALL_BUDGET_EXHAUSTED.*pending claim unreconciled/,
      );
      // Other phases are unaffected (per-phase markers).
      expect(await loadStallRetryStalls(controlRoot, operationId, "planning")).toBe(0);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("pending markers exhaust with the phase's own code (planning/spec-manager/consolidation)", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-preclaim-"));
    const operationId = "PRECLAIM-CODES";
    try {
      await claimStallRetryAttempt(controlRoot, operationId, "planning");
      await expect(loadStallRetryStalls(controlRoot, operationId, "planning")).rejects.toThrow(
        /PLANNER_STALL_BUDGET_EXHAUSTED/,
      );
      await claimStallRetryAttempt(controlRoot, operationId, "spec-manager");
      await expect(loadStallRetryStalls(controlRoot, operationId, "spec-manager")).rejects.toThrow(
        /SPEC_MANAGER_STALL_BUDGET_EXHAUSTED/,
      );
      await claimStallRetryAttempt(controlRoot, operationId, "consolidation");
      await expect(loadStallRetryStalls(controlRoot, operationId, "consolidation")).rejects.toThrow(
        /AEH_OPERATION_SUPERVISOR_STALL_BUDGET_EXHAUSTED/,
      );
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("first ledger write failure after successful pre-claim re-enters EXHAUSTED (blocker)", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-preclaim-"));
    const operationId = "PRECLAIM-2";
    try {
      // Claim succeeded durably before the counted attempt.
      await claimStallRetryAttempt(controlRoot, operationId, "discovery");
      // The counted ledger write then fails (no ledger file created, pending remains).
      const writeErr = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      const spy = vi.spyOn(fs, "writeFile").mockRejectedValueOnce(writeErr);
      try {
        await expect(recordStallRetryStall(controlRoot, operationId, "discovery")).rejects.toThrow(
          /STALL_RETRY_LEDGER_WRITE_FAILED|EXPLORER_STALL_BUDGET_EXHAUSTED/,
        );
      } finally {
        spy.mockRestore();
      }
      // Re-enter in a fresh invocation: unreconciled pending must be EXHAUSTED, never zero.
      await expect(loadStallRetryStalls(controlRoot, operationId, "discovery")).rejects.toThrow(
        /EXPLORER_STALL_BUDGET_EXHAUSTED/,
      );
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("ledger failure with no prior claim still leaves pending when the claim write succeeds (record pre-claims)", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-preclaim-"));
    const operationId = "PRECLAIM-3";
    const origWriteFile = fs.writeFile;
    try {
      // Allow the pending-marker write through, fail only the ledger temp write.
      const writeErr = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      const spy = vi.spyOn(fs, "writeFile").mockImplementation(((target: unknown, ...rest: unknown[]) => {
        if (String(target).includes(".pending")) return (origWriteFile as (...args: unknown[]) => Promise<void>)(target, ...rest);
        throw writeErr;
      }) as typeof fs.writeFile);
      try {
        await expect(recordStallRetryStall(controlRoot, operationId, "discovery")).rejects.toThrow(
          /STALL_RETRY_LEDGER_WRITE_FAILED/,
        );
      } finally {
        spy.mockRestore();
      }
      // The record-internal pre-claim remains: re-enter must be EXHAUSTED, not zero.
      await expect(loadStallRetryStalls(controlRoot, operationId, "discovery")).rejects.toThrow(
        /EXPLORER_STALL_BUDGET_EXHAUSTED/,
      );
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("successful record supersedes the marker: pending cleared, count durable", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-preclaim-"));
    const operationId = "PRECLAIM-4";
    try {
      await claimStallRetryAttempt(controlRoot, operationId, "discovery");
      expect(await recordStallRetryStall(controlRoot, operationId, "discovery")).toBe(1);
      // Pending reconciled (deleted), ledger count durable.
      await expect(fs.stat(stallRetryPendingFile(controlRoot, operationId, "discovery"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(1);
      // Success path clears a stale claim without touching the count.
      await claimStallRetryAttempt(controlRoot, operationId, "planning");
      await clearStallRetryClaim(controlRoot, operationId, "planning");
      expect(await loadStallRetryStalls(controlRoot, operationId, "planning")).toBe(0);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("marker write failure fails loudly without consuming (same as write-failure path)", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-preclaim-"));
    const operationId = "PRECLAIM-5";
    const writeErr = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const spy = vi.spyOn(fs, "writeFile").mockRejectedValueOnce(writeErr);
    try {
      await expect(claimStallRetryAttempt(controlRoot, operationId, "discovery")).rejects.toThrow(
        /STALL_RETRY_LEDGER_WRITE_FAILED.*discovery/,
      );
    } finally {
      spy.mockRestore();
    }
    // No retry consumed without durable accounting.
    await expect(fs.stat(stallRetryBudgetFile(controlRoot, operationId))).rejects.toMatchObject({ code: "ENOENT" });
    await fs.rm(controlRoot, { recursive: true, force: true });
  });

  it("runDiscovery: ledger failure after claim re-enters EXHAUSTED without regaining budget", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-preclaim-"));
    const operationId = "PRECLAIM-RUN-1";
    mocks.executeAgentPrompt.mockImplementation(async () => stallSession("stall-preclaim"));
    mocks.requireDurableChangeHandoff.mockRejectedValue(new Error("EXPLORER_FAILED: STALLED_FIRST_ACTIVITY: zero activity"));
    const origWriteFile = fs.writeFile;
    const writeErr = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    // Fail only ledger temp writes; let pending-marker writes through so the
    // first-ever stall leaves an unreconciled claim.
    const spy = vi.spyOn(fs, "writeFile").mockImplementation(((target: unknown, ...rest: unknown[]) => {
      if (String(target).includes(".pending")) return (origWriteFile as (...args: unknown[]) => Promise<void>)(target, ...rest);
      throw writeErr;
    }) as typeof fs.writeFile);
    try {
      await expect(
        runDiscovery("/root", controlRoot, {} as never, contract, selection, operationId, payload, []),
      ).rejects.toThrow(/STALL_RETRY_LEDGER_WRITE_FAILED.*discovery/);
    } finally {
      spy.mockRestore();
    }
    expect(mocks.executeAgentPrompt).toHaveBeenCalledTimes(1);
    // Fresh invocation must refuse EXHAUSTED via the unreconciled claim, never zero-budget.
    await expect(
      runDiscovery("/root", controlRoot, {} as never, contract, selection, operationId, payload, []),
    ).rejects.toThrow(/EXPLORER_STALL_BUDGET_EXHAUSTED/);
    expect(mocks.executeAgentPrompt).toHaveBeenCalledTimes(1);
    await fs.rm(controlRoot, { recursive: true, force: true });
  });
});
