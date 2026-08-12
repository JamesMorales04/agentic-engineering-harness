import { afterEach, describe, expect, it } from "vitest";
import { compilePaseoAgentLaunchSpec } from "../src/paseo/launchSpec.js";

const original = { id: process.env.AEH_OPERATION_ID, kind: process.env.AEH_OPERATION_KIND, workspace: process.env.AEH_OPERATION_WORKSPACE_ID };
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
      orchestration: { provider: "paseo", worker: { timeoutSeconds: 90, titlePrefix: "aeh" } },
      delivery: { paseo: { enabled: false } }
    } as never;
    const contract = { version: 1, task: { id: "AUDIT-1", title: "audit" }, routing: { intent: "audit" } } as never;
    const selection = {
      logicalAgent: "security-reviewer",
      paseoProvider: "codex",
      runtimeAdapter: "codex",
      modelName: "gpt-test",
      modelId: "openai/gpt-test",
      profile: "balanced"
    } as never;

    const spec = await compilePaseoAgentLaunchSpec("/repo", config, contract, { selection, phase: "review" });
    expect(spec).toEqual(expect.objectContaining({
      provider: "codex",
      model: "gpt-test",
      workspaceId: "workspace-op",
      operationId: "AUDIT-1",
      operationKind: "audit",
      phase: "review",
      timeoutSeconds: 90
    }));
    expect(spec.labels).toEqual(expect.objectContaining({
      "aeh.project": "demo",
      "aeh.task": "AUDIT-1",
      "aeh.role": "security-reviewer",
      "aeh.operation": "AUDIT-1",
      "aeh.operation.kind": "audit",
      "aeh.operation.phase": "review",
      "aeh.workspace.kind": "orchestration"
    }));
  });
});

function restore(name: string, value: string | undefined): void { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
