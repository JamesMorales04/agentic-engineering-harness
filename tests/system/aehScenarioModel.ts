import { OPERATION_KIND_VALUES, OPERATION_STATUS_VALUES, isAllowedOperationStatusTransition, type OperationKind, type OperationStatus } from "../../src/operations/state.js";

export interface AehScenario {
  id: string;
  dimensions: Record<string, string>;
  invariant: string;
  expected: string;
}

export interface ModelAction {
  index: number;
  initialStatus: OperationStatus;
  mode: "terminal" | "patch";
  to: OperationStatus;
  expected: "allowed" | "rejected" | "idempotent";
  entropy: number;
}

export const PRESERVATION_VALUES = ["VERBATIM", "PROJECTABLE", "COMPRESSIBLE", "RETRIEVABLE", "DISCARDABLE"] as const;
export const PERMISSION_VALUES = ["allow", "ask", "deny"] as const;
export const TRANSPORT_VALUES = ["direct", "paseo", "podman"] as const;
export const PHASE_VALUES = ["queued", "planning", "validation", "review", "delivery", "finished", "failed", "cancelled"] as const;
export const ROLE_VALUES = ["lead", "supervisor", "planner", "implementer", "reviewer"] as const;
export const CAPABILITY_VALUES = ["read", "write", "gitWrite", "network", "delegate", "retrieval"] as const;
export const RUNTIME_ADAPTER_VALUES = ["opencode", "codex", "native", "none"] as const;
export const PROVIDER_REQUIREMENT_VALUES = ["required", "optional"] as const;
export const PROVIDER_STATE_VALUES = ["available", "unavailable", "runtime-failure"] as const;
export const VALIDATION_OUTCOME_VALUES = ["PASS", "FAIL", "MALFORMED"] as const;
export const POLICY_OUTCOME_VALUES = ["ALLOW", "ASK", "DENY"] as const;
export const REVIEW_OUTCOME_VALUES = ["PASS", "FINDINGS", "BLOCKED"] as const;
export const RECOVERY_STATE_VALUES = ["none", "retry", "replacement", "stale-result"] as const;
export const DELIVERY_GATE_VALUES = ["open", "accepted", "failed", "blocked"] as const;

function pairScenarios<A extends readonly string[], B extends readonly string[]>(prefix: string, leftName: string, left: A, rightName: string, right: B, invariant: string, expected: string): AehScenario[] {
  return left.flatMap((leftValue) => right.map((rightValue) => ({ id: `${prefix}-${leftValue.toUpperCase()}-${rightValue.toUpperCase()}`, dimensions: { [leftName]: leftValue, [rightName]: rightValue }, invariant, expected })));
}

export const SCENARIOS: AehScenario[] = [
  {
    id: "SCN-SEEDED-ACTIONS",
    dimensions: { generator: "lcg-prng", sequence: "valid-and-invalid-actions", seed: "runtime" },
    invariant: "A supplied seed changes the deterministic action sequence while preserving model expectations for every action.",
    expected: "seeded-properties"
  },
  ...OPERATION_KIND_VALUES.map((kind) => ({
    id: `SCN-OP-KIND-${kind.toUpperCase()}`,
    dimensions: { operationKind: kind },
    invariant: "Every production operation kind has a durable v2 record shape.",
    expected: "record-compatible"
  })),
  ...OPERATION_STATUS_VALUES.flatMap((from) => OPERATION_STATUS_VALUES.map((to) => ({
    id: `SCN-LIFECYCLE-${from}-${to}`,
    dimensions: { from, to },
    invariant: "Lifecycle transitions are either explicitly allowed or deterministically rejected/idempotent.",
    expected: isAllowedOperationStatusTransition(from, to) ? "allowed" : "rejected"
  }))),
  ...PRESERVATION_VALUES.flatMap((preservation) => TRANSPORT_VALUES.map((transport) => ({
    id: `SCN-CONTEXT-${preservation}-${transport.toUpperCase()}`,
    dimensions: { preservation, transport },
    invariant: "Context delivery preserves normative bytes and never advertises an unavailable retrieval surface.",
    expected: "transport-safe"
  }))),
  ...pairScenarios("SCN-PHASE", "status", OPERATION_STATUS_VALUES, "phase", PHASE_VALUES, "Every active and terminal operation phase has an explicit status projection.", "classified"),
  ...pairScenarios("SCN-AUTH", "role", ROLE_VALUES, "capability", CAPABILITY_VALUES, "Runtime projections cannot broaden an effective capability beyond role policy.", "policy-checked"),
  ...pairScenarios("SCN-RUNTIME", "adapter", RUNTIME_ADAPTER_VALUES, "transport", TRANSPORT_VALUES, "Runtime adapter and transport combinations resolve to an explicit execution boundary.", "transport-checked"),
  ...pairScenarios("SCN-PROVIDER", "requirement", PROVIDER_REQUIREMENT_VALUES, "state", PROVIDER_STATE_VALUES, "Provider availability and failure preserve required/optional gate semantics.", "gate-checked"),
  ...pairScenarios("SCN-CONTEXT-AUTH", "preservation", PRESERVATION_VALUES, "retrieval", ["authorized", "unauthorized"] as const, "Raw retrieval authorization never crosses operation boundaries and VERBATIM bytes remain exact.", "context-checked"),
  ...pairScenarios("SCN-OUTCOME", "validation", VALIDATION_OUTCOME_VALUES, "policy", POLICY_OUTCOME_VALUES, "Validation and policy outcomes cannot be promoted by presentation layers.", "gate-checked"),
  ...pairScenarios("SCN-REVIEW", "review", REVIEW_OUTCOME_VALUES, "delivery", DELIVERY_GATE_VALUES, "Review and delivery gates remain truthful across accepted and blocked outcomes.", "delivery-checked"),
  ...pairScenarios("SCN-RECOVERY", "recovery", RECOVERY_STATE_VALUES, "delivery", DELIVERY_GATE_VALUES, "Retries and replacements cannot overwrite accepted terminal truth or bypass delivery gates.", "recovery-checked")
];

