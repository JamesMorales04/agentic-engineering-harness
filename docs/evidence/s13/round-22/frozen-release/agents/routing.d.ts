import type { TaskContract } from "../core/types.js";
import type { AgentExecutionSelection, AgentRouteContext, ResolvedAgentTopology, ResolvedRoute } from "./types.js";
import type { AgentSelector } from "./types.js";
export declare function resolveRoute(topology: ResolvedAgentTopology, context: AgentRouteContext): ResolvedRoute;
export declare function executionSelectionForAgent(topology: ResolvedAgentTopology, agentName: string): AgentExecutionSelection;
export declare function selectionWithModelOverride(topology: ResolvedAgentTopology, selection: AgentExecutionSelection, modelRef: string): AgentExecutionSelection;
export declare function selectExecutionForTask(topology: ResolvedAgentTopology, contract: TaskContract): {
    route: ResolvedRoute;
    selection: AgentExecutionSelection;
};
export declare function selectFallbackExecution(topology: ResolvedAgentTopology, contract: TaskContract, currentAgent: string): AgentExecutionSelection | undefined;
export declare function selectAgentName(topology: ResolvedAgentTopology, selector: AgentSelector): string;
export declare function selectAgentNames(topology: ResolvedAgentTopology, selector: AgentSelector, limit?: number): string[];
