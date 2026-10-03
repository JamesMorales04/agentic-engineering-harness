import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { ResolvedAgentTopology } from "../agents/types.js";
import type { HarnessProjectConfig, ValidatorSpec } from "../core/types.js";
import { sha256Canonical } from "../core/digest.js";
import type { ExecutionCatalogV1 } from "../architecture/executionCatalog.js";
import { defaultRoleProfiles, type CanonicalRole } from "../participants/index.js";
import type { ToolchainConfig, ToolchainLock } from "../toolchain/types.js";
import { validationCapabilityRegistry } from "../providers/validation/registry.js";
import { resolveOperationStateRoot } from "../operations/state.js";
import { OPERATIONAL_SKILLS_V1, type OperationalSkillV1 } from "./operationalSkills.js";

export type CapabilityAudienceV1 = "PARTICIPANT" | "CONTROLLER_ONLY";
export type CapabilityAvailabilityV1 = "AVAILABLE" | "CONFIGURED" | "DISABLED" | "UNKNOWN";
export type CapabilitySideEffectClassV1 = "READ_ONLY" | "PROCESS_EXECUTION" | "REPOSITORY_MUTATION" | "EXTERNAL_EFFECT" | "CONTROLLER_INTERNAL";

export interface CapabilityEntryV1 {
  id: string;
  kind: "RUNTIME" | "MODEL" | "MCP_SERVER" | "TOOLPACK" | "TOOLCHAIN_TOOL" | "VALIDATOR" | "CONTEXT_PROVIDER" | "DELIVERY_PROVIDER" | "HARNESS_INTERNAL";
  provider?: string;
  toolService?: string;
  version?: string;
  sourceOfTruth: string;
  availability: CapabilityAvailabilityV1;
  availabilityReason: string;
  audience: CapabilityAudienceV1;
  authorityRequired: string;
  sideEffectClass: CapabilitySideEffectClassV1;
  inputs: string[];
  outputs: string[];
  failureClasses: string[];
  roles: CanonicalRole[];
  skillRefs: string[];
}

export interface CapabilityRegistryV1 {
  version: 1;
  operationId?: string;
  capabilities: CapabilityEntryV1[];
  digest: string;
}

export interface CapabilityRegistryCompileInputV1 {
  operationId?: string;
  config: HarnessProjectConfig;
  executionCatalog: ExecutionCatalogV1;
  topology?: ResolvedAgentTopology;
  toolchain?: ToolchainConfig;
  toolchainLock?: ToolchainLock;
  providerVersions?: Record<string, string>;
}

const participantRoles = defaultRoleProfiles().map((profile) => profile.role);
const failureFamilies = ["UNAVAILABLE", "TIMEOUT", "INVALID_INPUT", "PERMISSION_DENIED", "PROVIDER_ERROR"];

