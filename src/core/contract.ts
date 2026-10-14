import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { HarnessProjectConfig, TaskContract, ValidationCapability } from "./types.js";
import { contractValidationRequirementsV1, dropUnresolvablePlanValidationRequirementsV1, mergeContractValidationRequirementsV1, type ValidationRequirementV1, type ValidationResolutionV1 } from "../architecture/validationRequirements.js";
import { triageChange, type TriageDecision, type TriageEvidence } from "./triage.js";

export interface CreateRoutedContractInput {
  title: string;
  request: string;
  scope: string[];
  acceptance?: string[];
  domains?: string[];
  risk?: "low" | "medium" | "high";
  flags?: TriageEvidence["flags"];
  expectedWorkUnits?: number;
  profile?: string;
  requirements?: Array<{ id: string; description?: string; validators?: string[] }>;
  routeDecision?: TriageDecision;
}

export async function createRoutedContract(root: string, config: HarnessProjectConfig, taskId: string, input: CreateRoutedContractInput): Promise<{ file: string; contract: TaskContract }> {
  // AEH-V2-0128: the deterministic floor consumes the same explicit
  // work-unit count as every other triage caller (single predicate
  // `requiresDelegatedPlanningV1` inside `triageChange`).
  const deterministicFloor = triageChange(config, { request: input.request, files: input.scope, domains: input.domains, risk: input.risk, flags: input.flags, ...(input.expectedWorkUnits !== undefined ? { expectedWorkUnits: input.expectedWorkUnits } : {}) });
  const decision = input.routeDecision ? applyDeterministicRouteFloor(deterministicFloor, input.routeDecision) : deterministicFloor;
  const acceptance = input.acceptance ?? [];
  // Requirement→validator traceability is deterministic: a requirement that does not name its own
  // approved validators is bound to the project's configured validation commands and validators.
  // The model cannot select commands, and a project without configured validation keeps the
  // fail-closed empty set (the evidence-completeness gate then blocks).
  // Requirement validators must name the deterministic validation check ids: configured commands
  // persist as `command.<id>` (src/validators/commands.ts) and configured validators persist under
  // their own id, which is what the requirement evidence graph matches against.
  const configuredValidators = [...new Set([
    ...(config.validation?.commands ?? []).map((command) => `command.${command.id}`),
    ...(config.validation?.validators ?? []).map((validator) => validator.id)
  ].filter((id) => id.trim().length > 0))].sort();
  const requirements = (input.requirements ?? acceptance.map((description, index) => ({ id: `AC-${index + 1}`, description, validators: [] })))
    .map((requirement) => requirement.validators?.length ? requirement : { ...requirement, validators: [...configuredValidators] });
  const contract: TaskContract = {
    version: 1,
    task: { id: taskId, title: input.title },
    request: input.request,
    git: { baseRef: config.validation?.baseRef ?? "main" },
    scope: { allowed: [...new Set(input.scope.length ? input.scope : ["**"])], forbidden: [], frozen: [] },
    routing: { intent: "implement", domains: [...new Set(input.domains ?? [])], risk: input.risk ?? "low", profile: input.profile, route: decision.route, assurance: decision.assurance, routeEvidence: decision.routeEvidence },
    requirements,
    constraints: { breakingApiChanges: false, newDependencies: false, schemaChanges: false },
    repair: { maxAttempts: config.orchestration?.worker?.maxRepairAttempts ?? 2 }
  };
  const contractsDir = path.resolve(root, config.sdd?.contractsDir ?? ".harness/contracts");
  await fs.mkdir(contractsDir, { recursive: true });
  const file = path.join(contractsDir, `${taskId}.yaml`);
  await fs.writeFile(file, YAML.stringify(contract));
  return { file, contract };
}

function applyDeterministicRouteFloor(floor: TriageDecision, proposed: TriageDecision): TriageDecision {
  const routeRank = { NO_AGENT: 0, DIRECT: 1, DELEGATED: 2, FORMAL_SDD: 3 } as const;
  const assuranceRank = { NONE: 0, STANDARD: 1, ELEVATED: 2, CRITICAL: 3 } as const;
  const route = routeRank[proposed.route] >= routeRank[floor.route] && proposed.route !== "NO_AGENT" ? proposed.route : floor.route;
  const assurance = assuranceRank[proposed.assurance] >= assuranceRank[floor.assurance] ? proposed.assurance : floor.assurance;
  const floorStrengthened = route !== proposed.route || assurance !== proposed.assurance;
  return {
    ...proposed,
    route,
    assurance,
    mechanism: floorStrengthened ? "HYBRID" : proposed.mechanism,
    routeEvidence: floorStrengthened ? [...proposed.routeEvidence, ...floor.routeEvidence] : proposed.routeEvidence,
    reasons: floorStrengthened ? [...proposed.reasons, "deterministic route and assurance floor retained"] : proposed.reasons
  };
}

