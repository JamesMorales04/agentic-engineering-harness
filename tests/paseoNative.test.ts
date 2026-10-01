import { describe, expect, it, vi } from "vitest";
import {
  contextUsageFromPaseoSnapshot,
  normalizePaseoNativeAgent,
  waitForPaseoAgentHandle
} from "../src/paseo/native.js";

describe("Paseo native observability", () => {
  it("normalizes canonical AgentSnapshot lastUsage", () => {
    const snapshot = normalizePaseoNativeAgent({
      id: "agent-1",
      status: "idle",
      workspaceId: "workspace-1",
      labels: { "aeh.kind": "lead" },
      lastUsage: {
        inputTokens: 100,
        outputTokens: 20,
        contextWindowUsedTokens: 80_000,
        contextWindowMaxTokens: 100_000
      }
    });
    expect(snapshot.lastUsage).toEqual(
      expect.objectContaining({
        contextWindowUsedTokens: 80_000,
        contextWindowMaxTokens: 100_000
      })
    );
    expect(contextUsageFromPaseoSnapshot(snapshot)).toEqual({
      used: 80_000,
      limit: 100_000,
      ratio: 0.8,
      source: "paseo-agent-snapshot",
      availability: "available"
    });
  });

  it("does not substitute generic token counters for context-window usage", () => {
    const snapshot = normalizePaseoNativeAgent({
      id: "agent-1",
      status: "idle",
      lastUsage: { inputTokens: 90_000, outputTokens: 1_000 }
    });
    expect(contextUsageFromPaseoSnapshot(snapshot)).toEqual({
      used: undefined,
      limit: undefined,
      source: "paseo-agent-snapshot",
      availability: "provider-usage-unavailable"
    });
  });

  it("closes the completed-before-subscribe race from the fresh timeline", async () => {
    const unsubscribe = vi.fn();
    const handle = {
      id: "agent-fast",
      subscribe: vi.fn(() => unsubscribe),
      refetch: vi.fn(async () => ({
        agent: { id: "agent-fast", status: "idle", workspaceId: "workspace-1" }
      })),
      timeline: {
        refetch: vi.fn(async () => ({
          entries: [
            { type: "user_message", text: "work" },
            { type: "assistant_message", text: "already done" }
          ]
        }))
      }
    };

    const result = await waitForPaseoAgentHandle(handle, 2_000);
    expect(result).toEqual(
      expect.objectContaining({
        id: "agent-fast",
        status: "idle",
        lastMessage: "already done",
        updatesObserved: 0
      })
    );
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("leaves structured timeline capture off unless efficiency telemetry is enabled", async () => {
    let status = "working";
    let agentUpdate: (() => void) | undefined;
    const timelineSubscribe = vi.fn(() => vi.fn());
    const timelineRefetch = vi.fn(async () => ({ entries: [{ type: "assistant_message", text: "done" }] }));
    const handle = {
      id: "agent-telemetry-disabled",
      subscribe: vi.fn((handler: () => void) => { agentUpdate = handler; return vi.fn(); }),
      refetch: vi.fn(async () => ({ agent: { id: "agent-telemetry-disabled", status } })),
      timeline: { refetch: timelineRefetch, subscribe: timelineSubscribe }
    };
    const waiting = waitForPaseoAgentHandle(handle, 2_000, undefined, 10);
    await new Promise((resolve) => setTimeout(resolve, 0));
    status = "idle";
    agentUpdate?.();
    const result = await waiting;
    expect(result.lastMessage).toBe("done");
    expect(result.efficiencyTelemetry).toBeUndefined();
    expect(timelineSubscribe).not.toHaveBeenCalled();
    expect(timelineRefetch).toHaveBeenCalledWith({ direction: "tail", limit: 50 });
  });

  it("captures provider turns and canonical tool calls when local efficiency telemetry is enabled", async () => {
    let status = "working";
    let agentUpdate: (() => void) | undefined;
    let timelineUpdate: ((value: unknown) => void) | undefined;
    const handle = {
      id: "agent-telemetry-enabled",
      subscribe: vi.fn((handler: () => void) => { agentUpdate = handler; return vi.fn(); }),
      refetch: vi.fn(async () => ({ agent: { id: "agent-telemetry-enabled", status, lastUsage: { inputTokens: 90, outputTokens: 20, contextWindowUsedTokens: 128 } } })),
      timeline: {
        subscribe: vi.fn((handler: (value: unknown) => void) => {
          timelineUpdate = handler;
          const unsubscribe = vi.fn();
          Object.assign(unsubscribe, { ready: Promise.resolve() });
          return unsubscribe;
        }),
        refetch: vi.fn(async () => ({
          projection: "canonical", gap: false, reset: false, staleCursor: false, hasOlder: false,
          entries: [{ provider: "openai", item: { type: "tool_call", status: "failed", callId: "call-1", name: "shell", detail: { type: "shell", command: "private command" }, metadata: { server: "local-shell" }, error: { code: "timeout" } }, turnId: "turn-1", timestamp: "2026-01-01T00:00:02.000Z", seqStart: 2, seqEnd: 2, collapsed: [] }]
        }))
      }
    };
    const waiting = waitForPaseoAgentHandle(handle, 2_000, undefined, 10, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    timelineUpdate?.({ event: { type: "turn_started", provider: "openai", turnId: "turn-1", timestamp: "2026-01-01T00:00:01.000Z" } });
    timelineUpdate?.({ event: { type: "turn_completed", provider: "openai", turnId: "turn-1", timestamp: "2026-01-01T00:00:03.000Z", usage: { inputTokens: 90, cachedInputTokens: 10, outputTokens: 20, totalCostUsd: 0.01 } } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    status = "idle";
    agentUpdate?.();
    const result = await waiting;
    expect(result.efficiencyTelemetry).toMatchObject({
      source: "PROVIDER_TURN_EVENTS",
      coverage: "COMPLETE",
      turnCount: 1,
      turns: [{ turnId: "turn-1", inputTokens: 90, cachedInputTokens: 10, outputTokens: 20, costUsd: 0.01 }],
      toolCalls: [{ callId: "call-1", toolName: "shell", outcome: "TIMEOUT" }]
    });
    expect(JSON.stringify(result.efficiencyTelemetry)).not.toContain("private command");
  });

  it("accepts a completed structured turn from changed lastUserMessageAt even without assistant text", async () => {
    const unsubscribe = vi.fn();
    const handle = {
      id: "agent-structured-fast",
      subscribe: vi.fn(() => unsubscribe),
      refetch: vi.fn(async () => ({
        agent: {
          id: "agent-structured-fast",
          status: "idle",
          workspaceId: "workspace-1",
          lastUserMessageAt: "2026-08-13T01:31:15.000Z"
        }
      })),
      timeline: {
        refetch: vi.fn(async () => ({ entries: [] }))
      }
    };

    const result = await waitForPaseoAgentHandle(handle, 2_000, {
      lastUserMessageAt: "2026-08-13T01:31:10.000Z"
    });

    expect(result).toEqual(
      expect.objectContaining({
        id: "agent-structured-fast",
        status: "idle",
        workspaceId: "workspace-1",
        updatesObserved: 0
      })
    );
    expect(result.lastMessage).toBeUndefined();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("waits on subscription updates when the initial idle snapshot has no completed turn", async () => {
    let status = "idle";
    let completed = false;
    let subscriber: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const handle = {
      id: "agent-1",
      subscribe: vi.fn((handler: () => void) => {
        subscriber = handler;
        return unsubscribe;
      }),
      refetch: vi.fn(async () => ({
        agent: { id: "agent-1", status, workspaceId: "workspace-1" }
      })),
      timeline: {
        refetch: vi.fn(async () => ({
          entries: completed ? [{ type: "assistant_message", text: "done" }] : []
        }))
      }
    };

    const waiting = waitForPaseoAgentHandle(handle, 2_000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    status = "working";
    subscriber?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    status = "idle";
    completed = true;
    subscriber?.();

    const result = await waiting;
    expect(result).toEqual(
      expect.objectContaining({
        id: "agent-1",
        status: "idle",
        workspaceId: "workspace-1",
        lastMessage: "done",
        source: "paseo-agent-subscription"
      })
    );
    expect(result.updatesObserved).toBeGreaterThanOrEqual(1);
    expect(handle.subscribe).toHaveBeenCalledTimes(1);
    expect(handle.refetch).toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("polls the canonical snapshot when the provider never emits updates", async () => {
    let status = "working";
    let done = false;
    const unsubscribe = vi.fn();
    const handle = {
      id: "agent-quiet",
      subscribe: vi.fn(() => unsubscribe),
      refetch: vi.fn(async () => ({
        agent: { id: "agent-quiet", status, workspaceId: "workspace-1", lastUserMessageAt: "2026-09-26T23:43:42.000Z" }
      })),
      timeline: {
        refetch: vi.fn(async () => ({ entries: done ? [{ type: "assistant_message", text: "done" }] : [] }))
      }
    };
    setTimeout(() => { status = "idle"; done = true; }, 30);
    const result = await waitForPaseoAgentHandle(handle, 5_000, undefined, 10);
    expect(result).toEqual(
      expect.objectContaining({
        id: "agent-quiet",
        status: "idle",
        lastMessage: "done"
      })
    );
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("does not treat metadata-only updates plus stale assistant output as turn completion", async () => {
    let status = "idle";
    let message = "previous turn";
    let subscriber: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const handle = {
      id: "agent-reused",
      subscribe: vi.fn((handler: () => void) => {
        subscriber = handler;
        return unsubscribe;
      }),
      refetch: vi.fn(async () => ({
        agent: {
          id: "agent-reused",
          status,
          workspaceId: "workspace-1",
          lastUserMessageAt: "2026-08-13T01:00:00.000Z"
        }
      })),
      timeline: {
        refetch: vi.fn(async () => ({
          entries: [{ type: "assistant_message", text: message }]
        }))
      }
    };

    let settled = false;
    const waiting = waitForPaseoAgentHandle(handle, 2_000, {
      lastAssistantMessage: "previous turn",
      lastUserMessageAt: "2026-08-13T01:00:00.000Z"
    }).then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // A metadata-only notification while the agent remains idle must not satisfy
    // the turn barrier when both assistant text and user-turn identity are stale.
    subscriber?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    status = "working";
    subscriber?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    status = "idle";
    message = "new turn";
    subscriber?.();

    const result = await waiting;
    expect(result).toEqual(expect.objectContaining({
      id: "agent-reused",
      status: "idle",
      lastMessage: "new turn"
    }));
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
