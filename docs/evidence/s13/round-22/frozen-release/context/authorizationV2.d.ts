import { type ExecutionBindingV2 } from "../architecture/executionIdentity.js";
import { type ExecutionAuthorityV1 } from "../security/executionLease.js";
import { type ContextContinuationInputV1, type ContextContinuationV1, type ContextRetrievalBudgetV1, type ContextRefAuthorizationReceiptV1 } from "./runtimeV2.js";
export interface ContextRetrievalReceiptV1 {
    version: 1;
    receiptId: string;
    requestId: string;
    operationId: string;
    projectId: string;
    operationExecutionRevision: number;
    candidateRevision: number;
    candidateRevisionDigest: string;
    participantId: string;
    participantGeneration: string;
    executionBindingDigest: string;
    controllerEpoch: number;
    sessionId: string;
    authorizationReceiptDigest: string;
    refId: string;
    fragmentId: string;
    artifactPath: string;
    sourceDigest: string;
    deliveredContentDigest: string;
    estimatedTokens: number;
    retrievedAt: string;
    receiptDigest: string;
}
export interface AuthorizedContextRetrievalRequestV1 {
    refId: string;
    requestId: string;
    maxTokens?: number;
}
export interface AuthorizedContextRetrievalResultV1 {
    fragmentId: string;
    content: string;
    artifact: string;
    sha256: string;
    estimatedTokens: number;
    repeated: boolean;
    receipt: ContextRetrievalReceiptV1;
}
export interface ContextRetrievalEvidenceV1 {
    version: 1;
    executionBindingDigest: string;
    contextManifestDigest: string;
    promptManifestDigest: string;
    receiptIds: string[];
    receiptDigests: string[];
    receiptsDigest: string;
    retrievalBudget: ContextRetrievalBudgetV1 | null;
    requests: number;
    totalTokens: number;
    retrievalStateDigest: string;
    progressiveManifestDigest: string;
    evidenceDigest: string;
}
export declare function issueContextRefAuthorization(root: string, controlRoot: string, operationId: string, participantId: string, options: {
    logicalAgent: string;
    phase: string;
    retrievalBudget: ContextRetrievalBudgetV1;
    capabilityAuthority: ExecutionAuthorityV1;
    contextManifest: Readonly<Record<string, unknown>>;
    now?: Date;
}): Promise<ContextRefAuthorizationReceiptV1 | undefined>;
export declare function retrieveAuthorizedContext(root: string, controlRoot: string, operationId: string, participantId: string, actualSessionId: string | undefined, logicalAgent: string, phase: string, request: AuthorizedContextRetrievalRequestV1): Promise<AuthorizedContextRetrievalResultV1>;
export declare function validateCurrentContextAuthorization(controlRoot: string, operationId: string, participantId: string, actualSessionId: string | undefined): Promise<ContextRefAuthorizationReceiptV1>;
export declare function loadContextRetrievalReceipts(controlRoot: string, operationId: string, participantId: string, binding: ExecutionBindingV2): Promise<ContextRetrievalReceiptV1[]>;
export declare function contextRetrievalEvidenceForResult(controlRoot: string, binding: ExecutionBindingV2): Promise<ContextRetrievalEvidenceV1>;
export declare function assertContextRetrievalEvidence(evidence: ContextRetrievalEvidenceV1, binding: ExecutionBindingV2): void;
/** Freeze the candidate/session retrieval receipt set atomically before accepting a StructuredResult. */
export declare function closeContextRetrievalForResult(controlRoot: string, binding: ExecutionBindingV2): Promise<ContextRetrievalEvidenceV1>;
export declare function recordContextContinuation(controlRoot: string, operationId: string, participantId: string, input: Omit<ContextContinuationInputV1, "sequence" | "previousSessionId" | "nextSessionId" | "previousTurnId" | "nextTurnId" | "contextRefIds" | "retrievalReceiptIds"> & {
    previousSessionId?: string;
}): Promise<ContextContinuationV1>;
