import { describe, expect, it } from "vitest";
import { resolveAgentTopology } from "../src/agents/config.js";
import { resolveSemanticAssessor } from "../src/semantic/assessment.js";
import { SEMANTIC_ASSESSOR_SYSTEM_PROMPT } from "../src/semantic/runtime.js";
import {
  assertSemanticStructuredOutputCapabilityV1,
  certifiedSemanticStructuredOutputModelsV1,
  requiredSemanticStructuredOutputLevelV1,
  semanticStructuredOutputCapabilityForModelV1,
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
    // Codex-channel Luna is certified at SCHEMA_BOUND_TOOL_CALL on the strict-reformulated
    // schema (2/2 schema-valid STACK trials through the production path; see
    // docs/evidence/model-routing/codex-requalification-2026-10-04.json).
    expect(certified).toContain("openai/gpt-6-luna");
    expect(certified).not.toContain("opencode-go/gpt-6-luna");
    expect(certified).not.toContain("opencode-go/mimo-v2.6-flash");
    expect(certified).not.toContain("opencode-go/muse-spark-1.3-contributor");
    expect(semanticStructuredOutputCapabilityForModelV1("openai/gpt-6-luna")).toMatchObject({ level: "SCHEMA_BOUND_TOOL_CALL", trials: 2, failures: 0, medianMs: 15_085 });
    expect(semanticStructuredOutputCapabilityForModelV1("openai/gpt-6-luna")?.pendingRequalification).not.toBe(true);
    expect(() => assertSemanticStructuredOutputCapabilityV1("openai/gpt-6-luna")).not.toThrow();
    expect(() => assertSemanticStructuredOutputCapabilityV1("opencode-go/mimo-v2.6-flash")).toThrow(/certified at TEXTUAL_JSON structured-output capability, below the required SCHEMA_BOUND_TOOL_CALL/);
    expect(() => assertSemanticStructuredOutputCapabilityV1("opencode-go/mimo-v2.6-flash")).toThrow(/No silent fallback/);
    expect(() => assertSemanticStructuredOutputCapabilityV1("opencode-go/muse-spark-1.3-contributor")).toThrow(/UNCERTIFIED/);
    expect(() => assertSemanticStructuredOutputCapabilityV1("vendor/unknown-model")).toThrow(/UNCERTIFIED/);
  });

  it("resolves the certified Codex-channel Luna assessor and stays fail-closed for ineligible models", () => {
    const ineligible = structuredClone(semanticAssessorTopologySource);
    ineligible.models.assessorModel = { runtime: "codex", provider: "openai", model: "muse-spark-1.3-contributor", variant: "xhigh" };
    expect(() => resolveSemanticAssessor(resolveAgentTopology(ineligible))).toThrow(/below the required SCHEMA_BOUND_TOOL_CALL/);

    // The canonical Codex-channel Luna fixture is certified: the real resolver accepts it.
    const assessor = resolveSemanticAssessor(resolveAgentTopology(structuredClone(semanticAssessorTopologySource)));
    expect(assessor.identity.modelId).toBe("openai/gpt-6-luna");
    expect(assessor.selection.paseoProvider).toBe("codex");
  });

  it("keeps assessor resolution fail-closed with no silent fallback for ineligible models", () => {
    const uncertified = structuredClone(semanticAssessorTopologySource);
    uncertified.models.assessorModel = { runtime: "codex", provider: "openai", model: "muse-spark-1.3-contributor", variant: "xhigh" };
    expect(() => resolveSemanticAssessor(resolveAgentTopology(uncertified))).toThrow(/SEMANTIC_ASSESSMENT_UNAVAILABLE/);
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
