/**
 * Deterministic advisory-invariant guard. Memory, telemetry, logs, and evals
 * are observations, never authority: no authority decision surface may import
 * eval/telemetry modules, and observation read helpers must not be consumed by
 * decision code. This module reads source text only and grants no authority.
 */
export interface AdvisoryInvariantViolationV1 {
    file: string;
    kind: "EVAL_IMPORT" | "AUTHORITY_OBSERVATION_IMPORT" | "OBSERVATION_READ_HELPER";
    detail: string;
}
export declare const AUTHORITY_DECISION_MODULES: readonly ["src/architecture/acceptanceOracle.ts", "src/architecture/objectiveCompletion.ts", "src/architecture/candidateAssurance.ts", "src/architecture/executionIdentity.ts", "src/architecture/validationRequirements.ts", "src/operations/state.ts", "src/security/actionPolicy.ts", "src/security/toolActionGate.ts", "src/security/gatedAction.ts", "src/security/humanDecision.ts", "src/agents/routing.ts", "src/agents/routingV2.ts", "src/certification/core.ts", "src/delivery/finalize.ts", "src/delivery/handoff.ts", "src/provenance/generate.ts"];
export declare const OBSERVATION_READ_HELPERS: readonly ["readTelemetryEvents", "readMetricSnapshots", "loadEvalCorpusManifest", "computeEvalCorpusIdentity", "compareEvalCase", "buildEvalDashboard", "evalResultComparableV1"];
export declare function scanAdvisoryInvariantV1(root: string): Promise<AdvisoryInvariantViolationV1[]>;
