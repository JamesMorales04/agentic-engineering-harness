import { afterEach, describe, expect, it, vi } from "vitest";
import { PaseoSdkUnavailableError } from "../src/paseo/sdk.js";
import { launchManagedPaseoAgent } from "../src/paseo/runtime.js";

function result(exitCode: number, stdout = "", stderr = "") { return { exitCode, stdout, stderr, durationMs: 1 }; }
function capabilities() { return { version: "0.6.0", background: true, quiet: true, json: false, outputSchema: true, daemonJson: true, nativeToolsRecommended: true }; }

afterEach(() => { delete process.env.AEH_PASEO_FORCE_CLI; });

describe("managed Paseo runtime", () => {
  it("uses the SDK as the primary agent lifecycle", async () => {
    const run = vi.fn(async () => { throw new Error("CLI should not be used"); });
    const sdk = {
      create: vi.fn(async () => ({ id: "sdk-agent", status: "idle", lastMessage: "done" })),
      run: vi.fn(), probe: vi.fn(), inspect: vi.fn(), list: vi.fn()
    };
    const launched = await launchManagedPaseoAgent("/repo", {
      cwd: "/repo",
      provider: "codex",
      model: "gpt-test",
      title: "worker",
      prompt: "do work"
    }, { run: run as never, detectCapabilities: vi.fn(async () => capabilities()) as never, sdk: sdk as never } as never);

    expect(launched).toEqual(expect.objectContaining({ id: "sdk-agent", transport: "sdk", exitCode: 0, stdout: "done" }));
    expect(sdk.create).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
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
    const sdk = {
      create: vi.fn(async () => { throw new PaseoSdkUnavailableError("not installed"); }),
      run: vi.fn(), probe: vi.fn(), inspect: vi.fn(), list: vi.fn()
    };
    const launched = await launchManagedPaseoAgent("/repo", {
      cwd: "/repo",
      provider: "codex",
      model: "gpt-test",
      title: "worker",
      prompt: "do work",
      timeoutSeconds: 1800
    }, { run: run as never, detectCapabilities: vi.fn(async () => capabilities()) as never, sdk: sdk as never } as never);

    expect(launched).toEqual(expect.objectContaining({ id: "agent-cli", transport: "cli", exitCode: 0, stdout: "cli done" }));
    expect(launched.stderr).toContain("SDK unavailable");
    expect(commands[0]).toContain("paseo run --background");
  });

  it("refuses to turn a systemPrompt-only idle lead into a CLI user turn", async () => {
    const run = vi.fn(async () => { throw new Error("CLI must not receive bootstrap text"); });
    const sdk = {
      create: vi.fn(async () => { throw new PaseoSdkUnavailableError("not installed"); }),
      run: vi.fn(), probe: vi.fn(), inspect: vi.fn(), list: vi.fn()
    };

    await expect(launchManagedPaseoAgent("/repo", {
      cwd: "/repo",
      provider: "codex",
      model: "gpt-test",
      title: "lead",
      systemPrompt: "secret session bootstrap",
      waitForFinish: false
    }, { run: run as never, detectCapabilities: vi.fn(async () => capabilities()) as never, sdk: sdk as never } as never)).rejects.toThrow("Refusing CLI fallback");
    expect(run).not.toHaveBeenCalled();
  });
});
