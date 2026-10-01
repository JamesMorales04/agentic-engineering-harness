import { type CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { type SemanticAssessmentBindingV1, type SemanticAssessmentServiceV1 } from "../semantic/assessment.js";
export interface ChangeSetV1 {
    version: 1;
    operationId: string;
    taskId: string;
    workUnitId: string;
    participantId: string;
    /**
     * The candidate revision the worker actually observed when it produced this
     * patch. It is never rewritten because candidate state advanced later; a
     * rebase produces an explicit derived ChangeSet instead.
     */
    baseCandidateRevision: number;
    /** Identity digest of the candidate the worker actually observed. */
    baseCandidateDigest: string;
    changedFiles: string[];
    patch: string;
    patchDigest: string;
    /** Present only when this ChangeSet is an explicit derived rebase of another ChangeSet. */
    derivation?: ChangeSetDerivationV1;
}
export interface ChangeSetDerivationV1 {
    kind: "WAVE_REBASE";
    originalChangeSetDigest: string;
    originalBaseCandidateRevision: number;
    originalBaseCandidateDigest: string;
    derivedAt: string;
}
export declare function changeSetDigest(changeSet: ChangeSetV1): string;
export interface CandidateImpactV1 {
    version: 1;
    /** The exact CandidateRevision that was assessed after successful assembly. */
    candidate: {
        candidateId: string;
        revision: number;
        identityDigest: string;
    };
    /** Deterministic lineage and patch facts from the assembly that created candidate. */
    baseCandidate: {
        candidateId: string;
        revision: number;
        identityDigest: string;
    };
    patchDigest: string;
    changedFiles: string[];
    changeKinds: string[];
    reviewDimensions: string[];
    requiresIndependentReview: boolean;
    interpretation: "MODEL" | "BLOCKED";
    unknowns?: string[];
    semanticAssessmentDigest?: string;
    digest: string;
}
export interface CandidateImpactAssessmentRuntimeV1 {
    service: SemanticAssessmentServiceV1;
    policyRevision: string;
    repositoryBinding: Omit<SemanticAssessmentBindingV1, "candidateId" | "candidateRevision" | "candidateDigest">;
}
export interface CandidateAssemblyInputV1 {
    root: string;
    operationId: string;
    projectId?: string;
    taskId: string;
    currentCandidate: CandidateRevisionV1;
    changeSet: ChangeSetV1;
    allowedScope: readonly string[];
    forbiddenScope?: readonly string[];
    candidateId: string;
    semanticAssessment?: CandidateImpactAssessmentRuntimeV1;
    workspace?: string;
    worktree?: string;
}
export interface CandidateAssemblyResultV1 {
    version: 1;
    changeSet: ChangeSetV1;
    candidate: CandidateRevisionV1;
    impact: CandidateImpactV1;
}
export declare function assembleCandidateChangeSet(input: CandidateAssemblyInputV1): Promise<CandidateAssemblyResultV1>;
