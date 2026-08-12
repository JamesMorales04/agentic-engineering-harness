import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { minimatch } from "minimatch";
import { z } from "zod";
import type { HarnessProjectConfig } from "../core/types.js";
import { parseJsonc } from "./jsonc.js";
import type { AgentDefinition, AgentOverride, AgentProfile, AgentTopologyLayer, AgentTopologyRemove, AgentTopologySource, CouncilDefinition, ModelDefinition, ModelOverride, ResolvedAgentDefinition, ResolvedAgentTopology, ResolvedModelDefinition, RoutingRule, RuntimeDefinition, RuntimeOverride } from "./types.js";

const permissionSchema = z.enum(["allow", "ask", "deny"]);
const runtimeCapabilitiesSchema = z.object({ nativeAgent: z.boolean().optional(), nativeAgentViaPaseo: z.boolean().optional(), modelSelection: z.boolean().optional(), variantSelection: z.boolean().optional(), sessions: z.boolean().optional(), structuredOutput: z.boolean().optional() });
const runtimeSchema = z.object({ adapter: z.string().min(1), paseoProvider: z.string().optional(), command: z.string().optional(), defaultArgs: z.array(z.string()).optional(), capabilities: runtimeCapabilitiesSchema.optional() });
const runtimeOverrideSchema = runtimeSchema.partial();
const modelSchema = z.object({ runtime: z.string().min(1), provider: z.string().optional(), model: z.string().min(1), variant: z.string().optional(), temperature: z.number().optional(), options: z.record(z.string(), z.unknown()).optional() });
const modelOverrideSchema = modelSchema.partial();
const executionSchema = z.object({ model: z.string().min(1), runtime: z.string().optional(), nativeAgent: z.string().optional(), variant: z.string().optional(), args: z.array(z.string()).optional(), transport: z.enum(["inherit", "paseo", "direct", "podman"]).optional() });
const permissionsSchema = z.object({ read: permissionSchema.optional(), write: permissionSchema.optional(), shell: permissionSchema.optional(), network: permissionSchema.optional(), delegate: permissionSchema.optional(), review: permissionSchema.optional(), validate: permissionSchema.optional(), gitWrite: permissionSchema.optional() }).optional();
const agentSchema = z.object({ role: z.string().min(1), domains: z.array(z.string()).optional(), description: z.string().optional(), execution: executionSchema, temperature: z.number().optional(), skills: z.array(z.string()).optional(), mcps: z.array(z.string()).optional(), promptPath: z.string().optional(), orchestratorPromptPath: z.string().optional(), outputContract: z.string().optional(), permissions: permissionsSchema, capabilities: z.array(z.string()).optional(), disabled: z.boolean().optional() });
const agentOverrideSchema = agentSchema.partial().extend({ execution: executionSchema.partial().optional() });
const profileSchema = z.object({ description: z.string().optional(), models: z.record(z.string(), modelOverrideSchema).optional(), agents: z.record(z.string(), agentOverrideSchema).optional() });
const routingSchema = z.object({ id: z.string().min(1), priority: z.number().optional(), when: z.object({ intent: z.union([z.string(), z.array(z.string())]).optional(), domains: z.array(z.string()).optional(), files: z.array(z.string()).optional(), risk: z.union([z.enum(["low", "medium", "high"]), z.array(z.enum(["low", "medium", "high"]))]).optional() }), use: z.string().optional(), reviewers: z.array(z.string()).optional(), validators: z.array(z.string()).optional() });
const recoveryStepSchema = z.object({ action: z.enum(["same-agent", "reroute", "agent", "lead", "stop"]), agent: z.string().optional() });
const councilSchema = z.object({ members: z.array(z.object({ model: z.string(), agent: z.string().optional() })), executionMode: z.enum(["parallel", "sequential"]).optional() });
const removeSchema = z.object({ runtimes: z.array(z.string()).optional(), models: z.array(z.string()).optional(), agents: z.array(z.string()).optional(), profiles: z.array(z.string()).optional(), routing: z.array(z.string()).optional(), councils: z.array(z.string()).optional() });
const layerSchema = z.object({ version: z.literal(1), extends: z.array(z.string().min(1)).optional(), activeProfile: z.string().optional(), skillRoots: z.array(z.string()).optional(), runtimes: z.record(z.string(), runtimeOverrideSchema).optional(), models: z.record(z.string(), modelOverrideSchema).optional(), agents: z.record(z.string(), agentOverrideSchema).optional(), profiles: z.record(z.string(), profileSchema).optional(), routing: z.array(routingSchema).optional(), recovery: z.record(z.string(), z.array(recoveryStepSchema)).optional(), councils: z.record(z.string(), councilSchema).optional(), remove: removeSchema.optional() });
const sourceSchema = z.object({ version: z.literal(1), activeProfile: z.string().optional(), skillRoots: z.array(z.string()).optional(), runtimes: z.record(z.string(), runtimeSchema), models: z.record(z.string(), modelSchema), agents: z.record(z.string(), agentSchema), profiles: z.record(z.string(), profileSchema).optional(), routing: z.array(routingSchema).optional(), recovery: z.record(z.string(), z.array(recoveryStepSchema)).optional(), councils: z.record(z.string(), councilSchema).optional() });

