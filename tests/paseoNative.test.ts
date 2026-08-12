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
});
