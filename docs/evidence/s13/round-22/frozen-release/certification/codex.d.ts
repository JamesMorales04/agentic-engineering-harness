import type { AgentProviderRequest, AgentProviderResult } from "./types.js";
import { LocalAgentProvider } from "./provider.js";
export interface CodexProviderOptions {
    command?: string;
    model?: string;
    reasoningEffort?: "low" | "medium" | "high" | "xhigh";
    extraArgs?: string[];
}
export interface CodexCapabilities {
    version?: string;
    supportsReasoningFlag: boolean;
    supportsConfigOverride: boolean;
    supportsJson: boolean;
    supportsEphemeral: boolean;
    supportsSkipGitRepoCheck: boolean;
    source: string;
}
/** Bootstrap adapter only. CertificationCore knows nothing about this provider. */
export declare class CodexAgentProvider extends LocalAgentProvider {
    readonly name = "codex";
    private readonly options;
    constructor(options?: CodexProviderOptions);
    execute(request: AgentProviderRequest): Promise<AgentProviderResult>;
}
export declare function codexCommandPreview(options: CodexProviderOptions | undefined, request: Pick<AgentProviderRequest, "args" | "prompt">): string[];
export declare function resolveCodexCapabilities(command?: string, cwd?: string): Promise<CodexCapabilities>;
