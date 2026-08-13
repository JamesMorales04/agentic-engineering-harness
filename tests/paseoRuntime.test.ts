import { afterEach, describe, expect, it, vi } from "vitest";
import { PaseoSdkUnavailableError } from "../src/paseo/sdk.js";
import {
  dispatchManagedPaseoAgent,
  launchManagedPaseoAgent,
  materializeManagedPaseoAgent,
  waitManagedPaseoAgent
} from "../src/paseo/runtime.js";

function result(exitCode: number, stdout = "", stderr = "") {
  return { exitCode, stdout, stderr, durationMs: 1 };
}
function capabilities() {
  return {
    version: "0.6.0",
    background: true,
    quiet: true,
    json: false,
    outputSchema: true,
    daemonJson: true,
    nativeToolsRecommended: true
  };
}
function sdk(overrides: Record<string, unknown> = {}) {
  return {
    create: vi.fn(async () => ({
      id: "sdk-agent",
      status: "working",
      lastMessage: "accepted"
    })),
    materialize: vi.fn(async () => ({
      id: "sdk-idle",
      status: "idle",
      workspaceId: "workspace-op"
    })),
    dispatch: vi.fn(async () => ({
      id: "sdk-idle",
      status: "working",
      workspaceId: "workspace-op"
    })),
    wait: vi.fn(async (_root: string, agentId: string) => ({
      id: agentId,
      status: "idle",
      lastMessage: "sdk wait done",
      workspaceId: "workspace-op"
    })),
    run: vi.fn(),
    probe: vi.fn(),
    inspect: vi.fn(),
    list: vi.fn(),
    ...overrides
  };
}
function native(overrides: Record<string, unknown> = {}) {
  return {
    preflight: vi.fn(async (_root: string, provider: string, model?: string) => ({
      ok: true,
      provider,
      model,
      source: "paseo-provider-models",
      message: "ok"
    })),
    preflightMode: vi.fn(
      async (_root: string, provider: string, modeId: string) => ({
        ok: true,
        provider,
        modeId,
        availableModes: [modeId],
        source: "paseo-provider-modes",
        message: "ok"
      })
    ),
    wait: vi.fn(async (_root: string, agentId: string) => ({
      id: agentId,
      status: "idle",
      lastMessage: "event done",
      workspaceId: "workspace-op",
      source: "paseo-agent-subscription",
      updatesObserved: 1
    })),
    ...overrides
  };
}
function deps(
  run: ReturnType<typeof vi.fn>,
  sdkDeps = sdk(),
  nativeDeps = native(),
  trace = vi.fn(async () => undefined)
) {
  return {
    run: run as never,
    detectCapabilities: vi.fn(async () => capabilities()) as never,
    sdk: sdkDeps as never,
    native: nativeDeps as never,
    trace: trace as never
  } as never;
}

afterEach(() => {
  delete process.env.AEH_PASEO_FORCE_CLI;
  delete process.env.AEH_OPERATION_ID;
  delete process.env.AEH_OPERATION_KIND;
  delete process.env.AEH_OPERATION_WORKSPACE_ID;
});

