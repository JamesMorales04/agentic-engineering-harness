import { OPERATION_KIND_VALUES, OPERATION_STATUS_VALUES, isAllowedOperationStatusTransition, type OperationKind, type OperationStatus } from "../../src/operations/state.js";

export interface AehScenario {
  id: string;
  dimensions: Record<string, string>;
  invariant: string;
  expected: string;
}

export const PRESERVATION_VALUES = ["VERBATIM", "PROJECTABLE", "COMPRESSIBLE", "RETRIEVABLE", "DISCARDABLE"] as const;
export const PERMISSION_VALUES = ["allow", "ask", "deny"] as const;
export const TRANSPORT_VALUES = ["direct", "paseo", "podman"] as const;

export const SCENARIOS: AehScenario[] = [
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
  })))
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

export function scenarioFailure(scenario: AehScenario, actual: unknown): Error {
  return new Error([
    `scenario=${scenario.id}`,
    `seed=${scenarioSeed()}`,
    `dimensions=${JSON.stringify(scenario.dimensions)}`,
    `expected=${scenario.expected}`,
    `invariant=${scenario.invariant}`,
    `actual=${JSON.stringify(actual)}`,
    `reproduction=AEH_SCENARIO=${scenario.id} AEH_SCENARIO_SEED=${scenarioSeed()} npm run test:scenario`
  ].join("\n"));
}
