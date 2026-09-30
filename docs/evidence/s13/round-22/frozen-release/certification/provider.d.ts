import type { UsageMetrics } from "../core/types.js";
import type { AgentProviderRequest, AgentProviderResult } from "./types.js";
export interface ProcessExecutionOptions {
    cwd: string;
    env?: Record<string, string | undefined>;
    timeoutMs: number;
    maxOutputBytes: number;
    allowNetwork?: boolean;
}
/** Execute an external actor without a shell and with a deliberately filtered environment. */
export declare function executeArgv(command: string, args: readonly string[], options: ProcessExecutionOptions): Promise<{
    status: "COMPLETED" | "FAILED" | "TIMED_OUT" | "OUTPUT_LIMIT";
    exitCode: number;
    signal?: string;
    stdout: string;
    stderr: string;
    durationMs: number;
    outputTruncated: boolean;
}>;
export declare class LocalAgentProvider {
    readonly name: string;
    readonly networkIsolation: "unavailable";
    execute(request: AgentProviderRequest): Promise<AgentProviderResult>;
}
export declare function buildProviderEnvironment(request: Pick<AgentProviderRequest, "environment" | "environmentAllowlist" | "credentialEnvAllowlist">): Record<string, string>;
export declare function parseJsonl(text: string): unknown[];
export declare function usageForProviderResult(result: AgentProviderResult): UsageMetrics;
