import { describe, expect, it, vi } from "vitest";
import {
  materializePaseoSdkAgentWithClient,
  runPaseoSdkAgentWithClient
} from "../src/paseo/sdk.js";

describe("Paseo SDK resumed turns", () => {
  it("prefers handle.run so dispatch and completion share one handle", async () => {
    const handle = {
      id: "agent-1",
      workspaceId: "workspace-1",
      run: vi.fn(async () => ({ status: "idle", lastMessage: "done" })),
      send: vi.fn(),
      waitForFinish: vi.fn()
    };
    const client = { agents: { ref: vi.fn(() => handle) } };

    const result = await runPaseoSdkAgentWithClient(client as never, "agent-1", "initialize", 60_000);

    expect(handle.run).toHaveBeenCalledWith("initialize", { timeoutMs: 60_000 });
    expect(handle.send).not.toHaveBeenCalled();
    expect(handle.waitForFinish).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ id: "agent-1", status: "idle", lastMessage: "done" }));
  });

  it("passes the output schema to an atomic resumed turn", async () => {
    const schema = { type: "object", properties: { verdict: { type: "string" } } };
    const handle = {
      id: "agent-structured",
      workspaceId: "workspace-1",
      run: vi.fn(async () => ({ status: "idle", lastMessage: '{"verdict":"PASS"}' }))
    };
    const client = { agents: { ref: vi.fn(() => handle) } };

    await runPaseoSdkAgentWithClient(
      client as never,
      "agent-structured",
      "review",
      60_000,
      schema
    );

    expect(handle.run).toHaveBeenCalledWith("review", {
      timeoutMs: 60_000,
      outputSchema: schema
    });
  });

  it("recovers the assistant payload from the timeline when run omits lastMessage", async () => {
    const payload = '{"verdict":"PASS","findings":[],"finalizationSafety":"SAFE","followUp":[]}';
    const handle = {
      id: "agent-timeline",
      workspaceId: "workspace-1",
      run: vi.fn(async () => ({ status: "idle" })),
      refetch: vi.fn(async () => ({ agent: { id: "agent-timeline", status: "idle" }, project: {} })),
      timeline: {
        refetch: vi.fn(async () => ({ entries: [{ role: "assistant", content: payload }] }))
      }
    };
    const client = { agents: { ref: vi.fn(() => handle) } };

    const result = await runPaseoSdkAgentWithClient(
      client as never,
      "agent-timeline",
      "review",
      60_000
    );

    expect(result.lastMessage).toBe(payload);
    expect(handle.timeline.refetch).toHaveBeenCalledWith({ direction: "tail", limit: 50 });
  });

  it("recovers the assistant payload from the OpenCode provider timeline item shape", async () => {
    const payload = '{"judgment":{"type":"ROUTE","recommendedRoute":"DIRECT"}}';
    const handle = {
      id: "agent-timeline-opencode",
      workspaceId: "workspace-1",
      run: vi.fn(async () => ({ status: "idle" })),
      refetch: vi.fn(async () => ({ agent: { id: "agent-timeline-opencode", status: "idle" }, project: {} })),
      timeline: {
        refetch: vi.fn(async () => ({ entries: [
          { provider: "opencode", item: { type: "user_message", text: "assess this" } },
          { provider: "opencode", item: { type: "reasoning", text: "thinking" } },
          { provider: "opencode", item: { type: "assistant_message", text: payload } }
        ] }))
      }
    };
    const client = { agents: { ref: vi.fn(() => handle) } };

    const result = await runPaseoSdkAgentWithClient(client as never, "agent-timeline-opencode", "assess", 60_000);

    expect(result.lastMessage).toBe(payload);
  });

  it("selects only the canonical last assistant message and never a nested tool payload", async () => {
    const payload = '{"judgment":{"type":"ROUTE","recommendedRoute":"DIRECT"}}';
    const handle = {
      id: "agent-timeline-tools",
      workspaceId: "workspace-1",
      run: vi.fn(async () => ({ status: "idle" })),
      refetch: vi.fn(async () => ({ agent: { id: "agent-timeline-tools", status: "idle" }, project: {} })),
      timeline: {
        refetch: vi.fn(async () => ({ entries: [
          { role: "assistant", content: [{ type: "text", text: "older assistant text" }] },
          { provider: "opencode", item: { type: "tool_call", input: { text: "nested-tool-payload" }, output: "nested-tool-output" } },
          { provider: "opencode", item: { type: "assistant_message", content: [{ type: "text", text: payload }, { type: "tool_use", input: { text: "assistant-nested-tool-payload" } }] } }
        ] }))
      }
    };
    const client = { agents: { ref: vi.fn(() => handle) } };

    const result = await runPaseoSdkAgentWithClient(client as never, "agent-timeline-tools", "assess", 60_000);

    expect(result.lastMessage).toBe(payload);
    expect(result.lastMessage).not.toContain("nested-tool");
    expect(result.lastMessage).not.toContain("older assistant text");
  });

  it("ignores user and reasoning entries when selecting the last assistant message", async () => {
    const payload = "assistant reply";
    const handle = {
      id: "agent-timeline-user-last",
      workspaceId: "workspace-1",
      run: vi.fn(async () => ({ status: "idle" })),
      refetch: vi.fn(async () => ({ agent: { id: "agent-timeline-user-last", status: "idle" }, project: {} })),
      timeline: {
        refetch: vi.fn(async () => ({ entries: [
          { provider: "opencode", item: { type: "assistant_message", text: payload } },
          { provider: "opencode", item: { type: "user_message", text: "follow-up user turn" } },
          { provider: "opencode", item: { type: "reasoning", text: "late reasoning" } }
        ] }))
      }
    };
    const client = { agents: { ref: vi.fn(() => handle) } };

    const result = await runPaseoSdkAgentWithClient(client as never, "agent-timeline-user-last", "assess", 60_000);

    expect(result.lastMessage).toBe(payload);
  });

  it("falls back to send plus wait on the same handle", async () => {
    const handle = {
      id: "agent-1",
      workspaceId: "workspace-1",
      send: vi.fn(async () => undefined),
      waitForFinish: vi.fn(async () => ({ status: "idle", lastMessage: "done" }))
    };
    const client = { agents: { ref: vi.fn(() => handle) } };

    const result = await runPaseoSdkAgentWithClient(client as never, "agent-1", "initialize", 60_000);

    expect(handle.send).toHaveBeenCalledWith("initialize", undefined);
    expect(handle.waitForFinish).toHaveBeenCalledWith(60_000);
    expect(result.status).toBe("idle");
  });

  it("keeps an output schema on a materialized agent before any prompt is sent", async () => {
    const schema = { type: "object", properties: { verdict: { type: "string" } } };
    let createOptions: Record<string, unknown> | undefined;
    const handle = { id: "agent-idle", workspaceId: "workspace-1", status: "idle" };
    const client = {
      agents: {
        create: vi.fn(async (options: Record<string, unknown>) => {
          createOptions = options;
          return handle;
        })
      }
    };

    await materializePaseoSdkAgentWithClient(client as never, {
      cwd: "/repo",
      workspaceId: "workspace-1",
      provider: "codex",
      model: "gpt-test",
      title: "reviewer",
      outputSchema: schema
    });

    expect(createOptions).toEqual(expect.objectContaining({ outputSchema: schema }));
    expect(createOptions).not.toHaveProperty("initialPrompt");
  });
});
