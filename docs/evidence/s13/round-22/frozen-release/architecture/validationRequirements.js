import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { sha256Canonical } from "../core/digest.js";
export const validationRequirementKindValues = [
    "unit-test",
    "integration-test",
    "bdd",
    "contract-test",
    "browser-test",
    "visual-test",
    "static-security",
    "dependency-security",
    "architecture",
    "policy",
    "command"
];
export const validationRequirementSchema = z.object({
    version: z.literal(1),
    id: z.string().trim().min(1).max(120),
    property: z.string().trim().min(1).max(500),
    kind: z.enum(validationRequirementKindValues),
    scope: z.array(z.string().trim().min(1).max(500)).min(1).max(128),
    evidenceNeeded: z.array(z.string().trim().min(1).max(300)).min(1).max(64),
    requirementRefs: z.array(z.string().trim().min(1).max(120)).max(128),
    acceptanceRefs: z.array(z.string().trim().min(1).max(120)).max(128)
}).strict();
/**
 * Deterministic check-id → validation-kind mapping for the frozen contract requirement →
 * configured validation traceability convention: configured commands persist as `command.<id>`
 * (src/validators/commands.ts) and configured validators persist under their own id, which is
 * what the requirement evidence graph matches against (src/evidence/graph.ts). A check id with
 * no configured command/validator behind it has no deterministic kind and is never fabricated.
 */
export function configuredValidationKindForCheckV1(checkId, input = {}) {
    if (input.commands?.some((command) => `command.${command.id}` === checkId))
        return "command";
    const validator = input.validators?.find((candidate) => candidate.id === checkId);
    if (validator)
        return adapterKinds[validator.adapter];
    return undefined;
}
/**
 * Compile the frozen contract requirements' bound validators into explicit candidate-bound
 * ValidationRequirements. Each distinct validator check id becomes exactly one requirement whose
 * id is the deterministic validation check id and whose `requirementRefs`/`acceptanceRefs` name
 * every contract requirement that declared it, so `resolveVerificationRequirementsV1` binds the
 * assertion to the exact evidence path. Validators without a configured deterministic kind are
 * skipped; the AcceptanceOracle then fails closed with no fabricated correspondence.
 */
