import { afterEach, describe, expect, it, vi } from "vitest";
import { runPaseoSdkAgentWithClient, dispatchPaseoSdkAgentWithClient } from "../src/paseo/sdk.js";
import {
  derivePaseoTurnIdempotencyKey,
  launchManagedPaseoAgent,
  waitManagedPaseoAgent,
} from "../src/paseo/runtimeCore.js";
import {
  isDiscoveryPlanningStallKill,
  shouldRetryDiscoveryPlanningStall,
  shouldRetrySpecManagerStall,
} from "../src/operations/change.js";
import { shouldRetrySupervisorConsolidationStall } from "../src/operations/supervisor.js";
import { shouldRetryRepairStall } from "../src/core/run.js";
import { stalledFirstActivityError } from "../src/paseo/firstActivityDeadline.js";
import type { WorkerSession } from "../src/core/types.js";

/**
 * RED-first regression for the fail-closed retry path (Luna blockers A1–A4).
 * Each block demonstrates currently-wrong behavior on the base branch and
 * must pass post-fix. No Paseo daemon; all provider boundaries are stubbed.
 *
 * MECHANISM notes: quiescence/uncertainty are DETERMINISTIC (status + stop
 * ack inspections only); first-activity watches are DETERMINISTIC
 * (timeline/snapshot growth polls); ambiguity resolution is DETERMINISTIC
 * (label-bound stop-all + re-list).
 */

function capabilities() {
  return { version: "0.6.0", background: true, quiet: true, json: false, outputSchema: true, daemonJson: true, nativeToolsRecommended: true };
}

function baseDeps(overrides: Record<string, unknown> = {}) {
  const sdk = {
    create: vi.fn(async () => ({ id: "sdk-agent", status: "working", lastMessage: "created" })),
    materialize: vi.fn(async () => { throw new Error("not used"); }),
    dispatch: vi.fn(async () => { throw new Error("not used"); }),
    wait: vi.fn(async (_root: string, agentId: string) => ({ id: agentId, status: "idle", lastMessage: "sdk wait done" })),
    run: vi.fn(),
    probe: vi.fn(async () => true),
    inspect: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
    ...overrides,
  };
  const native = {
    preflight: vi.fn(async (_root: string, provider: string) => ({ ok: true, provider, source: "test", message: "ok" })),
    preflightMode: vi.fn(async (_root: string, provider: string, modeId: string) => ({ ok: true, provider, modeId, availableModes: [modeId], source: "test", message: "ok" })),
    wait: vi.fn(async (_root: string, agentId: string) => ({ id: agentId, status: "idle", lastMessage: "event done", source: "paseo-agent-subscription", updatesObserved: 1 })),
  };
  return {
    run: vi.fn(async () => { throw new Error("CLI should not be used"); }) as never,
    detectCapabilities: vi.fn(async () => capabilities()) as never,
    sdk: sdk as never,
    native: native as never,
    trace: vi.fn(async () => undefined) as never,
  } as never;
}

afterEach(() => {
  delete process.env.AEH_PASEO_FORCE_CLI;
});

/** A stall-killed turn whose post-timeout stop could NOT prove quiescence. */
function uncertainStallSession(): WorkerSession {
  return {
    id: "agent-uncertain",
    provider: "paseo",
    logicalAgent: "explorer",
    exitCode: 124,
    stdout: "",
    stderr: `${stalledFirstActivityError(1_500_000, 1_800_000, { updatesObserved: 0, toolEvents: 0, assistantDelta: false })}\nPASEO_PROVIDER_LIFECYCLE_UNCERTAIN: post-timeout stop unverified for session 'agent-uncertain'; the session may still be RUNNING.`,
    killReason: "STALLED_FIRST_ACTIVITY",
    status: "timeout",
    transport: "paseo-sdk",
    providerQuiescence: "uncertain",
  } as unknown as WorkerSession;
}

