import { describe, expect, it, vi } from "vitest";
import { createPaseoSdkAgentWithClient } from "../src/paseo/sdk.js";

describe("Paseo SDK adapter", () => {
  it("creates workspace agents without parentage and places bootstrap in systemPrompt", async () => {
    let received: Record<string, unknown> | undefined;
    const handle = { id: "agent-worker", workspaceId: "workspace-1", status: "idle", refresh: vi.fn(), run: vi.fn(), waitForFinish: vi.fn() };
    const client = {
      agents: { create: vi.fn(), ref: vi.fn(), list: vi.fn() },
      workspaces: { ref: vi.fn(() => ({ agents: { create: vi.fn(async (options: Record<string, unknown>) => { received = options; return handle; }) } })) },
      connect: vi.fn(), close: vi.fn()
    };

    const result = await createPaseoSdkAgentWithClient(client as never, {
      cwd: "/repo",
      workspaceId: "workspace-1",
      provider: "codex",
      model: "gpt-test",
      title: "AEH worker",
      systemPrompt: "authoritative session instructions",
      labels: { "aeh.task": "TASK-1", "aeh.role": "backend-implementer" },
      waitForFinish: false
    });

    expect(result.id).toBe("agent-worker");
    expect(received).toEqual(expect.objectContaining({
      title: "AEH worker",
      config: { provider: "codex/gpt-test", systemPrompt: "authoritative session instructions" },
      labels: { "aeh.task": "TASK-1", "aeh.role": "backend-implementer" }
    }));
    expect(received).not.toHaveProperty("parent");
    expect(received).not.toHaveProperty("callerAgentId");
    expect(received).not.toHaveProperty("cwd");
  });

  it("waits for an initial worker prompt and returns the final assistant message", async () => {
    const handle = {
      id: "agent-2",
      workspaceId: null,
      status: "working",
      refresh: vi.fn(),
      run: vi.fn(),
      waitForFinish: vi.fn(async () => ({ status: "idle", lastMessage: "done" }))
    };
    let received: Record<string, unknown> | undefined;
    const client = {
      agents: { create: vi.fn(async (options: Record<string, unknown>) => { received = options; return handle; }), ref: vi.fn(), list: vi.fn() },
      workspaces: { ref: vi.fn() },
      connect: vi.fn(), close: vi.fn()
    };

    const result = await createPaseoSdkAgentWithClient(client as never, {
      cwd: "/repo",
      provider: "opencode",
      model: "deepseek-v4-flash",
      title: "worker",
      prompt: "Implement the bounded task",
      outputSchema: { type: "object" },
      timeoutMs: 1234
    });

    expect(received).toEqual(expect.objectContaining({ cwd: "/repo", prompt: "Implement the bounded task", outputSchema: { type: "object" } }));
    expect(handle.waitForFinish).toHaveBeenCalledWith(1234);
    expect(result).toEqual(expect.objectContaining({ id: "agent-2", status: "idle", lastMessage: "done" }));
  });
});
