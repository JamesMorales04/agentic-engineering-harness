import { describe, expect, it, vi } from "vitest";
import {
  derivePaseoTurnIdempotencyKey,
  launchManagedPaseoAgent,
  probeManagedPaseoAgent,
} from "../src/paseo/runtimeCore.js";

/**
 * D5 regression: orphan/duplicate turns + resume liveness. Fail-closed.
 *
 * MECHANISM: DETERMINISTIC (idempotency hash + operation-label reaper +
 * positive-only liveness; no model, no retry budgets, no leases touched).
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

describe("orphan/duplicate turns + resume liveness (D5)", () => {
  it("derives a deterministic idempotency key only for operation-owned turns", () => {
    const withOp = { cwd: "/repo", provider: "codex", title: "worker", prompt: "do work", labels: { "aeh.operation": "OP-1", "aeh.task": "T-1", "aeh.role": "worker" } } as never;
    const withoutOp = { cwd: "/repo", provider: "codex", title: "worker", prompt: "do work" } as never;
    const first = derivePaseoTurnIdempotencyKey(withOp);
    const second = derivePaseoTurnIdempotencyKey(withOp);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(derivePaseoTurnIdempotencyKey(withoutOp)).toBeUndefined();
  });

  it("carries the idempotency key on create and reaps by aeh.operation labels before retry", async () => {
    const deps = baseDeps();
    const sdk = (deps as unknown as { sdk: { create: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> } }).sdk;
    await launchManagedPaseoAgent("/repo", {
      cwd: "/repo", provider: "codex", model: "gpt-test", title: "worker", prompt: "do work",
      labels: { "aeh.operation": "OP-1", "aeh.task": "T-1", "aeh.role": "worker" },
    }, deps);
    expect(sdk.create).toHaveBeenCalledTimes(1);
    const createOptions = sdk.create.mock.calls[0]![1] as { labels?: Record<string, string> };
    expect(createOptions.labels?.["aeh.turn.idempotency"]).toMatch(/^[a-f0-9]{64}$/);
    expect(sdk.list).toHaveBeenCalledWith("/repo", expect.objectContaining({ "aeh.operation": "OP-1" }));
  });

  it("reuses a live idempotent orphan instead of creating a duplicate", async () => {
    const idempotency = derivePaseoTurnIdempotencyKey({
      cwd: "/repo", provider: "codex", title: "worker", prompt: "do work",
      labels: { "aeh.operation": "OP-1", "aeh.task": "T-1", "aeh.role": "worker" },
    } as never)!;
    const deps = baseDeps({
      list: vi.fn(async () => [{ id: "agent-orphan-1", status: "working", workspaceId: "ws", labels: { "aeh.operation": "OP-1", "aeh.turn.idempotency": idempotency }, raw: {} }]),
      create: vi.fn(async () => { throw new Error("must not create duplicate when live orphan exists"); }),
    });
    const result = await launchManagedPaseoAgent("/repo", {
      cwd: "/repo", provider: "codex", model: "gpt-test", title: "worker", prompt: "do work",
      labels: { "aeh.operation": "OP-1", "aeh.task": "T-1", "aeh.role": "worker" },
    }, deps);
    expect(result.id).toBe("agent-orphan-1");
  });

  it("reaps dead orphans best-effort and never blocks launch on list failure", async () => {
    const run = vi.fn(async (command: string) => ({ exitCode: 0, stdout: "stopped", stderr: "", durationMs: 1 }));
    const deps = baseDeps({
      list: vi.fn(async () => { throw new Error("list unavailable"); }),
      create: vi.fn(async () => ({ id: "sdk-new", status: "working", lastMessage: "created" })),
    }) as unknown as { run: ReturnType<typeof vi.fn>; sdk: { create: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> } };
    (deps as unknown as { run: unknown }).run = run as never;
    const result = await launchManagedPaseoAgent("/repo", {
      cwd: "/repo", provider: "codex", model: "gpt-test", title: "worker", prompt: "do work",
      labels: { "aeh.operation": "OP-1", "aeh.task": "T-1", "aeh.role": "worker" },
    }, deps as never);
    expect(result.id).toBe("sdk-new");
  });

  it("probe verifies liveness: live idle/working true, dead/unknown false (fail-closed)", async () => {
    const liveDeps = baseDeps({ inspect: vi.fn(async () => ({ id: "a1", status: "idle", raw: {} })) });
    await expect(probeManagedPaseoAgent("/repo", "a1", liveDeps)).resolves.toBe(true);
    const workingDeps = baseDeps({ inspect: vi.fn(async () => ({ id: "a1", status: "working", raw: {} })) });
    await expect(probeManagedPaseoAgent("/repo", "a1", workingDeps)).resolves.toBe(true);
    const deadDeps = baseDeps({ inspect: vi.fn(async () => ({ id: "a1", status: "failed", raw: {} })) });
    await expect(probeManagedPaseoAgent("/repo", "a1", deadDeps)).resolves.toBe(false);
    const unknownDeps = baseDeps({ inspect: vi.fn(async () => undefined), probe: vi.fn(async () => true) });
    await expect(probeManagedPaseoAgent("/repo", "a1", unknownDeps)).resolves.toBe(false);
  });
});