describe("A1: unknown status + stop-exit-0 is UNCERTAIN (exit code proves nothing)", () => {
  it("CLI wait timeout with unknown post-stop status marks the turn UNCERTAIN even though stop exited 0", async () => {
    process.env.AEH_PASEO_FORCE_CLI = "1";
    const run = vi.fn(async (command: string) => {
      if (command.startsWith("paseo wait")) return { exitCode: 124, stdout: "", stderr: "Timed out", durationMs: 1, timedOut: true };
      if (command.startsWith("paseo stop")) return { exitCode: 0, stdout: "stopped", stderr: "", durationMs: 1 };
      if (command.startsWith("paseo ls")) return { exitCode: 0, stdout: JSON.stringify([{ id: "agent-a1", status: "unknown", labels: {} }]), stderr: "", durationMs: 1 };
      if (command.startsWith("paseo logs")) return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
      throw new Error(`unexpected CLI command: ${command}`);
    });
    const deps = {
      run: run as never,
      detectCapabilities: vi.fn(async () => capabilities()) as never,
      trace: vi.fn(async () => undefined) as never,
      sdk: { create: vi.fn(), materialize: vi.fn(), dispatch: vi.fn(), wait: vi.fn(), run: vi.fn(), probe: vi.fn(), inspect: vi.fn(), list: vi.fn() } as never,
      native: undefined as never,
    } as never;
    const result = await waitManagedPaseoAgent("/repo", "agent-a1", 30, deps);
    expect(result.providerQuiescence).toBe("uncertain");
    expect(result.stderr).toMatch(/PASEO_PROVIDER_LIFECYCLE_UNCERTAIN/);
  });

  it("CLI wait timeout with positively-dead post-stop status is quiescent (positive observation, not exit code)", async () => {
    process.env.AEH_PASEO_FORCE_CLI = "1";
    const run = vi.fn(async (command: string) => {
      if (command.startsWith("paseo wait")) return { exitCode: 124, stdout: "", stderr: "Timed out", durationMs: 1, timedOut: true };
      if (command.startsWith("paseo stop")) return { exitCode: 0, stdout: "stopped", stderr: "", durationMs: 1 };
      if (command.startsWith("paseo ls")) return { exitCode: 0, stdout: JSON.stringify([{ id: "agent-a1", status: "completed", labels: {} }]), stderr: "", durationMs: 1 };
      if (command.startsWith("paseo logs")) return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
      throw new Error(`unexpected CLI command: ${command}`);
    });
    const deps = {
      run: run as never,
      detectCapabilities: vi.fn(async () => capabilities()) as never,
      trace: vi.fn(async () => undefined) as never,
      sdk: { create: vi.fn(), materialize: vi.fn(), dispatch: vi.fn(), wait: vi.fn(), run: vi.fn(), probe: vi.fn(), inspect: vi.fn(), list: vi.fn() } as never,
      native: undefined as never,
    } as never;
    const result = await waitManagedPaseoAgent("/repo", "agent-a1", 30, deps);
    expect(result.providerQuiescence).toBe("quiescent");
    expect(result.stderr).not.toMatch(/PASEO_PROVIDER_LIFECYCLE_UNCERTAIN/);
  });
});

describe("A2: UNCERTAIN turns never fresh-session retry in production loops", () => {
  const uncertain = uncertainStallSession();
  const stallError = new Error("EXPLORER_FAILED: STALLED_FIRST_ACTIVITY: zero activity");

  it("discovery/planning gate refuses UNCERTAIN even though the stall classifier fires", () => {
    expect(isDiscoveryPlanningStallKill(stallError, uncertain)).toBe(true);
    expect(shouldRetryDiscoveryPlanningStall(stallError, 0, uncertain)).toBe(false);
  });

  it("spec-manager gate refuses UNCERTAIN even though the stall classifier fires", () => {
    expect(shouldRetrySpecManagerStall(stallError, 0, uncertain)).toBe(false);
  });

  it("supervisor consolidation gate refuses UNCERTAIN even though the stall classifier fires", () => {
    expect(shouldRetrySupervisorConsolidationStall(stallError, 0, uncertain)).toBe(false);
  });

  it("repair gate refuses UNCERTAIN even though the stall classifier fires", () => {
    expect(shouldRetryRepairStall(stallError, 0, uncertain)).toBe(false);
  });
});

