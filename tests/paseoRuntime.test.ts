import { afterEach, describe, expect, it, vi } from "vitest";
import { PaseoSdkUnavailableError } from "../src/paseo/sdk.js";
import { dispatchManagedPaseoAgent, launchManagedPaseoAgent, materializeManagedPaseoAgent, waitManagedPaseoAgent } from "../src/paseo/runtime.js";

function result(exitCode: number, stdout = "", stderr = "") { return { exitCode, stdout, stderr, durationMs: 1 }; }
function capabilities() { return { version: "0.6.0", background: true, quiet: true, json: false, outputSchema: true, daemonJson: true, nativeToolsRecommended: true }; }
function sdk(overrides: Record<string, unknown> = {}) {
  return {
    create: vi.fn(async () => ({ id: "sdk-agent", status: "idle", lastMessage: "done" })),
    materialize: vi.fn(async () => ({ id: "sdk-idle", status: "idle", workspaceId: "workspace-op" })),
    dispatch: vi.fn(async () => ({ id: "sdk-idle", status: "working", workspaceId: "workspace-op" })),
    wait: vi.fn(async () => ({ id: "sdk-idle", status: "idle", lastMessage: "sdk wait done", workspaceId: "workspace-op" })),
    run: vi.fn(), probe: vi.fn(), inspect: vi.fn(), list: vi.fn(),
    ...overrides
  };
}
function native(overrides: Record<string, unknown> = {}) {
  return {
    preflight: vi.fn(async (_root: string, provider: string, model?: string) => ({ ok: true, provider, model, source: "paseo-provider-models", message: "ok" })),
    wait: vi.fn(async () => ({ id: "sdk-idle", status: "idle", lastMessage: "event done", workspaceId: "workspace-op", source: "paseo-agent-subscription", updatesObserved: 1 })),
    ...overrides
  };
}
function deps(run: ReturnType<typeof vi.fn>, sdkDeps = sdk(), nativeDeps = native()) {
  return {
    run: run as never,
    detectCapabilities: vi.fn(async () => capabilities()) as never,
    sdk: sdkDeps as never,
    native: nativeDeps as never,
    trace: vi.fn(async () => undefined) as never
  } as never;
}

afterEach(() => { delete process.env.AEH_PASEO_FORCE_CLI; });

