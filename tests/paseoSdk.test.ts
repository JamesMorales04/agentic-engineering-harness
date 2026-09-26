import { describe, expect, it, vi } from "vitest";
import {
  connectPaseoClient,
  createPaseoSdkAgentWithClient,
  dispatchPaseoSdkAgentWithClient,
  materializePaseoSdkAgentWithClient
} from "../src/paseo/sdk.js";

describe("Paseo SDK adapter", () => {
  it("returns a clear SDK-unavailable error when daemon connection never settles", async () => {
    const client = { connect: vi.fn(async () => await new Promise<void>(() => undefined)) };
    await expect(connectPaseoClient(client, 5)).rejects.toThrow(
      "Unable to connect to the Paseo daemon through @getpaseo/client: Connecting to the Paseo daemon timed out after 5ms."
    );
  });

  it("enforces a timeout for send-based dispatch and stops the agent", async () => {
    const stop = vi.fn(async () => undefined);
    const handle = { id: "agent-hung", status: "working", send: vi.fn(async () => await new Promise<void>(() => undefined)), stop };
    const client = {
      agents: { create: vi.fn(), ref: vi.fn(() => handle), list: vi.fn() },
      connect: vi.fn(),
      close: vi.fn()
    };

    await expect(dispatchPaseoSdkAgentWithClient(client as never, "agent-hung", "work", 10)).rejects.toThrow("dispatch timed out");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("stops an agent when SDK waitForFinish reports a timeout", async () => {
    const stop = vi.fn(async () => undefined);
    const handle = { id: "agent-timeout", status: "working", waitForFinish: vi.fn(async () => ({ status: "timeout" })), stop };
    const client = {
      agents: { create: vi.fn(async () => handle), ref: vi.fn(), list: vi.fn() },
      connect: vi.fn(),
      close: vi.fn()
    };

    const result = await createPaseoSdkAgentWithClient(client as never, { cwd: "/repo", provider: "opencode", model: "test-model", title: "worker", prompt: "work", timeoutMs: 10 });
    expect(result.status).toBe("timeout");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("creates workspace agents without parentage and keeps cwd alongside workspace placement", async () => {
    let received: Record<string, unknown> | undefined;
    const handle = {
      id: "agent-worker",
      workspaceId: "workspace-1",
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
    expect(received).toEqual(
      expect.objectContaining({
        title: "AEH worker",
        cwd: "/repo",
        workspaceId: "workspace-1",
        config: {
          provider: "codex/gpt-test",
          systemPrompt: "authoritative session instructions"
        },
        labels: { "aeh.task": "TASK-1", "aeh.role": "backend-implementer" }
      })
    );
    expect(received).not.toHaveProperty("parent");
    expect(received).not.toHaveProperty("callerAgentId");
  });

  it("places exact MCP server and preapproval policy inside AgentSessionConfig", async () => {
    let received: Record<string, unknown> | undefined;
    const handle = {
      id: "lead",
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
      cwd: "/repo",
      provider: "codex",
      model: "gpt-test",
      title: "lead",
      systemPrompt: "bootstrap",
      mcpServers: {
        "aeh-control": {
          type: "stdio",
          command: "/usr/bin/node",
          args: ["/pkg/dist/main.js", "operation", "mcp"],
          alwaysLoad: true
        }
      },
      toolPolicy: {
        preapproved: [
          { kind: "mcp", server: "aeh-control", tool: "aeh_operation_start_audit" }
        ]
      },
      waitForFinish: false
    });
    expect(received).toEqual(
      expect.objectContaining({
        cwd: "/repo",
        config: {
          provider: "codex/gpt-test",
          systemPrompt: "bootstrap",
          mcpServers: {
            "aeh-control": {
              type: "stdio",
              command: "/usr/bin/node",
              args: ["/pkg/dist/main.js", "operation", "mcp"],
              alwaysLoad: true
            }
          },
          toolPolicy: {
            preapproved: [
              {
                kind: "mcp",
                server: "aeh-control",
                tool: "aeh_operation_start_audit"
              }
            ]
          }
        }
      })
    );
  });

  it("passes provider mode, thinking option and launch env to Paseo without flattening them", async () => {
    let received: Record<string, unknown> | undefined;
    const handle = {
      id: "agent-opencode",
      workspaceId: "workspace-op",
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
    const inline = JSON.stringify({
      default_agent: "aeh-code-quality-reviewer",
      agent: { "aeh-code-quality-reviewer": { mode: "primary" } }
    });

    await createPaseoSdkAgentWithClient(client as never, {
      cwd: "/repo",
      workspaceId: "workspace-op",
      provider: "opencode",
      model: "opencode-go/MiMo-V2.6-Flash",
      modeId: "aeh-code-quality-reviewer",
      thinkingOptionId: "high",
      env: { OPENCODE_CONFIG_CONTENT: inline },
      title: "reviewer",
      waitForFinish: false
    });

    expect(received).toEqual(
      expect.objectContaining({
        cwd: "/repo",
        workspaceId: "workspace-op",
        env: { OPENCODE_CONFIG_CONTENT: inline },
        config: {
          provider: "opencode/opencode-go/MiMo-V2.6-Flash",
          modeId: "aeh-code-quality-reviewer",
          thinkingOptionId: "high"
        }
      })
    );
    expect((received?.config as Record<string, unknown>).env).toBeUndefined();
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

    const result = await createPaseoSdkAgentWithClient(client as never, {
      cwd: "/repo",
      provider: "opencode",
      model: "MiMo-V2.6-Flash",
      title: "worker",
      prompt: "Implement the bounded task",
      outputSchema: { type: "object" },
      timeoutMs: 1234
    });

    expect(received).toEqual(
      expect.objectContaining({
        cwd: "/repo",
        initialPrompt: "Implement the bounded task",
        outputSchema: { type: "object" },
        config: { provider: "opencode/MiMo-V2.6-Flash" }
      })
    );
    expect(received).not.toHaveProperty("prompt");
    expect(handle.waitForFinish).toHaveBeenCalledWith(1234);
    expect(result).toEqual(
      expect.objectContaining({ id: "agent-2", status: "idle", lastMessage: "done" })
    );
  });

  it("materializes an idle visible agent without dispatching user work", async () => {
    let received: Record<string, unknown> | undefined;
    const handle = {
      id: "agent-idle",
      workspaceId: "workspace-op",
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

    const result = await materializePaseoSdkAgentWithClient(client as never, {
      agentId: "agent-idle",
      cwd: "/repo",
      workspaceId: "workspace-op",
      provider: "codex",
      model: "gpt-test",
      title: "reviewer",
      prompt: "must not be dispatched yet"
    });

    expect(result).toEqual(
      expect.objectContaining({
        id: "agent-idle",
        status: "idle",
        workspaceId: "workspace-op"
      })
    );
    expect(received).toEqual(
      expect.objectContaining({
        agentId: "agent-idle",
        cwd: "/repo",
        workspaceId: "workspace-op",
        config: { provider: "codex/gpt-test" }
      })
    );
    expect(received).not.toHaveProperty("initialPrompt");
  });

  it("rejects provider-only input that cannot satisfy the SDK provider/model contract", async () => {
    const create = vi.fn();
    const client = {
      agents: {
        create,
        ref: vi.fn(),
        list: vi.fn()
      },
      connect: vi.fn(),
      close: vi.fn()
    };
    await expect(createPaseoSdkAgentWithClient(client as never, {
      cwd: "/repo",
      provider: "codex",
      title: "default"
    })).rejects.toThrow("Paseo SDK requires a provider/model value");
    expect(create).not.toHaveBeenCalled();
  });

  it("preserves an already combined provider/model value for Paseo", async () => {
    let received: Record<string, unknown> | undefined;
    const handle = {
      id: "agent-legacy",
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
      cwd: "/repo",
      provider: "codex/gpt-6-luna",
      title: "legacy"
    });

    expect(received).toEqual(
      expect.objectContaining({
        config: { provider: "codex/gpt-6-luna" }
      })
    );
    expect((received?.config as Record<string, unknown>)).not.toHaveProperty("model");
  });

  it("rejects conflicting embedded and explicit model values", async () => {
    const client = {
      agents: { create: vi.fn(), ref: vi.fn(), list: vi.fn() },
      connect: vi.fn(),
      close: vi.fn()
    };
    await expect(
      createPaseoSdkAgentWithClient(client as never, {
        cwd: "/repo",
        provider: "codex/gpt-a",
        model: "gpt-b",
        title: "conflict"
      })
    ).rejects.toThrow("Conflicting Paseo models");
  });
});
