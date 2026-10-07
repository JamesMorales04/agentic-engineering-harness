import { afterEach, describe, expect, it, vi } from "vitest";
import {
  derivePaseoTurnIdempotencyKey,
  launchManagedPaseoAgent,
} from "../src/paseo/runtimeCore.js";

/**
 * RED-first: ambiguity re-verification must be fail-closed.
 *
 * MECHANISM: DETERMINISTIC (re-list must prove NO UNRESOLVED matching
 * sessions; unknown/unrecognized counts as unresolved; re-list failure
 * throws instead of reading as empty).
 *
 * - unknown/unrecognized re-list record -> PASEO_TURN_IDEMPOTENCY_AMBIGUOUS, no fresh create
 * - re-list failure -> PASEO_TURN_IDEMPOTENCY_AMBIGUOUS (never [] -> create-new)
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

describe("ambiguity re-verify fail-closed (Luna blocker)", () => {
  const labels = { "aeh.operation": "OP-AMB-REVERIFY", "aeh.task": "T-1", "aeh.role": "worker" };
  const options = {
    cwd: "/repo", provider: "codex", model: "gpt-test", title: "worker", prompt: "do work", labels,
  } as never;
  const liveRecord = (id: string) => {
    const key = derivePaseoTurnIdempotencyKey(options)!;
    return { id, status: "working", workspaceId: "ws", labels: { "aeh.operation": "OP-AMB-REVERIFY", "aeh.turn.idempotency": key }, raw: {} };
  };
  const unknownRecord = (id: string, status?: string) => {
    const key = derivePaseoTurnIdempotencyKey(options)!;
    return status === undefined
      ? { id, workspaceId: "ws", labels: { "aeh.operation": "OP-AMB-REVERIFY", "aeh.turn.idempotency": key }, raw: {} }
      : { id, status, workspaceId: "ws", labels: { "aeh.operation": "OP-AMB-REVERIFY", "aeh.turn.idempotency": key }, raw: {} };
  };

  it("SDK: unknown-status re-list after stop-all throws AMBIGUOUS (never fresh-creates)", async () => {
    const list = vi.fn(async () => [liveRecord("a1"), liveRecord("a2")]);
    // Second call is the re-list after stop-all: one unreadable survivor.
    list.mockImplementationOnce(async () => [liveRecord("a1"), liveRecord("a2")]);
    list.mockImplementationOnce(async () => [unknownRecord("a1", "mystery")]);
    const run = vi.fn(async (command: string) => {
      if (command.startsWith("paseo stop")) return { exitCode: 0, stdout: "stopped", stderr: "", durationMs: 1 };
      throw new Error(`unexpected CLI command: ${command}`);
    });
    const create = vi.fn(async () => ({ id: "fresh-beside-unknown", status: "working", lastMessage: "created" }));
    const deps = baseSdkDeps({ list, create });
    (deps as unknown as { run: unknown }).run = run as never;
    await expect(launchManagedPaseoAgent("/repo", { ...options, waitForFinish: false } as never, deps)).rejects.toThrow(/PASEO_TURN_IDEMPOTENCY_AMBIGUOUS/);
    expect(create).not.toHaveBeenCalled();
  });

  it("SDK: re-list failure after stop-all throws AMBIGUOUS (never [] -> fresh-create)", async () => {
    const list = vi.fn(async () => [liveRecord("a1"), liveRecord("a2")]);
    list.mockImplementationOnce(async () => [liveRecord("a1"), liveRecord("a2")]);
    list.mockImplementationOnce(async () => { throw new Error("re-list unavailable"); });
    const run = vi.fn(async (command: string) => {
      if (command.startsWith("paseo stop")) return { exitCode: 0, stdout: "stopped", stderr: "", durationMs: 1 };
      throw new Error(`unexpected CLI command: ${command}`);
    });
    const create = vi.fn(async () => ({ id: "fresh-beside-unverified", status: "working", lastMessage: "created" }));
    const deps = baseSdkDeps({ list, create });
    (deps as unknown as { run: unknown }).run = run as never;
    await expect(launchManagedPaseoAgent("/repo", { ...options, waitForFinish: false } as never, deps)).rejects.toThrow(/PASEO_TURN_IDEMPOTENCY_AMBIGUOUS/);
    expect(create).not.toHaveBeenCalled();
  });

  it("CLI: unknown-status re-list after stop-all throws AMBIGUOUS (never paseo run)", async () => {
    process.env.AEH_PASEO_FORCE_CLI = "1";
    const key = derivePaseoTurnIdempotencyKey(options)!;
    const live = (id: string) => ({ id, status: "working", workspaceId: "ws", labels: { "aeh.operation": "OP-AMB-REVERIFY", "aeh.turn.idempotency": key }, raw: {} });
    const unknown = { id: "cli-a1", status: "mystery", workspaceId: "ws", labels: { "aeh.operation": "OP-AMB-REVERIFY", "aeh.turn.idempotency": key }, raw: {} };
    let listed = 0;
    const commands: string[] = [];
    const run = vi.fn(async (command: string) => {
      commands.push(command);
      if (command.startsWith("paseo ls")) {
        listed += 1;
        if (listed === 1) return { exitCode: 0, stdout: JSON.stringify([live("cli-a1"), live("cli-a2")]), stderr: "", durationMs: 1 };
        return { exitCode: 0, stdout: JSON.stringify([unknown]), stderr: "", durationMs: 1 };
      }
      if (command.startsWith("paseo stop")) return { exitCode: 0, stdout: "stopped", stderr: "", durationMs: 1 };
      throw new Error(`must not create-new next to unresolved CLI orphan (unexpected ${command})`);
    });
    const deps = {
      run: run as never,
      detectCapabilities: vi.fn(async () => capabilities()) as never,
      trace: vi.fn(async () => undefined) as never,
      sdk: { create: vi.fn(), materialize: vi.fn(), dispatch: vi.fn(), wait: vi.fn(), run: vi.fn(), probe: vi.fn(), inspect: vi.fn(), list: vi.fn() } as never,
      native: undefined as never,
    } as never;
    await expect(launchManagedPaseoAgent("/repo", { ...options, waitForFinish: false } as never, deps)).rejects.toThrow(/PASEO_TURN_IDEMPOTENCY_AMBIGUOUS/);
    expect(commands.some((c) => c.startsWith("paseo run")), "must never paseo run next to unresolved orphan").toBe(false);
  });

  it("CLI: re-list failure after stop-all throws AMBIGUOUS (never paseo run)", async () => {
    process.env.AEH_PASEO_FORCE_CLI = "1";
    const key = derivePaseoTurnIdempotencyKey(options)!;
    const live = (id: string) => ({ id, status: "working", workspaceId: "ws", labels: { "aeh.operation": "OP-AMB-REVERIFY", "aeh.turn.idempotency": key }, raw: {} });
    let listed = 0;
    const commands: string[] = [];
    const run = vi.fn(async (command: string) => {
      commands.push(command);
      if (command.startsWith("paseo ls")) {
        listed += 1;
        if (listed === 1) return { exitCode: 0, stdout: JSON.stringify([live("cli-a1"), live("cli-a2")]), stderr: "", durationMs: 1 };
        throw new Error("cli re-list unavailable");
      }
      if (command.startsWith("paseo stop")) return { exitCode: 0, stdout: "stopped", stderr: "", durationMs: 1 };
      throw new Error(`must not create-new on unverified CLI re-list (unexpected ${command})`);
    });
    const deps = {
      run: run as never,
      detectCapabilities: vi.fn(async () => capabilities()) as never,
      trace: vi.fn(async () => undefined) as never,
      sdk: { create: vi.fn(), materialize: vi.fn(), dispatch: vi.fn(), wait: vi.fn(), run: vi.fn(), probe: vi.fn(), inspect: vi.fn(), list: vi.fn() } as never,
      native: undefined as never,
    } as never;
    await expect(launchManagedPaseoAgent("/repo", { ...options, waitForFinish: false } as never, deps)).rejects.toThrow(/PASEO_TURN_IDEMPOTENCY_AMBIGUOUS/);
    expect(commands.some((c) => c.startsWith("paseo run")), "must never paseo run on unverified re-list").toBe(false);
  });
});