describe("managed Paseo runtime", () => {
  it("preflights provider/model then uses the SDK as the primary agent lifecycle", async () => {
    const run = vi.fn(async () => { throw new Error("CLI should not be used"); });
    const sdkDeps = sdk();
    const nativeDeps = native();
    const launched = await launchManagedPaseoAgent("/repo", {
      cwd: "/repo", provider: "codex", model: "gpt-test", title: "worker", prompt: "do work"
    }, deps(run, sdkDeps, nativeDeps));

    expect(launched).toEqual(expect.objectContaining({ id: "sdk-agent", transport: "sdk", exitCode: 0, stdout: "done" }));
    expect(nativeDeps.preflight).toHaveBeenCalledWith("/repo", "codex", "gpt-test", "/repo");
    expect(sdkDeps.create).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("fails before create when provider/model preflight is authoritative and negative", async () => {
    const run = vi.fn();
    const sdkDeps = sdk();
    const nativeDeps = native({ preflight: vi.fn(async () => ({ ok: false, provider: "codex", model: "missing", source: "paseo-provider-models", message: "model missing", availableModels: ["gpt-good"] })) });
    await expect(launchManagedPaseoAgent("/repo", {
      cwd: "/repo", provider: "codex", model: "missing", title: "worker", prompt: "do work"
    }, deps(run, sdkDeps, nativeDeps))).rejects.toThrow("Paseo provider preflight failed");
    expect(sdkDeps.create).not.toHaveBeenCalled();
  });

  it("continues to creation when preflight SDK capability is unavailable", async () => {
    const run = vi.fn(async () => { throw new Error("CLI should not be used"); });
    const sdkDeps = sdk();
    const nativeDeps = native({ preflight: vi.fn(async () => { throw new PaseoSdkUnavailableError("provider API unavailable"); }) });
    const launched = await launchManagedPaseoAgent("/repo", { cwd: "/repo", provider: "codex", title: "worker", prompt: "do work" }, deps(run, sdkDeps, nativeDeps));
    expect(launched.transport).toBe("sdk");
    expect(sdkDeps.create).toHaveBeenCalledTimes(1);
  });

  it("supports materialize, dispatch and event-driven wait as separate SDK lifecycle phases", async () => {
    const run = vi.fn(async () => { throw new Error("CLI should not be used"); });
    const sdkDeps = sdk();
    const nativeDeps = native();
    const runtimeDeps = deps(run, sdkDeps, nativeDeps);
    const materialized = await materializeManagedPaseoAgent("/repo", { cwd: "/repo", provider: "codex", model: "gpt", title: "reviewer" }, runtimeDeps);
    const dispatched = await dispatchManagedPaseoAgent("/repo", materialized.id!, "review it", 120, runtimeDeps);
    const waited = await waitManagedPaseoAgent("/repo", materialized.id!, 120, runtimeDeps);
    expect(materialized).toEqual(expect.objectContaining({ id: "sdk-idle", status: "idle", workspaceId: "workspace-op" }));
    expect(dispatched).toEqual(expect.objectContaining({ status: "working" }));
    expect(waited).toEqual(expect.objectContaining({ status: "idle", stdout: "event done", observation: "subscription" }));
    expect(sdkDeps.materialize).toHaveBeenCalledTimes(1);
    expect(sdkDeps.dispatch).toHaveBeenCalledTimes(1);
    expect(nativeDeps.wait).toHaveBeenCalledTimes(1);
    expect(sdkDeps.wait).not.toHaveBeenCalled();
  });

  it("falls back from subscription to SDK wait when subscriptions are unavailable", async () => {
    const run = vi.fn(async () => { throw new Error("CLI should not be used"); });
    const sdkDeps = sdk();
    const nativeDeps = native({ wait: vi.fn(async () => { throw new PaseoSdkUnavailableError("subscribe unavailable"); }) });
    const waited = await waitManagedPaseoAgent("/repo", "sdk-idle", 120, deps(run, sdkDeps, nativeDeps));
    expect(waited).toEqual(expect.objectContaining({ transport: "sdk", observation: "sdk-wait", stdout: "sdk wait done" }));
    expect(sdkDeps.wait).toHaveBeenCalledTimes(1);
  });

  it("falls back to negotiated CLI lifecycle when the SDK is unavailable", async () => {
    const commands: string[] = [];
    const run = vi.fn(async (command: string) => {
      commands.push(command);
      if (command.startsWith("paseo run --background")) return result(0, "agent-cli\n");
      if (command === "paseo wait 'agent-cli' --timeout 1800") return result(0, "idle");
      if (command === "paseo logs 'agent-cli' --tail 200") return result(0, "cli done");
      throw new Error(`unexpected ${command}`);
    });
    const sdkDeps = sdk({ create: vi.fn(async () => { throw new PaseoSdkUnavailableError("not installed"); }), wait: vi.fn(async () => { throw new PaseoSdkUnavailableError("not installed"); }) });
    const nativeDeps = native({ preflight: vi.fn(async () => { throw new PaseoSdkUnavailableError("not installed"); }), wait: vi.fn(async () => { throw new PaseoSdkUnavailableError("not installed"); }) });
    const launched = await launchManagedPaseoAgent("/repo", {
      cwd: "/repo", provider: "codex", model: "gpt-test", title: "worker", prompt: "do work", timeoutSeconds: 1800
    }, deps(run, sdkDeps, nativeDeps));

    expect(launched).toEqual(expect.objectContaining({ id: "agent-cli", transport: "cli", exitCode: 0, stdout: "cli done" }));
    expect(launched.stderr).toContain("SDK unavailable");
    expect(commands[0]).toContain("paseo run --background");
  });

  it("refuses to turn a systemPrompt-only idle lead into a CLI user turn", async () => {
    const run = vi.fn(async () => { throw new Error("CLI must not receive bootstrap text"); });
    const sdkDeps = sdk({ create: vi.fn(async () => { throw new PaseoSdkUnavailableError("not installed"); }) });
    const nativeDeps = native({ preflight: vi.fn(async () => { throw new PaseoSdkUnavailableError("not installed"); }) });
    await expect(launchManagedPaseoAgent("/repo", {
      cwd: "/repo", provider: "codex", model: "gpt-test", title: "lead", systemPrompt: "secret session bootstrap", waitForFinish: false
    }, deps(run, sdkDeps, nativeDeps))).rejects.toThrow("Refusing CLI fallback");
    expect(run).not.toHaveBeenCalled();
  });
});
