import { minimatch } from "minimatch";
import type { TaskContract } from "../core/types.js";
import type { ImplementationRoute } from "../architecture/contracts.js";
import type { AgentExecutionSelection, AgentRouteContext, ResolvedAgentTopology, ResolvedRoute, RoutingRule } from "./types.js";
import type { AgentSelector } from "./types.js";
export function resolveRoute(topology: ResolvedAgentTopology, context: AgentRouteContext): ResolvedRoute { const matched = topology.routing.filter((rule) => matchesRule(rule, context)).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)); const review: AgentSelector[] = []; const reasons: string[] = []; let implementation: AgentSelector | undefined; for (const rule of matched) { if (!implementation && rule.select) implementation = rule.select; review.push(...(rule.review ?? [])); reasons.push(`${rule.id}: intent=${context.intent}, domains=${(context.domains ?? []).join(",") || "none"}, files=${(context.files ?? []).length}, risk=${context.risk ?? "unspecified"}`); } return { ruleIds: matched.map((rule) => rule.id), implementation, review, reviewers: [], reasons }; }
export function executionSelectionForAgent(topology: ResolvedAgentTopology, agentName: string): AgentExecutionSelection { const agent = topology.agents[agentName]; if (!agent || agent.disabled) throw new Error(`Agent ${agentName} is unavailable.`); const model = agent.model; const runtime = agent.runtime; return { profile: topology.profile, logicalAgent: agent.name, role: agent.role, domains: agent.domains ?? [], specializations: agent.specializations ?? [], description: agent.description, contextRequirements: agent.contextRequirements, runtimeName: runtime.name, runtimeAdapter: runtime.adapter, paseoProvider: runtime.paseoProvider ?? runtime.adapter, modelAlias: model.alias, modelId: model.id, modelName: model.model, modelProvider: model.provider, variant: agent.execution.variant ?? model.variant, nativeAgent: agent.execution.nativeAgent, transport: agent.execution.transport ?? "inherit", temperature: agent.temperature ?? model.temperature, skills: [...new Set(agent.skills ?? [])], mcps: agent.mcps ?? [], permissions: agent.permissions ?? {}, outputContract: agent.outputContract, args: [...(runtime.defaultArgs ?? []), ...(agent.execution.args ?? [])], runtimeCapabilities: runtime.capabilities ?? {} }; }
export function selectionWithModelOverride(topology: ResolvedAgentTopology, selection: AgentExecutionSelection, modelRef: string): AgentExecutionSelection {
  if (!modelRef.startsWith("@")) throw new Error(`Escalation model override must use an alias such as @brain; received ${modelRef}.`);
  const alias = modelRef.slice(1);
  const model = topology.models[alias];
  if (!model) throw new Error(`Escalation references unknown model alias ${modelRef}.`);
  const runtime = topology.runtimes[model.runtime];
  if (!runtime) throw new Error(`Escalation model ${modelRef} references unavailable runtime ${model.runtime}.`);
  const agent = topology.agents[selection.logicalAgent];
  const runtimeChanged = selection.runtimeName !== model.runtime;
  return { ...selection, runtimeName: model.runtime, runtimeAdapter: runtime.adapter, paseoProvider: runtime.paseoProvider ?? runtime.adapter, modelAlias: alias, modelId: model.id, modelName: model.model, modelProvider: model.provider, variant: model.variant, nativeAgent: runtimeChanged ? undefined : selection.nativeAgent, args: [...(runtime.defaultArgs ?? []), ...(agent?.execution.args ?? [])], runtimeCapabilities: runtime.capabilities ?? {} };
}
export function selectExecutionForTask(topology: ResolvedAgentTopology, contract: TaskContract): { route: ResolvedRoute; selection: AgentExecutionSelection } {
  const context: AgentRouteContext = { intent: contract.routing?.intent ?? "implement", domains: contract.routing?.domains ?? [], files: contract.scope?.allowed ?? [], risk: contract.routing?.risk };
  const resolved = resolveRoute(topology, context);
  const implementationRoute = contract.routing?.route;
  const assurance = contract.routing?.assurance;
  assertCanonicalExecutionRoute(contract, implementationRoute);
  const implementation = resolved.implementation ?? { role: "Implementer" as const, domains: contract.routing?.domains ?? [] };
  const agentName = selectAgentName(topology, implementation);
  if (!agentName) throw new Error(`No agent route matched task ${contract.task.id} and no enabled implementer exists.`);
  const reviewers = new Set(resolved.review.flatMap((selector) => selectAgentNames(topology, selector)));
  if (assurance === "CRITICAL" && !hasDeterministicAssurance(contract) && reviewers.size === 0) {
    throw new Error(`CRITICAL_ASSURANCE_GATE_REJECTED: task ${contract.task.id} must declare a reviewer, validator, or deterministic verification evidence.`);
  }
  return { route: { ...resolved, reviewers: [...reviewers], implementationRoute, assurance }, selection: executionSelectionForAgent(topology, agentName) };
}

