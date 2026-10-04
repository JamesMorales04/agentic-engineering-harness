import { describe, expect, it } from "vitest";
import { outputJsonSchema, validateAgentOutput } from "../src/agents/outputContracts.js";
import { semanticAssessmentTypeValues } from "../src/semantic/assessment.js";

/**
 * CODEX-CHANNEL SEMANTIC ASSESSOR REQUALIFICATION — strict-mode regression gate.
 *
 * The Codex channel (`response_format: json_schema strict:true`, reached via Paseo
 * `--output-schema`) enforces a strict JSON Schema subset that the canonical
 * semantic-assessment schema violated (see
 * docs/evidence/model-routing/codex-structured-output-probe-2026-10-04.json):
 *  (1) Paseo 0.9.1 rejects the draft 2020-12 `$schema` dialect at agent creation;
 *  (2) Codex rejects `oneOf` (the zod discriminated-union emission);
 *  (3) Codex rejects `propertyNames`/schema-valued `additionalProperties`
 *      (the zod record emission for STACK `versions`);
 *  (4) Codex requires `required` to list every key in `properties`
 *      (the optional OPERATIONS_ANALYSIS `skillOrToolPackSuggestion`).
 *
 * This test pins the strict-compatible reformulation. Semantics are preserved
 * exactly: the same 8 assessment types, the same required top-level keys, the
 * same evidence binding, and no discriminators loosened (anyOf variants stay
 * disjoint on their `const` type discriminator; versions entries carry the same
 * key/value bounds; an explicit null suggestion is equivalent to absent).
 */
function walk(node: unknown, visit: (node: Record<string, unknown>, path: string) => void, path = "root"): void {
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  visit(record, path);
  if (record.properties && typeof record.properties === "object") {
    for (const [key, child] of Object.entries(record.properties as Record<string, unknown>)) walk(child, visit, `${path}.${key}`);
  }
  if (record.items && typeof record.items === "object" && !Array.isArray(record.items)) walk(record.items, visit, `${path}.items`);
  for (const keyword of ["oneOf", "anyOf"] as const) {
    const branches = record[keyword];
    if (Array.isArray(branches)) branches.forEach((branch, index) => walk(branch, visit, `${path}.${keyword}[${index}]`));
  }
}