describe("managed Paseo runtime", () => {
  it("preflights provider/model, creates immediately, then waits through subscription", async () => {
    const run = vi.fn(async () => {
      throw new Error("CLI should not be used");
    });
    const sdkDeps = sdk();
    const nativeDeps = native();
    const launched = await launchManagedPaseoAgent(
      "/repo",
      {
        cwd: "/repo",
        provider: "codex",
        model: "gpt-test",
        title: "worker",
        prompt: "do work"
      },
      deps(run, sdkDeps, nativeDeps)
    );

    expect(launched).toEqual(
      expect.objectContaining({
        id: "sdk-agent",
        transport: "sdk",
        observation: "subscription",
        exitCode: 0,
        stdout: "event done"
      })
    );
    expect(nativeDeps.preflight).toHaveBeenCalledWith(
      "/repo",
      "codex",
      "gpt-test",
      "/repo"
    );
    expect(nativeDeps.preflightMode).not.toHaveBeenCalled();
    expect(sdkDeps.create).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({ waitForFinish: false })
    );
    expect(nativeDeps.wait).toHaveBeenCalledWith(
      "/repo",
      "sdk-agent",
      1_800_000,
      undefined
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("trusts an AEH-managed inline OpenCode primary instead of querying ambient modes", async () => {
    const run = vi.fn(async () => {
      throw new Error("CLI should not be used");
    });
    const sdkDeps = sdk();
    const nativeDeps = native();
    const trace = vi.fn(async () => undefined);
    const launched = await launchManagedPaseoAgent(
      "/repo",
      {
        cwd: "/repo",
        provider: "opencode",
        model: "opencode-go/deepseek-v4-flash",
        modeId: "aeh-code-quality-reviewer",
        modeSource: "aeh-managed",
        env: { OPENCODE_CONFIG_CONTENT: "{\"default_agent\":\"aeh-code-quality-reviewer\"}" },
        title: "reviewer",
        prompt: "review"
      },
      deps(run, sdkDeps, nativeDeps, trace)
    );

    expect(launched.transport).toBe("sdk");
    expect(nativeDeps.preflightMode).not.toHaveBeenCalled();
    expect(sdkDeps.create).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({
        modeId: "aeh-code-quality-reviewer",
        modeSource: "aeh-managed",
        env: expect.objectContaining({ OPENCODE_CONFIG_CONTENT: expect.any(String) })
      })
    );
    expect(trace).toHaveBeenCalledWith(
      "/repo",
      "provider.mode.preflight",
      expect.objectContaining({
        ok: true,
        modeId: "aeh-code-quality-reviewer",
        source: "aeh-inline-config"
      })
    );
    expect(trace).toHaveBeenCalledWith(
      "/repo",
      "agent.identity",
      expect.objectContaining({
        provider: "opencode",
        modeId: "aeh-code-quality-reviewer",
        source: "aeh-managed",
        sessionScopedEnv: true
      })
    );
  });

  it("preflights an explicit native OpenCode agent and fails before create when it is unavailable", async () => {
    const run = vi.fn();
    const sdkDeps = sdk();
    const nativeDeps = native({
      preflightMode: vi.fn(async () => ({
        ok: false,
        provider: "opencode",
        modeId: "company-reviewer",
        availableModes: ["build", "plan"],
        source: "paseo-provider-modes",
        message: "requested mode missing"
      }))
    });

    await expect(
      launchManagedPaseoAgent(
        "/repo",
        {
          cwd: "/repo",
          provider: "opencode",
          model: "opencode-go/deepseek-v4-flash",
          modeId: "company-reviewer",
          modeSource: "explicit",
          env: { OPENCODE_CONFIG_CONTENT: "{}" },
          title: "reviewer",
          prompt: "review"
        },
        deps(run, sdkDeps, nativeDeps)
      )
    ).rejects.toThrow(
      "Paseo mode preflight failed: requested mode missing Available modes: build, plan."
    );
    expect(nativeDeps.preflightMode).toHaveBeenCalledWith(
      "/repo",
      "opencode",
      "company-reviewer",
      "/repo"
    );
    expect(sdkDeps.create).not.toHaveBeenCalled();
  });

  it("returns immediately when caller explicitly requests no wait", async () => {
    const run = vi.fn(async () => {
      throw new Error("CLI should not be used");
    });
    const sdkDeps = sdk();
    const nativeDeps = native();
    const launched = await launchManagedPaseoAgent(
      "/repo",
      {
        cwd: "/repo",
        provider: "codex",
        model: "gpt-test",
        title: "worker",
        prompt: "do work",
        waitForFinish: false
      },
      deps(run, sdkDeps, nativeDeps)
    );
    expect(launched).toEqual(
      expect.objectContaining({ id: "sdk-agent", status: "working", transport: "sdk" })
    );
    expect(nativeDeps.wait).not.toHaveBeenCalled();
  });

  it("fails before create when provider/model preflight is authoritative and negative", async () => {
    const run = vi.fn();
    const sdkDeps = sdk();
    const nativeDeps = native({
      preflight: vi.fn(async () => ({
        ok: false,
        provider: "codex",
        model: "missing",
        source: "paseo-provider-models",
        message: "model missing",
        availableModels: ["gpt-good"]
      }))
    });
    await expect(
      launchManagedPaseoAgent(
        "/repo",
        {
          cwd: "/repo",
          provider: "codex",
          model: "missing",
          title: "worker",
          prompt: "do work"
        },
        deps(run, sdkDeps, nativeDeps)
      )
    ).rejects.toThrow("Paseo provider preflight failed");
    expect(sdkDeps.create).not.toHaveBeenCalled();
  });

  it("continues to creation when provider preflight SDK capability is unavailable", async () => {
    const run = vi.fn(async () => {
      throw new Error("CLI should not be used");
    });
    const sdkDeps = sdk();
    const nativeDeps = native({
      preflight: vi.fn(async () => {
        throw new PaseoSdkUnavailableError("provider API unavailable");
      })
    });
    const launched = await launchManagedPaseoAgent(
      "/repo",
      {
        cwd: "/repo",
        provider: "codex",
        title: "worker",
        prompt: "do work"
      },
      deps(run, sdkDeps, nativeDeps)
    );
    expect(launched.transport).toBe("sdk");
    expect(sdkDeps.create).toHaveBeenCalledTimes(1);
  });

  it("supports materialize, dispatch and event-driven wait as separate SDK lifecycle phases", async () => {
    const run = vi.fn(async () => {
      throw new Error("CLI should not be used");
    });
    const sdkDeps = sdk();
    const nativeDeps = native();
    const runtimeDeps = deps(run, sdkDeps, nativeDeps);
    const materialized = await materializeManagedPaseoAgent(
      "/repo",
      {
        cwd: "/repo",
        provider: "codex",
        model: "gpt",
        title: "reviewer"
      },
      runtimeDeps
    );
    const dispatched = await dispatchManagedPaseoAgent(
      "/repo",
      materialized.id!,
      "review it",
      120,
      runtimeDeps
    );
    const waited = await waitManagedPaseoAgent(
      "/repo",
      materialized.id!,
      120,
      runtimeDeps
    );
    expect(materialized).toEqual(
      expect.objectContaining({
        id: "sdk-idle",
        status: "idle",
        workspaceId: "workspace-op"
      })
    );
    expect(dispatched).toEqual(expect.objectContaining({ status: "working" }));
    expect(waited).toEqual(
      expect.objectContaining({
        status: "idle",
        stdout: "event done",
        observation: "subscription"
      })
    );
    expect(sdkDeps.materialize).toHaveBeenCalledTimes(1);
    expect(sdkDeps.dispatch).toHaveBeenCalledTimes(1);
    expect(nativeDeps.wait).toHaveBeenCalledTimes(1);
    expect(sdkDeps.wait).not.toHaveBeenCalled();
  });

  it("falls back from subscription to SDK wait when subscriptions are unavailable", async () => {
    const run = vi.fn(async () => {
      throw new Error("CLI should not be used");
    });
    const sdkDeps = sdk();
    const nativeDeps = native({
      wait: vi.fn(async () => {
        throw new PaseoSdkUnavailableError("subscribe unavailable");
      })
    });
    const waited = await waitManagedPaseoAgent(
      "/repo",
      "sdk-idle",
      120,
      deps(run, sdkDeps, nativeDeps)
    );
    expect(waited).toEqual(
      expect.objectContaining({
        transport: "sdk",
        observation: "sdk-wait",
        stdout: "sdk wait done"
      })
    );
    expect(sdkDeps.wait).toHaveBeenCalledTimes(1);
  });

  it("falls back to negotiated CLI lifecycle when the SDK is unavailable for a config that needs no launch env", async () => {
    const commands: string[] = [];
    const run = vi.fn(async (command: string) => {
      commands.push(command);
      if (command.startsWith("paseo run --background")) return result(0, "agent-cli\n");
      if (command === "paseo wait 'agent-cli' --timeout 1800") return result(0, "idle");
      if (command === "paseo logs 'agent-cli' --tail 200") return result(0, "cli done");
      throw new Error(`unexpected ${command}`);
    });
    const sdkDeps = sdk({
      create: vi.fn(async () => {
        throw new PaseoSdkUnavailableError("not installed");
      }),
      wait: vi.fn(async () => {
        throw new PaseoSdkUnavailableError("not installed");
      })
    });
    const nativeDeps = native({
      preflight: vi.fn(async () => {
        throw new PaseoSdkUnavailableError("not installed");
      }),
      wait: vi.fn(async () => {
        throw new PaseoSdkUnavailableError("not installed");
      })
    });
    const launched = await launchManagedPaseoAgent(
      "/repo",
      {
        cwd: "/repo",
        provider: "codex",
        model: "gpt-test",
        title: "worker",
        prompt: "do work",
        timeoutSeconds: 1800
      },
      deps(run, sdkDeps, nativeDeps)
    );

    expect(launched).toEqual(
      expect.objectContaining({
        id: "agent-cli",
        transport: "cli",
        exitCode: 0,
        stdout: "cli done"
      })
    );
    expect(launched.stderr).toContain("SDK unavailable");
    expect(commands[0]).toContain("paseo run --background");
  });

  it("refuses CLI fallback when dropping OpenCode session env would reintroduce ambient-agent selection", async () => {
    const run = vi.fn();
    const sdkDeps = sdk({
      create: vi.fn(async () => {
        throw new PaseoSdkUnavailableError("not installed");
      })
    });
    const nativeDeps = native({
      preflight: vi.fn(async () => {
        throw new PaseoSdkUnavailableError("not installed");
      })
    });

    await expect(
      launchManagedPaseoAgent(
        "/repo",
        {
          cwd: "/repo",
          provider: "opencode",
          modeId: "aeh-reviewer",
          modeSource: "aeh-managed",
          env: { OPENCODE_CONFIG_CONTENT: "{}" },
          title: "reviewer",
          prompt: "review"
        },
        deps(run, sdkDeps, nativeDeps)
      )
    ).rejects.toThrow("Refusing CLI fallback because dropping that environment");
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses to turn a systemPrompt-only idle lead into a CLI user turn", async () => {
    const run = vi.fn(async () => {
      throw new Error("CLI must not receive bootstrap text");
    });
    const sdkDeps = sdk({
      create: vi.fn(async () => {
        throw new PaseoSdkUnavailableError("not installed");
      })
    });
    const nativeDeps = native({
      preflight: vi.fn(async () => {
        throw new PaseoSdkUnavailableError("not installed");
      })
    });
    await expect(
      launchManagedPaseoAgent(
        "/repo",
        {
          cwd: "/repo",
          provider: "codex",
          model: "gpt-test",
          title: "lead",
          systemPrompt: "secret session bootstrap",
          waitForFinish: false
        },
        deps(run, sdkDeps, nativeDeps)
      )
    ).rejects.toThrow("Refusing CLI fallback");
    expect(run).not.toHaveBeenCalled();
  });
});
