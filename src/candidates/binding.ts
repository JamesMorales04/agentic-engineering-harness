import { AehError } from "../core/errors.js";
import { assertWorkspaceMatchesCandidate } from "./identity.js";
import { bindOperationCandidate, loadOperation } from "../operations/state.js";
import { candidateRevisionsEqual, type CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { runExecutable } from "../utils/process.js";
import type { ChangeSetV1 } from "./assembler.js";

/** Bind an assembled tree, and restore the prior bound tree if the bind is rejected. */
export async function bindAssembledCandidate(input: {
  root: string;
  stateRoot: string;
  operationId: string;
  baseCandidate: CandidateRevisionV1;
  candidate: CandidateRevisionV1;
  changeSet: ChangeSetV1;
}): Promise<CandidateRevisionV1> {
  try {
    await assertWorkspaceMatchesCandidate(input.root, input.candidate);
    const updated = await bindOperationCandidate(input.stateRoot, input.operationId, input.candidate);
    if (updated.candidateRevision && candidateRevisionsEqual(updated.candidateRevision, input.candidate)) return updated.candidateRevision;
    throw new AehError("CANDIDATE_STALE", "Operation did not persist the exact assembled CandidateRevision.");
  } catch (error) {
    const latest = await loadOperation(input.stateRoot, input.operationId).catch(() => undefined);
    if (latest?.candidateRevision && candidateRevisionsEqual(latest.candidateRevision, input.candidate)) {
      // The durable write completed but a later event/receipt step reported an
      // error. Preserve the tree because it is already the bound candidate.
      return latest.candidateRevision;
    }
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
