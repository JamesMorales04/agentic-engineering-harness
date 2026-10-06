import { afterEach, describe, expect, it, vi } from "vitest";
import { runPaseoSdkAgentWithClient } from "../src/paseo/sdk.js";
import {
  derivePaseoTurnIdempotencyKey,
  launchManagedPaseoAgent,
  waitManagedPaseoAgent,
} from "../src/paseo/runtimeCore.js";
import {
  shouldRetryRepairStall,
  withBoundedRepairStallRetryV1,
} from "../src/core/run.js";
import type { WorkerSession } from "../src/core/types.js";

/**
 * RED-first regression for provider-turn hardening (E-NEW-1, E-NEW-2, E-NEW-9).
 * Each block fails before its repair and passes after. No Paseo daemon.
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

describe("E-NEW-1: ambiguous live idempotent reuse must fail closed (no create-new)", () => {
  const labels = { "aeh.operation": "OP-AMB", "aeh.task": "T-1", "aeh.role": "worker" };
  const options = {
    cwd: "/repo", provider: "codex", model: "gpt-test", title: "worker", prompt: "do work", labels,
  } as never;
  const liveRecord = (id: string) => {
    const key = derivePaseoTurnIdempotencyKey(options)!;
    return { id, status: "working", workspaceId: "ws", labels: { "aeh.operation": "OP-AMB", "aeh.turn.idempotency": key }, raw: {} };
  };

  it("SDK path: two live same-key records throw AMBIGUOUS and never create", async () => {
    const create = vi.fn(async () => { throw new Error("must not create-new on ambiguous live orphans"); });
    const deps = baseDeps({ list: vi.fn(async () => [liveRecord("a1"), liveRecord("a2")]), create });
    await expect(launchManagedPaseoAgent("/repo", options, deps)).rejects.toThrow(/PASEO_TURN_IDEMPOTENCY_AMBIGUOUS/);
    expect(create).not.toHaveBeenCalled();
  });

  it("CLI path: two live same-key records throw AMBIGUOUS and never run create", async () => {
    process.env.AEH_PASEO_FORCE_CLI = "1";
    const key = derivePaseoTurnIdempotencyKey(options)!;
    const orphans = [
      { id: "cli-a1", status: "working", workspaceId: "ws", labels: { "aeh.operation": "OP-AMB", "aeh.turn.idempotency": key }, raw: {} },
      { id: "cli-a2", status: "working", workspaceId: "ws", labels: { "aeh.operation": "OP-AMB", "aeh.turn.idempotency": key }, raw: {} },
    ];
    const commands: string[] = [];
    const run = vi.fn(async (command: string) => {
      commands.push(command);
      if (command.startsWith("paseo ls")) return { exitCode: 0, stdout: JSON.stringify(orphans), stderr: "", durationMs: 1 };
      throw new Error(`must not create-new on ambiguous live orphans (unexpected ${command})`);
    });
    const deps = {
      run: run as never,
      detectCapabilities: vi.fn(async () => capabilities()) as never,
      trace: vi.fn(async () => undefined) as never,
      sdk: { create: vi.fn(), materialize: vi.fn(), dispatch: vi.fn(), wait: vi.fn(), run: vi.fn(), probe: vi.fn(), inspect: vi.fn(), list: vi.fn() } as never,
      native: undefined as never,
    } as never;
    await expect(launchManagedPaseoAgent("/repo", options, deps)).rejects.toThrow(/PASEO_TURN_IDEMPOTENCY_AMBIGUOUS/);
    expect(commands.some((command) => command.startsWith("paseo run")), "ambiguous live CLI orphans must never relaunch").toBe(false);
  });
});

describe("E-NEW-2: sdk-wait fallback carries the first-activity stall bound", () => {
  it("hanging waitForFinish with zero content fires STALLED_FIRST_ACTIVITY, not bare DEADLINE", async () => {
    const handle = {
      id: "agent-sdk-wait-stalled",
      // No run(): forces the legacy send()+waitForFinish() fallback inside
      // runPaseoSdkAgentWithClient (the subscription-less wait path).
      send: vi.fn(async () => undefined),
      waitForFinish: vi.fn(async (ms?: number) => {
        await new Promise((resolve) => setTimeout(resolve, ms ?? 300));
        return { status: "timeout", error: `Timed out after ${ms ?? 300}ms.` };
      }),
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
    expect(result.activity?.toolEvents).toBe(0);
    expect(handle.stop).toHaveBeenCalled();
  });
});

describe("E-NEW-9: post-timeout stop is verified; unverified stops never fresh-retry", () => {
  function uncertainDeps() {
    const run = vi.fn(async (command: string) => {
      if (command === "paseo stop 'agent-uncertain'") return { exitCode: 1, stdout: "", stderr: "stop failed", durationMs: 1 };
      throw new Error(`unexpected CLI command: ${command}`);
    });
    const deps = baseDeps({
      inspect: vi.fn(async () => ({ id: "agent-uncertain", status: "working", raw: {} })),
    }) as unknown as { run: unknown };
    (deps as unknown as { run: unknown }).run = run as never;
    const native = {
      preflight: vi.fn(async (_root: string, provider: string) => ({ ok: true, provider, source: "test", message: "ok" })),
      preflightMode: vi.fn(async (_root: string, provider: string, modeId: string) => ({ ok: true, provider, modeId, availableModes: [modeId], source: "test", message: "ok" })),
      wait: vi.fn(async () => ({ id: "agent-uncertain", status: "timeout", error: "Timed out", source: "paseo-agent-subscription", updatesObserved: 0 })),
    };
    return { ...(deps as object), native: native as never } as never;
  }

  function uncertainSession(stderr: string): WorkerSession {
    return {
      id: "agent-uncertain",
      provider: "paseo",
      logicalAgent: "repairer",
      exitCode: 124,
      stdout: "",
      stderr,
      killReason: "DEADLINE",
      status: "timeout",
      transport: "paseo-sdk",
      providerQuiescence: "uncertain",
    } as unknown as WorkerSession;
  }

  it("stop-exit-1 + inspect-still-working marks the turn UNCERTAIN", async () => {
    const waited = await waitManagedPaseoAgent("/repo", "agent-uncertain", 1, uncertainDeps());
    expect(waited.status).toBe("timeout");
    expect((waited as unknown as { providerQuiescence?: string }).providerQuiescence).toBe("uncertain");
    expect(waited.stderr).toMatch(/PASEO_PROVIDER_LIFECYCLE_UNCERTAIN/);
  });

  it("UNCERTAIN sessions are never fresh-session retried", async () => {
    const session = uncertainSession("Timed out after 1000ms. PASEO_PROVIDER_LIFECYCLE_UNCERTAIN: stop unverified");
    expect(shouldRetryRepairStall(new Error("Timed out after 1000ms"), 0, session)).toBe(false);
    const execute = vi.fn(async () => ({ session }));
    await expect(withBoundedRepairStallRetryV1({ prompt: "p", execute })).rejects.toThrow(/PASEO_PROVIDER_LIFECYCLE_UNCERTAIN/);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
