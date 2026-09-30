import { describe, expect, it } from "vitest";
import { resolveAgentTopology } from "../src/agents/config.js";
import { compileOpenCodeRuntimeProjection } from "../src/agents/permissions.js";
import { resolveSemanticAssessor } from "../src/semantic/assessment.js";
import { SEMANTIC_ASSESSOR_SYSTEM_PROMPT } from "../src/semantic/runtime.js";
import {
  assertSemanticStructuredOutputCapabilityV1,
  certifiedSemanticStructuredOutputModelsV1,
  requiredSemanticStructuredOutputLevelV1,
  semanticStructuredOutputLevelRank,
  semanticStructuredOutputLevelValues
} from "../src/semantic/structuredOutput.js";
import { semanticAssessorTopologySource } from "./semanticAssessmentSupport.js";

describe("Semantic Assessor structured-output capability policy", () => {
  it("orders canonical capability levels and requires schema-bound tool calls", () => {
    expect(semanticStructuredOutputLevelValues).toEqual(["TEXTUAL_JSON", "JSON_OBJECT", "SCHEMA_BOUND_TOOL_CALL", "JSON_SCHEMA_VALIDATED", "JSON_SCHEMA_CONSTRAINED"]);
    expect(semanticStructuredOutputLevelRank("SCHEMA_BOUND_TOOL_CALL")).toBeGreaterThan(semanticStructuredOutputLevelRank("TEXTUAL_JSON"));
    expect(requiredSemanticStructuredOutputLevelV1).toBe("SCHEMA_BOUND_TOOL_CALL");
  });

  it("certifies only probe-verified models and never treats runtime flags as model proof", () => {
    const certified = certifiedSemanticStructuredOutputModelsV1();
    expect(certified).toContain("opencode-go/gpt-6-luna");
    expect(certified).not.toContain("opencode-go/mimo-v2.6-flash");
    expect(assertSemanticStructuredOutputCapabilityV1("opencode-go/gpt-6-luna").level).toBe("SCHEMA_BOUND_TOOL_CALL");
    expect(() => assertSemanticStructuredOutputCapabilityV1("opencode-go/mimo-v2.6-flash")).toThrow(/certified at TEXTUAL_JSON structured-output capability, below the required SCHEMA_BOUND_TOOL_CALL/);
    expect(() => assertSemanticStructuredOutputCapabilityV1("opencode-go/mimo-v2.6-flash")).toThrow(/No silent fallback/);
    expect(() => assertSemanticStructuredOutputCapabilityV1("vendor/unknown-model")).toThrow(/UNCERTIFIED/);
  });

  it("fails assessor resolution closed for an ineligible model instead of falling back", () => {
    const ineligible = structuredClone(semanticAssessorTopologySource);
    ineligible.models.assessorModel = { runtime: "opencode", provider: "opencode-go", model: "mimo-v2.6-flash" };
    expect(() => resolveSemanticAssessor(resolveAgentTopology(ineligible))).toThrow(/mimo-v2.6-flash.*below the required SCHEMA_BOUND_TOOL_CALL/);

    const certified = resolveSemanticAssessor(resolveAgentTopology(structuredClone(semanticAssessorTopologySource)));
    expect(certified.identity.modelId).toBe("opencode-go/gpt-6-luna");
  });

  it("keeps the OpenCode structured-output tool allowed under the assessor wildcard deny", () => {
    const assessor = resolveSemanticAssessor(resolveAgentTopology(structuredClone(semanticAssessorTopologySource)));
    const projection = compileOpenCodeRuntimeProjection(assessor.selection);
    const permission = projection.config.permission as Record<string, unknown>;
    expect(permission["*"]).toBe("deny");
    expect(permission.StructuredOutput).toBe("allow");
    expect(permission.read).toBe("deny");
    expect(permission.edit).toBe("deny");
    expect(permission.bash).toMatchObject({ "*": "deny" });
    const managed = projection.config.agent as Record<string, { permission: Record<string, unknown> }>;
    expect(Object.values(managed)[0]?.permission).toMatchObject({ "*": "deny", StructuredOutput: "allow" });
  });

  it("carries the canonical output discipline in the assessor prompt builder", () => {
    for (const clause of [
      "Output discipline: return exactly one JSON object and nothing else",
      "Include every required key",
      "[] for every empty required array",
      "never invent references",
      "exact requested assessment discriminator",
      "never as escaped or encoded strings",
      "No comments, no trailing commas"
    ]) expect(SEMANTIC_ASSESSOR_SYSTEM_PROMPT).toContain(clause);
  });
});
