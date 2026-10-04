import type { AgentExecutionSelection, ResolvedAgentTopology } from "./types.js";

/**
 * Canonical model-routing fallback registry (PARTIAL MODEL_ROUTING_MIGRATION).
 *
 * Mechanism: DETERMINISTIC. The registry is the single source of truth for explicit
 * provider fallback from the Muse workhorse (OpenCode Go) to the Luna brain (Codex).
 * Semantic assessment is fail-closed and never falls back (see resolveSemanticAssessor).
 *
 * Workhorse lanes (planner, spec-manager, explorer, librarian, implementer, normal
 * reviewer, repairer) resolve to Muse Spark 1.3 Contributor via OpenCode Go
 * (runtime opencode, provider opencode-go, model muse-spark-1.3-contributor).
 * Lead, Operation Supervisor, high-assurance/Harness Reviewer, difficult-diagnosis
 * escalation and explicit provider fallback resolve to GPT-6 Luna via Codex
 * (runtime codex, provider openai, model gpt-6-luna, variant xhigh).
 */
export const WORKHORSE_MODEL_ID_V1 = "opencode-go/muse-spark-1.3-contributor";
export const BRAIN_MODEL_ID_V1 = "openai/gpt-6-luna";

export interface ModelFallbackFromV1 {
  modelAlias: string;
  modelId: string;
  runtimeName: string;
  paseoProvider: string;
  variant?: string;
}

export interface ModelFallbackObservationV1 {
  version: 1;
  fallbackUsed: boolean;
  from?: ModelFallbackFromV1;
  to?: ModelFallbackFromV1;
  reason?: string;
}

export interface ModelFallbackRuleV1 {
  from: string;
  to: string;
  reason: string;
  when?: string[];
}

export function modelFallbackRegistryV1(topology?: ResolvedAgentTopology): Record<string, ModelFallbackRuleV1> {
  const configured = topology?.modelFallback;
  if (configured && Object.keys(configured).length) return structuredClone(configured);
  return {
    workhorseToBrain: {
      from: "@workhorse",
      to: "@brain",
      reason: "explicit-provider-fallback",
      when: ["provider-unavailable", "difficult-diagnosis", "high-assurance-review"]
    }
  };
}

function selectionIdentity(selection: AgentExecutionSelection): ModelFallbackFromV1 {
  return {
    modelAlias: selection.modelAlias,
    modelId: selection.modelId,
    runtimeName: selection.runtimeName,
    paseoProvider: selection.paseoProvider,
    ...(selection.variant ? { variant: selection.variant } : {})
  };
}

/**
 * Describe an explicit model fallback with observable fields. Returns fallbackUsed=false
 * when no fallback was taken. Callers must record the observation in telemetry; silent
 * fallback is forbidden (stale configs fail with UNSUPPORTED_* migration errors elsewhere).
 */
export function describeModelFallbackV1(input: {
  from: AgentExecutionSelection;
  to?: AgentExecutionSelection;
  reason?: string;
  fallbackUsed: boolean;
}): ModelFallbackObservationV1 {
  if (!input.fallbackUsed || !input.to) {
    return { version: 1, fallbackUsed: false };
  }
  return {
    version: 1,
    fallbackUsed: true,
    from: selectionIdentity(input.from),
    to: selectionIdentity(input.to),
    ...(input.reason ? { reason: input.reason } : {})
  };
}

/** No-fallback observation for fail-closed paths (e.g. semantic assessment). */
export function noModelFallbackV1(): ModelFallbackObservationV1 {
  return { version: 1, fallbackUsed: false };
}
