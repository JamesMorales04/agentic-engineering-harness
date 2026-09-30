import { type CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { type ExecutionBindingV2 } from "../architecture/executionIdentity.js";
import { type ContextRetrievalEvidenceV1 } from "../context/authorizationV2.js";
export interface StructuredResultProvenanceV1 {
    version: 1;
    status: "BOUND" | "PARTIAL" | "UNSUPPORTED";
    projectId?: string;
    operationId: string;
    operationRevision?: number;
    operationExecutionRevision?: number;
    participantId?: string;
    /** Unique controller-issued identity for this participant execution generation. */
    participantGeneration?: string;
    logicalAgent: string;
    role?: string;
    taskId?: string;
    candidate?: CandidateRevisionV1;
    controllerEpoch?: number;
    runtime?: {
        provider: string;
        model?: string;
        runtimeId?: string;
        sessionId?: string;
    };
    outputContract: string;
    outputSchemaDigest?: string;
    executionBinding?: ExecutionBindingV2;
    skillManifestDigest?: string;
    contextManifestDigest?: string;
    promptManifestDigest?: string;
    executionBlueprintDigest?: string;
    resolvedOperationPolicyDigest?: string;
    unsupported: string[];
    provenanceDigest: string;
}
export type StructuredResultSource = "mcp" | "captured";
export type StructuredResultTurnStatus = "PENDING" | "ACCEPTED" | "REJECTED" | "CONFLICT";
export interface StructuredResultTurn {
    id: string;
    sequence: number;
    revision: number;
    contract: string;
    phase?: string;
    status: StructuredResultTurnStatus;
    attempts: number;
    activatedAt: string;
    acceptedAt?: string;
    artifact?: string;
    sha256?: string;
    source?: StructuredResultSource;
    error?: string;
}
export interface StructuredResultChannel {
    version: 1;
    operationId: string;
    channelId: string;
    logicalAgent: string;
    role?: string;
    taskId?: string;
    operationRevision?: number;
    supervisorGeneration?: number;
    contract: string;
    provenance: StructuredResultProvenanceV1;
    agentId?: string;
    createdAt: string;
    updatedAt: string;
    sequence: number;
    activeTurn?: StructuredResultTurn;
}
export interface StructuredResultArtifact<T = unknown> {
    version: 1;
    kind: "agent-result";
    operationId: string;
    channelId: string;
    turnId: string;
    sequence: number;
    revision: number;
    attempt: number;
    logicalAgent: string;
    role?: string;
    taskId?: string;
    operationRevision?: number;
    supervisorGeneration?: number;
    agentId?: string;
    contract: string;
    provenance: StructuredResultProvenanceV1;
    contextEvidence: ContextRetrievalEvidenceV1;
    source: StructuredResultSource;
    createdAt: string;
    payloadSha256: string;
    payload: T;
}
export interface AcceptedStructuredResult<T = unknown> {
    artifact: string;
    sha256: string;
    payload: T;
    source: StructuredResultSource;
    turnId: string;
    channelId: string;
    provenance: StructuredResultProvenanceV1;
    contextEvidence: ContextRetrievalEvidenceV1;
}
export interface StructuredResultResolution<T = unknown> {
    ok: boolean;
    accepted?: AcceptedStructuredResult<T>;
    failure?: string;
}
export interface StructuredResultExpectation {
    operationId?: string;
    logicalAgent?: string;
    role?: string;
    contract?: string;
    phase?: string;
    participantId?: string;
    taskId?: string;
    attempt?: number;
    revision?: number;
    operationRevision?: number;
    supervisorGeneration?: number;
    provenance?: Partial<Omit<StructuredResultProvenanceV1, "version" | "status" | "unsupported" | "provenanceDigest">> & {
        status?: StructuredResultProvenanceV1["status"];
        unsupported?: string[];
        provenanceDigest?: string;
    };
    requireBoundProvenance?: boolean;
    verifyCurrentCandidate?: boolean;
}
export declare function provisionStructuredResultChannel(root: string, input: {
    operationId: string;
    logicalAgent: string;
    role?: string;
    taskId?: string;
    operationRevision?: number;
    supervisorGeneration?: number;
    contract: string;
    provenance?: StructuredResultProvenanceV1;
    channelId?: string;
}): Promise<StructuredResultChannel>;
export declare function bindStructuredResultChannel(root: string, operationId: string, channelId: string, agentId: string): Promise<StructuredResultChannel>;
/** Finalize an inert Paseo result channel after its idle provider session returns
 * an actual id and the controller has durably compiled the complete binding. */
export declare function finalizeStructuredResultChannelForAgent(root: string, agentId: string, provenance: StructuredResultProvenanceV1): Promise<StructuredResultChannel>;
export declare function activateStructuredResultTurn(root: string, operationId: string, channelId: string, phase?: string): Promise<StructuredResultTurn>;
export declare function activateStructuredResultTurnForAgent(root: string, agentId: string, phase?: string): Promise<StructuredResultTurn>;
export declare function createStructuredResultProvenance(input: Omit<StructuredResultProvenanceV1, "version" | "status" | "unsupported" | "provenanceDigest"> & {
    unsupported?: string[];
}): StructuredResultProvenanceV1;
export declare function assertStructuredResultProvenance(provenance: StructuredResultProvenanceV1, expected: {
    operationId: string;
    logicalAgent: string;
    role?: string;
    taskId?: string;
    contract: string;
}): void;
export declare function acceptStructuredResult<T = unknown>(root: string, operationId: string, channelId: string, payload: unknown, source: StructuredResultSource): Promise<AcceptedStructuredResult<T>>;
export declare function acceptedStructuredResultForAgent<T = unknown>(root: string, agentId: string, expected?: StructuredResultExpectation): Promise<AcceptedStructuredResult<T> | undefined>;
export declare function structuredResultProvenanceForAgent(root: string, agentId: string): Promise<StructuredResultProvenanceV1 | undefined>;
export declare function reconcileStructuredResult<T = unknown>(root: string, input: {
    operationId: string;
    agentId?: string;
    logicalAgent: string;
    role?: string;
    taskId?: string;
    contract: string;
    provenance?: StructuredResultProvenanceV1;
    phase?: string;
    stdout: string;
    stderr?: string;
}): Promise<StructuredResultResolution<T>>;
export declare function projectAcceptedStructuredResult<T extends {
    stdout: string;
}>(root: string, agentId: string, result: T): Promise<T>;
export declare function loadStructuredResultChannel(root: string, operationId: string, channelId: string): Promise<StructuredResultChannel>;
export declare function resultSinkMcpServerDefinition(root: string, operationId: string, channelId: string): {
    type: "stdio";
    command: string;
    args: string[];
    env: Record<string, string>;
    alwaysLoad: true;
};
