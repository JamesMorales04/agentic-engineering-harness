import { AehError } from "../core/errors.js";

/**
 * Canonical structured-output capability levels. A provider/model is certified only at a level
 * demonstrated by bounded real-provider evidence; runtime-level flags are not model proof.
 *
 * - TEXTUAL_JSON: the model emits JSON-ish text with no schema guarantee.
 * - JSON_OBJECT: the provider guarantees a syntactically valid JSON object.
 * - SCHEMA_BOUND_TOOL_CALL: the model reliably returns a schema-advertised structured tool call
 *   whose arguments pass AEH's deterministic schema validation on every probe trial (the platform
 *   may not validate the tool input itself).
 * - JSON_SCHEMA_VALIDATED: the platform parses and validates the structured output against the
 *   schema before exposing the canonical object.
 * - JSON_SCHEMA_CONSTRAINED: the provider constrains generation to the schema grammar.
 */
export const semanticStructuredOutputLevelValues = [
  "TEXTUAL_JSON",
  "JSON_OBJECT",
  "SCHEMA_BOUND_TOOL_CALL",
  "JSON_SCHEMA_VALIDATED",
  "JSON_SCHEMA_CONSTRAINED"
] as const;
export type SemanticStructuredOutputLevelV1 = (typeof semanticStructuredOutputLevelValues)[number];

/** The level the Semantic Assessor requires for provider-enforced structured output. */
export const requiredSemanticStructuredOutputLevelV1: SemanticStructuredOutputLevelV1 = "SCHEMA_BOUND_TOOL_CALL";

export interface SemanticStructuredOutputCapabilityV1 {
  level: SemanticStructuredOutputLevelV1;
  trials: number;
  failures: number;
  medianMs?: number;
  note?: string;
}

/**
 * Bounded real-provider probe evidence that establishes the per-model capability levels
 * (sanitized diagnostic record; the probe is not certification by itself).
 */
export const semanticStructuredOutputCapabilityEvidenceV1 = {
  report: "docs/evidence/s13/structured-output-probe.json",
  sha256: "a72260fb2b1fe9fb318c0a354e62533467cb2fb9b6ae5d1f2fe76904709cae6b",
  probedAt: "2026-09-27",
  openCodeVersion: "1.18.32",
  paseoServerVersion: "0.9.1"
} as const;

/**
 * Deterministic certified capability registry keyed by the canonical model id
 * (`<provider>/<model>`). A model absent here is uncertified and cannot serve the Semantic
 * Assessor. Selection happens before execution and the resolved model remains part of the
 * assessor identity provenance.
 */
export const semanticStructuredOutputCapabilitiesV1: Readonly<Record<string, SemanticStructuredOutputCapabilityV1>> = {
  "opencode-go/gpt-6-luna": { level: "SCHEMA_BOUND_TOOL_CALL", trials: 4, failures: 0, medianMs: 6_400 },
  "opencode-go/deepseek-v4.1-flash": { level: "SCHEMA_BOUND_TOOL_CALL", trials: 2, failures: 0, medianMs: 11_418 },
  "opencode-go/kimi-k3": { level: "SCHEMA_BOUND_TOOL_CALL", trials: 2, failures: 0, medianMs: 12_932 },
  "opencode-go/glm-5.3": { level: "SCHEMA_BOUND_TOOL_CALL", trials: 2, failures: 0, medianMs: 105_000, note: "slow (81-129 s per trial)" },
  "opencode-go/mimo-v2.6-flash": {
    level: "TEXTUAL_JSON",
    trials: 17,
    failures: 14,
    note: "Across the probe matrix: with the AEH wildcard permission deny in place the model never reached the structured tool (free text or a stalled turn); with StructuredOutput allowed it called the tool in 3/3 full-schema trials but captured judgment as an encoded string in every case (schema-invalid). Discipline improves tool-call compliance but not nested-object typing. Not certified for semantic assessment."
  }
};

export function semanticStructuredOutputLevelRank(level: SemanticStructuredOutputLevelV1): number {
  return semanticStructuredOutputLevelValues.indexOf(level);
}

export function semanticStructuredOutputCapabilityForModelV1(modelId: string): SemanticStructuredOutputCapabilityV1 | undefined {
  return Object.hasOwn(semanticStructuredOutputCapabilitiesV1, modelId) ? semanticStructuredOutputCapabilitiesV1[modelId] : undefined;
}

export function certifiedSemanticStructuredOutputModelsV1(required: SemanticStructuredOutputLevelV1 = requiredSemanticStructuredOutputLevelV1): string[] {
  const minimum = semanticStructuredOutputLevelRank(required);
  return Object.entries(semanticStructuredOutputCapabilitiesV1)
    .filter(([, capability]) => semanticStructuredOutputLevelRank(capability.level) >= minimum)
    .map(([model]) => model)
    .sort();
}

/** Fail-closed capability assertion: no silent fallback and no runtime-level trust. */
export function assertSemanticStructuredOutputCapabilityV1(modelId: string, required: SemanticStructuredOutputLevelV1 = requiredSemanticStructuredOutputLevelV1): SemanticStructuredOutputCapabilityV1 {
  const capability = semanticStructuredOutputCapabilityForModelV1(modelId);
  if (capability && semanticStructuredOutputLevelRank(capability.level) >= semanticStructuredOutputLevelRank(required)) return capability;
  const actual = capability ? capability.level : "UNCERTIFIED";
  const certified = certifiedSemanticStructuredOutputModelsV1(required);
  throw new AehError(
    "SEMANTIC_ASSESSMENT_UNAVAILABLE",
    `Semantic Assessor model '${modelId}' is certified at ${actual} structured-output capability, below the required ${required}. Certified models: ${certified.join(", ")}. No silent fallback is performed; select a certified model for the Semantic Assessor or record new probe evidence.`
  );
}
