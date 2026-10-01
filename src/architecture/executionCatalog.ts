import { sha256Canonical } from "../core/digest.js";
import { defaultRoleProfiles, defaultSkillSeed, type RoleProfileV1 } from "../participants/index.js";

export const executionTransportValues = ["inherit", "paseo", "direct", "podman"] as const;
export type ExecutionTransportV1 = (typeof executionTransportValues)[number];

export interface ExecutionBindingV1 {
  runtimeId: string;
  modelAlias: string;
  transport: ExecutionTransportV1;
  profile?: string;
  variant?: string;
  nativeAgent?: string;
  temperature?: number;
  outputContract?: string;
  args?: string[];
}

export interface ExecutionRuntimeProfileV1 {
  id: string;
  adapter: string;
  provider?: string;
  capabilities: Record<string, boolean>;
}

export interface ExecutionModelRuntimeProfileV1 {
  alias: string;
  id: string;
  runtime: string;
  provider?: string;
  model: string;
  variant?: string;
}

export interface ExecutionCatalogV1 {
  version: 1;
  runtimeProfiles: ExecutionRuntimeProfileV1[];
  modelProfiles: ExecutionModelRuntimeProfileV1[];
  roleProfiles: RoleProfileV1[];
  roleBindings: Record<string, ExecutionBindingV1>;
  skillRefs: string[];
  routeRuleIds: string[];
  policy: {
    maxParticipants: number;
    maxConcurrent: number;
  };
  digest: string;
}

export interface ExecutionCatalogInputV1 {
  runtimes: Record<string, { adapter: string; paseoProvider?: string; capabilities?: object }>;
  models: Record<string, { alias?: string; id?: string; runtime: string; provider?: string; model: string; variant?: string }>;
  roleBindings?: Record<string, ExecutionBindingV1>;
  routeRuleIds?: readonly string[];
  policy?: Partial<ExecutionCatalogV1["policy"]>;
}

export function compileExecutionCatalog(input: ExecutionCatalogInputV1): ExecutionCatalogV1 {
  const runtimeProfiles = Object.entries(input.runtimes).map(([id, runtime]) => ({
    id,
    adapter: runtime.adapter,
    ...(runtime.paseoProvider ? { provider: runtime.paseoProvider } : {}),
    capabilities: Object.fromEntries(Object.entries(runtime.capabilities ?? {}).filter(([, value]) => value !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) as Record<string, boolean>
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
    version: 1 as const,
    runtimeProfiles,
    modelProfiles,
    roleProfiles: [...defaultRoleProfiles()],
    roleBindings: Object.fromEntries(Object.entries(input.roleBindings ?? {}).sort(([left], [right]) => left.localeCompare(right)).map(([role, binding]) => [role, { ...binding, args: binding.args ? [...binding.args] : undefined }])) as Record<string, ExecutionBindingV1>,
    skillRefs: defaultSkillSeed().skills.map((skill) => skill.id).sort(),
    routeRuleIds: [...new Set(input.routeRuleIds ?? [])].sort(),
    policy: {
      maxParticipants: input.policy?.maxParticipants ?? 32,
      maxConcurrent: input.policy?.maxConcurrent ?? 4
    }
  };
  return { ...base, digest: sha256Canonical(base) };
}