/** Deterministic projection of configured surfaces. It neither probes providers nor grants tools or authority. */
export function compileCapabilityRegistryV1(input: CapabilityRegistryCompileInputV1): CapabilityRegistryV1 {
  const capabilities: CapabilityEntryV1[] = [];
  const skillsByCapability = indexSkills(OPERATIONAL_SKILLS_V1);
  const add = (entry: Omit<CapabilityEntryV1, "skillRefs">): void => {
    capabilities.push({
      ...entry,
      roles: [...new Set(entry.roles)].sort(),
      inputs: [...new Set(entry.inputs)].sort(),
      outputs: [...new Set(entry.outputs)].sort(),
      failureClasses: [...new Set(entry.failureClasses)].sort(),
      skillRefs: [...(skillsByCapability.get(entry.id) ?? [])].sort()
    });
  };

  const roleBindings = input.executionCatalog.roleBindings;
  for (const runtime of input.executionCatalog.runtimeProfiles) {
    const roles = Object.entries(roleBindings).filter(([, binding]) => binding.runtimeId === runtime.id).map(([role]) => role).filter(isCanonicalRole);
    add({
      id: "runtime:" + runtime.id, kind: "RUNTIME", provider: runtime.provider ?? runtime.adapter, toolService: runtime.adapter,
      sourceOfTruth: "ExecutionCatalogV1.runtimeProfiles", availability: "CONFIGURED",
      availabilityReason: "Runtime is present in the frozen ExecutionCatalog; live health is not probed by this registry.",
      audience: roles.length ? "PARTICIPANT" : "CONTROLLER_ONLY", authorityRequired: roles.length ? "compiled execution binding" : "controller runtime configuration",
      sideEffectClass: "PROCESS_EXECUTION", inputs: ["ExecutionBlueprint"], outputs: ["provider turn"],
      failureClasses: ["UNAVAILABLE", "TIMEOUT", "PROVIDER_ERROR"], roles
    });
  }
  for (const model of input.executionCatalog.modelProfiles) {
    const roles = Object.entries(roleBindings).filter(([, binding]) => binding.modelAlias === model.alias).map(([role]) => role).filter(isCanonicalRole);
    add({
      id: "model:" + model.alias, kind: "MODEL", provider: model.provider ?? "unknown", toolService: model.runtime,
      ...(input.providerVersions?.[model.provider ?? ""] ? { version: input.providerVersions[model.provider ?? ""] } : {}),
      sourceOfTruth: "ExecutionCatalogV1.modelProfiles", availability: "CONFIGURED",
      availabilityReason: "Model is declared in the frozen ExecutionCatalog; billing and provider health remain unknown until reported by the provider.",
      audience: roles.length ? "PARTICIPANT" : "CONTROLLER_ONLY", authorityRequired: "compiled execution binding",
      sideEffectClass: "PROCESS_EXECUTION", inputs: ["provider request"], outputs: ["provider response"],
      failureClasses: ["UNAVAILABLE", "TIMEOUT", "PROVIDER_ERROR"], roles
    });
  }

  const selectedMcpRoles = new Map<string, CanonicalRole[]>();
  for (const agent of Object.values(input.topology?.agents ?? {})) {
    if (agent.disabled) continue;
    for (const server of agent.mcps ?? []) if (isCanonicalRole(agent.role)) selectedMcpRoles.set(server, [...(selectedMcpRoles.get(server) ?? []), agent.role]);
  }
  for (const [name, server] of Object.entries(input.config.mcp?.servers ?? {})) {
    const roles = [...new Set(selectedMcpRoles.get(name) ?? [])];
    const enabled = server.enabled !== false;
    add({
      id: "mcp:" + name, kind: "MCP_SERVER", provider: server.type === "remote" ? "remote-mcp" : "local-mcp", toolService: name,
      sourceOfTruth: ".harness/project.yaml#mcp.servers." + name,
      availability: enabled ? "CONFIGURED" : "DISABLED",
      availabilityReason: !enabled ? "MCP server is disabled in project configuration." : roles.length ? "Enabled and selected by configured participant agents; server readiness is not probed." : "Enabled in project configuration but not selected by an active participant agent.",
      audience: enabled && roles.length ? "PARTICIPANT" : "CONTROLLER_ONLY",
      authorityRequired: enabled && roles.length ? "compiled role ToolPack and MCP selection" : "controller configuration",
      sideEffectClass: server.type === "remote" ? "EXTERNAL_EFFECT" : "PROCESS_EXECUTION",
      inputs: ["MCP tool request"], outputs: ["MCP tool result"], failureClasses: [...failureFamilies, "INVALID_ARGUMENT"], roles
    });
  }

  for (const roleProfile of input.executionCatalog.roleProfiles) {
    const declaredTools = [...new Set([...roleProfile.toolPack.required, ...roleProfile.toolPack.optional])].filter((tool) => !roleProfile.toolPack.forbidden.includes(tool));
    for (const tool of declaredTools) {
      const processTool = ["command-execute", "test-runner", "database-client"].includes(tool);
      add({
        id: "toolpack:" + roleProfile.role + ":" + tool, kind: "TOOLPACK", toolService: tool,
        sourceOfTruth: "ExecutionCatalogV1.roleProfiles." + roleProfile.role + ".toolPack", availability: "CONFIGURED",
        availabilityReason: roleProfile.toolPack.required.includes(tool) ? "Declared in the frozen role ToolPack." : "Optional ceiling in the frozen role ToolPack; runtime projection still applies its own authorization.",
        audience: "PARTICIPANT", authorityRequired: "compiled " + roleProfile.role + " ToolPack",
        sideEffectClass: tool === "repository-write" ? "REPOSITORY_MUTATION" : processTool ? "PROCESS_EXECUTION" : "READ_ONLY",
        inputs: [tool + " request"], outputs: [tool + " result"], failureClasses: failureFamilies, roles: [roleProfile.role]
      });
    }
  }

  const lockedTools = input.toolchainLock?.tools ?? {};
  const toolchainConfigPath = input.config.toolchain?.configPath ?? ".harness/toolchain.yaml";
  const toolchainLockPath = input.config.toolchain?.lockPath ?? input.toolchain?.manager.lockFile ?? ".harness/toolchain.lock.json";
  for (const [name, tool] of Object.entries(input.toolchain?.tools ?? {})) {
    const locked = lockedTools[name];
    add({
      id: "toolchain:" + name, kind: "TOOLCHAIN_TOOL", provider: tool.source ?? tool.kind, toolService: tool.command,
      ...(locked?.resolvedVersion ? { version: locked.resolvedVersion } : input.providerVersions?.[name] ? { version: input.providerVersions[name] } : tool.version ? { version: tool.version } : {}),
      sourceOfTruth: locked ? toolchainLockPath + "#tools." + name : toolchainConfigPath + "#tools",
      availability: locked ? "CONFIGURED" : "UNKNOWN",
      availabilityReason: locked ? "Tool appears in the resolved toolchain lock; installation and executable health are not probed." : "Configured in toolchain but absent from the resolved lock.",
      audience: "CONTROLLER_ONLY", authorityRequired: "controller toolchain policy", sideEffectClass: "PROCESS_EXECUTION",
      inputs: ["controller invocation"], outputs: ["tool result"], failureClasses: ["UNAVAILABLE", "TIMEOUT", "TOOL_ERROR"], roles: []
    });
  }

  for (const adapter of configuredValidatorAdapters(input.config.validation?.validators ?? [])) {
    add({
      id: "validator:" + adapter, kind: "VALIDATOR", provider: adapter, toolService: adapter,
      sourceOfTruth: "src/validators/registry.ts and ValidationCapabilityRegistry",
      availability: "CONFIGURED",
      availabilityReason: "Validator adapter is declared by project configuration; exact provider detection and handler support are resolved when invoked.",
      audience: "CONTROLLER_ONLY", authorityRequired: "controller validation policy", sideEffectClass: "PROCESS_EXECUTION",
      inputs: ["candidate", "validation contract"], outputs: ["candidate-bound validation result"],
      failureClasses: ["UNAVAILABLE", "TIMEOUT", "VALIDATION_FAILURE", "PROVIDER_ERROR"], roles: []
    });
  }
  for (const providerId of validationCapabilityRegistry.list()) add({
    id: "validator-provider:" + providerId, kind: "VALIDATOR", provider: providerId, toolService: providerId,
    sourceOfTruth: "ValidationCapabilityRegistry", availability: "AVAILABLE",
    availabilityReason: "Provider implementation is registered; project detection/readiness is evaluated only when invoked.",
    audience: "CONTROLLER_ONLY", authorityRequired: "controller validation policy", sideEffectClass: "PROCESS_EXECUTION",
    inputs: ["validation provider context"], outputs: ["validation result"],
    failureClasses: ["UNAVAILABLE", "TIMEOUT", "VALIDATION_FAILURE", "PROVIDER_ERROR"], roles: []
  });

  const context = input.config.context;
  const contextProviders = [
    { id: "context:repository-map", provider: "repository-map", enabled: context?.repositoryMap?.enabled !== false, source: ".harness/project.yaml#context.repositoryMap", service: "repository map", roles: participantRoles, effects: "READ_ONLY" as const },
    { id: "context:semantic-retrieval", provider: context?.semanticRetrieval?.provider, enabled: Boolean(context?.semanticRetrieval?.provider && context.semanticRetrieval.provider !== "none"), source: ".harness/project.yaml#context.semanticRetrieval", service: "semantic retrieval", roles: participantRoles.filter((role) => role !== "Lead/Director" && role !== "Operation Supervisor"), effects: "READ_ONLY" as const },
    { id: "context:authorized-retrieval", provider: "aeh-context", enabled: Boolean(context), source: ".harness/project.yaml#context", service: "authorized context gateway", roles: participantRoles.filter((role) => role !== "Lead/Director" && role !== "Operation Supervisor"), effects: "READ_ONLY" as const },
    { id: "context:compression", provider: context?.compression?.provider, enabled: Boolean(context?.compression?.provider && context.compression.provider !== "none"), source: ".harness/project.yaml#context.compression", service: "context compression", roles: [], effects: "CONTROLLER_INTERNAL" as const }
  ];
  for (const provider of contextProviders) add({
    id: provider.id, kind: "CONTEXT_PROVIDER", ...(provider.provider ? { provider: provider.provider } : {}), ...(provider.provider && input.providerVersions?.[provider.provider] ? { version: input.providerVersions[provider.provider] } : {}), toolService: provider.service,
    sourceOfTruth: provider.source, availability: provider.enabled ? "CONFIGURED" : "DISABLED",
    availabilityReason: provider.enabled ? "Enabled by project configuration; transport readiness and per-execution requirements are resolved at launch." : "Not enabled by project configuration.",
    audience: provider.roles.length ? "PARTICIPANT" : "CONTROLLER_ONLY",
    authorityRequired: provider.roles.length ? "authorized context policy and execution binding" : "controller context policy",
    sideEffectClass: provider.effects, inputs: ["scoped context request"], outputs: ["authorized context fragments"],
    failureClasses: ["UNAVAILABLE", "PERMISSION_DENIED", "TIMEOUT", "MISSING_CONTEXT"], roles: provider.roles
  });

  const delivery = input.config.delivery;
  const deliveryProviders = [
    { id: "delivery:github", enabled: delivery?.github?.enabled === true, provider: "github", source: ".harness/project.yaml#delivery.github", service: "GitHub delivery request" },
    { id: "delivery:paseo", enabled: delivery?.paseo?.enabled === true, provider: "paseo", source: ".harness/project.yaml#delivery.paseo", service: "Paseo workspace delivery request" }
  ];
  for (const provider of deliveryProviders) add({
    id: provider.id, kind: "DELIVERY_PROVIDER", provider: provider.provider, toolService: provider.service, sourceOfTruth: provider.source,
    availability: provider.enabled ? "CONFIGURED" : "DISABLED",
    availabilityReason: provider.enabled ? "Enabled in project configuration; credentials and action policy are checked at request time." : "Disabled or absent in project configuration.",
    audience: "CONTROLLER_ONLY", authorityRequired: "controller delivery policy and operation authorization", sideEffectClass: "EXTERNAL_EFFECT",
    inputs: ["accepted candidate", "delivery request"], outputs: ["delivery record"],
    failureClasses: ["UNAVAILABLE", "PERMISSION_DENIED", "EXTERNAL_EFFECT_FAILURE"], roles: []
  });

  const internal: Array<Omit<CapabilityEntryV1, "skillRefs">> = [
    { id: "aeh:structured-result-submission", kind: "HARNESS_INTERNAL", toolService: "scoped structured result gateway", sourceOfTruth: "src/paseo structured-result channel", availability: input.config.orchestration?.provider === "paseo" ? "CONFIGURED" : "DISABLED", availabilityReason: "Projected only into a bound Paseo participant session; the registry does not create that session or broaden its channel.", audience: "PARTICIPANT", authorityRequired: "frozen participant result channel", sideEffectClass: "CONTROLLER_INTERNAL", inputs: ["participant structured result"], outputs: ["candidate-bound result evidence"], failureClasses: ["STALE_BINDING", "INVALID_RESULT", "PERMISSION_DENIED"], roles: participantRoles },
    { id: "aeh:candidate-lifecycle", kind: "HARNESS_INTERNAL", toolService: "candidate lifecycle controller", sourceOfTruth: "src/candidates and src/operations", availability: "AVAILABLE", availabilityReason: "Candidate lifecycle is owned by the Harness controller and is not exposed as a participant tool.", audience: "CONTROLLER_ONLY", authorityRequired: "controller candidate lifecycle authority", sideEffectClass: "CONTROLLER_INTERNAL", inputs: ["candidate revision request"], outputs: ["candidate revision"], failureClasses: ["STALE_BINDING", "PERMISSION_DENIED", "INVALID_STATE"], roles: [] },
    { id: "aeh:validation-invocation", kind: "HARNESS_INTERNAL", toolService: "validation controller", sourceOfTruth: "src/validators/registry.ts", availability: "AVAILABLE", availabilityReason: "Validation invocation is controller-owned; validators do not gain participant authority.", audience: "CONTROLLER_ONLY", authorityRequired: "controller validation authority", sideEffectClass: "CONTROLLER_INTERNAL", inputs: ["candidate", "acceptance requirements"], outputs: ["validation report"], failureClasses: ["INVALID_STATE", "VALIDATION_FAILURE", "TIMEOUT"], roles: [] },
    { id: "aeh:browser-validation", kind: "HARNESS_INTERNAL", provider: "playwright", ...(input.providerVersions?.playwright ? { version: input.providerVersions.playwright } : {}), toolService: "Playwright validator", sourceOfTruth: "src/validators/registry.ts#playwright", availability: input.config.validation?.validators?.some((spec) => spec.adapter === "playwright") ? "CONFIGURED" : "UNKNOWN", availabilityReason: "Browser validation is controller-invoked; a skill cannot expose Playwright as a participant tool.", audience: "CONTROLLER_ONLY", authorityRequired: "controller validation policy", sideEffectClass: "PROCESS_EXECUTION", inputs: ["candidate", "browser validation spec"], outputs: ["browser validation evidence"], failureClasses: ["UNAVAILABLE", "TIMEOUT", "VALIDATION_FAILURE"], roles: [] },
    { id: "aeh:operation-artifact-retrieval", kind: "HARNESS_INTERNAL", toolService: "operation artifact store", sourceOfTruth: "src/operations and src/evidence", availability: "AVAILABLE", availabilityReason: "Artifacts are retrieved through authorized context and operation APIs; raw storage is controller-owned.", audience: "CONTROLLER_ONLY", authorityRequired: "operation artifact authorization", sideEffectClass: "CONTROLLER_INTERNAL", inputs: ["operation and artifact identity"], outputs: ["authorized artifact evidence"], failureClasses: ["NOT_FOUND", "PERMISSION_DENIED", "STALE_BINDING"], roles: [] },
    { id: "aeh:skill-retrieval", kind: "HARNESS_INTERNAL", toolService: "operational skill projection", sourceOfTruth: "src/capabilities/operationalSkills.ts", availability: "AVAILABLE", availabilityReason: "The controller projects selected skill sections; skill content does not grant its referenced capability.", audience: "CONTROLLER_ONLY", authorityRequired: "controller projection policy", sideEffectClass: "CONTROLLER_INTERNAL", inputs: ["role", "WorkUnit", "ToolPack", "observed failure"], outputs: ["bounded skill guidance"], failureClasses: ["UNKNOWN_SKILL", "VERSION_MISMATCH"], roles: [] },
    { id: "aeh:supervisor-recovery", kind: "HARNESS_INTERNAL", toolService: "aeh_supervisor_recovery_decide", sourceOfTruth: "src/operations/supervisorMcp.ts and frozen OperationLivenessPolicy", availability: input.config.orchestration?.provider === "paseo" ? "CONFIGURED" : "DISABLED", availabilityReason: "Projected only into the current bound Operation Supervisor session; controller validates cited evidence, session binding, and frozen retry/economic limits.", audience: input.config.orchestration?.provider === "paseo" ? "PARTICIPANT" : "CONTROLLER_ONLY", authorityRequired: "current bound Operation Supervisor session and frozen operation policy", sideEffectClass: "CONTROLLER_INTERNAL", inputs: ["participant binding", "activity evidence", "bounded recovery action"], outputs: ["durable Supervisor recovery decision"], failureClasses: ["STALE_BINDING", "PERMISSION_DENIED", "ECONOMIC_HARD_BOUNDARY_REACHED"], roles: input.config.orchestration?.provider === "paseo" ? ["Operation Supervisor"] : [] },
    { id: "aeh:lead-recovery", kind: "HARNESS_INTERNAL", toolService: "aeh_operation_recover_participant", sourceOfTruth: "src/operations/mcp.ts and frozen EconomicEnvelopeV1", availability: input.config.orchestration?.provider === "paseo" && input.config.orchestration.interactive?.usePaseoTools !== false ? "CONFIGURED" : "DISABLED", availabilityReason: "Projected only into the bound interactive Lead; controller validates exact participant evidence and never widens the Owner-delegated hard envelope.", audience: input.config.orchestration?.provider === "paseo" && input.config.orchestration.interactive?.usePaseoTools !== false ? "PARTICIPANT" : "CONTROLLER_ONLY", authorityRequired: "current bound Lead session and frozen Owner-delegated envelope", sideEffectClass: "CONTROLLER_INTERNAL", inputs: ["participant binding", "activity evidence", "continue/resume/retry, fail, or request a bounded linked replan/rotation/split/reassignment"], outputs: ["durable Lead lease renewal or typed recovery request"], failureClasses: ["STALE_BINDING", "PERMISSION_DENIED", "ECONOMIC_HARD_BOUNDARY_REACHED"], roles: input.config.orchestration?.provider === "paseo" && input.config.orchestration.interactive?.usePaseoTools !== false ? ["Lead/Director"] : [] },
    { id: "aeh:operation-control", kind: "HARNESS_INTERNAL", toolService: "aeh-control operation tools", sourceOfTruth: "src/operations/mcp.ts route schemas and bound Lead identity", availability: input.config.orchestration?.provider === "paseo" && input.config.orchestration.interactive?.usePaseoTools !== false ? "CONFIGURED" : "DISABLED", availabilityReason: "Projected only to the interactive Lead session that receives aeh-control tools; operational skills do not expose these tools to operation participants.", audience: input.config.orchestration?.provider === "paseo" && input.config.orchestration.interactive?.usePaseoTools !== false ? "PARTICIPANT" : "CONTROLLER_ONLY", authorityRequired: "interactive Lead identity plus deterministic route, lineage, and controller gates", sideEffectClass: "CONTROLLER_INTERNAL", inputs: ["route-specific LeadOperationIntentV1", "durable operation reference"], outputs: ["operation digest, compact portfolio, or structured tool error v1"], failureClasses: ["INVALID_INPUT", "OPERATION_LINEAGE", "OWNER_BOUNDARY", "PERMISSION_DENIED", "CONTROLLER_STATE"], roles: input.config.orchestration?.provider === "paseo" && input.config.orchestration.interactive?.usePaseoTools !== false ? ["Lead/Director"] : [] },
    { id: "aeh:paseo-participant-lifecycle", kind: "HARNESS_INTERNAL", toolService: "Paseo session lifecycle", sourceOfTruth: "src/paseo/sdk.ts and src/paseo/runtimeCore.ts", availability: input.config.orchestration?.provider === "paseo" ? "CONFIGURED" : "DISABLED", availabilityReason: "Participant sessions are controlled by the Paseo adapter and controller lifecycle policy.", audience: "CONTROLLER_ONLY", authorityRequired: "controller participant lifecycle authority", sideEffectClass: "CONTROLLER_INTERNAL", inputs: ["frozen execution binding"], outputs: ["participant session state"], failureClasses: ["UNAVAILABLE", "TIMEOUT", "STALE_BINDING"], roles: [] }
  ];
  for (const entry of internal) add(entry);

  capabilities.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const body = { version: 1 as const, ...(input.operationId ? { operationId: input.operationId } : {}), capabilities };
  return { ...body, digest: sha256Canonical(body) };
}

