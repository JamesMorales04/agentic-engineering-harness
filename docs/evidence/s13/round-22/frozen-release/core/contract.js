import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { triageChange } from "./triage.js";
export async function createRoutedContract(root, config, taskId, input) {
    const deterministicFloor = triageChange(config, { request: input.request, files: input.scope, domains: input.domains, risk: input.risk, flags: input.flags });
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
    const contract = {
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
function applyDeterministicRouteFloor(floor, proposed) {
    const routeRank = { NO_AGENT: 0, DIRECT: 1, DELEGATED: 2, FORMAL_SDD: 3 };
    const assuranceRank = { NONE: 0, STANDARD: 1, ELEVATED: 2, CRITICAL: 3 };
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
export function rejectLegacyTaskContract(value) {
    throw new Error("UNSUPPORTED_TASK_CONTRACT: legacy workflow fields are not accepted; migrate the contract to routing.route, routing.assurance, requirements, and verification.");
}
//# sourceMappingURL=contract.js.map