function packageRoot(): string { return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."); }

export async function loadAgentTopologySource(root: string, config: HarnessProjectConfig): Promise<AgentTopologySource> {
  const file = path.resolve(root, config.agents?.configPath ?? ".harness/agents.source.jsonc");
  const composed = await loadComposedLayer(file, new Set<string>());
  return sourceSchema.parse(composed) as AgentTopologySource;
}

async function loadComposedLayer(file: string, stack: Set<string>): Promise<AgentTopologyLayer> {
  const absolute = path.resolve(file);
  if (stack.has(absolute)) throw new Error(`Circular agent topology extension detected at ${absolute}.`);
  const nextStack = new Set(stack); nextStack.add(absolute);
  const layer = layerSchema.parse(parseJsonc(await fs.readFile(absolute, "utf8"))) as AgentTopologyLayer;
  let composed: AgentTopologyLayer = { version: 1 };
  for (const extension of layer.extends ?? []) composed = composeAgentTopologyLayers(composed, await loadComposedLayer(resolveExtension(extension, path.dirname(absolute)), nextStack));
  return composeAgentTopologyLayers(composed, { ...layer, extends: undefined });
}

function resolveExtension(extension: string, fromDirectory: string): string {
  if (extension === "aeh:default") return path.join(packageRoot(), "presets", "agents", "default.jsonc");
  if (extension.startsWith("aeh:")) throw new Error(`Unknown built-in agent topology preset ${extension}.`);
  return path.isAbsolute(extension) ? extension : path.resolve(fromDirectory, extension);
}

export function composeAgentTopologyLayers(base: AgentTopologyLayer, overlay: AgentTopologyLayer): AgentTopologyLayer {
  const merged: AgentTopologyLayer = {
    version: 1,
    activeProfile: overlay.activeProfile ?? base.activeProfile,
    skillRoots: union(base.skillRoots ?? [], overlay.skillRoots ?? []),
    runtimes: mergeRecord(base.runtimes, overlay.runtimes, mergeRuntime),
    models: mergeRecord(base.models, overlay.models, mergeModel),
    agents: mergeRecord(base.agents, overlay.agents, mergeAgentLayer),
    profiles: mergeRecord(base.profiles, overlay.profiles, mergeProfile),
    routing: mergeRouting(base.routing ?? [], overlay.routing ?? []),
    recovery: { ...(base.recovery ?? {}), ...(overlay.recovery ?? {}) },
    councils: { ...(base.councils ?? {}), ...(overlay.councils ?? {}) }
  };
  return applyRemovals(merged, overlay.remove);
}

function mergeRuntime(base: RuntimeOverride | undefined, overlay: RuntimeOverride): RuntimeOverride { return { ...(base ?? {}), ...overlay, capabilities: { ...(base?.capabilities ?? {}), ...(overlay.capabilities ?? {}) } }; }
function mergeModel(base: ModelOverride | undefined, overlay: ModelOverride): ModelOverride { return { ...(base ?? {}), ...overlay, options: { ...(base?.options ?? {}), ...(overlay.options ?? {}) } }; }
function mergeAgentLayer(base: AgentOverride | undefined, overlay: AgentOverride): AgentOverride { return { ...(base ?? {}), ...overlay, execution: { ...(base?.execution ?? {}), ...(overlay.execution ?? {}) }, permissions: { ...(base?.permissions ?? {}), ...(overlay.permissions ?? {}) } }; }
function mergeProfile(base: AgentProfile | undefined, overlay: AgentProfile): AgentProfile { return { ...(base ?? {}), ...overlay, models: mergeRecord(base?.models, overlay.models, mergeModel), agents: mergeRecord(base?.agents, overlay.agents, mergeAgentLayer) }; }
function mergeRecord<T>(base: Record<string, T> | undefined, overlay: Record<string, T> | undefined, merger: (base: T | undefined, overlay: T) => T): Record<string, T> | undefined { if (!base && !overlay) return undefined; const result: Record<string, T> = { ...(base ?? {}) }; for (const [name, value] of Object.entries(overlay ?? {})) result[name] = merger(result[name], value); return result; }
function mergeRouting(base: RoutingRule[], overlay: RoutingRule[]): RoutingRule[] { const result = [...base]; for (const rule of overlay) { const index = result.findIndex((item) => item.id === rule.id); if (index >= 0) result[index] = rule; else result.push(rule); } return result; }
function union(base: string[], overlay: string[]): string[] { return [...new Set([...base, ...overlay])]; }

function applyRemovals(layer: AgentTopologyLayer, remove?: AgentTopologyRemove): AgentTopologyLayer {
  if (!remove) return layer;
  const result = structuredClone(layer) as AgentTopologyLayer;
  const removedAgents = deleteMatches(result.agents, remove.agents);
  deleteMatches(result.runtimes, remove.runtimes);
  deleteMatches(result.models, remove.models);
  deleteMatches(result.profiles, remove.profiles);
  deleteMatches(result.councils, remove.councils);
  result.routing = (result.routing ?? []).filter((rule) => !matchesAny(rule.id, remove.routing ?? [])).map((rule) => ({ ...rule, use: rule.use && removedAgents.has(rule.use) ? undefined : rule.use, reviewers: (rule.reviewers ?? []).filter((name) => !removedAgents.has(name)), validators: (rule.validators ?? []).filter((name) => !removedAgents.has(name)) })).filter((rule) => Boolean(rule.use || rule.reviewers?.length || rule.validators?.length));
  for (const [failure, steps] of Object.entries(result.recovery ?? {})) result.recovery![failure as keyof typeof result.recovery] = (steps ?? []).filter((step) => !(step.action === "agent" && step.agent && removedAgents.has(step.agent)));
  for (const council of Object.values(result.councils ?? {})) council.members = council.members.filter((member) => !member.agent || !removedAgents.has(member.agent));
  return result;
}

function deleteMatches<T>(record: Record<string, T> | undefined, patterns: string[] | undefined): Set<string> { const removed = new Set<string>(); if (!record || !patterns?.length) return removed; for (const name of Object.keys(record)) if (matchesAny(name, patterns)) { delete record[name]; removed.add(name); } return removed; }
function matchesAny(value: string, patterns: string[]): boolean { return patterns.some((pattern) => minimatch(value, pattern, { dot: true })); }

export async function loadResolvedAgentTopology(root: string, config: HarnessProjectConfig, profileOverride?: string): Promise<ResolvedAgentTopology> { return resolveAgentTopology(await loadAgentTopologySource(root, config), profileOverride ?? config.agents?.activeProfile); }
export function resolveAgentTopology(source: AgentTopologySource, profileOverride?: string): ResolvedAgentTopology {
  const profileName = profileOverride ?? source.activeProfile; const profile = profileName ? source.profiles?.[profileName] : undefined; if (profileName && !profile) throw new Error(`Unknown agent profile: ${profileName}`);
  const models = structuredClone(source.models) as Record<string, ModelDefinition>; for (const [alias, override] of Object.entries(profile?.models ?? {})) { if (!models[alias]) throw new Error(`Profile ${profileName} overrides unknown model alias @${alias}`); models[alias] = { ...models[alias], ...override, options: { ...(models[alias].options ?? {}), ...(override.options ?? {}) } } as ModelDefinition; }
  const agents = structuredClone(source.agents) as Record<string, AgentDefinition>; const overrides = Object.entries(profile?.agents ?? {}).sort(([a], [b]) => wildcardCount(b) - wildcardCount(a)); for (const [pattern, override] of overrides) { const matched = Object.keys(agents).filter((name) => minimatch(name, pattern)); if (!matched.length && !/[?*\[]/.test(pattern)) throw new Error(`Profile ${profileName} overrides unknown agent ${pattern}`); for (const name of matched) agents[name] = mergeAgent(agents[name], override); }
  const resolvedModels: Record<string, ResolvedModelDefinition> = {}; for (const [alias, model] of Object.entries(models)) { if (!source.runtimes[model.runtime]) throw new Error(`Model @${alias} references unknown runtime ${model.runtime}`); const id = model.provider && !model.model.includes("/") ? `${model.provider}/${model.model}` : model.model; resolvedModels[alias] = { ...model, alias, id }; }
  const resolvedAgents: Record<string, ResolvedAgentDefinition> = {}; for (const [name, agent] of Object.entries(agents)) { const modelRef = agent.execution.model; let model: ResolvedModelDefinition; if (modelRef.startsWith("@")) { const alias = modelRef.slice(1); model = resolvedModels[alias]; if (!model) throw new Error(`Agent ${name} references unknown model alias ${modelRef}`); } else { const runtimeName = agent.execution.runtime; if (!runtimeName) throw new Error(`Agent ${name} uses direct model ${modelRef} and must set execution.runtime`); const provider = modelRef.includes("/") ? modelRef.split("/")[0] : undefined; model = { alias: modelRef, id: modelRef, runtime: runtimeName, provider, model: modelRef }; }
    const runtimeName = agent.execution.runtime ?? model.runtime; if (runtimeName !== model.runtime && modelRef.startsWith("@")) throw new Error(`Agent ${name} runtime ${runtimeName} conflicts with ${modelRef} runtime ${model.runtime}`); const runtime = source.runtimes[runtimeName]; if (!runtime) throw new Error(`Agent ${name} references unknown runtime ${runtimeName}`); if (agent.execution.nativeAgent && runtime.capabilities?.nativeAgent === false) throw new Error(`Runtime ${runtimeName} does not support nativeAgent but ${name} configures ${agent.execution.nativeAgent}`); resolvedAgents[name] = { ...agent, name, execution: { ...agent.execution, runtime: runtimeName, variant: agent.execution.variant ?? model.variant, transport: agent.execution.transport ?? "inherit" }, runtime: { ...runtime, name: runtimeName }, model }; }
  return { version: 1, profile: profileName, skillRoots: source.skillRoots ?? [".harness/skills"], runtimes: source.runtimes, models: resolvedModels, agents: resolvedAgents, routing: source.routing ?? [], recovery: source.recovery ?? {}, councils: source.councils ?? {} };
}
function mergeAgent(base: AgentDefinition, override: AgentOverride): AgentDefinition { return { ...base, ...override, execution: { ...base.execution, ...(override.execution ?? {}) }, permissions: { ...(base.permissions ?? {}), ...(override.permissions ?? {}) } } as AgentDefinition; }
function wildcardCount(value: string): number { return [...value].filter((char) => char === "*" || char === "?").length; }