/** Read project toolchain/provider locks without probing executables. Missing optional lock files stay unknown. */
export async function discoverCapabilityRegistryV1(root: string, input: Omit<CapabilityRegistryCompileInputV1, "toolchain" | "toolchainLock" | "providerVersions">): Promise<CapabilityRegistryV1> {
  const config = input.config;
  const toolchainConfigPath = config.toolchain?.configPath ?? ".harness/toolchain.yaml";
  const toolchain = await readOptionalFile(root, toolchainConfigPath, (text) => parseYaml(text) as ToolchainConfig);
  const lockPath = config.toolchain?.lockPath ?? toolchain?.manager.lockFile ?? ".harness/toolchain.lock.json";
  const toolchainLock = await readOptionalFile(root, lockPath, (text) => JSON.parse(text) as ToolchainLock);
  const providerVersions = await readOptionalFile(root, ".harness/provider-versions.json", (text) => JSON.parse(text) as Record<string, string>);
  return compileCapabilityRegistryV1({ ...input, ...(toolchain ? { toolchain } : {}), ...(toolchainLock ? { toolchainLock } : {}), ...(providerVersions ? { providerVersions } : {}) });
}

/** Persist the operation-start registry snapshot. A later discovery may not silently replace it. */
export async function persistOperationCapabilityRegistryV1(root: string, registry: CapabilityRegistryV1): Promise<CapabilityRegistryV1> {
  if (!registry.operationId) throw new Error("CAPABILITY_REGISTRY_OPERATION_REQUIRED: operation-scoped registries require a durable operation id.");
  const stateRoot = resolveOperationStateRoot(root);
  const directory = path.resolve(stateRoot, ".harness", "operations", safeOperationId(registry.operationId));
  const file = path.join(directory, "capability-registry-v1.json");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const current = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (current) {
    const parsed = JSON.parse(current) as CapabilityRegistryV1;
    assertCapabilityRegistryV1(parsed);
    if (parsed.digest !== registry.digest) return parsed;
    return parsed;
  }
  const content = `${JSON.stringify(registry, null, 2)}\n`;
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try { await fs.rename(temporary, file); }
  catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    const raced = JSON.parse(await fs.readFile(file, "utf8")) as CapabilityRegistryV1;
    assertCapabilityRegistryV1(raced);
    return raced;
  }
  return registry;
}

