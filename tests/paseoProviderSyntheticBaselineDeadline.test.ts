import { describe, expect, it, vi } from "vitest";
import { runPaseoSdkAgentWithClient } from "../src/paseo/sdk.js";

/**
 * RED for Luna round-4 blocker on `ru/provider-stallbound-2` (tip f75f20b):
 * synthetic empty baseline + pre-existing content → `observed` set → stall
 * timer defers to provider wait instead of firing STALLED_FIRST_ACTIVITY.
 *
 * Synthetic-baseline mode must be deadline-ONLY: when baseline capture failed,
 * progress is unprovable (any content seen after entry may pre-date entry),
 * so the `observed` flag must NOT suppress the stall verdict. Timer expiry
 * in synthetic mode always returns STALLED_FIRST_ACTIVITY.
 */

function failingThenContentTimeline() {
  const content = {
    entries: [{ type: "tool_call", callId: "pre-existing-1", name: "bash", status: "done" }],
  };
  const refetch = vi.fn((..._args: unknown[]) => {
    const call = refetch.mock.calls.length;
    if (call === 1) {
      throw new Error("baseline capture boom");
    }
    return Promise.resolve(content);
  });
  return { refetch };
}

describe("RED: synthetic baseline is deadline-ONLY (observed must not suppress stall)", () => {
  it("waitForFinish fallback: capture-fails + pre-existing content + timer expiry → STALLED", async () => {
    const handle = {
      id: "agent-sdk-wait-synthetic-content",
      send: vi.fn(async () => undefined),
      waitForFinish: vi.fn(async (ms?: number) => {
        await new Promise((resolve) => setTimeout(resolve, ms ?? 300));
        return { status: "timeout", error: `Timed out after ${ms ?? 300}ms.` };
      }),
      stop: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      refetch: vi.fn(async () => ({ agent: { id: "agent-sdk-wait-synthetic-content", status: "working" } })),
      timeline: failingThenContentTimeline(),
    };
    const client = { agents: { ref: vi.fn(() => handle) } };
    const result = await runPaseoSdkAgentWithClient(
      client as never,
      "agent-sdk-wait-synthetic-content",
      "work",
      300,
      undefined,
      undefined,
      { firstActivityMs: 50, pollMs: 10 }
    );
    expect(result.status).toBe("timeout");
    expect(result.killReason).toBe("STALLED_FIRST_ACTIVITY");
    expect(result.error).toContain("STALLED_FIRST_ACTIVITY");
    expect(handle.cancel.mock.calls.length + handle.stop.mock.calls.length).toBeGreaterThan(0);
  });

  it("polling fallback: capture-fails + pre-existing content + timer expiry → STALLED", async () => {
    const handle = {
      id: "agent-sdk-poll-synthetic-content",
      send: vi.fn(async () => undefined),
      // No waitForFinish: forces the bare status-poll fallback inside waitForHandle.
      stop: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      refetch: vi.fn(async () => ({ agent: { id: "agent-sdk-poll-synthetic-content", status: "working" } })),
      timeline: failingThenContentTimeline(),
    };
    const client = { agents: { ref: vi.fn(() => handle) } };
    const result = await runPaseoSdkAgentWithClient(
      client as never,
      "agent-sdk-poll-synthetic-content",
      "work",
      800,
      undefined,
      undefined,
      { firstActivityMs: 50, pollMs: 10 }
    );
    expect(result.status).toBe("timeout");
    expect(result.killReason).toBe("STALLED_FIRST_ACTIVITY");
    expect(result.error).toContain("STALLED_FIRST_ACTIVITY");
  });
});
