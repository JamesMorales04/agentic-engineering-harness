import { type PaseoSdkPermissionStop } from "./sdk.js";
export interface PaseoNativeUsage {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    totalCostUsd?: number;
    contextWindowMaxTokens?: number;
    contextWindowUsedTokens?: number;
}
export interface PaseoNativeAgentSnapshot {
    id: string;
    status?: string;
    workspaceId?: string;
    labels?: Record<string, string>;
    lastUsage?: PaseoNativeUsage;
    raw: Record<string, unknown>;
}
export interface PaseoContextUsageSnapshot {
    used?: number;
    limit?: number;
    ratio?: number;
    source: "paseo-agent-snapshot";
    availability: "available" | "no-usage-yet" | "provider-usage-unavailable";
}
export interface PaseoProviderPreflightResult {
    ok: boolean;
    provider: string;
    model?: string;
    providerStatus?: string;
    availableModels?: string[];
    source: "paseo-provider-snapshot" | "paseo-provider-models" | "paseo-provider-diagnostic" | "paseo-provider-unchecked";
    message: string;
}
export interface PaseoNativeWaitResult {
    id: string;
    workspaceId?: string;
    status?: string;
    lastMessage?: string;
    error?: string;
    permission?: PaseoSdkPermissionStop;
    source: "paseo-agent-subscription";
    updatesObserved: number;
}
export interface PaseoTurnBaseline {
    lastAssistantMessage?: string;
    lastUserMessageAt?: string;
}
export interface NativeAgentHandle {
    readonly id: string;
    latest?(): Record<string, unknown> | null;
    refetch?(requestId?: string): Promise<{
        agent: Record<string, unknown>;
        project?: unknown;
    } | null>;
    refresh?(requestId?: string): Promise<{
        agent: Record<string, unknown>;
        project?: unknown;
    } | null>;
    subscribe?(handler: (update: unknown) => void): () => void;
    timeline?: {
        refetch(options?: Record<string, unknown>): Promise<unknown>;
    };
}
export declare function inspectPaseoNativeAgent(root: string, agentId: string): Promise<PaseoNativeAgentSnapshot | undefined>;
export declare function normalizePaseoNativeAgent(raw: Record<string, unknown>): PaseoNativeAgentSnapshot;
export declare function contextUsageFromPaseoSnapshot(snapshot: PaseoNativeAgentSnapshot): PaseoContextUsageSnapshot;
export declare function capturePaseoAgentTurnBaseline(root: string, agentId: string): Promise<PaseoTurnBaseline>;
export declare function preflightPaseoProviderModel(root: string, providerValue: string, modelValue?: string, cwd?: string): Promise<PaseoProviderPreflightResult>;
export declare function waitForPaseoAgentNative(root: string, agentId: string, timeoutMs?: number, baseline?: PaseoTurnBaseline): Promise<PaseoNativeWaitResult>;
export declare function waitForPaseoAgentHandle(handle: NativeAgentHandle, timeoutMs?: number, baseline?: PaseoTurnBaseline, pollIntervalMs?: number): Promise<PaseoNativeWaitResult>;