export function operationKinds(): readonly OperationKind[] { return OPERATION_KIND_VALUES; }
export function operationStatuses(): readonly OperationStatus[] { return OPERATION_STATUS_VALUES; }

export function selectedScenarios(): AehScenario[] {
  const requested = process.env.AEH_SCENARIO?.trim();
  if (!requested) return SCENARIOS;
  const selected = SCENARIOS.filter((scenario) => scenario.id === requested);
  if (!selected.length) throw new Error(`Unknown AEH_SCENARIO '${requested}'. Known scenarios: ${SCENARIOS.map((scenario) => scenario.id).join(", ")}`);
  return selected;
}

export function scenarioSeed(): number {
  const raw = process.env.AEH_SCENARIO_SEED?.trim() || "20260814";
  const seed = Number(raw);
  if (!Number.isSafeInteger(seed)) throw new Error(`AEH_SCENARIO_SEED must be a safe integer, received '${raw}'.`);
  return seed;
}

export function generateSeededActionSequence(seed: number, length = 32): ModelAction[] {
  let state = seed >>> 0;
  const next = (): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  return Array.from({ length }, (_, index) => {
    const entropy = next();
    const forced = (((entropy >>> 8) + index) >>> 0) % 4;
    const initialStatus: OperationStatus = forced === 0 ? "QUEUED" : forced === 1 ? "RUNNING" : forced === 2 ? (OPERATION_STATUS_VALUES[2 + (entropy % 3)] ?? "SUCCEEDED") : "QUEUED";
    const mode: ModelAction["mode"] = forced === 1 ? "terminal" : "patch";
    const to: OperationStatus = forced === 0 ? "RUNNING" : forced === 1 ? "SUCCEEDED" : forced === 2 ? "RUNNING" : "SUCCEEDED";
    const allowed = isAllowedOperationStatusTransition(initialStatus, to);
    return { index, initialStatus, mode, to, expected: initialStatus === to && isTerminalStatus(initialStatus) ? "idempotent" : mode === "patch" && initialStatus === "QUEUED" && to === "SUCCEEDED" ? "rejected" : allowed ? "allowed" : "rejected", entropy };
  });
}

export function scenarioFailure(scenario: AehScenario, actual: unknown, actions?: ModelAction[]): Error {
  return new Error([
    `scenario=${scenario.id}`,
    `seed=${scenarioSeed()}`,
    `dimensions=${JSON.stringify(scenario.dimensions)}`,
    `expected=${scenario.expected}`,
    `invariant=${scenario.invariant}`,
    `actual=${JSON.stringify(actual)}`,
    actions ? `actionSequence=${JSON.stringify(actions)}` : undefined,
    `reproduction=AEH_SCENARIO=${scenario.id} AEH_SCENARIO_SEED=${scenarioSeed()} npm run test:scenario`
  ].filter(Boolean).join("\n"));
}

function isTerminalStatus(status: OperationStatus): boolean { return status === "SUCCEEDED" || status === "FAILED" || status === "CANCELLED"; }
