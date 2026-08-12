import { describe, expect, it, vi } from "vitest";
import { createPaseoSdkAgentWithClient, materializePaseoSdkAgentWithClient } from "../src/paseo/sdk.js";

describe("Paseo SDK adapter", () => {
  it("creates workspace agents without parentage and keeps cwd alongside workspace placement", async () => {
    let received: Record<string, unknown> | undefined;
    const handle = { id: "agent-worker", workspaceId: "workspace-1", status: "idle", refresh: vi.fn(), run: vi.fn(), waitForFinish: vi.fn() };
    const client = {
      agents: { create: vi.fn(async (options: Record<string, unknown>) => { received = options; return handle; }), ref: vi.fn(), list: vi.fn() },
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
      cwd: "/repo",
      workspaceId: "workspace-1",
      config: { provider: "codex", model: "gpt-test", systemPrompt: "authoritative session instructions" },
      labels: { "aeh.task": "TASK-1", "aeh.role": "backend-implementer" }
    }));
    expect(received).not.toHaveProperty("parent");
    expect(received).not.toHaveProperty("callerAgentId");
  });

  it("places exact MCP server and preapproval policy inside AgentSessionConfig", async () => {
    let received: Record<string, unknown> | undefined;
    const handle = { id: "lead", workspaceId: null, status: "idle", refresh: vi.fn(), run: vi.fn(), waitForFinish: vi.fn() };
    const client = {
      agents: { create: vi.fn(async (options: Record<string, unknown>) => { received = options; return handle; }), ref: vi.fn(), list: vi.fn() },
      connect: vi.fn(), close: vi.fn()
    };
    await createPaseoSdkAgentWithClient(client as never, {
      cwd: "/repo",
      provider: "codex",
      model: "gpt-test",
      title: "lead",
      systemPrompt: "bootstrap",
      mcpServers: { "aeh-control": { type: "stdio", command: "/usr/bin/node", args: ["/pkg/dist/main.js", "operation", "mcp"], alwaysLoad: true } },
      toolPolicy: { preapproved: [{ kind: "mcp", server: "aeh-control", tool: "aeh_operation_start_audit" }] },
      waitForFinish: false
    });
    expect(received).toEqual(expect.objectContaining({
      cwd: "/repo",
      config: {
        provider: "codex",
        model: "gpt-test",
        systemPrompt: "bootstrap",
        mcpServers: { "aeh-control": { type: "stdio", command: "/usr/bin/node", args: ["/pkg/dist/main.js", "operation", "mcp"], alwaysLoad: true } },
        toolPolicy: { preapproved: [{ kind: "mcp", server: "aeh-control", tool: "aeh_operation_start_audit" }] }
      }
    }));
  });

  it("uses initialPrompt and waits for an initial worker prompt", async () => {
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

    expect(received).toEqual(expect.objectContaining({
      cwd: "/repo",
      initialPrompt: "Implement the bounded task",
      outputSchema: { type: "object" },
      config: { provider: "opencode", model: "deepseek-v4-flash" }
    }));
    expect(received).not.toHaveProperty("prompt");
    expect(handle.waitForFinish).toHaveBeenCalledWith(1234);
    expect(result).toEqual(expect.objectContaining({ id: "agent-2", status: "idle", lastMessage: "done" }));
  });

  it("materializes an idle visible agent without dispatching user work", async () => {
    let received: Record<string, unknown> | undefined;
    const handle = { id: "agent-idle", workspaceId: "workspace-op", status: "idle", refresh: vi.fn(), run: vi.fn(), waitForFinish: vi.fn() };
    const client = {
      agents: { create: vi.fn(async (options: Record<string, unknown>) => { received = options; return handle; }), ref: vi.fn(), list: vi.fn() },
      connect: vi.fn(), close: vi.fn()
    };

    const result = await materializePaseoSdkAgentWithClient(client as never, {
      cwd: "/repo",
      workspaceId: "workspace-op",
      provider: "codex",
      model: "gpt-test",
      title: "reviewer",
      prompt: "must not be dispatched yet"
    });

    expect(result).toEqual(expect.objectContaining({ id: "agent-idle", status: "idle", workspaceId: "workspace-op" }));
    expect(received).toEqual(expect.objectContaining({ cwd: "/repo", workspaceId: "workspace-op", config: { provider: "codex", model: "gpt-test" } }));
    expect(received).not.toHaveProperty("initialPrompt");
  });

  it("allows the SDK/provider to select a default model when AEH has none", async () => {
    let received: Record<string, unknown> | undefined;
    const handle = { id: "agent-default", workspaceId: null, status: "idle", refresh: vi.fn(), run: vi.fn(), waitForFinish: vi.fn() };
    const client = {
      agents: { create: vi.fn(async (options: Record<string, unknown>) => { received = options; return handle; }), ref: vi.fn(), list: vi.fn() },
      connect: vi.fn(), close: vi.fn()
    };
    await createPaseoSdkAgentWithClient(client as never, { cwd: "/repo", provider: "codex", title: "default" });
    expect(received).toEqual(expect.objectContaining({ cwd: "/repo", config: { provider: "codex" } }));
  });

  it("normalizes a legacy combined provider/model value into Paseo config fields", async () => {
    let received: Record<string, unknown> | undefined;
    const handle = { id: "agent-legacy", workspaceId: null, status: "idle", refresh: vi.fn(), run: vi.fn(), waitForFinish: vi.fn() };
    const client = {
      agents: { create: vi.fn(async (options: Record<string, unknown>) => { received = options; return handle; }), ref: vi.fn(), list: vi.fn() },
      connect: vi.fn(), close: vi.fn()
    };

    await createPaseoSdkAgentWithClient(client as never, {
      cwd: "/repo",
      provider: "codex/gpt-5.6-luna",
      title: "legacy"
    });

    expect(received).toEqual(expect.objectContaining({ config: { provider: "codex", model: "gpt-5.6-luna" } }));
  });

  it("rejects conflicting embedded and explicit model values", async () => {
    const client = { agents: { create: vi.fn(), ref: vi.fn(), list: vi.fn() }, connect: vi.fn(), close: vi.fn() };
    await expect(createPaseoSdkAgentWithClient(client as never, {
      cwd: "/repo",
      provider: "codex/gpt-a",
      model: "gpt-b",
      title: "conflict"
    })).rejects.toThrow("Conflicting Paseo models");
  });
});
