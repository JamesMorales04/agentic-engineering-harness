import { computeWorktreeDigest, listWorktreeDigestPaths } from "../core/git.js";
import { AehError } from "../core/errors.js";
import { candidateRevisionsEqual, type CandidateRevisionV1 } from "../operations/v2Contracts.js";
import fs from "node:fs/promises";
import path from "node:path";

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

export async function assertWorkspaceSourceDigest(root: string, expectedSourceDigest: string, identity: Pick<CandidateWorkspaceIdentityEvidenceV1, "candidateId" | "candidateRevision" | "candidateIdentityDigest">): Promise<{ expectedSourceDigest: string; observedSourceDigest: string }> {
  const observedSourceDigest = await computeWorktreeDigest(root);
  const evidence = { ...identity, expectedSourceDigest, observedSourceDigest };
  if (observedSourceDigest !== expectedSourceDigest) {
    // Bounded diagnostic inventory: names the exact digest inputs at the moment of mismatch so a
    // transient non-source write (provider/session scratch) is identifiable without weakening the gate.
    const inventory = await workspaceDigestInventory(root);
    const summary = inventory.slice(0, 5).map((entry) => `${entry.path}@${Math.round(entry.mtimeMs)}`).join(", ");
    throw new AehError("CANDIDATE_WORKSPACE_MISMATCH", `workspace does not materialize CandidateRevision ${identity.candidateId} r${identity.candidateRevision} (expectedSourceDigest=${expectedSourceDigest}, observedSourceDigest=${observedSourceDigest}). recent digest inputs: ${summary || "<none>"}.`, { details: { ...evidence, inventory } });
  }
  return { expectedSourceDigest, observedSourceDigest };
}

async function workspaceDigestInventory(root: string): Promise<CandidateWorkspaceDigestInputV1[]> {
  let files: string[];
  try { files = await listWorktreeDigestPaths(root); }
  catch { return []; }
  const entries: CandidateWorkspaceDigestInputV1[] = [];
  for (const file of files.slice(0, 5_000)) {
    try {
      const stat = await fs.lstat(path.resolve(root, file));
      entries.push({ path: file.replaceAll("\\", "/"), size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      entries.push({ path: file.replaceAll("\\", "/"), size: -1, mtimeMs: -1 });
    }
  }
  return entries.sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path)).slice(0, 25);
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
