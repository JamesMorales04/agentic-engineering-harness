import { describe, expect, it, vi } from "vitest";
import { continueManagedPaseoAgent } from "../src/paseo/runtime.js";

function capabilities() {
  return {
    version: "0.3.1",
    background: true,
    quiet: true,
    json: false,
    outputSchema: true,
    daemonJson: true,
    nativeToolsRecommended: true
  };
}

describe("Paseo resumed-turn barrier", () => {
  it("captures assistant baseline before dispatch and passes it to subscription wait", async () => {
    const capture = vi.fn(async () => ({ lastAssistantMessage: "old answer" }));
    const wait = vi.fn(async (_root: string, _agentId: string, _timeout: number, baseline: unknown) => ({
      id: "agent-1",
      status: "idle",
      lastMessage: "new answer",
      source: "paseo-agent-subscription" as const,
      updatesObserved: 2,
      baseline
    }));
    const dispatch = vi.fn(async () => ({
      id: "agent-1",
      status: "working",
      workspaceId: "workspace-1"
    }));
    const trace = vi.fn(async () => undefined);
    const deps = {
      run: vi.fn(),
      detectCapabilities: vi.fn(async () => capabilities()),
      trace,
      native: {
        capture,
        wait,
        preflight: vi.fn(async () => ({
          ok: true,
          provider: "codex",
          source: "paseo-provider-unchecked",
          message: "ok"
        }))
      },
      sdk: {
        create: vi.fn(),
        materialize: vi.fn(),
        dispatch,
        wait: vi.fn(),
        run: vi.fn(),
        probe: vi.fn(),
        inspect: vi.fn(),
        list: vi.fn()
      }
    };

    const result = await continueManagedPaseoAgent(
      "/repo",
      "agent-1",
      "continue",
      120,
      deps as never
    );

    expect(result.stdout).toBe("new answer");
    expect(capture).toHaveBeenCalledBefore(dispatch);
    expect(wait).toHaveBeenCalledWith(
      "/repo",
      "agent-1",
      120_000,
      { lastAssistantMessage: "old answer" }
    );
    expect(trace).toHaveBeenCalledWith(
      "/repo",
      "agent.turn.baseline",
      expect.objectContaining({ agentId: "agent-1", assistantMessage: "present" })
    );
  });
});