function assertCanonicalExecutionRoute(contract: TaskContract, route?: ImplementationRoute): void {
  if (route === "NO_AGENT") throw new Error(`NO_AGENT_ROUTE: task ${contract.task.id} cannot be assigned an implementation agent.`);
}

function hasDeterministicAssurance(contract: TaskContract): boolean {
  return Boolean(
    contract.verification?.commands?.length ||
    contract.verification?.validators?.length ||
    contract.verification?.capabilities?.length ||
    contract.requirements?.some((requirement) => Boolean(requirement.validator || requirement.validators?.length))
  );
}
export function selectFallbackExecution(topology: ResolvedAgentTopology, contract: TaskContract, currentAgent: string): AgentExecutionSelection | undefined { const desiredDomains = contract.routing?.domains ?? []; const candidates = Object.values(topology.agents).filter((agent) => agent.role === "Implementer" && !agent.disabled && agent.name !== currentAgent); const ranked = candidates.sort((a, b) => domainScore(b.domains ?? [], desiredDomains) - domainScore(a.domains ?? [], desiredDomains)); return ranked[0] ? executionSelectionForAgent(topology, ranked[0].name) : undefined; }
export function selectAgentName(topology: ResolvedAgentTopology, selector: AgentSelector): string { const name = selectAgentNames(topology, selector, 1)[0]; if (!name) throw new Error(`No enabled ${selector.role} participant matches the requested domains or specializations.`); return name; }
export function selectAgentNames(topology: ResolvedAgentTopology, selector: AgentSelector, limit = Number.MAX_SAFE_INTEGER): string[] { return Object.values(topology.agents).filter((agent) => !agent.disabled && agent.role === selector.role && matchesValues(agent.domains ?? [], selector.domains ?? []) && matchesValues(agent.specializations ?? [], selector.specializations ?? [])).sort((a, b) => domainScore(b.domains ?? [], selector.domains ?? []) - domainScore(a.domains ?? [], selector.domains ?? []) || a.name.localeCompare(b.name)).slice(0, limit).map((agent) => agent.name); }
function domainScore(agentDomains: string[], desired: string[]): number { if (!desired.length) return agentDomains.includes("*") ? 1 : 0; return desired.reduce((score, domain) => score + (agentDomains.some((pattern) => pattern === "*" || minimatch(domain, pattern) || minimatch(pattern, domain)) ? 1 : 0), 0); }
function matchesRule(rule: RoutingRule, context: AgentRouteContext): boolean { const condition = rule.when; if (condition.intent) { const intents = Array.isArray(condition.intent) ? condition.intent : [condition.intent]; if (!intents.includes(context.intent)) return false; } if (condition.risk) { const risks = Array.isArray(condition.risk) ? condition.risk : [condition.risk]; if (!context.risk || !risks.includes(context.risk)) return false; } if (condition.domains?.length) { const domains = context.domains ?? []; if (!condition.domains.some((pattern) => domains.some((domain) => minimatch(domain, pattern) || minimatch(pattern, domain)))) return false; } if (condition.files?.length) { const files = context.files ?? []; if (!condition.files.some((pattern) => files.some((file) => minimatch(file, pattern, { dot: true })))) return false; } return true; }
function matchesValues(available: string[], requested: string[]): boolean { if (!requested.length) return true; return requested.some((pattern) => available.some((value) => pattern === "*" || value === "*" || minimatch(value, pattern) || minimatch(pattern, value))); }
