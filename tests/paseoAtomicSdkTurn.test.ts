import { describe, expect, it, vi } from "vitest";
import { runPaseoSdkAgentWithClient } from "../src/paseo/sdk.js";

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

  it("falls back to send plus wait on the same handle", async () => {
    const handle = {
      id: "agent-1",
      workspaceId: "workspace-1",
      send: vi.fn(async () => undefined),
      waitForFinish: vi.fn(async () => ({ status: "idle", lastMessage: "done" }))
    };
    const client = { agents: { ref: vi.fn(() => handle) } };

    const result = await runPaseoSdkAgentWithClient(client as never, "agent-1", "initialize", 60_000);

    expect(handle.send).toHaveBeenCalledWith("initialize");
    expect(handle.waitForFinish).toHaveBeenCalledWith(60_000);
    expect(result.status).toBe("idle");
  });
});