export function rejectLegacyTaskContract(value: unknown): never {
  throw new Error("UNSUPPORTED_TASK_CONTRACT: legacy workflow fields are not accepted; migrate the contract to routing.route, routing.assurance, requirements, and verification.");
}

/**
 * Single-source assembly of the frozen-contract validation traceability
 * inputs shared by the wave-execution blueprint path and the downstream
 * candidate-assurance oracle path. Both consumers must observe the same
 * contract-derived set, otherwise the oracle rejects what the blueprint never
 * contained (AEH-V2-0099 class). MECHANISM: DETERMINISTIC.
 */
export function contractValidationSourcesForContractV1(
  contract: Pick<TaskContract, "requirements" | "scope" | "verification">,
  config: Pick<HarnessProjectConfig, "validation">
): {
  requirements: readonly { id: string; validators?: readonly string[] }[];
  scope: readonly string[];
  commands?: readonly { id: string }[];
  validators?: readonly { id: string; adapter: string }[];
  providers?: readonly { id: string; capability: ValidationCapability; provider: string }[];
} {
  return {
    requirements: contract.requirements ?? [],
    scope: contract.scope?.allowed ?? ["**"],
    commands: [...(config.validation?.commands ?? []), ...(contract.verification?.commands ?? [])],
    validators: [...(config.validation?.validators ?? []), ...(contract.verification?.validators ?? [])],
    providers: config.validation?.providers ?? []
  };
}

/**
 * Merge frozen-contract-derived validation requirements into a plan-declared
 * base set with one shared semantic (no per-callsite duplication). The
 * contract-derived requirement is normative per check id; an incompatible
 * same-id kind fails closed via `mergeContractValidationRequirementsV1`.
 */
export function mergedPlanContractValidationRequirementsV1(
  base: readonly ValidationRequirementV1[],
  contract: Pick<TaskContract, "requirements" | "scope" | "verification">,
  config: Pick<HarnessProjectConfig, "validation">
): ValidationRequirementV1[] {
  return mergeContractValidationRequirementsV1(base, contractValidationRequirementsV1(contractValidationSourcesForContractV1(contract, config)));
}

/**
 * Partition a merged (plan + contract-derived) validation set into the
 * resolvable set and the advisory set, without ever silently dropping a
 * CONTRACT-derived requirement. A blocked contract-derived id is a genuine
 * frozen-gate inconsistency and fails closed (`VALIDATION_REQUIREMENT_BLOCKED`);
 * only genuinely unresolvable PLAN-only requirements are dropped, and the
 * caller must persist the durable `harness.plan.validation-requirements-dropped`
 * record for them. MECHANISM: DETERMINISTIC.
 */
export function partitionMergedValidationRequirementsV1(
  merged: readonly ValidationRequirementV1[],
  contractDerived: readonly ValidationRequirementV1[],
  resolution: ValidationResolutionV1
): { kept: ValidationRequirementV1[]; dropped: ValidationRequirementV1[] } {
  const contractIds = new Set(contractDerived.map((requirement) => requirement.id));
  const blockedContract = resolution.blocked.filter((item) => contractIds.has(item.requirementId));
  if (blockedContract.length) {
    throw new Error(`VALIDATION_REQUIREMENT_BLOCKED: frozen contract-derived validation requirement(s) cannot be resolved: ${blockedContract.map((item) => `${item.requirementId}: ${item.reason}`).join("; ")}`);
  }
  const partition = dropUnresolvablePlanValidationRequirementsV1(merged, resolution);
  const droppedContract = partition.dropped.filter((requirement) => contractIds.has(requirement.id));
  if (droppedContract.length) {
    throw new Error(`VALIDATION_REQUIREMENT_BLOCKED: frozen contract-derived validation requirement(s) must never be dropped as advisory: ${droppedContract.map((requirement) => requirement.id).join(", ")}`);
  }
  return partition;
}
