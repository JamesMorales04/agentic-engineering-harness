import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { HarnessProjectConfig, TaskContract } from "./types.js";
import { triageChange, type TriageDecision, type TriageEvidence } from "./triage.js";

export interface CreateRoutedContractInput {
  title: string;
  request: string;
  scope: string[];
  acceptance?: string[];
  domains?: string[];
  risk?: "low" | "medium" | "high";
  flags?: TriageEvidence["flags"];
  profile?: string;
  requirements?: Array<{ id: string; description?: string; validators?: string[] }>;
  routeDecision?: TriageDecision;
}

export async function createRoutedContract(root: string, config: HarnessProjectConfig, taskId: string, input: CreateRoutedContractInput): Promise<{ file: string; contract: TaskContract }> {
  const deterministicFloor = triageChange(config, { request: input.request, files: input.scope, domains: input.domains, risk: input.risk, flags: input.flags });
  const decision = input.routeDecision ? applyDeterministicRouteFloor(deterministicFloor, input.routeDecision) : deterministicFloor;
  const acceptance = input.acceptance ?? [];
  const requirements = input.requirements ?? acceptance.map((description, index) => ({ id: `AC-${index + 1}`, description, validators: [] }));
  const contract: TaskContract = {
    version: 1,
    task: { id: taskId, title: input.title },
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
