import { afterEach, describe, expect, it, vi } from "vitest";
import { launchManagedPaseoAgent } from "../src/paseo/runtimeCore.js";

/**
 * RED-first: INITIAL-list failure on an idempotent/ambiguous turn path must
 * throw PASEO_TURN_IDEMPOTENCY_AMBIGUOUS (never undefined-then-create).
 *
 * MECHANISM: DETERMINISTIC (unverified list cannot prove empty; a matching
 * live writer may be present but unobserved — fail closed).
 */

function capabilities() {
  return { version: "0.6.0", background: true, quiet: true, json: false, outputSchema: true, daemonJson: true, nativeToolsRecommended: true };
}

function baseSdkDeps(overrides: Record<string, unknown> = {}) {
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

describe("ambiguity initial-list fail-closed (Luna re-blocker)", () => {
  const labels = { "aeh.operation": "OP-AMB-INITIAL", "aeh.task": "T-1", "aeh.role": "worker" };
  const options = {
    cwd: "/repo", provider: "codex", model: "gpt-test", title: "worker", prompt: "do work", labels,
  } as never;

  it("SDK: initial deps.sdk.list error throws AMBIGUOUS (never sdk.create)", async () => {
    const create = vi.fn(async () => ({ id: "fresh-beside-unverified", status: "working", lastMessage: "created" }));
    const deps = baseSdkDeps({
      list: vi.fn(async () => { throw new Error("sdk list unavailable"); }),
      create,
    });
    await expect(launchManagedPaseoAgent("/repo", { ...options, waitForFinish: false } as never, deps)).rejects.toThrow(/PASEO_TURN_IDEMPOTENCY_AMBIGUOUS/);
    expect(create).not.toHaveBeenCalled();
  });

  it("CLI: initial paseo ls error throws AMBIGUOUS (never paseo run create)", async () => {
    process.env.AEH_PASEO_FORCE_CLI = "1";
    const commands: string[] = [];
    const run = vi.fn(async (command: string) => {
      commands.push(command);
      if (command.startsWith("paseo ls")) throw new Error("cli list unavailable");
      throw new Error(`must not create-new on unverified CLI list (unexpected ${command})`);
    });
    const deps = {
      run: run as never,
      detectCapabilities: vi.fn(async () => capabilities()) as never,
      trace: vi.fn(async () => undefined) as never,
      sdk: { create: vi.fn(), materialize: vi.fn(), dispatch: vi.fn(), wait: vi.fn(), run: vi.fn(), probe: vi.fn(), inspect: vi.fn(), list: vi.fn() } as never,
      native: undefined as never,
    } as never;
    await expect(launchManagedPaseoAgent("/repo", { ...options, waitForFinish: false } as never, deps)).rejects.toThrow(/PASEO_TURN_IDEMPOTENCY_AMBIGUOUS/);
    expect(commands.some((c) => c.startsWith("paseo run")), "must never paseo run on unverified initial list").toBe(false);
  });
});