describe("A3: ambiguous live same-key turns stop-all + re-verify (self-healing, no operator)", () => {
  const labels = { "aeh.operation": "OP-AMB", "aeh.task": "T-1", "aeh.role": "worker" };
  const options = {
    cwd: "/repo", provider: "codex", model: "gpt-test", title: "worker", prompt: "do work", labels,
  } as never;
  const liveRecord = (id: string) => {
    const key = derivePaseoTurnIdempotencyKey(options)!;
    return { id, status: "working", workspaceId: "ws", labels: { "aeh.operation": "OP-AMB", "aeh.turn.idempotency": key }, raw: {} };
  };

  it("SDK path: two live same-key records are stopped, re-verified empty, then fresh-created", async () => {
    const stopped: string[] = [];
    let listed = 0;
    const list = vi.fn(async () => (++listed === 1 ? [liveRecord("a1"), liveRecord("a2")] : []));
    const run = vi.fn(async (command: string) => {
      const match = /^paseo stop '([^']+)'/.exec(command);
      if (match) { stopped.push(match[1]!); return { exitCode: 0, stdout: "stopped", stderr: "", durationMs: 1 }; }
      throw new Error(`unexpected CLI command: ${command}`);
    });
    const create = vi.fn(async () => ({ id: "fresh", status: "working", lastMessage: "created" }));
    const deps = baseDeps({ list, create });
    (deps as unknown as { run: unknown }).run = run as never;
    const result = await launchManagedPaseoAgent("/repo", { ...options, waitForFinish: false } as never, deps);
    expect(stopped.sort()).toEqual(["a1", "a2"]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.id).toBe("fresh");
  });

  it("cross-operation matches throw fencing-required and never create", async () => {
    const key = derivePaseoTurnIdempotencyKey(options)!;
    const foreign = [
      { id: "ours", status: "working", workspaceId: "ws", labels: { "aeh.operation": "OP-AMB", "aeh.turn.idempotency": key }, raw: {} },
      { id: "theirs", status: "working", workspaceId: "ws", labels: { "aeh.operation": "OP-OTHER", "aeh.turn.idempotency": key }, raw: {} },
    ];
    const create = vi.fn(async () => { throw new Error("must not create on cross-operation ambiguity"); });
    const run = vi.fn(async () => { throw new Error("must not stop foreign sessions"); });
    const deps = baseDeps({ list: vi.fn(async () => foreign), create });
    (deps as unknown as { run: unknown }).run = run as never;
    await expect(launchManagedPaseoAgent("/repo", { ...options, waitForFinish: false } as never, deps)).rejects.toThrow(/PASEO_TURN_FENCING_REQUIRED/);
    expect(create).not.toHaveBeenCalled();
  });

  it("stop failure during self-healing throws (never silently proceeds to create)", async () => {
    const run = vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "stop denied", durationMs: 1 }));
    const create = vi.fn(async () => { throw new Error("must not create when stop-all failed"); });
    const deps = baseDeps({ list: vi.fn(async () => [liveRecord("a1"), liveRecord("a2")]), create });
    (deps as unknown as { run: unknown }).run = run as never;
    await expect(launchManagedPaseoAgent("/repo", { ...options, waitForFinish: false } as never, deps)).rejects.toThrow(/PASEO_TURN_IDEMPOTENCY_AMBIGUOUS/);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("A4: residual paths carry the first-activity bound or an explicit UNCERTAIN-capable fallback", () => {
  it("SDK send()+wait fallback with zero content fires STALLED_FIRST_ACTIVITY, not bare DEADLINE", async () => {
    const handle = {
      id: "agent-sdk-wait-stalled",
      send: vi.fn(async () => undefined),
      waitForFinish: undefined,
      stop: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      refetch: vi.fn(async () => ({ agent: { id: "agent-sdk-wait-stalled", status: "working" } })),
      timeline: { refetch: vi.fn(async () => ({ entries: [] })) },
    };
    const client = { agents: { ref: vi.fn(() => handle) } };
    const result = await runPaseoSdkAgentWithClient(
      client as never, "agent-sdk-wait-stalled", "work", 300, undefined, undefined, { firstActivityMs: 50, pollMs: 10 }
    );
    expect(result.status).toBe("timeout");
    expect(result.killReason).toBe("STALLED_FIRST_ACTIVITY");
    expect(result.error).toContain("STALLED_FIRST_ACTIVITY");
  });

  it("SDK dispatch run() branch carries the first-activity watch when armed", async () => {
    const handle = {
      id: "agent-dispatch-run",
      run: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { status: "timeout", error: "Timed out after 300ms." };
      }),
      stop: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      refetch: vi.fn(async () => ({ agent: { id: "agent-dispatch-run", status: "working" } })),
      timeline: { refetch: vi.fn(async () => ({ entries: [] })) },
    };
    const client = { agents: { ref: vi.fn(() => handle) } };
    const result = await dispatchPaseoSdkAgentWithClient(
      client as never, "agent-dispatch-run", "work", 300, undefined, { firstActivityMs: 50, pollMs: 10 } as never
    );
    expect(result.status).toBe("timeout");
    expect(result.killReason).toBe("STALLED_FIRST_ACTIVITY");
    expect(result.error).toContain("STALLED_FIRST_ACTIVITY");
  });

  it("CLI wait timeout with empty post-stop logs classifies STALLED (stop-then-read verdict, never silent DEADLINE)", async () => {
    process.env.AEH_PASEO_FORCE_CLI = "1";
    const run = vi.fn(async (command: string) => {
      if (command.startsWith("paseo wait")) return { exitCode: 124, stdout: "", stderr: "Timed out", durationMs: 1, timedOut: true };
      if (command.startsWith("paseo stop")) return { exitCode: 0, stdout: "stopped", stderr: "", durationMs: 1 };
      if (command.startsWith("paseo ls")) return { exitCode: 0, stdout: JSON.stringify([{ id: "agent-cli", status: "completed", labels: {} }]), stderr: "", durationMs: 1 };
      if (command.startsWith("paseo logs")) return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
      throw new Error(`unexpected CLI command: ${command}`);
    });
    const deps = {
      run: run as never,
      detectCapabilities: vi.fn(async () => capabilities()) as never,
      trace: vi.fn(async () => undefined) as never,
      sdk: { create: vi.fn(), materialize: vi.fn(), dispatch: vi.fn(), wait: vi.fn(), run: vi.fn(), probe: vi.fn(), inspect: vi.fn(), list: vi.fn() } as never,
      native: undefined as never,
    } as never;
    const result = await waitManagedPaseoAgent("/repo", "agent-cli", 30, deps);
    expect(result.killReason).toBe("STALLED_FIRST_ACTIVITY");
    expect(result.stderr).toContain("STALLED_FIRST_ACTIVITY");
  });
});