describe("semantic-assessment outputJsonSchema is Codex strict-compatible", () => {
  it("carries no rejected dialect marker or unsupported composition keywords", () => {
    const schema = outputJsonSchema("semantic-assessment");
    expect(schema).toBeDefined();
    expect(schema).not.toHaveProperty("$schema");
    const found: string[] = [];
    walk(schema, (node, path) => {
      for (const keyword of ["oneOf", "propertyNames", "$ref", "$defs", "discriminator"]) {
        if (keyword in node) found.push(`${path}: ${keyword}`);
      }
    });
    expect(found).toEqual([]);
  });

  it("sets additionalProperties:false on every object and requires every property", () => {
    const schema = outputJsonSchema("semantic-assessment");
    const violations: string[] = [];
    walk(schema, (node, path) => {
      if (node.type === "object") {
        if (node.additionalProperties !== false) violations.push(`${path}: additionalProperties !== false`);
        const properties = (node.properties ?? {}) as Record<string, unknown>;
        const required = (node.required ?? []) as string[];
        for (const key of Object.keys(properties)) {
          if (!required.includes(key)) violations.push(`${path}: '${key}' missing from required`);
        }
      }
    });
    expect(violations).toEqual([]);
  });

  it("keeps all eight assessment types as disjoint const-discriminated anyOf variants", () => {
    const schema = outputJsonSchema("semantic-assessment") as unknown as {
      type: string;
      required: string[];
      properties: { judgment: { anyOf: Array<{ properties: { type: { const: string } } }> } };
    };
    expect(schema.type).toBe("object");
    expect([...schema.required].sort()).toEqual(["assumptions", "claims", "judgment", "knowledgeGaps", "recommendations", "unknowns"]);
    const discriminators = schema.properties.judgment.anyOf.map((variant) => variant.properties.type.const);
    expect([...discriminators].sort()).toEqual([...semanticAssessmentTypeValues].sort());
  });

  it("encodes STACK versions as strict-safe entries preserving the key/value bounds", () => {
    const schema = outputJsonSchema("semantic-assessment") as unknown as {
      properties: { judgment: { anyOf: Array<{ properties: { type: { const: string }; versions?: unknown } }> } };
    };
    const stack = schema.properties.judgment.anyOf.find((variant) => variant.properties.type.const === "STACK");
    expect(stack).toBeDefined();
    expect(stack!.properties.versions).toMatchObject({
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "value"],
        properties: {
          key: { type: "string", minLength: 1, maxLength: 200 },
          value: { type: "string", minLength: 1, maxLength: 200 }
        }
      }
    });
  });

  it("accepts every assessment type through the deterministic validator with the strict shapes", () => {
    const ref = "evidence";
    const base = {
      claims: [],
      assumptions: [],
      unknowns: ["bounded evidence only"],
      recommendations: [],
      knowledgeGaps: []
    };
    const payloads: Array<{ judgment: Record<string, unknown> }> = [
      { judgment: { type: "INTENT", intent: "change", confidence: 0.8, evidenceRefs: [ref] } },
      { judgment: { type: "ROUTE", recommendedRoute: "DIRECT", scopeClarity: "HIGH", decompositionNeed: false, coordinationNeed: false, architectureUncertainty: false, productUncertainty: false, formalizationNeed: "NONE", semanticRiskSignals: [], evidenceRefs: [ref], unknowns: ["u"] } },
      { judgment: { type: "FAILURE", classification: "AMBIGUOUS_OUTPUT", evidenceRefs: [ref] } },
      {
        judgment: {
          type: "STACK", languages: ["Rust"], frameworks: [], packageManagers: [], databases: [],
          toolchains: [], signals: [{ id: "language", evidenceRef: ref }], testFrameworks: [],
          migrationMechanisms: [], buildSystems: [],
          versions: [{ key: "rustc", value: "1.82.0" }],
          projectSkillRoots: [], evidenceRefs: [ref], unknowns: ["u"]
        }
      },
      { judgment: { type: "ISSUE", classification: "ready", requestedOutcome: "Ship it", explicitRequirements: [], evidenceRefs: [ref], unknowns: ["u"] } },
      { judgment: { type: "CANDIDATE_IMPACT", changedFiles: ["src/a.ts"], changeKinds: ["source"], reviewDimensions: [], requiresIndependentReview: true, evidenceRefs: [ref], unknowns: ["u"] } },
      { judgment: { type: "VALIDATION_NEED", property: "p", rationale: "r", scope: ["src/**"], evidenceRefs: [ref], unknowns: ["u"] } },
      { judgment: { type: "OPERATIONS_ANALYSIS", classification: "UNCERTAIN", probableCause: "UNKNOWN", suggestedSupervisorAction: "NONE", rationale: "bounded", skillOrToolPackSuggestion: null, evidenceRefs: [ref], unknowns: ["u"] } }
    ];
    for (const payload of payloads) {
      const result = validateAgentOutput("semantic-assessment", { ...base, ...payload });
      expect(result.issues).toEqual([]);
      expect(result.ok).toBe(true);
    }
    // The superseded record encoding is rejected: the wire shape and the
    // deterministic validator agree on entries, with no dual-read fallback.
    const record = validateAgentOutput("semantic-assessment", {
      ...base,
      judgment: {
        type: "STACK", languages: [], frameworks: [], packageManagers: [], databases: [],
        toolchains: [], signals: [], testFrameworks: [], migrationMechanisms: [],
        buildSystems: [], versions: { rustc: "1.82.0" }, projectSkillRoots: [],
        evidenceRefs: [ref], unknowns: []
      }
    });
    expect(record.ok).toBe(false);
  });
});
