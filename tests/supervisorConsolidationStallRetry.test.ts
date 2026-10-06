import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  SUPERVISOR_CONSOLIDATION_STALL_MAX_ATTEMPTS,
  SUPERVISOR_CONSOLIDATION_STALL_MAX_RETRIES,
  shouldRetrySupervisorConsolidationStall,
  withBoundedSupervisorConsolidationStallRetryV1,
  supervisorTurnTimedOutV1,
} from "../src/operations/supervisor.js";
import type { WorkerSession } from "../src/core/types.js";

function timeoutSession(): WorkerSession {
  return {
    id: "timeout-1",
    exitCode: 124,
    stdout: "",
    stderr: "provider turn deadline expired after 300000ms (timeout)",
    status: "timeout",
    transport: "paseo-sdk",
    killReason: "DEADLINE",
    activityCounts: { updatesObserved: 0, toolEvents: 0, assistantDelta: false },
  } as unknown as WorkerSession;
}

function okSession(): WorkerSession {
  return {
    id: "ok-1",
    exitCode: 0,
    stdout: "AEH_RESULT_JSON={}",
    stderr: "",
    status: "idle",
    transport: "paseo-sdk",
    activityCounts: { updatesObserved: 2, toolEvents: 1, assistantDelta: true },
  } as unknown as WorkerSession;
}

describe("supervisor consolidation stall-kill bounded retry (A3)", () => {
  it("caps the stall budget at two attempts total (mirrors init/rotation/discovery budget)", () => {
    expect(SUPERVISOR_CONSOLIDATION_STALL_MAX_ATTEMPTS).toBe(2);
    expect(SUPERVISOR_CONSOLIDATION_STALL_MAX_RETRIES).toBe(1);
  });

  it("reuses the timeout taxonomy and keeps contract/provenance terminal", () => {
    expect(supervisorTurnTimedOutV1(timeoutSession())).toBe(true);
    expect(supervisorTurnTimedOutV1(okSession())).toBe(false);
    expect(
      shouldRetrySupervisorConsolidationStall(
        new Error("AEH_OPERATION_SUPERVISOR_TURN_TIMEOUT: consolidation turn exceeded 300s; session stopped and generation failed closed"),
        0,
        timeoutSession(),
      ),
    ).toBe(true);
    expect(
      shouldRetrySupervisorConsolidationStall(
        new Error("AEH_OPERATION_SUPERVISOR_TURN_TIMEOUT: consolidation turn exceeded 300s; session stopped and generation failed closed"),
        1,
        timeoutSession(),
      ),
    ).toBe(false);
    expect(
      shouldRetrySupervisorConsolidationStall(
        new Error("AEH_OPERATION_SUPERVISOR_CONTRACT: correction response did not match the supervisor contract"),
        0,
        okSession(),
      ),
    ).toBe(false);
    expect(
      shouldRetrySupervisorConsolidationStall(
        new Error("AEH_OPERATION_SUPERVISOR_PROVENANCE: consolidation did not account for the exact raw finding set. expected=a received=b"),
        0,
        okSession(),
      ),
    ).toBe(false);
    expect(
      shouldRetrySupervisorConsolidationStall(new Error("AEH_OPERATION_SUPERVISOR_FAILED: supervisor exited with 1: boom"), 0, okSession()),
    ).toBe(false);
  });

  it("retries once with identical inputs after a stall-kill then succeeds (fresh generation, same finding-set)", async () => {
    const prompts: string[] = [];
    const attempt = vi.fn(async (prompt: string) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        throw new Error("AEH_OPERATION_SUPERVISOR_TURN_TIMEOUT: consolidation turn exceeded 300s; session stopped and generation failed closed");
      }
      return { output: { summary: "ok" }, session: okSession() };
    });
    const frozenPrompt = "[AEH_SUPERVISOR_CONSOLIDATE] same finding-set";
    const result = await withBoundedSupervisorConsolidationStallRetryV1({
      requestAttempt: attempt,
      prompt: frozenPrompt,
    });
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(prompts).toEqual([frozenPrompt, frozenPrompt]);
    expect(result.session.exitCode).toBe(0);
  });

  it("rethrows the original class after two consecutive stall kills", async () => {
    const attempt = vi.fn(async () => {
      throw new Error("AEH_OPERATION_SUPERVISOR_TURN_TIMEOUT: consolidation turn exceeded 300s; session stopped and generation failed closed");
    });
    await expect(
      withBoundedSupervisorConsolidationStallRetryV1({ requestAttempt: attempt, prompt: "p" }),
    ).rejects.toThrow(/AEH_OPERATION_SUPERVISOR_TURN_TIMEOUT/);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry INVALID/contract/provenance failures", async () => {
    const attempt = vi.fn(async () => {
      throw new Error("AEH_OPERATION_SUPERVISOR_CONTRACT: correction response did not match the supervisor contract");
    });
    await expect(
      withBoundedSupervisorConsolidationStallRetryV1({ requestAttempt: attempt, prompt: "p" }),
    ).rejects.toThrow(/AEH_OPERATION_SUPERVISOR_CONTRACT/);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
