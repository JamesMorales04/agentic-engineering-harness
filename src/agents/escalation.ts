import type { HarnessProjectConfig, ReviewEscalationStage } from "../core/types.js";
import { executionSelectionForAgent } from "./routing.js";
import type { AgentExecutionSelection, ResolvedAgentTopology } from "./types.js";
import type { QualityState } from "./qualityConvergence.js";

export const DEFAULT_ESCALATION_STAGES: ReviewEscalationStage[] = [
  { name: "normal", action: "remediate" },
  { name: "quality", action: "remediate" },
  { name: "senior", action: "remediate", model: "@brain" },
  { name: "diagnosis", action: "diagnose", agent: "oracle", model: "@brain" },
  { name: "replan", action: "replan", agent: "planner", model: "@brain" }
];

export function escalationStages(config: HarnessProjectConfig): ReviewEscalationStage[] {
  const configured = config.workflow?.reviews?.escalation?.stages;
  return configured?.length ? configured : DEFAULT_ESCALATION_STAGES;
}

export function nextEscalationIndex(state: QualityState, current: number, config: HarnessProjectConfig): number {
  const stages = escalationStages(config);
  if (!stages.length) return 0;
  if (state.counts.critical > 0 && state.round === 0) return Math.min(config.workflow?.reviews?.escalation?.criticalStartStage ?? 2, stages.length - 1);
  if (state.convergence === "STAGNATING" || state.convergence === "REGRESSING" || state.convergence === "CYCLING") return Math.min(current + 1, stages.length - 1);
  if (state.convergence === "IMPROVING" && current > 0) return current - 1;
  return Math.min(current, stages.length - 1);
}

export function resumeAfterReplan(config: HarnessProjectConfig): number {
  const stages = escalationStages(config);
  return Math.min(config.workflow?.reviews?.escalation?.replanResumeStage ?? 2, Math.max(0, stages.length - 1));
}

export function selectionForStage(topology: ResolvedAgentTopology, fallback: AgentExecutionSelection, stage: ReviewEscalationStage): AgentExecutionSelection {
  let selection = fallback;
  if (stage.agent) {
    if (topology.agents[stage.agent] && !topology.agents[stage.agent].disabled) selection = executionSelectionForAgent(topology, stage.agent);
    else if (stage.action === "diagnose") {
      const diagnostic = Object.values(topology.agents).find((agent) => !agent.disabled && (agent.role === "escalation" || agent.role === "orchestrator"));
      if (diagnostic) selection = executionSelectionForAgent(topology, diagnostic.name);
    } else if (stage.action === "replan") {
      const planner = Object.values(topology.agents).find((agent) => !agent.disabled && agent.role === "planner");
      if (planner) selection = executionSelectionForAgent(topology, planner.name);
    }
  }
  return stage.model ? overrideSelectionModel(topology, selection, stage.model) : selection;
}

export function overrideSelectionModel(topology: ResolvedAgentTopology, selection: AgentExecutionSelection, modelRef: string): AgentExecutionSelection {
  if (!modelRef.startsWith("@")) throw new Error(`Escalation model override must use an alias such as @brain; received ${modelRef}.`);
  const alias = modelRef.slice(1);
  const model = topology.models[alias];
  if (!model) throw new Error(`Escalation references unknown model alias ${modelRef}.`);
  const runtime = topology.runtimes[model.runtime];
  if (!runtime) throw new Error(`Escalation model ${modelRef} references unavailable runtime ${model.runtime}.`);
  const agent = topology.agents[selection.logicalAgent];
  const runtimeChanged = selection.runtimeName !== model.runtime;
  return {
    ...selection,
    runtimeName: model.runtime,
    runtimeAdapter: runtime.adapter,
    paseoProvider: runtime.paseoProvider ?? runtime.adapter,
    modelAlias: alias,
    modelId: model.id,
    modelName: model.model,
    modelProvider: model.provider,
    variant: model.variant,
    nativeAgent: runtimeChanged ? undefined : selection.nativeAgent,
    args: [...(runtime.defaultArgs ?? []), ...(agent?.execution.args ?? [])],
    runtimeCapabilities: runtime.capabilities ?? {}
  };
}
