import type { AgentExecutionSelection } from "../agents/types.js";
import type { HarnessProjectConfig, TaskRisk } from "../core/types.js";
export interface SandboxDecision {
    required: boolean;
    provider: string;
    reasons: string[];
    selection: AgentExecutionSelection;
}
export declare function sandboxPolicyDigest(config: HarnessProjectConfig, selection: AgentExecutionSelection, risk?: TaskRisk): string;
export declare function enforceSandboxPolicy(selection: AgentExecutionSelection, config: HarnessProjectConfig, risk?: TaskRisk): SandboxDecision;
export declare function hardenedPodmanArgs(config: HarnessProjectConfig, selection: AgentExecutionSelection, writable: boolean, options?: {
    persistentIsolatedHome?: boolean;
}): string[];
export declare function sandboxImage(config: HarnessProjectConfig): string;
export declare function allowedSandboxEnvironment(config: HarnessProjectConfig, source?: NodeJS.ProcessEnv): Record<string, string>;
