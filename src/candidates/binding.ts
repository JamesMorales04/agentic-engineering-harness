import { AehError } from "../core/errors.js";
import { assertWorkspaceMatchesCandidate } from "./identity.js";
import { bindOperationCandidateWithAssemblyReceipt, loadOperation, recordCandidateAssemblyReceipt } from "../operations/state.js";
import { candidateRevisionsEqual, type CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { runExecutable } from "../utils/process.js";
import type { ChangeSetV1 } from "./assembler.js";

/**
 * Bind an assembled tree and record the deterministic ASSEMBLING receipt
 * (ChangeSet lineage and its settled source receipt) in a SINGLE durable
 * commit, restoring the prior bound tree if the bind is rejected. Because the
 * candidate transition and the receipt-map insert share one locked
 * `mutateOperation` callback, a crash can leave either the base revision
 * (nothing bound) or the bound candidate with its receipt — never a
 * bound-but-unreceipted orphan. Recording an assembly receipt after a durable
 * bind failure is not attempted: the candidate did not advance.
 */
export async function bindAssembledCandidate(input: {
  root: string;
  stateRoot: string;
  operationId: string;
  baseCandidate: CandidateRevisionV1;
  candidate: CandidateRevisionV1;
  changeSet: ChangeSetV1;
}): Promise<CandidateRevisionV1> {
  let bound: CandidateRevisionV1;
  try {
    await assertWorkspaceMatchesCandidate(input.root, input.candidate);
    const updated = await bindOperationCandidateWithAssemblyReceipt(input.stateRoot, input.operationId, { baseCandidate: input.baseCandidate, candidate: input.candidate, changeSet: input.changeSet });
    if (updated.candidateRevision && candidateRevisionsEqual(updated.candidateRevision, input.candidate)) bound = updated.candidateRevision;
    else throw new AehError("CANDIDATE_STALE", "Operation did not persist the exact assembled CandidateRevision.");
  } catch (error) {
    const latest = await loadOperation(input.stateRoot, input.operationId).catch(() => undefined);
    if (latest?.candidateRevision && candidateRevisionsEqual(latest.candidateRevision, input.candidate)) {
      // The single-commit bind already landed (or a legacy two-step orphan is
      // being retried with the same inputs): ensure the assembly receipt
      // idempotently instead of double-advancing the revision.
      await recordCandidateAssemblyReceipt(input.stateRoot, input.operationId, { baseCandidate: input.baseCandidate, candidate: input.candidate, changeSet: input.changeSet });
      bound = latest.candidateRevision;
    } else {
      if (latest?.candidateRevision && candidateRevisionsEqual(latest.candidateRevision, input.baseCandidate)) {
        const assembledTreeIsPresent = await assertWorkspaceMatchesCandidate(input.root, input.candidate).then(() => true, () => false);
        if (assembledTreeIsPresent) {
          const inverse = await runExecutable("git", ["apply", "--reverse", "--binary", "-"], {
            cwd: input.root,
            timeoutMs: 60_000,
            stdin: input.changeSet.patch
          });
          if (inverse.exitCode !== 0) throw new AehError("CANDIDATE_STALE", `Candidate binding failed and the unbound ChangeSet could not be reverted: ${inverse.stderr || inverse.stdout}`, { cause: error });
          await assertWorkspaceMatchesCandidate(input.root, input.baseCandidate);
        }
      }
      throw error;
    }
  }
  return bound;
}
