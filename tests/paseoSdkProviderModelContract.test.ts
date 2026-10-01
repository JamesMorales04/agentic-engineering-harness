import { describe, expect, it, vi } from "vitest";
import { createPaseoSdkAgentWithClient } from "../src/paseo/sdk.js";

function stubClientWithCreateCapture() {
  let received: Record<string, unknown> | undefined;
  const create = vi.fn(async (options: Record<string, unknown>) => {
    received = options;
    return { id: "agent-1", workspaceId: "workspace-1", status: "idle" };
  });
  const client = {
    agents: { create, ref: vi.fn(), list: vi.fn() },
    connect: vi.fn(),
    close: vi.fn()
  };
  return { client, create, received: () => received };
}

describe("Paseo SDK provider/model boundary contract", () => {
  it("sends the combined provider/model value in config.provider and omits config.model", async () => {
    const { client, received } = stubClientWithCreateCapture();
    const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ agent: { "aeh-implementer": { mode: "primary" } } }) };
    const labels = { "aeh.operation": "op-s9-r8", "aeh.task": "TASK-S9-R8", "aeh.role": "implementer" };

    await createPaseoSdkAgentWithClient(client as never, {
      cwd: "/tmp/aeh-s9-sdk-provider-model-contract",
      workspaceId: "workspace-s9",
      parentAgentId: "agent-parent",
      provider: "opencode",
      model: "opencode-go/deepseek-v4.1-flash",
      modeId: "primary",
      thinkingOptionId: "high",
      env,
      title: "S9-R8 regression",
      systemPrompt: "frozen system prompt",
      prompt: "perform the bounded task",
      labels,
      waitForFinish: false
    });

    const outgoing = received();
    expect(outgoing).toBeDefined();
    expect(outgoing?.config).toEqual({
      provider: "opencode/opencode-go/deepseek-v4.1-flash",
      modeId: "primary",
      thinkingOptionId: "high",
      systemPrompt: "frozen system prompt"
    });
    expect(outgoing?.config).not.toHaveProperty("model");
    expect(outgoing).toEqual(
      expect.objectContaining({
        cwd: "/tmp/aeh-s9-sdk-provider-model-contract",
        workspaceId: "workspace-s9",
        parent: "agent-parent",
        env,
        title: "S9-R8 regression",
        initialPrompt: "perform the bounded task",
        labels
      })
    );
  });

  it("combines a simple provider/model pair without emitting a separate config.model", async () => {
    const { client, received } = stubClientWithCreateCapture();

    await createPaseoSdkAgentWithClient(client as never, {
      cwd: "/repo",
      provider: "codex",
      model: "gpt-test",
      title: "simple",
      waitForFinish: false
    });

    const outgoing = received();
    expect(outgoing?.config).toEqual({ provider: "codex/gpt-test" });
    expect(outgoing?.config).not.toHaveProperty("model");
    expect(outgoing).not.toHaveProperty("initialPrompt");
  });
});
