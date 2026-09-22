import { computeWorktreeDigest } from "../core/git.js";
import { AehError } from "../core/errors.js";
import { candidateRevisionsEqual, type CandidateRevisionV1 } from "../operations/v2Contracts.js";

export interface CandidateWorkspaceIdentityEvidenceV1 {
  version: 1;
  candidateId: string;
  candidateRevision: number;
  candidateIdentityDigest: string;
  expectedSourceDigest: string;
  observedSourceDigest: string;
  status: "MATCH";
}

export async function assertWorkspaceSourceDigest(root: string, expectedSourceDigest: string, identity: Pick<CandidateWorkspaceIdentityEvidenceV1, "candidateId" | "candidateRevision" | "candidateIdentityDigest">): Promise<{ expectedSourceDigest: string; observedSourceDigest: string }> {
  const observedSourceDigest = await computeWorktreeDigest(root);
  const evidence = { ...identity, expectedSourceDigest, observedSourceDigest };
  if (observedSourceDigest !== expectedSourceDigest) {
    throw new AehError("CANDIDATE_WORKSPACE_MISMATCH", `workspace does not materialize CandidateRevision ${identity.candidateId} r${identity.candidateRevision}.`, { details: evidence });
  }
  return { expectedSourceDigest, observedSourceDigest };
}

/** Proves that an observed workspace is the immutable source tree named by a candidate. */
export async function assertWorkspaceMatchesCandidate(root: string, candidate: CandidateRevisionV1, currentCandidate?: CandidateRevisionV1 | null): Promise<CandidateWorkspaceIdentityEvidenceV1> {
  if (currentCandidate !== undefined && (!currentCandidate || !candidateRevisionsEqual(candidate, currentCandidate))) {
    throw new AehError("CANDIDATE_STALE", `CandidateRevision ${candidate.candidateId} r${candidate.revision} is no longer the current operation candidate.`, { details: { candidateIdentityDigest: candidate.identityDigest, currentCandidateIdentityDigest: currentCandidate?.identityDigest } });
  }
  const identity = {
    version: 1 as const,
    candidateId: candidate.candidateId,
    candidateRevision: candidate.revision,
    candidateIdentityDigest: candidate.identityDigest
  };
  const source = await assertWorkspaceSourceDigest(root, candidate.sourceDigest, identity);
  return { ...identity, ...source, status: "MATCH" };
}

export function isCandidateWorkspaceIdentityEvidence(value: unknown, candidate: CandidateRevisionV1): value is CandidateWorkspaceIdentityEvidenceV1 {
  if (!value || typeof value !== "object") return false;
  const evidence = value as Partial<CandidateWorkspaceIdentityEvidenceV1>;
  return evidence.version === 1 && evidence.status === "MATCH" && evidence.candidateId === candidate.candidateId && evidence.candidateRevision === candidate.revision && evidence.candidateIdentityDigest === candidate.identityDigest && evidence.expectedSourceDigest === candidate.sourceDigest && evidence.observedSourceDigest === candidate.sourceDigest;
}
