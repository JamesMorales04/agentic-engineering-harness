import { describe, expect, it, vi } from "vitest";
import { createPaseoSdkAgentWithClient } from "../src/paseo/sdk.js";

describe("Paseo operation parenting", () => {
  it("passes parent as a top-level create option without changing AgentSessionConfig", async () => {
    let received: Record<string, unknown> | undefined;
    const handle = {
      id: "reviewer-1",
      workspaceId: "workspace-op",
      status: "idle",
      latest: vi.fn(() => ({ id: "reviewer-1", status: "idle", workspaceId: "workspace-op" })),
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
      cwd: "/repo",
      workspaceId: "workspace-op",
      parentAgentId: "supervisor-1",
      provider: "opencode",
      model: "opencode-go/deepseek-v4-flash",
      title: "aeh-reviewer",
      labels: {
        "aeh.operation": "AUDIT-1",
        "aeh.supervisor.generation": "1"
      },
      waitForFinish: false
    });

    expect(received).toEqual(expect.objectContaining({
      cwd: "/repo",
      workspaceId: "workspace-op",
      parent: "supervisor-1",
      config: expect.objectContaining({
        provider: "opencode",
        model: "opencode-go/deepseek-v4-flash"
      })
    }));
    expect(received?.config).not.toHaveProperty("parent");
  });
});