export function contractValidationRequirementsV1(input) {
    const scope = [...new Set(input.scope.map((entry) => entry.trim()).filter(Boolean))];
    const byCheckId = new Map();
    for (const requirement of input.requirements) {
        for (const checkId of new Set(requirement.validators ?? [])) {
            if (!checkId.trim())
                continue;
            const refs = byCheckId.get(checkId) ?? new Set();
            refs.add(requirement.id);
            byCheckId.set(checkId, refs);
        }
    }
    const output = [];
    for (const [checkId, refs] of [...byCheckId.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const kind = configuredValidationKindForCheckV1(checkId, input);
        if (!kind)
            continue;
        const requirementRefs = [...refs].sort();
        output.push({
            version: 1,
            id: checkId,
            property: `Frozen contract requirement(s) ${requirementRefs.join(", ")} must be validated by '${checkId}'.`,
            kind,
            scope: scope.length ? scope : ["**"],
            evidenceNeeded: [`passing '${checkId}' validation evidence for the frozen contract requirement(s) ${requirementRefs.join(", ")}.`],
            requirementRefs,
            acceptanceRefs: requirementRefs
        });
    }
    return output;
}
/**
 * Merge frozen-contract-derived validation requirements into the plan-declared base set. A plan
 * requirement that names the same deterministic validation check id as a contract-derived
 * requirement is the same validation need (the compiled plan is allowed to name the configured
 * validator ids it observes); the contract-derived requirement is normative and replaces it when
 * the declared kind agrees. An incompatible same-id declaration is a genuine deterministic
 * conflict and fails closed instead of silently dropping a requirement.
 */
export function mergeContractValidationRequirementsV1(base, contractDerived) {
    const byId = new Map(base.map((requirement) => [requirement.id, requirement]));
    for (const derived of contractDerived) {
        const existing = byId.get(derived.id);
        if (existing && existing.kind !== derived.kind) {
            throw new Error(`VALIDATION_REQUIREMENT_ID_CONFLICT: plan requirement '${derived.id}' declares kind '${existing.kind}' but the frozen contract-derived requirement declares '${derived.kind}'.`);
        }
        byId.set(derived.id, derived);
    }
    return [...byId.values()];
}
/**
 * Split plan-declared validation requirements into the resolvable set and the advisory set that no
 * approved project script, configured command, validator, or provider resolves. Only the resolvable
 * set may compile into the participant plan; the frozen contract's own validators are compiled and
 * enforced independently, so an unresolvable advisory requirement is recorded and dropped instead
 * of rejecting the entire implementation plan before any work runs (AEH-V2-0118).
 */
export function dropUnresolvablePlanValidationRequirementsV1(requirements, resolution) {
    const blockedIds = new Set(resolution.blocked.map((item) => item.requirementId));
    return {
        kept: requirements.filter((requirement) => !blockedIds.has(requirement.id)),
        dropped: requirements.filter((requirement) => blockedIds.has(requirement.id))
    };
}
const scriptCandidates = {
    "unit-test": ["test"],
    "integration-test": ["integration", "test:integration", "integration-test"],
    bdd: ["bdd", "acceptance", "test:bdd"],
    "contract-test": ["contract", "test:contract"],
    "browser-test": ["e2e", "test:e2e", "browser"],
    "visual-test": ["visual", "test:visual", "visual-regression"],
    "static-security": ["security", "lint", "check"],
    "dependency-security": ["audit", "security:dependencies"],
    architecture: ["architecture", "check:architecture"],
    policy: ["policy", "check:policy"],
    command: []
};
const adapterKinds = {
    bdd: "bdd",
    gherkin: "bdd",
    reqnroll: "bdd",
    "test-execution": "unit-test",
    "unit-test": "unit-test",
    "integration-test": "integration-test",
    "integration-environment": "integration-test",
    "contract-test": "contract-test",
    pact: "contract-test",
    openapi: "contract-test",
    playwright: "browser-test",
    "browser-test": "browser-test",
    visual: "visual-test",
    "visual-test": "visual-test",
    opengrep: "static-security",
    "static-security": "static-security",
    trivy: "dependency-security",
    "dependency-security": "dependency-security",
    architecture: "architecture",
    policy: "policy",
    command: "command"
};
/**
 * Resolves semantic validation needs to project/configured actions. The model
 * supplies only the requirement; it cannot select an executable command,
 * provider, tool or credential.
 */
export async function resolveValidationRequirements(input) {
    const requirements = input.requirements.map((requirement) => validationRequirementSchema.parse(requirement));
    const allowed = new Set(input.allowedKinds ?? validationRequirementKindValues);
    const scripts = await projectScripts(input.root);
    const commands = [...(input.config?.validation?.commands ?? []), ...(input.contract?.verification?.commands ?? [])];
    const validators = [...(input.config?.validation?.validators ?? []), ...(input.contract?.verification?.validators ?? [])];
    const providers = input.config?.validation?.providers ?? [];
    const actions = [];
    const blocked = [];
    for (const requirement of requirements) {
        if (!allowed.has(requirement.kind)) {
            blocked.push({ requirementId: requirement.id, reason: `validation kind '${requirement.kind}' is disallowed by policy.` });
            continue;
        }
        const action = resolveConfigured(requirement, commands, validators, providers, input.availableTools) ?? resolveProjectScript(requirement, scripts, input.projectStack);
        if (!action)
            blocked.push({ requirementId: requirement.id, reason: `no approved project script, command, validator, or provider resolves '${requirement.kind}'.` });
        else
            actions.push(action);
    }
    const withoutDigest = { version: 1, requirements, actions, blocked };
    return { ...withoutDigest, digest: sha256Canonical(withoutDigest) };
}
function resolveConfigured(requirement, commands, validators, providers, availableTools) {
    // A `command`-kind requirement states the property to demonstrate; the Planner must not select a
    // concrete command. When it does not name one of the approved command ids and the frozen project
    // config approves exactly one command, that command is the deterministic resolution (matching the
    // single-configured-validator/provider rule below) instead of a fail-closed block (AEH-V2-0110).
    const command = commands.find((candidate) => candidate.id === requirement.id || candidate.id === requirement.kind || `command.${candidate.id}` === requirement.id)
        ?? (requirement.kind === "command" && commands.length === 1 ? commands[0] : undefined);
    if (command)
        return action(requirement, "configured-command", command.id, command.command);
    const validator = validators.find((candidate) => adapterKinds[candidate.adapter] === requirement.kind && (candidate.id === requirement.id || candidate.id === requirement.kind || validators.length === 1));
    if (validator)
        return action(requirement, "configured-validator", validator.id, validator.command);
    const provider = providers.find((candidate) => providerKind(candidate.capability) === requirement.kind && (candidate.id === requirement.id || candidate.provider === requirement.kind || providers.length === 1));
    if (!provider)
        return undefined;
    const requiredTool = typeof provider.options?.tool === "string" ? provider.options.tool : undefined;
    if (requiredTool && !availableTools?.some((tool) => tool.id === requiredTool && tool.available))
        return undefined;
    return { ...action(requirement, "approved-provider", provider.id, provider.command), provider: provider.provider };
}
function resolveProjectScript(requirement, scripts, stack) {
    const script = scriptCandidates[requirement.kind].find((name) => typeof scripts[name] === "string" && scripts[name].trim());
    if (!script)
        return undefined;
    return action(requirement, "project-script", script, script === "test" ? "npm test" : `npm run ${script}`);
}
function action(requirement, source, selector, command) {
    return { version: 1, requirementId: requirement.id, kind: requirement.kind, source, selector, ...(command ? { command } : {}), scope: [...requirement.scope], evidenceNeeded: [...requirement.evidenceNeeded] };
}
function providerKind(capability) {
    return adapterKinds[capability];
}
async function projectScripts(root) {
    try {
        const parsed = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
        return Object.fromEntries(Object.entries(parsed.scripts ?? {}).filter((entry) => typeof entry[1] === "string"));
    }
    catch {
        return {};
    }
}
//# sourceMappingURL=validationRequirements.js.map