import { describe, expect, it, vi } from "vitest";
import { launchManagedPaseoAgent } from "../src/paseo/runtime.js";

function deps() {
  return {
    run: vi.fn(), detectCapabilities: vi.fn(), trace: vi.fn(async () => undefined),
    native: {
      capture: vi.fn(), wait: vi.fn(),
      preflight: vi.fn(async () => ({ ok: true, message: "ok", availableModels: [] })),
      preflightMode: vi.fn()
    },
    sdk: {
      create: vi.fn(async () => ({ id: "legacy-agent", status: "working" })),
      materialize: vi.fn(async () => ({ id: "fast-agent", status: "idle" })),
      dispatch: vi.fn(), wait: vi.fn(),
      run: vi.fn(async () => ({ id: "fast-agent", status: "idle", lastMessage: "done" })),
      probe: vi.fn(), inspect: vi.fn(), list: vi.fn()
    }
  };
}

describe("Paseo initial-turn barrier", () => {
  it("materializes before the atomic first turn", async () => {
    const runtime = deps();
    const result = await launchManagedPaseoAgent("/repo", {
      cwd: "/repo", title: "explorer", provider: "opencode", prompt: "discover", timeoutSeconds: 30
    }, runtime as never);
    expect(result).toEqual(expect.objectContaining({ id: "fast-agent", stdout: "done", observation: "sdk-run" }));
    expect(runtime.sdk.materialize).toHaveBeenCalledBefore(runtime.sdk.run);
    expect(runtime.sdk.run).toHaveBeenCalledWith("/repo", "fast-agent", "discover", 30_000, undefined);
    expect(runtime.sdk.create).not.toHaveBeenCalled();
    expect(runtime.sdk.wait).not.toHaveBeenCalled();
    expect(runtime.native.wait).not.toHaveBeenCalled();
  });

  it("preserves detached launch semantics", async () => {
    const runtime = deps();
    await launchManagedPaseoAgent("/repo", {
      cwd: "/repo", title: "detached", provider: "opencode", prompt: "work", waitForFinish: false
    }, runtime as never);
    expect(runtime.sdk.create).toHaveBeenCalledTimes(1);
    expect(runtime.sdk.materialize).not.toHaveBeenCalled();
    expect(runtime.sdk.run).not.toHaveBeenCalled();
  });
});
