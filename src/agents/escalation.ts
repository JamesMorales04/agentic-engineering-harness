import type { HarnessProjectConfig, ReviewEscalationStage } from "../core/types.js";
import type { AgentExecutionSelection } from "./types.js";
import type { QualityState } from "./qualityConvergence.js";

export const DEFAULT_ESCALATION_STAGES: ReviewEscalationStage[] = [
  { name: "normal", action: "remediate" },
  { name: "quality", action: "remediate", role: "Implementer" },
  { name: "senior", action: "remediate", role: "Implementer", model: "@brain" },
  { name: "diagnosis", action: "diagnose", role: "Reviewer", model: "@brain" },
  { name: "replan", action: "replan", role: "Planner", model: "@brain" }
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
  const desired = Math.min(config.workflow?.reviews?.escalation?.replanResumeStage ?? 2, Math.max(0, stages.length - 1));
  return Math.max(0, desired - 1);
}

/** Apply already-resolved outer-boundary selections without reopening topology. */
export function selectionForStage(fallback: AgentExecutionSelection, stage: ReviewEscalationStage, roleSelection?: AgentExecutionSelection, modelSelection?: AgentExecutionSelection): AgentExecutionSelection {
  return modelSelection ?? roleSelection ?? fallback;
}
