import { dispatchManagedPaseoAgent } from "../paseo/runtime.js";
import { recordPaseoTrace } from "../paseo/trace.js";
import { type OperationRecord } from "./state.js";
export type OperationCompletionStatus = "PENDING" | "SENT" | "FAILED" | "DISABLED";
export interface OperationCompletionTarget {
    version: 1;
    operationId: string;
    agentId: string;
    source?: string;
    status: OperationCompletionStatus;
    registeredAt: string;
    attemptedAt?: string;
    attempts?: number;
    sentAt?: string;
    failedAt?: string;
    error?: string;
}
export interface OperationCompletionDeps {
    dispatch?: typeof dispatchManagedPaseoAgent;
    trace?: typeof recordPaseoTrace;
    retryDelaysMs?: number[];
    sleep?: (ms: number) => Promise<void>;
}
export declare function operationCompletionFile(root: string, operationId: string): string;
export declare function registerOperationCompletionTarget(root: string, operationId: string, agentId: string, source?: string, trace?: typeof recordPaseoTrace): Promise<OperationCompletionTarget>;
export declare function disableOperationCompletionTarget(root: string, operationId: string, reason: string, trace?: typeof recordPaseoTrace): Promise<void>;
export declare function loadOperationCompletionTarget(root: string, operationId: string): Promise<OperationCompletionTarget | undefined>;
export declare function notifyOperationCompletion(root: string, operation: OperationRecord, deps?: OperationCompletionDeps): Promise<OperationCompletionTarget | undefined>;
export declare function completionPrompt(operation: OperationRecord): string;
