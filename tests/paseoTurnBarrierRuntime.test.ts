import { describe, expect, it, vi } from "vitest";
import { continueManagedPaseoAgent } from "../src/paseo/runtime.js";
import { PaseoSdkUnavailableError } from "../src/paseo/sdk.js";

function runtimeDeps() {
  return {
    run: vi.fn(),
    detectCapabilities: vi.fn(),
    trace: vi.fn(async () => undefined),
    native: {
      capture: vi.fn(async () => ({ lastAssistantMessage: "old answer" })),
      wait: vi.fn(async () => ({
        id: "agent-1",
        status: "idle",
        lastMessage: "fallback answer",
        source: "paseo-agent-subscription" as const,
        updatesObserved: 1
      })),
      preflight: vi.fn(),
      preflightMode: vi.fn()
    },
    sdk: {
      create: vi.fn(),
      materialize: vi.fn(),
      dispatch: vi.fn(async () => ({ id: "agent-1", status: "working", workspaceId: "workspace-1" })),
      wait: vi.fn(),
      run: vi.fn(async () => ({ id: "agent-1", status: "idle", lastMessage: "new answer", workspaceId: "workspace-1" })),
      probe: vi.fn(),
      inspect: vi.fn(),
      list: vi.fn()
    }
  };
}

describe("Paseo resumed-turn barrier", () => {
  it("uses one SDK run turn as the primary completion barrier", async () => {
    const runtime = runtimeDeps();
    const result = await continueManagedPaseoAgent("/repo", "agent-1", "continue", 120, runtime as never);

    expect(result).toEqual(expect.objectContaining({
      id: "agent-1",
      status: "idle",
      stdout: "new answer",
      observation: "sdk-run"
    }));
    expect(runtime.sdk.run).toHaveBeenCalledWith("/repo", "agent-1", "continue", 120_000);
    expect(runtime.native.capture).not.toHaveBeenCalled();
    expect(runtime.sdk.dispatch).not.toHaveBeenCalled();
    expect(runtime.native.wait).not.toHaveBeenCalled();
  });

  it("keeps baseline and subscription as a compatibility fallback", async () => {
    const runtime = runtimeDeps();
    runtime.sdk.run.mockRejectedValue(new PaseoSdkUnavailableError("run unavailable"));

    const result = await continueManagedPaseoAgent("/repo", "agent-1", "continue", 120, runtime as never);

    expect(result.stdout).toBe("fallback answer");
    expect(runtime.native.capture).toHaveBeenCalledBefore(runtime.sdk.dispatch);
    expect(runtime.native.wait).toHaveBeenCalledWith(
      "/repo",
      "agent-1",
      120_000,
      { lastAssistantMessage: "old answer" }
    );
  });
});
