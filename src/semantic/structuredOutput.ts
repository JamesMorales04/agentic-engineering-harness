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
  /**
   * Pending channel requalification. While true the entry is documentary only: it records
   * a KNOWN evidence gap for this exact `<provider>/<model>` channel without granting
   * certification. certifiedSemanticStructuredOutputModelsV1() excludes pending entries and
   * assertSemanticStructuredOutputCapabilityV1() rejects them fail-closed. Flip to false (or
   * remove) only with bounded real-provider probe evidence on the model's own channel:
   * trials/failures/medianMs plus the probe report sha256 recorded in the note.
   */
  pendingRequalification?: boolean;
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
 *
 * PARTIAL MODEL_ROUTING_MIGRATION (owner-approved): the canonical Semantic Assessor route is
 * Luna via Codex (`openai/gpt-6-luna`, runtime codex). The superseded OpenCode-routed Luna
 * pairing (`opencode-go/gpt-6-luna`) was removed: stale assessor topologies using it fail with
 * UNSUPPORTED_LEGACY_ASSESSOR_ROUTING (see src/agents/config.ts). Muse
 * (`opencode-go/muse-spark-1.3-contributor`) is intentionally NOT certified for semantic
 * assessment (failed Muse qualification evidence is preserved out-of-tree; see
 * docs/V0.4.13.md requalification path). No silent fallback is performed.
 *
 * Codex-channel Luna certification note: the S13 probe matrix certified gpt-6-luna ONLY via the
 * OpenCode channel (`opencode-go/gpt-6-luna` 4/4 schema-valid); the Codex channel initially
 * recorded 0 successful trials (S13: 401 authorization-unavailable; 2026-10-04 round-1 bounded
 * probe: 4 attempts, 0 schema-valid outputs across two channel barriers). The CODEX-CHANNEL
 * SEMANTIC ASSESSOR REQUALIFICATION then reformulated the semantic-assessment schema to the
 * Codex strict subset (anyOf union, strict entries array for STACK versions, required
 * nullable suggestion, no $schema dialect) with semantics preserved, repaired the Codex
 * launch-path model identifier, and certified the Codex channel on 2/2 schema-valid STACK
 * trials through the production path (see
 * docs/evidence/model-routing/codex-requalification-2026-10-04.json). The OpenCode-channel
 * S13 evidence is cited for provenance only and never transfers across channels.
 */
export const semanticStructuredOutputCapabilitiesV1: Readonly<Record<string, SemanticStructuredOutputCapabilityV1>> = {
  "openai/gpt-6-luna": { level: "SCHEMA_BOUND_TOOL_CALL", trials: 2, failures: 0, medianMs: 15_085, note: "Codex-channel certified 2026-10-04: 2/2 schema-valid STACK trials via the production path (Paseo SDK, deny-all, semantic-assessment contract). Report docs/evidence/model-routing/codex-requalification-2026-10-04.json sha256 b9e6b5b1837ffef40e9f59ef3e5aaa3e1931216e20bd4520a540f921a860983f (schema sha256 f6f206c204a5f13075344c1b8f29401e950d999be11ca29f3ae3e2881b9073a2, prompt sha256 3d78118898276107fffdc6500e50c592136cab6f4e3ef5c06ead509e297be936). Scoped to that schema sha; any schema change re-opens requalification." },
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
    .filter(([, capability]) => !capability.pendingRequalification && semanticStructuredOutputLevelRank(capability.level) >= minimum)
    .map(([model]) => model)
    .sort();
}

/** Fail-closed capability assertion: no silent fallback and no runtime-level trust. */
export function assertSemanticStructuredOutputCapabilityV1(modelId: string, required: SemanticStructuredOutputLevelV1 = requiredSemanticStructuredOutputLevelV1): SemanticStructuredOutputCapabilityV1 {
  const capability = semanticStructuredOutputCapabilityForModelV1(modelId);
  if (capability && !capability.pendingRequalification && semanticStructuredOutputLevelRank(capability.level) >= semanticStructuredOutputLevelRank(required)) return capability;
  const actual = capability?.pendingRequalification ? "PENDING_REQUALIFICATION" : capability ? capability.level : "UNCERTIFIED";
  const certified = certifiedSemanticStructuredOutputModelsV1(required);
  throw new AehError(
    "SEMANTIC_ASSESSMENT_UNAVAILABLE",
    `Semantic Assessor model '${modelId}' is certified at ${actual} structured-output capability, below the required ${required}. Certified models: ${certified.join(", ")}. No silent fallback is performed; select a certified model for the Semantic Assessor or record new probe evidence.`
  );
}
