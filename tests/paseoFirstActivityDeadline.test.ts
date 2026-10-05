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
import { waitForPaseoAgentHandle } from "../src/paseo/native.js";
import { runPaseoSdkAgentWithClient } from "../src/paseo/sdk.js";

describe("first-activity deadline constants", () => {
  it("holds a generous bound strictly under the provider turn deadline", () => {
    expect(FIRST_ACTIVITY_DEADLINE_MS).toBe(20 * 60_000);
    expect(PROVIDER_TURN_DEADLINE_MS).toBe(30 * 60_000);
    expect(FIRST_ACTIVITY_DEADLINE_MS).toBeLessThan(PROVIDER_TURN_DEADLINE_MS);
  });

  it("stays far above the semantic model deadline so bounded reasoning is never cut", () => {
    expect(SEMANTIC_MODEL_DEADLINE_MS_V1).toBe(300_000);
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
    expect(classifyProviderTurnKillReason({ exitCode: 124, stderr: stalledFirstActivityError(1_200_000, 60_000, { updatesObserved: 0, toolEventCount: 0 }) })).toBe("STALLED_FIRST_ACTIVITY");
    expect(classifyProviderTurnKillReason({ exitCode: 124, stderr: "Provider turn deadline expired after 1800000ms" })).toBe("DEADLINE");
  });

  it("reports error kills for non-timeout failures", () => {
    const reason: ProviderTurnKillReason = classifyProviderTurnKillReason({ exitCode: 1, stderr: "provider exploded" });
    expect(reason).toBe("ERROR");
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
    expect(elapsed).toBeLessThan(5_000);
    expect(stop).toHaveBeenCalled();
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
