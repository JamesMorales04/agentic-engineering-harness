import { describe, expect, it, vi } from "vitest";
import { compilePaseoAgentLaunchSpec } from "../src/paseo/launchSpec.js";
import { createPaseoSdkAgentWithClient } from "../src/paseo/sdk.js";

describe("AEH-managed OpenCode identity through Paseo", () => {
  it("keeps the generated native identity session-local and leaves Paseo modeId unset", async () => {
    const config = {
      version: 1,
      project: { name: "agentic-engineering-harness" },
      orchestration: {
        provider: "paseo",
        worker: { timeoutSeconds: 120, titlePrefix: "aeh" }
      },
      delivery: { paseo: { enabled: false } }
    } as never;
    const contract = {
      version: 1,
      task: { id: "AUDIT-REGRESSION", title: "audit" },
      routing: { intent: "audit" }
    } as never;
    const selection = {
      logicalAgent: "code-quality-reviewer",
      role: "reviewer",
      description: "Review code quality.",
      paseoProvider: "opencode",
      runtimeAdapter: "opencode",
      runtimeName: "opencode",
      modelName: "deepseek-v4-flash",
      modelId: "opencode-go/deepseek-v4-flash",
      profile: "balanced",
      skills: [],
      mcps: [],
      permissions: {
        read: "allow",
        write: "deny",
        shell: "allow",
        network: "deny",
        delegate: "deny",
        review: "allow",
        gitWrite: "deny"
      }
    } as never;

    const spec = await compilePaseoAgentLaunchSpec("/repo", config, contract, {
      selection,
      phase: "review"
    });

    expect(spec.nativeAgentId).toBe("aeh-code-quality-reviewer");
    expect(spec.modeId).toBeUndefined();
    expect(spec.modeSource).toBeUndefined();

    const inline = JSON.parse(spec.env!.OPENCODE_CONFIG_CONTENT) as {
      default_agent: string;
      agent: Record<string, { mode: string }>;
    };
    expect(inline.default_agent).toBe("aeh-code-quality-reviewer");
    expect(inline.agent["aeh-code-quality-reviewer"].mode).toBe("primary");

    let received: Record<string, unknown> | undefined;
    const handle = {
      id: "paseo-reviewer",
      workspaceId: null,
      status: "idle",
      refresh: vi.fn(),
      run: vi.fn(),
      waitForFinish: vi.fn()
    };
    const client = {
      agents: {
        create: vi.fn(async (options: Record<string, unknown>) => {
          received = options;
          return handle;
        }),
        ref: vi.fn(),
        list: vi.fn()
      },
      connect: vi.fn(),
      close: vi.fn()
    };

    await createPaseoSdkAgentWithClient(client as never, {
      cwd: spec.cwd,
      provider: spec.provider,
      model: spec.model,
      modeId: spec.modeId,
      thinkingOptionId: spec.thinkingOptionId,
      env: spec.env,
      title: spec.title,
      labels: spec.labels,
      waitForFinish: false
    });

    expect(received).toEqual(
      expect.objectContaining({
        cwd: "/repo",
        env: expect.objectContaining({
          OPENCODE_CONFIG_CONTENT: expect.any(String)
        }),
        config: expect.objectContaining({
          provider: "opencode",
          model: "opencode-go/deepseek-v4-flash"
        })
      })
    );
    expect(received?.config).not.toHaveProperty("modeId");
  });

  it("still exposes an explicit external OpenCode agent as Paseo modeId", async () => {
    const config = {
      version: 1,
      project: { name: "demo" },
      orchestration: { provider: "paseo", worker: {} },
      delivery: { paseo: { enabled: false } }
    } as never;
    const contract = {
      version: 1,
      task: { id: "TASK-EXPLICIT", title: "task" },
      routing: { intent: "implement" }
    } as never;
    const selection = {
      logicalAgent: "backend-implementer",
      role: "implementer",
      paseoProvider: "opencode",
      runtimeAdapter: "opencode",
      runtimeName: "opencode",
      modelName: "deepseek-v4-flash",
      modelId: "opencode-go/deepseek-v4-flash",
      nativeAgent: "company-backend-agent",
      skills: [],
      mcps: [],
      permissions: { read: "allow", write: "allow", shell: "allow" }
    } as never;

    const spec = await compilePaseoAgentLaunchSpec("/repo", config, contract, {
      selection
    });

    expect(spec.nativeAgentId).toBe("company-backend-agent");
    expect(spec.modeId).toBe("company-backend-agent");
    expect(spec.modeSource).toBe("explicit");
  });
});
