import { describe, expect, it } from "vitest";
import { compileExecutionCatalog } from "../src/architecture/executionCatalog.js";
import type { ParticipantAssignmentV1 } from "../src/architecture/participantPlan.js";
import { selectionForParticipant } from "../src/agents/waveExecutor.js";
import { buildOpenCodeRuntimeConfig } from "../src/agents/permissions.js";
import type { AgentExecutionSelection } from "../src/agents/types.js";
import type { HarnessProjectConfig } from "../src/core/types.js";

function base(overrides: Partial<AgentExecutionSelection> = {}): AgentExecutionSelection {
  return {
    logicalAgent: "topology-implementer",
    role: "Implementer",
    domains: [],
    runtimeName: "opencode",
    runtimeAdapter: "opencode",
    paseoProvider: "opencode",
    modelAlias: "workhorse",
    modelId: "test/model",
    modelName: "model",
    transport: "direct",
    skills: [],
    mcps: ["serena"],
    permissions: {},
    args: [],
    runtimeCapabilities: {},
    ...overrides,
  };
}

function catalogFor(role: string) {
  return compileExecutionCatalog({
    runtimes: { opencode: { adapter: "opencode" } },
    models: { workhorse: { runtime: "opencode", model: "model", id: "test/model" } },
    roleBindings: { [role]: { runtimeId: "opencode", modelAlias: "workhorse", transport: "direct" } },
  });
}

function assignment(toolPack: ParticipantAssignmentV1["toolPack"]): ParticipantAssignmentV1 {
  return {
    participantId: "participant:WU-01",
    role: "Implementer",
    specialization: "node-runtime",
    competencies: ["node-runtime"],
    skills: ["implementation-discipline"],
    toolPack,
    budget: { maxTokens: 1000, reservedTokens: 100, maxConcurrent: 1 },
    workUnitIds: ["WU-01"],
  };
}

function project(): HarnessProjectConfig {
  return {
    version: 1,
    project: { name: "mcp-namespace-test" },
    mcp: {
      servers: {
        serena: { type: "local", command: ["serena", "start-mcp-server"], enabled: true },
      },
    },
  };
}

describe("MCP/toolPack namespace separation (DETERMINISTIC)", () => {
  it("never injects tool identifiers into the MCP namespace", () => {
    const selected = selectionForParticipant(
      base(),
      assignment({ version: 1, required: ["repository-read", "repository-write", "command-execute", "context-read"], optional: [], forbidden: ["agent-spawn-by-name"] }),
      catalogFor("Implementer"),
    );
    expect(selected.mcps).toEqual(["serena"]);
    // Shell authority still flows through the permission projection, not MCP.
    expect(selected.permissions.shell).toBe("allow");
    expect(selected.permissions.write).toBe("allow");
  });

  it("preserves an empty topology MCP selection instead of tool names", () => {
    const selected = selectionForParticipant(
      base({ mcps: [] }),
      assignment({ version: 1, required: ["repository-read", "command-execute"], optional: ["test-runner"], forbidden: [] }),
      catalogFor("Implementer"),
    );
    expect(selected.mcps).toEqual([]);
  });

  it("still denies unknown MCP server names fail-closed at launch-config build", () => {
    expect(() => buildOpenCodeRuntimeConfig(base({ mcps: ["command-execute"] }), project())).toThrow(/MCP_SERVER_UNCONFIGURED/);
    expect(() => buildOpenCodeRuntimeConfig(base({ mcps: ["mcp-evil"] }), project())).toThrow(/MCP_SERVER_UNCONFIGURED/);
  });

  it("builds launch config for topology-selected MCP servers present in project config", () => {
    const selected = selectionForParticipant(
      base(),
      assignment({ version: 1, required: ["repository-read", "repository-write", "command-execute", "context-read"], optional: [], forbidden: ["agent-spawn-by-name"] }),
      catalogFor("Implementer"),
    );
    const config = buildOpenCodeRuntimeConfig(selected, project()) as { mcp: Record<string, unknown>; tools: Record<string, boolean> };
    expect(Object.keys(config.mcp)).toEqual(["serena"]);
    expect(config.tools["serena_*"]).toBe(true);
  });
});
