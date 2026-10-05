import { describe, expect, it, vi } from "vitest";
import {
  FIRST_ACTIVITY_DEADLINE_MS,
  PROVIDER_TURN_DEADLINE_MS,
  SEMANTIC_MODEL_DEADLINE_MS_V1,
  classifyProviderTurnKillReason,
  hasProviderVisibleActivity,
  stalledFirstActivityError,
  type ProviderTurnKillReason
} from "../src/paseo/firstActivityDeadline.js";
import { isContentTimelineEnvelope, waitForPaseoAgentHandle } from "../src/paseo/native.js";
import {
  countNewRunToolKeys,
  extractRunToolKeys,
  runActivityHasGrown,
  runPaseoSdkAgentWithClient
} from "../src/paseo/sdk.js";

describe("first-activity deadline constants", () => {
  it("holds a conservative bound strictly under the provider turn deadline", () => {
    // TRADEOFF (not closure): residual false-stall risk is real — the SDK
    // path cannot measure time-to-first-activity and a healthy 27.7min
    // completion was observed, so a healthy-but-silent-past-25min turn is
    // still stopped. Accepted because all 14 observed timeouts were
    // zero-activity stalls, the kill routes into existing bounded retry
    // (fresh turns median ~2min), the 30min hard cap is unchanged, and
    // STALLED stays distinguishable from DEADLINE for forensics.
    // Stop-then-read guarantees correct CLASSIFICATION + content
    // preservation, not turn preservation.
    expect(FIRST_ACTIVITY_DEADLINE_MS).toBe(25 * 60_000);
    expect(PROVIDER_TURN_DEADLINE_MS).toBe(30 * 60_000);
    expect(FIRST_ACTIVITY_DEADLINE_MS).toBeLessThan(PROVIDER_TURN_DEADLINE_MS);
    // Retry-recovery existence: stall text routes into existing budgets.
    expect(
      stalledFirstActivityError(1_500_000, 1_800_000, { updatesObserved: 0, toolEventCount: 0, assistantDelta: false })
    ).toContain("existing retry budgets apply");
    // Forensics: STALLED stays distinguishable from DEADLINE.
    expect(
      classifyProviderTurnKillReason({ exitCode: 124, stderr: stalledFirstActivityError(1_500_000, 1_800_000, { updatesObserved: 0, toolEventCount: 0, assistantDelta: false }) })
    ).toBe("STALLED_FIRST_ACTIVITY");
    expect(
      classifyProviderTurnKillReason({ exitCode: 124, stderr: "Provider turn deadline expired after 1800000ms" })
    ).toBe("DEADLINE");
  });

  it("stays far above the semantic model deadline so bounded reasoning is never cut", () => {
    expect(SEMANTIC_MODEL_DEADLINE_MS_V1).toBe(300_000);
    expect(FIRST_ACTIVITY_DEADLINE_MS).toBe(5 * SEMANTIC_MODEL_DEADLINE_MS_V1);
    expect(FIRST_ACTIVITY_DEADLINE_MS).toBeGreaterThan(SEMANTIC_MODEL_DEADLINE_MS_V1);
  });
});

describe("hasProviderVisibleActivity", () => {
  it("is false for zero provider-visible signals", () => {
    expect(hasProviderVisibleActivity({ updatesObserved: 0, toolEventCount: 0, assistantDelta: false })).toBe(false);
  });

  it("counts tool-call events as activity", () => {
    expect(hasProviderVisibleActivity({ updatesObserved: 0, toolEventCount: 1, assistantDelta: false })).toBe(true);
  });

  it("counts assistant stream output as activity", () => {
    expect(hasProviderVisibleActivity({ updatesObserved: 0, toolEventCount: 0, assistantDelta: true })).toBe(true);
  });

  it("does not count bare subscription updates without content", () => {
    expect(hasProviderVisibleActivity({ updatesObserved: 3, toolEventCount: 0, assistantDelta: false })).toBe(false);
  });
});

