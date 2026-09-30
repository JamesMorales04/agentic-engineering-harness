import { type OperationDigest } from "./digest.js";
import { type OperationRecordV2 } from "./state.js";
export interface OperationMcpRequest {
    jsonrpc?: string;
    id?: string | number | null;
    method?: string;
    params?: Record<string, unknown>;
}
export type ContextAgentIdentitySource = "argument" | "environment" | "lead-state";
export interface ContextAgentIdentity {
    agentId: string;
    source: ContextAgentIdentitySource;
}
export type OperationStatusDetail = "compact" | "full";
export declare function serveOperationMcp(): Promise<void>;
export declare function handleOperationMcpRequest(request: OperationMcpRequest): Promise<Record<string, unknown>>;
export declare function readOperationDigest(root: string, operationId: string): Promise<OperationDigest>;
export declare function readOperationStatus(root: string, operationId: string, detail?: OperationStatusDetail): Promise<OperationDigest | OperationRecordV2>;
export declare function acknowledgeOperationRevision(root: string, operationId: string, revision: number, env?: NodeJS.ProcessEnv): Promise<{
    operationId: string;
    acknowledgedRevision: number;
    currentRevision: number;
    currentRevisionAcknowledged: boolean;
}>;
export declare function resolveContextAgentIdentity(root: string, explicitAgentId?: string, env?: NodeJS.ProcessEnv): Promise<ContextAgentIdentity>;
export declare function operationToolResult(value: unknown, text?: string): Record<string, unknown>;