export async function loadOperationCapabilityRegistryV1(root: string, operationId: string): Promise<CapabilityRegistryV1 | undefined> {
  const file = path.resolve(resolveOperationStateRoot(root), ".harness", "operations", safeOperationId(operationId), "capability-registry-v1.json");
  const content = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (!content) return undefined;
  const value = JSON.parse(content) as CapabilityRegistryV1;
  assertCapabilityRegistryV1(value);
  if (value.operationId !== operationId) throw new Error("CAPABILITY_REGISTRY_IDENTITY_MISMATCH: operation artifact belongs to a different operation.");
  return value;
}

function indexSkills(skills: readonly OperationalSkillV1[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const skill of skills) for (const id of skill.applicableCapabilities) index.set(id, [...(index.get(id) ?? []), skill.id]);
  return index;
}
function configuredValidatorAdapters(specs: readonly ValidatorSpec[]): string[] { return [...new Set(specs.map((spec) => spec.adapter))].sort(); }
function isCanonicalRole(role: string): role is CanonicalRole { return participantRoles.includes(role as CanonicalRole); }

async function readOptionalFile<T>(root: string, relative: string, parse: (text: string) => T): Promise<T | undefined> {
  try { return parse(await fs.readFile(path.resolve(root, relative), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("CAPABILITY_REGISTRY_SOURCE_INVALID: could not read " + relative + ": " + String(error), { cause: error });
  }
}

export function capabilityRegistryDigest(registry: CapabilityRegistryV1): string {
  const { digest: _digest, ...body } = registry;
  return sha256Canonical(body);
}

export function assertCapabilityRegistryV1(value: unknown): asserts value is CapabilityRegistryV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CAPABILITY_REGISTRY_INVALID: expected an object.");
  const registry = value as CapabilityRegistryV1;
  if (registry.version !== 1 || !Array.isArray(registry.capabilities) || registry.capabilities.some((item) => !item.id || !item.sourceOfTruth || !item.authorityRequired || !Array.isArray(item.roles) || !Array.isArray(item.skillRefs))) throw new Error("CAPABILITY_REGISTRY_INVALID: version or capability entries are malformed.");
  if (new Set(registry.capabilities.map((item) => item.id)).size !== registry.capabilities.length) throw new Error("CAPABILITY_REGISTRY_INVALID: capability ids must be unique.");
  if (!/^[a-f0-9]{64}$/.test(registry.digest) || capabilityRegistryDigest(registry) !== registry.digest) throw new Error("CAPABILITY_REGISTRY_INVALID: digest is inconsistent.");
}

function safeOperationId(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error("INVALID_OPERATION_ID");
  return value;
}
