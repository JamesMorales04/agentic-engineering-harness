import { AehError } from "../core/errors.js";
import { sha256Canonical } from "../core/digest.js";
import { resourceClaimConflicts, type ResourceClaimV1 } from "../architecture/workGraph.js";
import { candidateRevisionsEqual, type CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { loadOperation, withOperationCoordinationLock } from "../operations/state.js";
import { runExecutable } from "../utils/process.js";
import { changeSetDigest, type CandidateImpactAssessmentRuntimeV1, type CandidateImpactV1, type CandidateScopeEscapeV1, type ChangeSetV1 } from "./assembler.js";
import { assertWorkspaceMatchesCandidate } from "./identity.js";
import { assembleAndBindCandidateChangeSet } from "./binding.js";

/**
 * A wave base is the frozen candidate every worker in one parallel wave
 * actually observed. Sibling ChangeSets keep that base forever; when a later
 * sibling must be integrated on top of an earlier sibling the integration
 * produces an explicit derived ChangeSet instead of rewriting the original.
 */
export interface WaveBaseV1 {
  version: 1;
  operationId: string;
  taskId: string;
  waveIndex: number;
  candidate: CandidateRevisionV1;
  frozenAt: string;
}

export interface WaveChangeSetSubmissionV1 {
  workUnitId: string;
  changeSet: ChangeSetV1;
  allowedScope: readonly string[];
  forbiddenScope?: readonly string[];
  resourceClaims?: readonly ResourceClaimV1[];
}

export interface WaveIntegrationStepV1 {
  workUnitId: string;
  changeSet: ChangeSetV1;
  candidate: CandidateRevisionV1;
  impact: CandidateImpactV1;
  derived: boolean;
}

export interface WaveReconciliationRequirementV1 {
  workUnitId: string;
  reason: string;
  observedBaseRevision: number;
  observedBaseDigest: string;
}

export interface WaveIntegrationResultV1 {
  version: 1;
  wave: WaveBaseV1;
  integrated: WaveIntegrationStepV1[];
  reconciliationRequired: WaveReconciliationRequirementV1[];
  digest: string;
}

export function createWaveBase(input: { operationId: string; taskId: string; waveIndex: number; candidate: CandidateRevisionV1; now?: Date }): WaveBaseV1 {
  const base = {
    version: 1 as const,
    operationId: input.operationId,
    taskId: input.taskId,
    waveIndex: input.waveIndex,
    candidate: input.candidate,
    frozenAt: (input.now ?? new Date()).toISOString()
  };
  return base;
}

export function waveBaseDigest(wave: WaveBaseV1): string {
  return sha256Canonical(wave);
}

/**
 * Deterministically integrate one wave's ChangeSets on top of the frozen wave
 * base. Integration is a truthful prefix: steps already integrated remain
 * bound as candidate revisions, and units that cannot be integrated without an
 * explicit rebase are reported for re-execution against the new candidate.
 * Per-submission assembly failures (scope escape, impact rejection, bind
 * failure, ...) are reported the same way, as typed reconciliation
 * requirements. Only wave-level preconditions (wrong operation, stale base)
 * and an unrestorable workspace throw out of this function.
 */
export async function integrateWaveChangeSets(input: {
  root: string;
  stateRoot: string;
  operationId: string;
  taskId: string;
  wave: WaveBaseV1;
  submissions: readonly WaveChangeSetSubmissionV1[];
  semanticAssessment?: CandidateImpactAssessmentRuntimeV1;
  now?: Date;
  /**
   * Best-effort forensic hook for a scope-escape rejection (observability
   * only, never authority). Failures are swallowed so the fail-closed
   * rejection still throws.
   */
  onScopeEscape?: (record: CandidateScopeEscapeV1) => Promise<void> | void;
}): Promise<WaveIntegrationResultV1> {
  if (input.wave.operationId !== input.operationId || input.wave.taskId !== input.taskId) {
    throw new AehError("CANDIDATE_STALE", "Wave base belongs to another operation or task.");
  }
  const operation = await loadOperation(input.stateRoot, input.operationId);
  if (operation.status !== "RUNNING") throw new AehError("CANDIDATE_STALE", `Wave integration requires a running operation; status is ${operation.status}.`);
  const current = operation.candidateRevision;
  if (!current) throw new AehError("CANDIDATE_STALE", `Operation ${input.operationId} has no current candidate revision.`);
  if (!candidateRevisionsEqual(current, input.wave.candidate)) {
    throw new AehError("CANDIDATE_STALE", "Wave base is no longer the current candidate revision.");
  }

  const now = (input.now ?? new Date()).toISOString();
  const reconciliationRequired: WaveReconciliationRequirementV1[] = [];
  const seen = new Set<string>();
  const accepted: WaveChangeSetSubmissionV1[] = [];
  for (const submission of [...input.submissions].sort((left, right) => left.workUnitId.localeCompare(right.workUnitId))) {
    if (seen.has(submission.workUnitId)) throw new AehError("PARTICIPANT_PLAN_INVALID", `Wave submission for '${submission.workUnitId}' was provided more than once.`);
    seen.add(submission.workUnitId);
    const changeSet = submission.changeSet;
    if (changeSet.version !== 1 || changeSet.operationId !== input.operationId || changeSet.taskId !== input.taskId || changeSet.workUnitId !== submission.workUnitId) {
      throw new AehError("CANDIDATE_STALE", `ChangeSet identity for '${submission.workUnitId}' does not match the wave integration request.`);
    }
    if (changeSet.baseCandidateRevision !== input.wave.candidate.revision || changeSet.baseCandidateDigest !== input.wave.candidate.identityDigest) {
      reconciliationRequired.push({ workUnitId: submission.workUnitId, reason: `stale-base:r${changeSet.baseCandidateRevision}`, observedBaseRevision: changeSet.baseCandidateRevision, observedBaseDigest: changeSet.baseCandidateDigest });
      continue;
    }
    const resourceConflict = accepted.find((other) => resourceClaimConflicts(other.resourceClaims ?? [], submission.resourceClaims ?? []).length > 0);
    if (resourceConflict) {
      const reasons = resourceClaimConflicts(resourceConflict.resourceClaims ?? [], submission.resourceClaims ?? []);
      reconciliationRequired.push({ workUnitId: submission.workUnitId, reason: `resource-claim:${reasons.join("|")}`, observedBaseRevision: changeSet.baseCandidateRevision, observedBaseDigest: changeSet.baseCandidateDigest });
      continue;
    }
    accepted.push(submission);
  }

  const ordered = [...accepted].sort((left, right) => left.workUnitId.localeCompare(right.workUnitId));  const integrated: WaveIntegrationStepV1[] = [];
  let activeCandidate = current;
  for (const submission of ordered) {
    const original = submission.changeSet;
    let effective = original;
    if (integrated.length > 0) {
      const check = await runExecutable("git", ["apply", "--check", "--binary", "-"], { cwd: input.root, timeoutMs: 60_000, stdin: original.patch });
      if (check.exitCode !== 0) {
        reconciliationRequired.push({ workUnitId: submission.workUnitId, reason: `rebase-required:${firstLine(check.stderr || check.stdout)}`, observedBaseRevision: original.baseCandidateRevision, observedBaseDigest: original.baseCandidateDigest });
        continue;
      }
      effective = {
        ...original,
        baseCandidateRevision: activeCandidate.revision,
        baseCandidateDigest: activeCandidate.identityDigest,
        derivation: {
          kind: "WAVE_REBASE",
          originalChangeSetDigest: changeSetDigest(original),
          originalBaseCandidateRevision: original.baseCandidateRevision,
          originalBaseCandidateDigest: original.baseCandidateDigest,
          derivedAt: now
        }
      };
    }
    let assembled;
    try {
      // Serialized under the per-operation coordination lock (re-validated
      // inside): a concurrent assembly that advanced the candidate first
      // surfaces here as a clean per-submission stale signal, never a torn
      // workspace or mixed-tree bind.
      const locked = await assembleAndBindCandidateChangeSet({
        root: input.root,
        stateRoot: input.stateRoot,
        operationId: input.operationId,
        projectId: activeCandidate.projectId,
        taskId: input.taskId,
        baseCandidate: activeCandidate,
        changeSet: effective,
        allowedScope: submission.allowedScope,
        forbiddenScope: submission.forbiddenScope,
        candidateId: `candidate:${input.operationId}:r${activeCandidate.revision + 1}`,
        workspace: activeCandidate.workspace,
        worktree: activeCandidate.worktree ?? input.root,
        semanticAssessment: input.semanticAssessment,
        ...(input.onScopeEscape ? { onScopeEscape: input.onScopeEscape } : {})
      });
      assembled = { changeSet: effective, candidate: locked.candidate, impact: locked.impact };
      activeCandidate = locked.candidate;
    } catch (error) {
      // Rollback holds the coordination lock: the reverse + post-check run
      // UNDER the lock with freshness re-validated against the durable
      // candidate inside, so a sibling that committed the same applicable
      // patch after our lock release is never undone. Fail closed (no
      // reverse on uncertainty).
      await withOperationCoordinationLock(input.stateRoot, input.operationId, async () => {
        const durableOp = await loadOperation(input.stateRoot, input.operationId).catch(() => undefined);
        const durable = durableOp?.candidateRevision;
        if (!durable) throw new AehError("CANDIDATE_STALE", "Wave integration failed and the current candidate could not be loaded.", { cause: error });
        if (!candidateRevisionsEqual(durable, activeCandidate)) {
          // Our base is stale: a sibling advanced. The workspace must
          // materialize the durable candidate (the sibling owns it); never
          // reverse — reversing the identical patch would undo the sibling.
          // Anything else is torn and throws fail-closed.
          const durableTreeIsPresent = await assertWorkspaceMatchesCandidate(input.root, durable).then(() => true, () => false);
          if (!durableTreeIsPresent) throw new AehError("CANDIDATE_STALE", "Wave integration failed and the workspace matches neither the wave base nor the current candidate.", { cause: error });
          return;
        }
        // Durable == wave base: no sibling advanced, so restoring the base
        // tree under the lock cannot clobber a sibling.
        const baseTreeIsPresent = await assertWorkspaceMatchesCandidate(input.root, activeCandidate).then(() => true, () => false);
        if (!baseTreeIsPresent) {
          const reverse = await runExecutable("git", ["apply", "--reverse", "--binary", "-"], { cwd: input.root, timeoutMs: 60_000, stdin: effective.patch });
          if (reverse.exitCode !== 0) throw new AehError("CANDIDATE_STALE", `Wave integration failed and the unbound ChangeSet could not be reverted: ${reverse.stderr || reverse.stdout}`, { cause: error });
          await assertWorkspaceMatchesCandidate(input.root, activeCandidate).catch((rollbackError) => { throw new AehError("CANDIDATE_STALE", "Wave integration failed and the reverted workspace no longer matches its base candidate.", { cause: rollbackError }); });
        }
      });
      // Per-submission assembly failures are typed reconciliation requirements,
      // not wave-level throws: earlier siblings stay bound as a truthful prefix
      // and the caller emits a structured FAIL wave summary with those binds
      // recorded. The worker-observed base is reported (not the derived rebase
      // base) so re-execution can target the exact stale candidate.
      reconciliationRequired.push({ workUnitId: submission.workUnitId, reason: `assembly-failed:${firstLine(error instanceof Error ? error.message : String(error))}`, observedBaseRevision: original.baseCandidateRevision, observedBaseDigest: original.baseCandidateDigest });
      continue;
    }
    integrated.push({ workUnitId: submission.workUnitId, changeSet: effective, candidate: assembled.candidate, impact: assembled.impact, derived: integrated.length > 0 });
  }

  const body = { version: 1 as const, wave: input.wave, integrated, reconciliationRequired };
  return { ...body, digest: sha256Canonical(body) };
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0]?.slice(0, 200) ?? "patch-conflict";
}
