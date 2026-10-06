import { describe, expect, it, vi } from "vitest";

import {
  REPAIR_STALL_MAX_ATTEMPTS,
  REPAIR_STALL_MAX_RETRIES,
  shouldRetryRepairStall,
  withBoundedRepairStallRetryV1,
} from "../src/core/run.js";
import type { WorkerSession } from "../src/core/types.js";

function stallSession(id: string): WorkerSession {
  return {
    id,
    provider: "paseo",
    logicalAgent: "repairer",
    exitCode: 124,
    stdout: "",
    stderr: "STALLED_FIRST_ACTIVITY: zero activity after 1200000ms (timeout)",
    killReason: "STALLED_FIRST_ACTIVITY",
    status: "timeout",
    transport: "paseo-sdk",
    activityCounts: { updatesObserved: 0, toolEvents: 0, assistantDelta: false },
  } as unknown as WorkerSession;
}

function timeoutSession(id: string): WorkerSession {
  return {
    id,
    provider: "paseo",
    logicalAgent: "repairer",
    exitCode: 124,
    stdout: "",
    stderr: "provider turn deadline expired after 300000ms (timeout)",
    killReason: "DEADLINE",
    status: "timeout",
    transport: "paseo-sdk",
    activityCounts: { updatesObserved: 0, toolEvents: 0, assistantDelta: false },
  } as unknown as WorkerSession;
}

function okSession(id: string): WorkerSession {
  return {
    id,
    provider: "paseo",
    logicalAgent: "repairer",
    exitCode: 0,
    stdout: "AEH_RESULT_JSON={}",
    stderr: "",
    status: "idle",
    transport: "paseo-sdk",
    activityCounts: { updatesObserved: 2, toolEvents: 1, assistantDelta: true },
  } as unknown as WorkerSession;
}

describe("repair-loop stall-kill bounded retry (A6)", () => {
  it("caps the stall budget at two attempts total (mirrors content maxRepairs language)", () => {
    expect(REPAIR_STALL_MAX_ATTEMPTS).toBe(2);
    expect(REPAIR_STALL_MAX_RETRIES).toBe(1);
  });

  it("classifies stall/timeout kills as retryable, INVALID/schema/contract/provenance as terminal", () => {
    expect(shouldRetryRepairStall(new Error("REPAIR_FAILED: STALLED_FIRST_ACTIVITY: zero activity"), 0, stallSession("s1"))).toBe(true);
    expect(shouldRetryRepairStall(new Error("REPAIR_FAILED: exit=124 timeout"), 0, timeoutSession("s2"))).toBe(true);
    expect(shouldRetryRepairStall(new Error("REPAIR_FAILED: STALLED_FIRST_ACTIVITY"), 1, stallSession("s1"))).toBe(false);
    expect(shouldRetryRepairStall(new Error("REPAIR_RESULT_INVALID: schema rejected payload"), 0, okSession("s3"))).toBe(false);
    expect(shouldRetryRepairStall(new Error("AEH_RESULT_PROVENANCE: unbound session"), 0, okSession("s4"))).toBe(false);
    expect(shouldRetryRepairStall(new Error("CANDIDATE_WORKSPACE_MISMATCH: stale candidate"), 0, okSession("s5"))).toBe(false);
    expect(shouldRetryRepairStall(new Error("SOME_OTHER_FAILURE: boom"), 0, okSession("s6"))).toBe(false);
  });

  it("retries once with identical inputs after a stall-kill then succeeds (fresh session, same prompt)", async () => {
    const prompts: string[] = [];
    const execute = vi.fn(async (prompt: string) => {
      prompts.push(prompt);
      if (prompts.length === 1) return { session: stallSession("stall-1") };
      return { session: okSession("ok-2") };
    });
    const frozenPrompt = "repair prompt identical inputs";
    const result = await withBoundedRepairStallRetryV1({ prompt: frozenPrompt, execute });
    expect(result.session.exitCode).toBe(0);
    expect(result.session.id).toBe("ok-2");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(prompts).toEqual([frozenPrompt, frozenPrompt]);
    // Structured diagnostics preserved through the retry path.
    expect(result.session.activityCounts).toEqual({ updatesObserved: 2, toolEvents: 1, assistantDelta: true });
  });

  it("rethrows the original stall class after two consecutive stall kills (fail-closed)", async () => {
    const execute = vi.fn(async () => ({ session: stallSession("stall-x") }));
    await expect(
      withBoundedRepairStallRetryV1({ prompt: "p", execute }),
    ).rejects.toThrow(/STALLED_FIRST_ACTIVITY|exit=124|timeout/i);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry INVALID payload rejections and preserves the terminal error", async () => {
    const execute = vi.fn(async () => {
      throw new Error("REPAIR_RESULT_INVALID: schema rejected payload");
    });
    await expect(withBoundedRepairStallRetryV1({ prompt: "p", execute })).rejects.toThrow(/REPAIR_RESULT_INVALID/);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("retries a thrown stall kill once then succeeds", async () => {
    const execute = vi.fn(async () => {
      const call = execute.mock.calls.length;
      if (call === 1) throw new Error("REPAIR_FAILED: STALLED_FIRST_ACTIVITY: zero activity");
      return { session: okSession("ok-2") };
    });
    const result = await withBoundedRepairStallRetryV1({ prompt: "p", execute });
    expect(result.session.exitCode).toBe(0);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
