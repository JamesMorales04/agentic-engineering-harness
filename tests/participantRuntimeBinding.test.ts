import { describe, expect, it } from "vitest";
import { selectionForParticipant } from "../src/agents/waveExecutor.js";
import { compileExecutionCatalog } from "../src/architecture/executionCatalog.js";
import type { AgentExecutionSelection } from "../src/agents/types.js";
import type { ParticipantAssignmentV1 } from "../src/architecture/participantPlan.js";

const base: AgentExecutionSelection = {
  logicalAgent: "topology-implementer",
  role: "Implementer",
  domains: ["cross-cutting"],
  runtimeName: "stale-topology-runtime",
  runtimeAdapter: "stale",
  paseoProvider: "stale",
  modelAlias: "stale-model",
  modelId: "stale/model",
  modelName: "stale",
  transport: "direct",
  skills: ["stale-topology-skill"],
  mcps: ["stale-topology-tool"],
  permissions: { read: "allow", write: "allow", shell: "allow", gitWrite: "allow" },
  args: [],
  runtimeCapabilities: { modelSelection: false }
};

describe("compiled participant runtime binding", () => {
  it("uses the frozen assignment role, identity, skills and tool ceiling", () => {
    const assignment: ParticipantAssignmentV1 = {
      participantId: "participant:review",
      role: "Reviewer",
      specialization: "security.authorization",
      competencies: ["security.authorization"],
      skills: ["independent-review", "security-authorization-review"],
      toolPack: { version: 1, required: ["repository-read"], optional: ["context-read"], forbidden: ["repository-write", "command-execute"] },
      budget: { maxTokens: 1000, reservedTokens: 100, maxConcurrent: 1 },
      workUnitIds: ["review"]
    };
    const catalog = compileExecutionCatalog({
      runtimes: { direct: { adapter: "direct", capabilities: { modelSelection: true, structuredOutput: true } } },
      models: { workhorse: { runtime: "direct", model: "model", id: "test/model" } },
      roleBindings: { Reviewer: { runtimeId: "direct", modelAlias: "workhorse", transport: "direct" } }
    });
    const selection = selectionForParticipant(base, assignment, catalog);
    expect(selection).toMatchObject({ logicalAgent: "participant:review", role: "Reviewer", specializations: ["security.authorization"], skills: assignment.skills });
    expect(selection.permissions.write).toBe("deny");
    expect(selection.permissions.shell).toBe("deny");
    expect(selection.permissions.gitWrite).toBe("deny");
    expect(selection.mcps).toEqual(["context-read", "repository-read"]);
    expect(selection).toMatchObject({ runtimeName: "direct", runtimeAdapter: "direct", modelAlias: "workhorse", modelId: "test/model", modelName: "model", runtimeCapabilities: { modelSelection: true, structuredOutput: true } });
  });

  it("fails closed when a frozen role has no catalog binding", () => {
    const assignment: ParticipantAssignmentV1 = {
      participantId: "participant:implementation",
      role: "Implementer",
      specialization: "typescript-node",
      competencies: ["typescript"],
      skills: ["implementation-discipline"],
      toolPack: { version: 1, required: ["repository-read"], optional: [], forbidden: [] },
      budget: { maxTokens: 1000, reservedTokens: 100, maxConcurrent: 1 },
      workUnitIds: ["implementation"]
    };
    const catalog = compileExecutionCatalog({ runtimes: {}, models: {} });
    expect(() => selectionForParticipant(base, assignment, catalog)).toThrow("no execution binding");
  });

  it("rejects a catalog binding whose model belongs to another runtime", () => {
    const assignment: ParticipantAssignmentV1 = {
      participantId: "participant:implementation",
      role: "Implementer",
      specialization: "typescript-node",
      competencies: ["typescript"],
      skills: ["implementation-discipline"],
      toolPack: { version: 1, required: ["repository-read"], optional: [], forbidden: [] },
      budget: { maxTokens: 1000, reservedTokens: 100, maxConcurrent: 1 },
      workUnitIds: ["implementation"]
    };
    const catalog = compileExecutionCatalog({
      runtimes: { direct: { adapter: "direct" }, paseo: { adapter: "paseo" } },
      models: { workhorse: { runtime: "paseo", model: "model", id: "test/model" } },
      roleBindings: { Implementer: { runtimeId: "direct", modelAlias: "workhorse", transport: "direct" } }
    });
    expect(() => selectionForParticipant(base, assignment, catalog)).toThrow("pairs model");
  });
});
