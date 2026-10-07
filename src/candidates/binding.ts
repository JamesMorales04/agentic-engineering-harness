import { AehError } from "../core/errors.js";
import { assertWorkspaceMatchesCandidate } from "./identity.js";
import { bindOperationCandidateWithAssemblyReceipt, loadOperation, recordCandidateAssemblyReceipt, withOperationCoordinationLock } from "../operations/state.js";
import { candidateRevisionsEqual, type CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { runExecutable } from "../utils/process.js";
import { assembleCandidateChangeSet, type CandidateAssemblyInputV1, type CandidateImpactV1, type ChangeSetV1 } from "./assembler.js";

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

/**
 * Assemble a ChangeSet and bind the resulting candidate while holding the
 * per-operation coordination lock (DETERMINISTIC serialization mechanism).
 * The current candidate is re-loaded and re-validated INSIDE the lock before
 * any `git apply` touches the shared workspace: a concurrent assembly that
 * already advanced the candidate turns this call into a clean, retryable
 * CANDIDATE_STALE instead of a torn workspace or a mixed-tree bind.
 *
 * This is the single choke point every in-repo assembly path must use
 * (repair apply/reject, wave integration, DIRECT assembly). The lock also
 * narrows the workspace check-vs-apply TOCTOU between concurrent assemblies
 * to worker filesystem writes, which remain out of scope (off-patch worker
 * writes are only observed through the captured diff, never live-gated).
 */
export async function assembleAndBindCandidateChangeSet(
  input: Omit<CandidateAssemblyInputV1, "currentCandidate"> & { stateRoot: string; baseCandidate: CandidateRevisionV1 }
): Promise<{ candidate: CandidateRevisionV1; impact: CandidateImpactV1 }> {
  const { stateRoot, baseCandidate, ...assemblyInput } = input;
  return withOperationCoordinationLock(stateRoot, input.operationId, async () => {
    const latest = await loadOperation(stateRoot, input.operationId);
    const current = latest.candidateRevision;
    if (!current || !candidateRevisionsEqual(current, baseCandidate)) {
      throw new AehError("CANDIDATE_STALE", `ChangeSet is based on revision ${baseCandidate.revision}, current candidate is revision ${current?.revision ?? "none"}.`);
    }
    const assembled = await assembleCandidateChangeSet({ ...assemblyInput, currentCandidate: current });
    const bound = await bindAssembledCandidate({ root: input.root, stateRoot, operationId: input.operationId, baseCandidate: current, candidate: assembled.candidate, changeSet: input.changeSet });
    return { candidate: bound, impact: assembled.impact };
  });
}
