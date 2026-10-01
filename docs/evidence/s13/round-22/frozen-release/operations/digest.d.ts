import { type OperationRecordV2 } from "./state.js";
export type OperationLeadAttention = "none" | "blocked" | "terminal";
export interface OperationDigest {
    version: 1;
    operationId: string;
    kind: string;
    status: OperationRecordV2["status"];
    phase: string;
    revision: number;
    updatedAt: string;
    lastProgressAt: string;
    progress: {
        expected: number;
        running: number;
        completed: number;
        failed: number;
        blocked: number;
    };
    supervisor?: {
        generation: number;
        status: string;
    };
    lead: {
        acknowledgedRevision: number;
        currentRevisionAcknowledged: boolean;
    };
    attention: OperationLeadAttention;
    requiresLeadAction: boolean;
    result: {
        available: boolean;
        report?: string;
        keys: string[];
    };
    error?: string;
}
export declare function buildOperationDigest(operation: OperationRecordV2): OperationDigest;
export declare function operationDigestText(digest: OperationDigest): string;
