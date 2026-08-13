import { afterEach, describe, expect, it } from "vitest";
import { compilePaseoAgentLaunchSpec } from "../src/paseo/launchSpec.js";

const original = {
  id: process.env.AEH_OPERATION_ID,
  kind: process.env.AEH_OPERATION_KIND,
  workspace: process.env.AEH_OPERATION_WORKSPACE_ID
};
afterEach(() => {
  restore("AEH_OPERATION_ID", original.id);
  restore("AEH_OPERATION_KIND", original.kind);
  restore("AEH_OPERATION_WORKSPACE_ID", original.workspace);
});

describe("Paseo launch spec", () => {
  it("uses operation-local workspace and labels even when delivery Paseo is disabled", async () => {
    process.env.AEH_OPERATION_ID = "AUDIT-1";
    process.env.AEH_OPERATION_KIND = "audit";
    process.env.AEH_OPERATION_WORKSPACE_ID = "workspace-op";
    const config = {
      version: 1,
      project: { name: "demo" },
      orchestration: {
        provider: "paseo",
        worker: { timeoutSeconds: 90, titlePrefix: "aeh" }
      },
      delivery: { paseo: { enabled: false } }
    } as never;
    const contract = {
      version: 1,
      task: { id: "AUDIT-1", title: "audit" },
      routing: { intent: "audit" }
    } as never;
    const selection = {
      logicalAgent: "security-reviewer",
      paseoProvider: "codex",
      runtimeAdapter: "codex",
      modelName: "gpt-test",
      modelId: "openai/gpt-test",
      profile: "balanced"
    } as never;

    const spec = await compilePaseoAgentLaunchSpec("/repo", config, contract, {
      selection,
      phase: "review"
    });
    expect(spec).toEqual(
      expect.objectContaining({
        provider: "codex",
        model: "gpt-test",
        workspaceId: "workspace-op",
        operationId: "AUDIT-1",
        operationKind: "audit",
        phase: "review",
        timeoutSeconds: 90
      })
    );
    expect(spec.modeId).toBeUndefined();
    expect(spec.env).toBeUndefined();
    expect(spec.labels).toEqual(
      expect.objectContaining({
        "aeh.project": "demo",
        "aeh.task": "AUDIT-1",
        "aeh.role": "security-reviewer",
        "aeh.operation": "AUDIT-1",
        "aeh.operation.kind": "audit",
        "aeh.operation.phase": "review",
        "aeh.workspace.kind": "orchestration"
      })
    );
  });

  it("compiles an AEH-managed OpenCode primary agent into modeId and session env", async () => {
    process.env.AEH_OPERATION_ID = "AUDIT-2";
    process.env.AEH_OPERATION_KIND = "audit";
    process.env.AEH_OPERATION_WORKSPACE_ID = "workspace-op";
    const config = {
      version: 1,
      project: { name: "demo" },
      orchestration: {
        provider: "paseo",
        worker: { timeoutSeconds: 120, titlePrefix: "aeh" }
      },
      delivery: { paseo: { enabled: false } }
    } as never;
    const contract = {
      version: 1,
      task: { id: "AUDIT-2", title: "audit" },
      routing: { intent: "audit" }
    } as never;
    const selection = {
      logicalAgent: "code-quality-reviewer",
      role: "reviewer",
      description: "Review maintainability.",
      paseoProvider: "opencode",
      runtimeAdapter: "opencode",
      runtimeName: "opencode",
      modelName: "deepseek-v4-flash",
      modelId: "opencode-go/deepseek-v4-flash",
      profile: "balanced",
      variant: "high",
      skills: [],
      mcps: [],
      permissions: { read: "allow", write: "deny", shell: "allow", network: "deny" }
    } as never;

    const spec = await compilePaseoAgentLaunchSpec("/repo", config, contract, {
      selection,
      phase: "review"
    });
    const inline = JSON.parse(spec.env!.OPENCODE_CONFIG_CONTENT) as {
      default_agent: string;
      agent: Record<string, Record<string, unknown>>;
    };

    expect(spec).toEqual(
      expect.objectContaining({
        provider: "opencode",
        model: "opencode-go/deepseek-v4-flash",
        modeId: "aeh-code-quality-reviewer",
        modeSource: "aeh-managed",
        nativeAgentId: "aeh-code-quality-reviewer",
        thinkingOptionId: "high"
      })
    );
    expect(inline.default_agent).toBe("aeh-code-quality-reviewer");
    expect(inline.agent["aeh-code-quality-reviewer"]).toEqual(
      expect.objectContaining({
        mode: "primary",
        model: "opencode-go/deepseek-v4-flash"
      })
    );
    expect(spec.labels).toEqual(
      expect.objectContaining({
        "aeh.native-agent": "aeh-code-quality-reviewer",
        "aeh.native-agent.source": "aeh-managed"
      })
    );
  });

  it("preserves an explicitly configured OpenCode nativeAgent as the Paseo mode", async () => {
    const config = {
      version: 1,
      project: { name: "demo" },
      orchestration: { provider: "paseo", worker: {} },
      delivery: { paseo: { enabled: false } }
    } as never;
    const contract = {
      version: 1,
      task: { id: "TASK-1", title: "task" },
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
    const inline = JSON.parse(spec.env!.OPENCODE_CONFIG_CONTENT) as Record<string, unknown>;
    expect(spec.modeId).toBe("company-backend-agent");
    expect(spec.modeSource).toBe("explicit");
    expect(spec.nativeAgentId).toBe("company-backend-agent");
    expect(inline).not.toHaveProperty("agent");
    expect(inline).not.toHaveProperty("default_agent");
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
