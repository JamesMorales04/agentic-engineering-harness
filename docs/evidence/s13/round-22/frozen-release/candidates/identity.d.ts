import { type CandidateRevisionV1 } from "../operations/v2Contracts.js";
export interface CandidateWorkspaceIdentityEvidenceV1 {
    version: 1;
    candidateId: string;
    candidateRevision: number;
    candidateIdentityDigest: string;
    expectedSourceDigest: string;
    observedSourceDigest: string;
    status: "MATCH";
}
export interface CandidateWorkspaceDigestInputV1 {
    path: string;
    size: number;
    mtimeMs: number;
}
export declare function assertWorkspaceSourceDigest(root: string, expectedSourceDigest: string, identity: Pick<CandidateWorkspaceIdentityEvidenceV1, "candidateId" | "candidateRevision" | "candidateIdentityDigest">): Promise<{
    expectedSourceDigest: string;
    observedSourceDigest: string;
}>;
/** Proves that an observed workspace is the immutable source tree named by a candidate. */
export declare function assertWorkspaceMatchesCandidate(root: string, candidate: CandidateRevisionV1, currentCandidate?: CandidateRevisionV1 | null): Promise<CandidateWorkspaceIdentityEvidenceV1>;
export declare function isCandidateWorkspaceIdentityEvidence(value: unknown, candidate: CandidateRevisionV1): value is CandidateWorkspaceIdentityEvidenceV1;
