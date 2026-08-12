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
    wait: vi.fn(async () => ({ id: "sdk-idle", status: "idle", lastMessage: "done", workspaceId: "workspace-op" })),
    run: vi.fn(), probe: vi.fn(), inspect: vi.fn(), list: vi.fn(),
    ...overrides
  };
}

afterEach(() => { delete process.env.AEH_PASEO_FORCE_CLI; });

describe("managed Paseo runtime", () => {
  it("uses the SDK as the primary agent lifecycle", async () => {
    const run = vi.fn(async () => { throw new Error("CLI should not be used"); });
    const sdkDeps = sdk();
    const launched = await launchManagedPaseoAgent("/repo", {
      cwd: "/repo", provider: "codex", model: "gpt-test", title: "worker", prompt: "do work"
    }, { run: run as never, detectCapabilities: vi.fn(async () => capabilities()) as never, sdk: sdkDeps as never } as never);

    expect(launched).toEqual(expect.objectContaining({ id: "sdk-agent", transport: "sdk", exitCode: 0, stdout: "done" }));
    expect(sdkDeps.create).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("still prefers the SDK when no explicit model was supplied", async () => {
    const run = vi.fn(async () => { throw new Error("CLI should not be used"); });
    const sdkDeps = sdk();
    await launchManagedPaseoAgent("/repo", { cwd: "/repo", provider: "codex", title: "worker", prompt: "do work" }, { run: run as never, detectCapabilities: vi.fn(async () => capabilities()) as never, sdk: sdkDeps as never } as never);
    expect(sdkDeps.create).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("supports materialize, dispatch and wait as separate SDK lifecycle phases", async () => {
    const run = vi.fn(async () => { throw new Error("CLI should not be used"); });
    const sdkDeps = sdk();
    const deps = { run: run as never, detectCapabilities: vi.fn(async () => capabilities()) as never, sdk: sdkDeps as never } as never;
    const materialized = await materializeManagedPaseoAgent("/repo", { cwd: "/repo", provider: "codex", model: "gpt", title: "reviewer" }, deps);
    const dispatched = await dispatchManagedPaseoAgent("/repo", materialized.id!, "review it", 120, deps);
    const waited = await waitManagedPaseoAgent("/repo", materialized.id!, 120, deps);
    expect(materialized).toEqual(expect.objectContaining({ id: "sdk-idle", status: "idle", workspaceId: "workspace-op" }));
    expect(dispatched).toEqual(expect.objectContaining({ status: "working" }));
    expect(waited).toEqual(expect.objectContaining({ status: "idle", stdout: "done" }));
    expect(sdkDeps.materialize).toHaveBeenCalledTimes(1);
    expect(sdkDeps.dispatch).toHaveBeenCalledTimes(1);
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
    const sdkDeps = sdk({
      create: vi.fn(async () => { throw new PaseoSdkUnavailableError("not installed"); }),
      wait: vi.fn(async () => { throw new PaseoSdkUnavailableError("not installed"); })
    });
    const launched = await launchManagedPaseoAgent("/repo", {
      cwd: "/repo", provider: "codex", model: "gpt-test", title: "worker", prompt: "do work", timeoutSeconds: 1800
    }, { run: run as never, detectCapabilities: vi.fn(async () => capabilities()) as never, sdk: sdkDeps as never } as never);

    expect(launched).toEqual(expect.objectContaining({ id: "agent-cli", transport: "cli", exitCode: 0, stdout: "cli done" }));
    expect(launched.stderr).toContain("SDK unavailable");
    expect(commands[0]).toContain("paseo run --background");
  });

  it("refuses to turn a systemPrompt-only idle lead into a CLI user turn", async () => {
    const run = vi.fn(async () => { throw new Error("CLI must not receive bootstrap text"); });
    const sdkDeps = sdk({ create: vi.fn(async () => { throw new PaseoSdkUnavailableError("not installed"); }) });
    await expect(launchManagedPaseoAgent("/repo", {
      cwd: "/repo", provider: "codex", model: "gpt-test", title: "lead", systemPrompt: "secret session bootstrap", waitForFinish: false
    }, { run: run as never, detectCapabilities: vi.fn(async () => capabilities()) as never, sdk: sdkDeps as never } as never)).rejects.toThrow("Refusing CLI fallback");
    expect(run).not.toHaveBeenCalled();
  });
});
