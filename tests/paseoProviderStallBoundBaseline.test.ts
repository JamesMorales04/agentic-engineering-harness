import { describe, expect, it, vi } from "vitest";
import { runPaseoSdkAgentWithClient } from "../src/paseo/sdk.js";

/**
 * RED-first regression for Luna blocker on pr/provider-turn-hardening:
 * fallback waits must carry the first-activity stall bound even when
 * baseline capture fails. Both stubs force `captureRunActivityBaseline`
 * to throw (sync-throwing timeline.refetch), so the current code synthesizes
 * no baseline and leaves the wait unbounded (bare DEADLINE). The fix must
 * synthesize a zero-activity baseline at fallback entry so the deadline is
 * always armed and settles STALLED_FIRST_ACTIVITY.
 */

function failingTimeline() {
  // Force baseline capture to throw exactly once (sync throw escapes the
  // internal `.catch` in captureRunActivityBaseline), then behave as an
  // empty timeline so post-fix stall verdicts and pre-fix turnResult reads
  // succeed. Pre-fix code leaves the wait unbounded (bare DEADLINE);
  // post-fix code must synthesize a zero-activity baseline and fire STALLED.
  const refetch = vi.fn((..._args: unknown[]) => {
    const call = refetch.mock.calls.length;
    if (call === 1) {
      throw new Error("baseline capture boom");
    }
    return Promise.resolve({ entries: [] });
  });
  return { refetch };
}

describe("RED: baseline-capture failure still arms the stall bound", () => {
  it("waitForFinish fallback with baseline failure fires STALLED, not bare DEADLINE", async () => {
    const handle = {
      id: "agent-sdk-wait-baseline-fail",
      send: vi.fn(async () => undefined),
      waitForFinish: vi.fn(async (ms?: number) => {
        await new Promise((resolve) => setTimeout(resolve, ms ?? 300));
        return { status: "timeout", error: `Timed out after ${ms ?? 300}ms.` };
      }),
      stop: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      refetch: vi.fn(async () => ({ agent: { id: "agent-sdk-wait-baseline-fail", status: "working" } })),
      timeline: failingTimeline(),
    };
    const client = { agents: { ref: vi.fn(() => handle) } };
    const result = await runPaseoSdkAgentWithClient(
      client as never,
      "agent-sdk-wait-baseline-fail",
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

  it("polling fallback with baseline failure fires STALLED, not bare DEADLINE", async () => {
    const handle = {
      id: "agent-sdk-poll-baseline-fail",
      send: vi.fn(async () => undefined),
      // No waitForFinish: forces the bare status-poll fallback inside waitForHandle.
      stop: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      refetch: vi.fn(async () => ({ agent: { id: "agent-sdk-poll-baseline-fail", status: "working" } })),
      timeline: failingTimeline(),
    };
    const client = { agents: { ref: vi.fn(() => handle) } };
    const result = await runPaseoSdkAgentWithClient(
      client as never,
      "agent-sdk-poll-baseline-fail",
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
