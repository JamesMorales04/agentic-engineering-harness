export interface PaseoSdkMcpStdioServer {
    type: "stdio";
    command: string;
    args?: string[];
    env?: Record<string, string>;
    alwaysLoad?: boolean;
    /** Metadata consumed by AEH-managed MCP proxies; native Paseo ignores it. */
    toolPolicy?: {
        allow?: string[];
        deny?: string[];
    };
}
export interface PaseoSdkToolPolicy {
    preapproved: Array<{
        kind: "mcp";
        server: string;
        tool: string;
    }>;
}
export interface PaseoSdkAgentOptions {
    /** Provider resource id requested for a frozen pre-prompt execution binding. */
    agentId?: string;
    cwd: string;
    workspaceId?: string;
    parentAgentId?: string;
    provider: string;
    model?: string;
    modeId?: string;
    thinkingOptionId?: string;
    env?: Record<string, string>;
    title: string;
    systemPrompt?: string;
    prompt?: string;
    outputSchema?: Record<string, unknown>;
    labels?: Record<string, string>;
    mcpServers?: Record<string, PaseoSdkMcpStdioServer>;
    toolPolicy?: PaseoSdkToolPolicy;
    /** Provider-native options validated by the selected provider (for example Codex sandbox policy). */
    providerOptions?: Record<string, unknown>;
    /** Paseo provider feature values (for example `{ auto_accept: true }` for OpenCode prompts). */
    featureValues?: Record<string, unknown>;
    timeoutMs?: number;
    waitForFinish?: boolean;
}
export interface PaseoSdkPermissionStop {
    name?: string;
    title?: string;
    description?: string;
    patterns?: string[];
}
export interface PaseoSdkAgentResult {
    id: string;
    workspaceId?: string;
    status?: string;
    lastMessage?: string;
    error?: string;
    /** Bounded identity of the provider approval prompt that stopped the turn (AEH-V2-0116). */
    permission?: PaseoSdkPermissionStop;
}
export interface PaseoSdkAgentRecord {
    id: string;
    title?: string;
    status?: string;
    workspaceId?: string;
    labels?: Record<string, string>;
    raw: Record<string, unknown>;
}
interface PaseoSdkTurnResult {
    status: string;
    lastMessage?: string;
    error?: string;
    final?: {
        pendingPermissions?: unknown;
    } | null;
}
interface PaseoSdkAgentHandle {
    readonly id: string;
    readonly workspaceId?: string | null;
    readonly status?: unknown;
    readonly pendingPermissions?: unknown;
    latest?(): Record<string, unknown> | null;
    refresh?(requestId?: string): Promise<{
        agent: Record<string, unknown>;
        project: unknown;
    } | null>;
    refetch?(requestId?: string): Promise<{
        agent: Record<string, unknown>;
        project: unknown;
    } | null>;
    send?(text: string, options?: Record<string, unknown>): Promise<void>;
    run?(text: string, options?: {
        timeoutMs?: number;
        outputSchema?: Record<string, unknown>;
    }): Promise<PaseoSdkTurnResult>;
    waitForFinish?(timeoutMs?: number): Promise<PaseoSdkTurnResult>;
    cancel?(): Promise<void>;
    stop?(): Promise<void>;
    kill?(): Promise<void>;
    abort?(): Promise<void>;
    archive?(): Promise<{
        archivedAt: string;
    }>;
    timeline?: {
        refetch(options?: Record<string, unknown>): Promise<unknown>;
    };
}
interface PaseoSdkClient {
    readonly agents: {
        create(options: Record<string, unknown>): Promise<PaseoSdkAgentHandle>;
        ref(agentId: string): PaseoSdkAgentHandle;
        list(options?: Record<string, unknown>): Promise<{
            entries: Array<{
                agent: Record<string, unknown>;
            }>;
        }>;
    };
    connect(): Promise<void>;
    close(): Promise<void>;
}
export declare class PaseoSdkUnavailableError extends Error {
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
export declare class PaseoSdkTimeoutError extends Error {
    constructor(message: string);
}
export declare function connectPaseoClient(client: {
    connect(): Promise<void>;
}, timeoutMs?: number): Promise<void>;
export declare function createPaseoSdkAgent(root: string, options: PaseoSdkAgentOptions): Promise<PaseoSdkAgentResult>;
export declare function materializePaseoSdkAgent(root: string, options: PaseoSdkAgentOptions): Promise<PaseoSdkAgentResult>;
export declare function materializePaseoSdkAgentWithClient(client: PaseoSdkClient, options: PaseoSdkAgentOptions): Promise<PaseoSdkAgentResult>;
export declare function createPaseoSdkAgentWithClient(client: PaseoSdkClient, options: PaseoSdkAgentOptions): Promise<PaseoSdkAgentResult>;
export declare function dispatchPaseoSdkAgent(root: string, agentId: string, prompt: string, timeoutMs?: number): Promise<PaseoSdkAgentResult>;
export declare function dispatchPaseoSdkAgentWithClient(client: PaseoSdkClient, agentId: string, prompt: string, timeoutMs?: number): Promise<PaseoSdkAgentResult>;
export declare function waitPaseoSdkAgent(root: string, agentId: string, timeoutMs?: number): Promise<PaseoSdkAgentResult>;
/** Execute one resumed turn on one concrete SDK handle. Prefer the SDK's atomic
 * run() primitive so dispatch and completion observation cannot be separated by
 * an idle->running->idle race. Older SDKs fall back to send()+waitForFinish()
 * on the same handle/client. Structured output constraints accompany the turn
 * when provided. When the session has an AEH structured-result capability, the
 * accepted durable result artifact is projected back into lastMessage so legacy
 * consumers remain compatible without making transcript text lifecycle authority. */
export declare function runPaseoSdkAgent(root: string, agentId: string, prompt: string, timeoutMs?: number, outputSchema?: Record<string, unknown>): Promise<PaseoSdkAgentResult>;
export declare function runPaseoSdkAgentWithClient(client: PaseoSdkClient, agentId: string, prompt: string, timeoutMs?: number, outputSchema?: Record<string, unknown>): Promise<PaseoSdkAgentResult>;
export declare function archivePaseoSdkAgent(root: string, agentId: string): Promise<void>;
export declare function inspectPaseoSdkAgent(root: string, agentId: string): Promise<PaseoSdkAgentRecord | undefined>;
export declare function inspectPaseoSdkAgentTimeline(root: string, agentId: string): Promise<unknown[] | undefined>;
export declare function probePaseoSdkAgent(root: string, agentId: string): Promise<boolean>;
export declare function listPaseoSdkAgents(root: string, labels?: Record<string, string>): Promise<PaseoSdkAgentRecord[]>;
export {};
