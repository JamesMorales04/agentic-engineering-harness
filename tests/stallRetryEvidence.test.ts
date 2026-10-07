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
  isStallKilledProviderTurn,
  loadStallRetryStalls,
} from "../src/operations/stallRetryBudget.js";
import type { TaskContract, WorkerSession } from "../src/core/types.js";

/**
 * RED for Luna blocker (ru/ledger-evidence-11): `isStallKilledProviderTurn`
 * text-searches stdout/stderr for /timed out|timeout|stalled_first_activity/i,
 * so (1) a CLEAN turn merely mentioning "timeout" consumes budget, and
 * (2) a missing-signal terminal failure clears as clean (regains budget).
 *
 * Required fail-closed rule: STALL requires STRUCTURED evidence only
 * (killReason STALLED_FIRST_ACTIVITY, status timeout, exit 124); CLEAN requires
 * affirmative clean-success evidence; AMBIGUOUS terminal failure COUNTS.
 */

const contract = {
  version: 1,
  task: { id: "CHANGE-STALL-EVIDENCE-RED", title: "t" },
  scope: { allowed: ["**"], forbidden: [], frozen: [] },
  routing: { intent: "implement", domains: [], risk: "low", route: "FORMAL_SDD", assurance: "ELEVATED" },
  constraints: { breakingApiChanges: false, newDependencies: false, schemaChanges: false },
  requirements: [],
} as unknown as TaskContract;

const selection = { role: "Explorer", logicalAgent: "explorer", transport: "paseo" } as never;
const payload = { request: "Add the FAREWELL export.", files: [], domains: [], risk: "low" } as never;

function cleanSessionMentioningTimeout(id: string): WorkerSession {
  return {
    id,
    exitCode: 0,
    stdout: "AEH_RESULT_JSON={} note: previous timeout handling documented here",
    stderr: "",
    status: "idle",
    transport: "paseo-sdk",
  } as unknown as WorkerSession;
}

function ambiguousSessionNoSignals(id: string): WorkerSession {
  return {
    id,
    exitCode: 1,
    stdout: "",
    stderr: "",
    status: "failed",
    transport: "paseo-sdk",
  } as unknown as WorkerSession;
}

beforeEach(() => {
  mocks.executeAgentPrompt.mockReset();
  mocks.requireDurableChangeHandoff.mockReset();
});

describe("RED: structured-evidence reconciliation (Luna blocker)", () => {
  it("probe: text mention alone is NEVER stall evidence", () => {
    expect(
      isStallKilledProviderTurn({
        exitCode: 0,
        status: "idle",
        stdout: "discussed timeout handling",
        stderr: "",
      }),
    ).toBe(false);
  });

  it("RED1: clean turn merely mentioning timeout consumes nothing (ledger 0)", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-evidence-red1-"));
    try {
      const operationId = "OP-EVIDENCE-RED1";
      mocks.executeAgentPrompt.mockResolvedValueOnce(cleanSessionMentioningTimeout("clean-1"));
      mocks.requireDurableChangeHandoff.mockRejectedValueOnce(
        new Error("EXPLORER_RESULT_INVALID: schema rejected payload"),
      );
      await expect(
        runDiscovery("/root", controlRoot, {} as never, contract, selection, operationId, payload, []),
      ).rejects.toThrow(/EXPLORER_RESULT_INVALID/);
      expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(0);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("RED2: ambiguous terminal failure (no clean proof, no stall proof) COUNTS (ledger 1)", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-evidence-red2-"));
    try {
      const operationId = "OP-EVIDENCE-RED2";
      mocks.executeAgentPrompt.mockResolvedValueOnce(ambiguousSessionNoSignals("ambig-1"));
      mocks.requireDurableChangeHandoff.mockRejectedValueOnce(
        new Error("EXPLORER_RESULT_INVALID: schema rejected payload"),
      );
      await expect(
        runDiscovery("/root", controlRoot, {} as never, contract, selection, operationId, payload, []),
      ).rejects.toThrow(/EXPLORER_RESULT_INVALID/);
      expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(1);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });
});
