import { sha256Canonical } from "../core/digest.js";
import { defaultRoleProfiles, defaultSkillSeed } from "../participants/index.js";
export const executionTransportValues = ["inherit", "paseo", "direct", "podman"];
export function compileExecutionCatalog(input) {
    const runtimeProfiles = Object.entries(input.runtimes).map(([id, runtime]) => ({
        id,
        adapter: runtime.adapter,
        ...(runtime.paseoProvider ? { provider: runtime.paseoProvider } : {}),
        capabilities: Object.fromEntries(Object.entries(runtime.capabilities ?? {}).filter(([, value]) => value !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
    })).sort((left, right) => left.id.localeCompare(right.id));
    const modelProfiles = Object.entries(input.models).map(([alias, model]) => ({
        alias: model.alias ?? alias,
        id: model.id ?? model.model,
        runtime: model.runtime,
        ...(model.provider ? { provider: model.provider } : {}),
        model: model.model,
        ...(model.variant ? { variant: model.variant } : {})
    })).sort((left, right) => left.alias.localeCompare(right.alias));
    const base = {
        version: 1,
        runtimeProfiles,
        modelProfiles,
        roleProfiles: [...defaultRoleProfiles()],
        roleBindings: Object.fromEntries(Object.entries(input.roleBindings ?? {}).sort(([left], [right]) => left.localeCompare(right)).map(([role, binding]) => [role, { ...binding, args: binding.args ? [...binding.args] : undefined }])),
        skillRefs: defaultSkillSeed().skills.map((skill) => skill.id).sort(),
        routeRuleIds: [...new Set(input.routeRuleIds ?? [])].sort(),
        policy: {
            maxParticipants: input.policy?.maxParticipants ?? 32,
            maxConcurrent: input.policy?.maxConcurrent ?? 4
        }
    };
    return { ...base, digest: sha256Canonical(base) };
}
//# sourceMappingURL=executionCatalog.js.map