describe("classifyProviderTurnKillReason", () => {
  it("distinguishes stall kills from deadline kills", () => {
    expect(classifyProviderTurnKillReason({ exitCode: 124, stderr: stalledFirstActivityError(1_500_000, 1_800_000, { updatesObserved: 0, toolEventCount: 0, assistantDelta: false }) })).toBe("STALLED_FIRST_ACTIVITY");
    expect(classifyProviderTurnKillReason({ exitCode: 124, stderr: "Provider turn deadline expired after 1800000ms" })).toBe("DEADLINE");
  });

  it("reports error kills for non-timeout failures", () => {
    const reason: ProviderTurnKillReason = classifyProviderTurnKillReason({ exitCode: 1, stderr: "provider exploded" });
    expect(reason).toBe("ERROR");
  });
});

describe("isContentTimelineEnvelope (native content-tie)", () => {
  it("counts tool-call timeline items as content", () => {
    expect(isContentTimelineEnvelope({
      agentId: "a",
      event: { type: "timeline", item: { type: "tool_call", status: "running", callId: "c1", name: "read", detail: { type: "read" } } }
    })).toBe(true);
  });

  it("counts assistant-output timeline items as content", () => {
    expect(isContentTimelineEnvelope({
      agentId: "a",
      event: { type: "timeline", item: { type: "assistant_message", text: "working on it" } }
    })).toBe(true);
  });

  it("ignores empty, metadata-only, and turn-marker envelopes", () => {
    expect(isContentTimelineEnvelope({ agentId: "a", event: { type: "timeline" } })).toBe(false);
    expect(isContentTimelineEnvelope({ agentId: "a", event: { type: "timeline", item: { type: "heartbeat", at: "now" } } })).toBe(false);
    expect(isContentTimelineEnvelope({ agentId: "a", event: { type: "turn_completed", turnId: "t1" } })).toBe(false);
    expect(isContentTimelineEnvelope({ agentId: "a", event: { type: "turn_started", turnId: "t1" } })).toBe(false);
    expect(isContentTimelineEnvelope({ ping: 1 })).toBe(false);
    expect(isContentTimelineEnvelope(undefined)).toBe(false);
  });
});

