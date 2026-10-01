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
export declare const semanticStructuredOutputLevelValues: readonly ["TEXTUAL_JSON", "JSON_OBJECT", "SCHEMA_BOUND_TOOL_CALL", "JSON_SCHEMA_VALIDATED", "JSON_SCHEMA_CONSTRAINED"];
export type SemanticStructuredOutputLevelV1 = (typeof semanticStructuredOutputLevelValues)[number];
/** The level the Semantic Assessor requires for provider-enforced structured output. */
export declare const requiredSemanticStructuredOutputLevelV1: SemanticStructuredOutputLevelV1;
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
export declare const semanticStructuredOutputCapabilityEvidenceV1: {
    readonly report: "docs/evidence/s13/structured-output-probe.json";
    readonly sha256: "a72260fb2b1fe9fb318c0a354e62533467cb2fb9b6ae5d1f2fe76904709cae6b";
    readonly probedAt: "2026-09-27";
    readonly openCodeVersion: "1.18.32";
    readonly paseoServerVersion: "0.9.1";
};
/**
 * Deterministic certified capability registry keyed by the canonical model id
 * (`<provider>/<model>`). A model absent here is uncertified and cannot serve the Semantic
 * Assessor. Selection happens before execution and the resolved model remains part of the
 * assessor identity provenance.
 */
export declare const semanticStructuredOutputCapabilitiesV1: Readonly<Record<string, SemanticStructuredOutputCapabilityV1>>;
export declare function semanticStructuredOutputLevelRank(level: SemanticStructuredOutputLevelV1): number;
export declare function semanticStructuredOutputCapabilityForModelV1(modelId: string): SemanticStructuredOutputCapabilityV1 | undefined;
export declare function certifiedSemanticStructuredOutputModelsV1(required?: SemanticStructuredOutputLevelV1): string[];
/** Fail-closed capability assertion: no silent fallback and no runtime-level trust. */
export declare function assertSemanticStructuredOutputCapabilityV1(modelId: string, required?: SemanticStructuredOutputLevelV1): SemanticStructuredOutputCapabilityV1;
