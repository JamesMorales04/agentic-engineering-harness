import type { AgentExecutionSelection } from "../agents/types.js";
import type { TaskContract } from "../core/types.js";
export interface AgentPromptPolicyOptions {
    outputContract?: string;
    phase?: string;
    operationKind?: string;
    transport: string;
}
export interface AgentPromptPolicy {
    skills: string[];
    outputContractContext?: string;
}
export declare function compileAgentPromptPolicy(selection: AgentExecutionSelection, contract: TaskContract, options: AgentPromptPolicyOptions): AgentPromptPolicy;
export declare function hasTraceableAcceptance(contract: TaskContract): boolean;
export declare function nativeSchemaEnforced(selection: AgentExecutionSelection, transport: string): boolean;
export declare function outputContractContext(contractName: string, nativeSchema: boolean, repair?: boolean): string;