describe("native wait first-activity deadline (no Paseo)", () => {
  it("kills a simulated idle turn at the first-activity bound with a stall reason", async () => {
    const unsubscribe = vi.fn();
    const handle = {
      id: "agent-stalled",
      subscribe: vi.fn(() => unsubscribe),
      refetch: vi.fn(async () => ({ agent: { id: "agent-stalled", status: "working" } })),
      timeline: { refetch: vi.fn(async () => ({ entries: [] })) }
    };

    const started = Date.now();
    const result = await waitForPaseoAgentHandle(handle, 5_000, undefined, 10, false, undefined, undefined, 50);
    const elapsed = Date.now() - started;

    expect(result.status).toBe("timeout");
    expect(result.killReason).toBe("STALLED_FIRST_ACTIVITY");
    expect(result.error).toContain("STALLED_FIRST_ACTIVITY");
    expect(elapsed).toBeLessThan(5_000);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("an empty-timeline flood never satisfies the bound", async () => {
    let timelineUpdate: ((value: unknown) => void) | undefined;
    const unsubscribe = vi.fn();
    const handle = {
      id: "agent-flooded",
      subscribe: vi.fn(() => unsubscribe),
      refetch: vi.fn(async () => ({ agent: { id: "agent-flooded", status: "working" } })),
      timeline: {
        refetch: vi.fn(async () => ({ entries: [] })),
        subscribe: vi.fn((handler: (value: unknown) => void) => { timelineUpdate = handler; return vi.fn(); })
      }
    };

    const waiting = waitForPaseoAgentHandle(handle, 5_000, undefined, 10, true, undefined, undefined, 60);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Flood with 50 empty/metadata envelopes: no tool events, no assistant output.
    for (let index = 0; index < 50; index += 1) {
      timelineUpdate?.({ agentId: "agent-flooded", event: { type: "timeline", timestamp: new Date().toISOString() } });
      timelineUpdate?.({ agentId: "agent-flooded", event: { type: "turn_completed", turnId: `t-${index}` } });
      timelineUpdate?.({ agentId: "agent-flooded", event: { type: "timeline", item: { type: "heartbeat" } } });
    }
    const result = await waiting;

    expect(result.status).toBe("timeout");
    expect(result.killReason).toBe("STALLED_FIRST_ACTIVITY");
    expect(result.activity?.toolEvents).toBe(0);
    expect(result.activity?.assistantDelta).toBe(false);
  });

  it("leaves an active turn unaffected", async () => {
    let status = "working";
    let agentUpdate: (() => void) | undefined;
    let timelineUpdate: ((value: unknown) => void) | undefined;
    const unsubscribe = vi.fn();
    const handle = {
      id: "agent-active",
      subscribe: vi.fn((handler: () => void) => { agentUpdate = handler; return unsubscribe; }),
      refetch: vi.fn(async () => ({ agent: { id: "agent-active", status } })),
      timeline: {
        refetch: vi.fn(async () => ({ entries: [{ type: "assistant_message", text: "done" }] })),
        subscribe: vi.fn((handler: (value: unknown) => void) => { timelineUpdate = handler; return vi.fn(); })
      }
    };

    const waiting = waitForPaseoAgentHandle(handle, 5_000, undefined, 10, true, undefined, undefined, 1_200_000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    timelineUpdate?.({ agentId: "agent-active", event: { type: "timeline", item: { type: "tool_call", status: "running", callId: "call-1", name: "read", detail: { type: "read" } }, timestamp: new Date().toISOString() } });
    status = "idle";
    agentUpdate?.();
    const result = await waiting;

    expect(result.status).toBe("idle");
    expect(result.killReason).toBeUndefined();
    expect(result.error).toBeUndefined();
  });
});

describe("sdk monotonic growth tracking (no Paseo)", () => {
  const toolEntry = (callId: string) => ({
    item: { type: "tool_call", status: "completed", callId, name: "read", detail: { type: "read" } }
  });

  it("detects new tool keys without saturating at the tail window", () => {
    const baseline = {
      toolKeys: Array.from({ length: 20 }, (_, index) => `id:old-${index}`),
      assistantText: undefined,
      lastMessage: undefined,
      observed: true
    };
    // 21+ new tool calls: the tail holds only the newest 20, all absent from baseline.
    const current = {
      toolKeys: Array.from({ length: 20 }, (_, index) => `id:new-${index}`),
      assistantText: undefined,
      lastMessage: undefined,
      observed: true
    };
    expect(runActivityHasGrown(baseline, current)).toBe(true);
    expect(countNewRunToolKeys(baseline, current)).toBe(20);
  });

  it("an empty-timeline flood is never growth and never resets", () => {
    const baseline = {
      toolKeys: ["id:old-1"],
      assistantText: "prior output",
      lastMessage: "prior snapshot",
      observed: true
    };
    const flooded = { toolKeys: [], assistantText: undefined, lastMessage: "prior snapshot", observed: false };
    expect(runActivityHasGrown(baseline, flooded)).toBe(false);
    expect(countNewRunToolKeys(baseline, flooded)).toBe(0);
    expect(extractRunToolKeys([{ type: "heartbeat" }, { item: { type: "note", text: "meta" } }])).toEqual([]);
  });

  it("tracks assistant deltas as growth", () => {
    const baseline = { toolKeys: [], assistantText: "hello", lastMessage: undefined, observed: true };
    expect(runActivityHasGrown(baseline, { toolKeys: [], assistantText: "hello world", lastMessage: undefined, observed: true })).toBe(true);
    expect(runActivityHasGrown(baseline, { toolKeys: [], assistantText: "hello", lastMessage: undefined, observed: true })).toBe(false);
  });
});

describe("sdk atomic-run first-activity deadline (no Paseo)", () => {
  it("kills a simulated idle run at the first-activity bound with a stall reason", async () => {
    const stop = vi.fn(async () => undefined);
    const handle = {
      id: "agent-sdk-stalled",
      run: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        return { status: "idle", lastMessage: "too late" };
      }),
      stop,
      refetch: vi.fn(async () => ({ agent: { id: "agent-sdk-stalled", status: "working" } })),
      timeline: { refetch: vi.fn(async () => ({ entries: [] })) }
    };
    const client = { agents: { ref: vi.fn(() => handle) } };

    const started = Date.now();
    const result = await runPaseoSdkAgentWithClient(client as never, "agent-sdk-stalled", "work", 5_000, undefined, undefined, { firstActivityMs: 50, pollMs: 10 });
    const elapsed = Date.now() - started;

    expect(result.status).toBe("timeout");
    expect(result.killReason).toBe("STALLED_FIRST_ACTIVITY");
    expect(result.error).toContain("STALLED_FIRST_ACTIVITY");
    expect(result.activity?.toolEvents).toBe(0);
    expect(elapsed).toBeLessThan(5_000);
    expect(stop).toHaveBeenCalled();
  });

  it("tracks 21+ tool calls without saturating and leaves the run unaffected", async () => {
    const oldEntries = Array.from({ length: 20 }, (_, index) => ({
      item: { type: "tool_call", status: "completed", callId: `old-${index}`, name: "read", detail: { type: "read" } }
    }));
    const newEntries = Array.from({ length: 20 }, (_, index) => ({
      item: { type: "tool_call", status: "completed", callId: `new-${index}`, name: "read", detail: { type: "read" } }
    }));
    // First refetch is the pre-run baseline; every later poll sees the newest
    // tail (all new keys) even though 21+ tool calls arrived — no saturation.
    let calls = 0;
    const handle = {
      id: "agent-sdk-many-tools",
      run: vi.fn(async () => ({ status: "idle", lastMessage: "done with many tools" })),
      refetch: vi.fn(async () => ({ agent: { id: "agent-sdk-many-tools", status: "idle" } })),
      timeline: {
        refetch: vi.fn(async () => {
          calls += 1;
          return calls === 1 ? { entries: oldEntries } : { entries: newEntries };
        })
      }
    };
    const client = { agents: { ref: vi.fn(() => handle) } };

    const result = await runPaseoSdkAgentWithClient(client as never, "agent-sdk-many-tools", "work", 5_000, undefined, undefined, { firstActivityMs: 200, pollMs: 10 });

    expect(result.status).toBe("idle");
    expect(result.lastMessage).toBe("done with many tools");
    expect(result.killReason).toBeUndefined();
  });

  it("stop-then-read: late post-stop activity is DEADLINE with forensics, never STALLED", async () => {
    // ORDERING INVARIANT: stop FIRST freezes the turn, then the authoritative
    // post-stop read decides. The timeline is empty during the race and gains
    // content only once stop() freezes the turn — a read-before-stop
    // implementation would misclassify this as STALLED.
    let stopped = false;
    const stop = vi.fn(async () => { stopped = true; });
    const handle = {
      id: "agent-sdk-late",
      run: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        return { status: "idle", lastMessage: "too late" };
      }),
      stop,
      refetch: vi.fn(async () => ({ agent: { id: "agent-sdk-late", status: "working" } })),
      timeline: {
        refetch: vi.fn(async () =>
          stopped
            ? { entries: [{ item: { type: "tool_call", status: "running", callId: "late-1", name: "read", detail: { type: "read" } } }] }
            : { entries: [] }
        )
      }
    };
    const client = { agents: { ref: vi.fn(() => handle) } };

    const result = await runPaseoSdkAgentWithClient(client as never, "agent-sdk-late", "work", 5_000, undefined, undefined, { firstActivityMs: 50, pollMs: 10 });

    expect(stop).toHaveBeenCalled();
    // Turn still failed by stop, but classified correctly with activity.
    expect(result.status).toBe("timeout");
    expect(result.killReason).not.toBe("STALLED_FIRST_ACTIVITY");
    expect(result.killReason).toBe("DEADLINE");
    expect(result.activity?.toolEvents).toBeGreaterThan(0);
    expect(result.error).not.toContain("STALLED_FIRST_ACTIVITY");
  });

  it("leaves an active run unaffected", async () => {
    const handle = {
      id: "agent-sdk-active",
      run: vi.fn(async () => ({ status: "idle", lastMessage: "done" })),
      refetch: vi.fn(async () => ({ agent: { id: "agent-sdk-active", status: "idle" } })),
      timeline: { refetch: vi.fn(async () => ({ entries: [] })) }
    };
    const client = { agents: { ref: vi.fn(() => handle) } };

    const result = await runPaseoSdkAgentWithClient(client as never, "agent-sdk-active", "work", 5_000, undefined, undefined, { firstActivityMs: 50, pollMs: 10 });

    expect(result.status).toBe("idle");
    expect(result.lastMessage).toBe("done");
    expect(result.killReason).toBeUndefined();
  });
});
