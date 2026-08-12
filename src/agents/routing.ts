import { minimatch } from "minimatch";
import type { TaskContract } from "../core/types.js";
import type { AgentExecutionSelection, AgentRouteContext, ResolvedAgentTopology, ResolvedRoute, RoutingRule } from "./types.js";

export function resolveRoute(topology: ResolvedAgentTopology, context: AgentRouteContext): ResolvedRoute {
  const matched = topology.routing.filter((rule) => matchesRule(rule, context)).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const reviewers = new Set<string>();
  const validators = new Set<string>();
  const reasons: string[] = [];
  let agent: string | undefined;
  for (const rule of matched) {
    if (!agent && rule.use) agent = rule.use;
    for (const reviewer of rule.reviewers ?? []) reviewers.add(reviewer);
    for (const validator of rule.validators ?? []) validators.add(validator);
    reasons.push(`${rule.id}: matched ${describeCondition(rule, context)}`);
  }
  return { ruleIds: matched.map((rule) => rule.id), agent, reviewers: [...reviewers], validators: [...validators], reasons };
}

export function selectExecutionForTask(topology: ResolvedAgentTopology, contract: TaskContract): { route: ResolvedRoute; selection: AgentExecutionSelection } {
  const context: AgentRouteContext = { intent: contract.routing?.intent ?? "implement", domains: contract.routing?.domains ?? [], files: contract.scope?.allowed ?? [], risk: contract.routing?.risk };
  const route = resolveRoute(topology, context);
  const agentName = contract.routing?.agent ?? route.agent ?? Object.values(topology.agents).find((agent) => agent.role === "implementer" && !agent.disabled)?.name;
  if (!agentName) throw new Error(`No agent route matched task ${contract.task.id} and no enabled implementer exists.`);
  const agent = topology.agents[agentName];
  if (!agent || agent.disabled) throw new Error(`Task ${contract.task.id} selected unavailable agent ${agentName}.`);
  const reviewers = new Set([...(route.reviewers ?? []), ...(contract.routing?.reviewers ?? [])]);
  for (const reviewer of reviewers) if (!topology.agents[reviewer] || topology.agents[reviewer].disabled) throw new Error(`Task ${contract.task.id} requires unavailable reviewer ${reviewer}.`);
  const model = agent.model;
  const runtime = agent.runtime;
  return {
    route: { ...route, reviewers: [...reviewers] },
    selection: {
      profile: topology.profile,
      logicalAgent: agent.name,
      role: agent.role,
      domains: agent.domains ?? [],
      runtimeName: runtime.name,
      runtimeAdapter: runtime.adapter,
      paseoProvider: runtime.paseoProvider ?? runtime.adapter,
      modelAlias: model.alias,
      modelId: model.id,
      variant: agent.execution.variant ?? model.variant,
      nativeAgent: agent.execution.nativeAgent,
      temperature: agent.temperature ?? model.temperature,
      skills: agent.skills ?? [],
      mcps: agent.mcps ?? [],
      permissions: agent.permissions ?? {},
      outputContract: agent.outputContract,
      args: [...(runtime.defaultArgs ?? []), ...(agent.execution.args ?? [])]
    }
  };
}

function matchesRule(rule: RoutingRule, context: AgentRouteContext): boolean {
  const condition = rule.when;
  if (condition.intent) {
    const intents = Array.isArray(condition.intent) ? condition.intent : [condition.intent];
    if (!intents.includes(context.intent)) return false;
  }
  if (condition.risk) {
    const risks = Array.isArray(condition.risk) ? condition.risk : [condition.risk];
    if (!context.risk || !risks.includes(context.risk)) return false;
  }
  if (condition.domains?.length) {
    const domains = context.domains ?? [];
    if (!condition.domains.some((pattern) => domains.some((domain) => minimatch(domain, pattern) || minimatch(pattern, domain)))) return false;
  }
  if (condition.files?.length) {
    const files = context.files ?? [];
    if (!condition.files.some((pattern) => files.some((file) => minimatch(file, pattern, { dot: true })))) return false;
  }
  return true;
}
function describeCondition(rule: RoutingRule, context: AgentRouteContext): string { return `intent=${context.intent}, domains=${(context.domains ?? []).join(",") || "none"}, files=${(context.files ?? []).length}, risk=${context.risk ?? "unspecified"}`; }
