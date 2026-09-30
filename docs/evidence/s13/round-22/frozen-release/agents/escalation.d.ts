import type { HarnessProjectConfig, ReviewEscalationStage } from "../core/types.js";
import type { AgentExecutionSelection } from "./types.js";
import type { QualityState } from "./qualityConvergence.js";
export declare const DEFAULT_ESCALATION_STAGES: ReviewEscalationStage[];
export declare function escalationStages(config: HarnessProjectConfig): ReviewEscalationStage[];
export declare function nextEscalationIndex(state: QualityState, current: number, config: HarnessProjectConfig): number;
export declare function resumeAfterReplan(config: HarnessProjectConfig): number;
/** Apply already-resolved outer-boundary selections without reopening topology. */
export declare function selectionForStage(fallback: AgentExecutionSelection, stage: ReviewEscalationStage, roleSelection?: AgentExecutionSelection, modelSelection?: AgentExecutionSelection): AgentExecutionSelection;
