import { describe, expect, it, vi } from "vitest";
import { continueManagedPaseoAgent, launchManagedPaseoAgent } from "../src/paseo/runtime.js";

const managedLabels = {
  "aeh.operation": "CHANGE-TEST",
  "aeh.role": "explorer",
  "aeh.operation.phase": "discovery"
};

function deps() {
  return {
    run: vi.fn(), detectCapabilities: vi.fn(), trace: vi.fn(async () => undefined),
    updateLabels: vi.fn(async () => undefined),
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
  it("materializes a managed participant before the atomic first turn", async () => {
    const runtime = deps();
    const result = await launchManagedPaseoAgent("/repo", {
      cwd: "/repo", title: "explorer", provider: "opencode", prompt: "discover", timeoutSeconds: 30, labels: managedLabels
    }, runtime as never);
    expect(result).toEqual(expect.objectContaining({ id: "fast-agent", stdout: "done", observation: "sdk-run" }));
    expect(runtime.sdk.materialize).toHaveBeenCalledBefore(runtime.sdk.run);
    expect(runtime.sdk.run).toHaveBeenCalledWith("/repo", "fast-agent", "discover", 30_000, undefined);
    expect(runtime.sdk.create).not.toHaveBeenCalled();
    expect(runtime.sdk.wait).not.toHaveBeenCalled();
    expect(runtime.native.wait).not.toHaveBeenCalled();
  });

  it("forwards an output schema through the managed atomic first turn", async () => {
    const runtime = deps();
    const schema = { type: "object", required: ["verdict"] };
    await launchManagedPaseoAgent("/repo", {
      cwd: "/repo", title: "typed", provider: "opencode", prompt: "work", outputSchema: schema, timeoutSeconds: 45, labels: managedLabels
    }, runtime as never);
    expect(runtime.sdk.run).toHaveBeenCalledWith("/repo", "fast-agent", "work", 45_000, schema);
    expect(runtime.sdk.create).not.toHaveBeenCalled();
  });

  it("materializes the provider-assigned id frozen in ExecutionBinding before the first prompt", async () => {
    const runtime = deps();
    runtime.sdk.materialize.mockResolvedValue({ id: "binding-session-id", status: "idle" });
    await launchManagedPaseoAgent("/repo", {
      cwd: "/repo", title: "bound", provider: "opencode", prompt: "work", agentId: "binding-session-id", labels: { ...managedLabels, "aeh.execution.binding.digest": "a".repeat(64) }
    }, runtime as never);
    expect(runtime.sdk.materialize).toHaveBeenCalledWith("/repo", expect.objectContaining({ agentId: "binding-session-id", waitForFinish: false }));
    expect(runtime.sdk.materialize).toHaveBeenCalledBefore(runtime.sdk.run);
    expect(runtime.sdk.run).toHaveBeenCalledWith("/repo", "binding-session-id", "work", 1_800_000, undefined);
    expect(runtime.sdk.create).not.toHaveBeenCalled();
  });

  it("updates and verifies full Paseo binding labels before continuing a materialized session", async () => {
    const runtime = deps();
    const labels = { "aeh.execution.binding": JSON.stringify({ version: 2, digest: "b".repeat(64) }), "aeh.execution.binding.digest": "b".repeat(64) };
    await continueManagedPaseoAgent("/repo", "actual-session", "work", 30, runtime as never, { type: "object" }, labels);
    expect(runtime.updateLabels).toHaveBeenCalledWith("/repo", "actual-session", labels);
    expect(runtime.updateLabels).toHaveBeenCalledBefore(runtime.sdk.run);
    expect(runtime.sdk.run).toHaveBeenCalledWith("/repo", "actual-session", "work", 30_000, { type: "object" });
  });

  it("fails closed before a Paseo turn when binding-label persistence fails", async () => {
    const runtime = deps();
    runtime.updateLabels.mockRejectedValue(new Error("label update unavailable"));
    await expect(continueManagedPaseoAgent("/repo", "actual-session", "work", 30, runtime as never, undefined, { "aeh.execution.binding": "{}" }))
      .rejects.toThrow("label update unavailable");
    expect(runtime.sdk.run).not.toHaveBeenCalled();
  });

  it("fails closed before sending the prompt when Paseo returns a different provider id", async () => {
    const runtime = deps();
    runtime.sdk.materialize.mockResolvedValue({ id: "other-provider-id", status: "idle" });
    await expect(launchManagedPaseoAgent("/repo", {
      cwd: "/repo", title: "bound", provider: "opencode", prompt: "work", agentId: "binding-session-id", labels: { ...managedLabels, "aeh.execution.binding.digest": "a".repeat(64) }
    }, runtime as never)).rejects.toThrow("EXECUTION_BINDING_RUNTIME_SESSION_MISMATCH");
    expect(runtime.sdk.run).not.toHaveBeenCalled();
    expect(runtime.sdk.create).not.toHaveBeenCalled();
  });

  it("preserves explicitly detached managed launch semantics", async () => {
    const runtime = deps();
    await launchManagedPaseoAgent("/repo", {
      cwd: "/repo", title: "detached", provider: "opencode", prompt: "work", waitForFinish: false, labels: managedLabels
    }, runtime as never);
    expect(runtime.sdk.create).toHaveBeenCalledTimes(1);
    expect(runtime.sdk.materialize).not.toHaveBeenCalled();
    expect(runtime.sdk.run).not.toHaveBeenCalled();
  });

  it("never creates a second agent after a managed materialized turn has started", async () => {
    const runtime = deps();
    runtime.sdk.run.mockRejectedValue(new Error("turn failed"));
    await expect(launchManagedPaseoAgent("/repo", {
      cwd: "/repo", title: "single-run", provider: "opencode", prompt: "work", labels: managedLabels
    }, runtime as never)).rejects.toThrow("turn failed");
    expect(runtime.sdk.materialize).toHaveBeenCalledTimes(1);
    expect(runtime.sdk.create).not.toHaveBeenCalled();
  });
});
