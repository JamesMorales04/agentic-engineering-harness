export declare const V2_CONTRACT_VERSION: 1;
export type CandidateRevisionV1 = {
    version: typeof V2_CONTRACT_VERSION;
    operationId: string;
    candidateId: string;
    projectId?: string;
    taskId?: string;
    revision: number;
    workspace?: string;
    worktree?: string;
    parentCandidateId?: string;
    sourceDigest: string;
    createdAt?: string;
    canonicalIdentity: string;
    identityDigest: string;
};
export type CandidateRevisionInputV1 = Pick<CandidateRevisionV1, "operationId" | "candidateId" | "revision" | "sourceDigest"> & Partial<Pick<CandidateRevisionV1, "projectId" | "taskId" | "workspace" | "worktree" | "parentCandidateId" | "createdAt">>;
export type RuntimeTerminalEvidenceV1 = {
    kind: "runtime-terminal";
    eventId: string;
    observedAt: string;
    terminal: true;
    status: "SUCCEEDED" | "FAILED" | "CANCELLED";
    exitCode: number | null;
};
export type ContractEvidenceV1 = {
    contractId: string;
    contractDigest: string;
    valid: true;
};
export type PersistedArtifactV1 = {
    artifactId: string;
    artifactDigest: string;
    persisted: true;
    persistedAt: string;
};
export type ProvenanceEvidenceV1 = {
    provenanceId: string;
    provenanceDigest: string;
    source: string;
    valid: true;
};
export type ParticipantReceiptV1 = {
    version: typeof V2_CONTRACT_VERSION;
    receiptId: string;
    operationId: string;
    participantId: string;
    sessionId?: string;
    attempt?: number;
    parentParticipantId?: string;
    supervisorGeneration?: number;
    role?: string;
    phase?: string;
    startedAt?: string;
    finishedAt?: string;
    outputContract?: string;
    outputDigest?: string;
    artifactRef?: string;
    candidate?: CandidateRevisionV1;
    candidateBinding?: CandidateRevisionV1;
    outcome: "SUCCEEDED" | "FAILED" | "CANCELLED";
    runtimeTerminal?: RuntimeTerminalEvidenceV1;
    runtimeTerminalEvidence?: RuntimeTerminalEvidenceV1;
    contract?: ContractEvidenceV1;
    artifact?: PersistedArtifactV1;
    persistedArtifact?: PersistedArtifactV1;
    provenance?: ProvenanceEvidenceV1;
    settled?: true;
    createdAt: string;
};
/**
 * Deterministic ASSEMBLING evidence (TARGET 8.1: "ChangeSet lineage and assembly receipt").
 * Exactly one receipt is recorded for every successful candidate transition, binding the frozen
 * base candidate, the assembled candidate, and (when a settled bounded-work receipt exists for
 * the ChangeSet producer) that source receipt. Completion evidence resolves a work receipt that
 * binds the pre-assembly candidate through this chain instead of re-binding the receipt itself.
 */
export type CandidateAssemblyReceiptV1 = {
    version: typeof V2_CONTRACT_VERSION;
    assemblyId: string;
    operationId: string;
    taskId: string;
    workUnitId: string;
    /** ChangeSet producer identity (controller-issued participant id in managed execution). */
    participantId: string;
    baseCandidateId: string;
    baseRevision: number;
    baseIdentityDigest: string;
    /** Candidate the producer actually observed; differs from base only for an explicit rebase. */
    sourceBaseRevision: number;
    sourceBaseIdentityDigest: string;
    sourceReceiptId?: string;
    sourceReceiptDigest?: string;
    sourceChangeSetDigest: string;
    candidateId: string;
    revision: number;
    identityDigest: string;
    changeSetDigest: string;
    patchDigest: string;
    operationExecutionRevision: number;
    controllerEpoch: number;
    createdAt: string;
    digest: string;
};
export type CandidateLineageReceiptResolutionV1 = {
    kind: "DIRECT";
} | {
    kind: "ASSEMBLY";
    assembly: CandidateAssemblyReceiptV1;
}
/** Non-producing bounded work (discovery, planning, review) completed on an ancestor candidate. */
 | {
    kind: "ANCESTOR";
};
export type TerminalGateFailureCodeV1 = "INVALID_RECEIPT" | "OPERATION_MISMATCH" | "CANDIDATE_MISMATCH" | "RUNTIME_TERMINAL_EVIDENCE_REQUIRED" | "CONTRACT_INVALID" | "PERSISTED_ARTIFACT_REQUIRED" | "PROVENANCE_INVALID";
export type TerminalGateDecisionV1 = {
    allowed: boolean;
    reasons: ReadonlyArray<{
        code: TerminalGateFailureCodeV1;
        message: string;
    }>;
};
export type TerminalGateContextV1 = {
    operationId?: string;
    candidate: CandidateRevisionV1;
    now?: string | Date;
};
export declare function canonicalCandidateIdentity(input: CandidateRevisionInputV1): string;
export declare function candidateIdentityDigest(input: CandidateRevisionInputV1): string;
export declare const canonicalCandidateDigest: typeof candidateIdentityDigest;
export declare function createCandidateRevisionV1(input: CandidateRevisionInputV1): CandidateRevisionV1;
export declare function assertCandidateRevisionInputV1(value: unknown): asserts value is CandidateRevisionInputV1;
export declare function assertCandidateRevisionV1(value: unknown): asserts value is CandidateRevisionV1;
export declare function candidateRevisionsEqual(left: CandidateRevisionV1, right: CandidateRevisionV1): boolean;
export declare function isStaleCandidateBinding(bound: CandidateRevisionV1, current: CandidateRevisionV1): boolean;
export declare const isCandidateRevisionStale: typeof isStaleCandidateBinding;
export declare function assertCurrentCandidateBinding(bound: CandidateRevisionV1, current: CandidateRevisionV1): void;
export declare function evaluateTerminalGate(receipt: unknown, expected: CandidateRevisionV1 | TerminalGateContextV1): TerminalGateDecisionV1;
export declare const evaluateTerminalGateV1: typeof evaluateTerminalGate;
export declare function assertParticipantReceiptV1(value: unknown): asserts value is ParticipantReceiptV1;
export declare function candidateAssemblyReceiptIdV1(operationId: string, candidateId: string): string;
export declare function candidateAssemblyReceiptDigestV1(receipt: CandidateAssemblyReceiptV1): string;
export declare function createCandidateAssemblyReceiptV1(input: Omit<CandidateAssemblyReceiptV1, "version" | "assemblyId" | "digest">): CandidateAssemblyReceiptV1;
export declare function assertCandidateAssemblyReceiptV1(value: unknown): asserts value is CandidateAssemblyReceiptV1;
/**
 * DETERMINISTIC receipt lineage resolution. A receipt is accepted for the current candidate when
 * it is bound to it directly, or when the durable assembly-receipt chain proves the receipt's
 * settled bounded work produced an assembly on the current candidate's ancestry, with the source
 * receipt id and digest recorded at the assembly boundary. No receipt field is rewritten.
 */
export declare function resolveCandidateLineageReceiptV1(input: {
    receipt: ParticipantReceiptV1;
    current: CandidateRevisionV1;
    assemblies: readonly CandidateAssemblyReceiptV1[];
}): CandidateLineageReceiptResolutionV1 | undefined;
