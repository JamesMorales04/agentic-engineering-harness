import { sha256Canonical } from "../core/digest.js";
import { AehError } from "../core/errors.js";
import type { HarnessProjectConfig, TaskContract, WorkerSession } from "../core/types.js";
import type { AgentExecutionSelection } from "../agents/types.js";
import type { ExecutionCatalogV1 } from "../architecture/executionCatalog.js";
import { loadOperation, currentControllerEpoch, isTerminalOperation, resolveOperationStateRoot } from "../operations/state.js";
import { HumanDecisionLedgerV2 } from "../security/humanDecision.js";
import type { OwnerHardProtectionExemptionGrantV1 } from "../security/ownerExemption.js";
import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { deterministicParticipantId } from "../security/executionLease.js";
import { recordEvent } from "../telemetry/events.js";
import { recordPaseoTrace } from "../paseo/trace.js";
import fs from "node:fs/promises";
import path from "node:path";
import { minimatch } from "minimatch";
import type { CandidateImpactAssessmentRuntimeV1, CandidateScopeEscapeV1, ChangeSetV1 } from "./assembler.js";
import { captureInverseCandidateChangeSet, executeIsolatedCandidateMutation } from "./direct.js";
import { assembleAndBindCandidateChangeSet } from "./binding.js";
import {
  buildScopeEscapeCorrectionPrompt,
  isScopeCorrectionTimeoutError,
  withOneScopeEscapeCorrectionTurnV1,
} from "./scopeEscapeCorrection.js";
import {
  assertRepairScopeBlockerReceipt,
  createRepairScopeBlockerReceipt,
  parseRepairScopeBlockerFromSession,
  writeRepairScopeBlockerReceipt,
  filterForbiddenScopeForAmendment,
  assertRepairScopeAmendment,
  repairHardProtectedPaths,
  normalizeRepairScopePath,
  verifyOwnerHardProtectionExemption,
  REPAIR_AMENDABLE_MANIFEST_PATHS,
  type RepairScopeAmendmentV1,
  type RepairScopeBlockerReceiptV1,
} from "./repairScope.js";

export interface RepairCandidateMutationResultV1 {
  session: WorkerSession;
  changeSet?: ChangeSetV1;
  candidate?: CandidateRevisionV1;
  impact?: import("./assembler.js").CandidateImpactV1;
  /**
   * DETERMINISTIC typed BLOCKED outcome for the out-of-scope-blocker path.
   * Present only when the Repairer returned NO ChangeSet and declared
   * `filesNeededOutsideScope[]` with per-file reasons. This is a validation
   * FAIL / BLOCKED receipt, NOT a terminal throw and NOT a silent pass.
   * Silent scope expansion still throws in the assembler.
   */
  scopeBlocker?: RepairScopeBlockerReceiptV1;
  /**
   * True when the single bounded scope-escape correction turn was used and
   * succeeded (initial assembly escaped, correction re-validated and bound).
   * Counts against the EXISTING repair budget (no new knob): run.ts consumes
   * this against maxRepairs (attempts + corrections < max). Terminal
   * second-escape/timeout throws the ORIGINAL (no flag, operation dead).
   */
  correctionUsed?: boolean;
}

export function assertCompiledRepairer(selection: AgentExecutionSelection | undefined, catalog: ExecutionCatalogV1 | undefined): asserts selection is AgentExecutionSelection {
  if (!selection || selection.role !== "Repairer") throw new AehError("PARTICIPANT_PLAN_INVALID", "A frozen Repairer selection is required for candidate repair.");
  if (selection.permissions.review === "allow" || selection.permissions.delegate === "allow" || selection.permissions.gitWrite === "allow" || selection.outputContract === "reviewer") {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "Repairer authority cannot include review, delegation, Git delivery, or reviewer output capability.");
  }
  if (!catalog) throw new AehError("PARTICIPANT_PLAN_INVALID", "A compiled ExecutionCatalog is required for candidate repair.");
  const { digest, ...catalogBody } = catalog;
  if (sha256Canonical(catalogBody) !== digest) throw new AehError("PARTICIPANT_PLAN_INVALID", "Repairer ExecutionCatalog digest is invalid.");
  const binding = catalog.roleBindings.Repairer;
  if (!binding) throw new AehError("PARTICIPANT_PLAN_INVALID", "The compiled ExecutionCatalog has no Repairer role binding.");
  const matches = binding.runtimeId === selection.runtimeName &&
    binding.modelAlias === selection.modelAlias &&
    binding.transport === selection.transport &&
    binding.profile === selection.profile &&
    binding.variant === selection.variant &&
    binding.nativeAgent === selection.nativeAgent &&
    binding.outputContract === selection.outputContract;
  if (!matches) throw new AehError("PARTICIPANT_PLAN_INVALID", "Repairer selection does not match its frozen ExecutionCatalog role binding.");
}

export async function executeRepairerCandidateMutation(input: {
  root: string;
  stateRoot: string;
  operationId: string;
  taskId: string;
  workUnitId: string;
  phase: string;
  config: HarnessProjectConfig;
  contract: TaskContract;
  selection: AgentExecutionSelection | undefined;
  executionCatalog: ExecutionCatalogV1 | undefined;
  allowedScope: readonly string[];
  forbiddenScope: readonly string[];
  prompt: string;
  execute: (isolatedRoot: string, participantId: string, prompt: string) => Promise<WorkerSession>;
  prepareWorkspace?: (isolatedRoot: string) => Promise<void>;
  semanticAssessment?: CandidateImpactAssessmentRuntimeV1;
  /**
   * DETERMINISTIC controller-owned exemption for a single lead-approved
   * bounded replan. When present, exactly the amendment-exempted paths are
   * removed from the effective forbidden list for this retry. The amendment
   * must be backed by a durable lead/human decision, persisted contract
   * amendment, and reseal; the default-deny source (`repairProtectedPaths`)
   * is unchanged and all other protected paths still fail closed.
   */
  scopeAmendment?: RepairScopeAmendmentV1;
  /**
   * Best-effort forensic hook for a scope-escape rejection (observability
   * only, never authority). Failures are swallowed so the fail-closed
   * rejection still throws; no blocker routing for silent expansion.
   */
  onScopeEscape?: (record: CandidateScopeEscapeV1) => Promise<void> | void;
  /**
   * DETERMINISTIC REMAINING repair-budget slots for the pre-offer correction
   * gate (Luna round-3). When defined, `remaining >= 1` decides the offer
   * (remaining < 1 → original escape throw immediately, no correction);
   * when undefined, falls back to the static `maxAttempts >= 1` check.
   * run.ts passes `maxRepairs - (attempts + escapeCorrectionsUsed)` computed
   * AFTER incrementing attempts for the current repair turn.
   */
  escapeCorrectionRemainingBudget?: number;
}): Promise<RepairCandidateMutationResultV1> {
  assertCompiledRepairer(input.selection, input.executionCatalog);
  const selection = input.selection;
  const operation = await loadOperation(input.stateRoot, input.operationId);
  const currentCandidate = operation.candidateRevision;
  if (!currentCandidate) throw new AehError("CANDIDATE_STALE", `Operation ${input.operationId} has no current CandidateRevision for Repairer execution.`);
  if (currentCandidate.taskId && currentCandidate.taskId !== input.taskId) throw new AehError("CANDIDATE_STALE", "Repairer candidate belongs to another task.");

  const participantId = deterministicParticipantId(input.operationId, selection.logicalAgent, `${input.phase}:${input.workUnitId}`);
  const isolated = await executeIsolatedCandidateMutation({
    root: input.root,
    operationId: input.operationId,
    taskId: input.taskId,
    workUnitId: input.workUnitId,
    candidate: currentCandidate,
    config: input.config,
    contract: input.contract,
    execute: (isolatedRoot) => input.execute(isolatedRoot, participantId, input.prompt),
    prepareWorkspace: input.prepareWorkspace
  });
  if (isolated.session.exitCode !== 0) {
    // A runtime failure is not a scope blocker; surface the session unchanged
    // so the controller can fail closed through its normal repair accounting.
    // A blocker declaration on a failed turn is ignored (no authority).
    return { session: isolated.session };
  }
  if (!isolated.changeSet) {
    // No-mutation path: either an empty repair turn or an explicit
    // out-of-scope-blocker declaration. The blocker must be a schema-valid
    // `repair-result` payload with NO file changes; it surfaces as a typed
    // BLOCKED receipt, never a throw and never a silent pass.
    const needed = parseRepairScopeBlockerFromSession(isolated.session);
    if (!needed) return { session: isolated.session };
    const forbidden = [...input.forbiddenScope, ...repairProtectedPaths(input.config, input.contract)];
    const partitioned = partitionRepairScopeBlockerFiles(needed, input.allowedScope, forbidden);
    if (partitioned.stripped.length) {
      // Best-effort diagnostic only (never authority): preserve the
      // model-confusion signal for forensics. Failures are swallowed so the
      // strip-and-proceed path is never masked by observability.
      await recordPaseoTrace(input.stateRoot, "candidate.repair.blocker.stripped", {
        operationId: input.operationId,
        taskId: input.taskId,
        workUnitId: input.workUnitId,
        participantId,
        mechanism: "DETERMINISTIC",
        declared: partitioned.declared,
        declaredCount: partitioned.declared.length,
        stripped: partitioned.stripped,
        strippedFiles: partitioned.stripped.map((entry) => entry.path),
        strippedCount: partitioned.stripped.length,
        genuinelyBlocked: partitioned.genuinelyBlocked,
        genuinelyBlockedFiles: partitioned.genuinelyBlocked.map((entry) => entry.path),
        genuinelyBlockedCount: partitioned.genuinelyBlocked.length,
      }).catch(() => undefined);
    }
    if (!partitioned.genuinelyBlocked.length) {
      // Vacuous declaration: every declared file was already writable, so
      // there is no out-of-scope need to block on. Proceed without a blocker
      // (no throw, no receipt, no amendment); the strip trace above preserves
      // the model-confusion signal.
      return { session: isolated.session };
    }
    const blocker = createRepairScopeBlockerReceipt({
      operationId: input.operationId,
      taskId: input.taskId,
      workUnitId: input.workUnitId,
      participantId,
      filesNeededOutsideScope: partitioned.genuinelyBlocked,
    });
    // Fail closed: the BLOCKED outcome is only valid with a durable receipt.
    // A receipt write failure throws (no suppression); write-then-verify reads
    // the receipt back and re-validates digest + schema before surfacing.
    const receiptFile = await writeRepairScopeBlockerReceipt(input.stateRoot, input.config, blocker);
    await verifyRepairScopeBlockerReceipt(receiptFile, blocker);
    await recordEvent(input.stateRoot, input.config, "harness.candidate.repair-scope-blocked", {
      taskId: input.taskId,
      workUnitId: input.workUnitId,
      participantId,
      role: selection.role,
      blockerDigest: blocker.digest,
      filesNeededOutsideScope: blocker.filesNeededOutsideScope,
    }).catch(() => undefined);
    return { session: isolated.session, scopeBlocker: blocker };
  }
  // A turn that both mutates and declares needed files is contradictory:
  // fail closed rather than guessing which signal has authority.
  if (parseRepairScopeBlockerFromSession(isolated.session)) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "REPAIR_SCOPE_BLOCKER_CONFLICT: Repairer declared filesNeededOutsideScope while also producing a ChangeSet; the no-mutation blocker path requires no file changes.");
  }
  const initialChangeSet: ChangeSetV1 = isolated.changeSet;

  // Amendment-path exact carve-out for subtree denies (see assembler field
  // docs): only the amendment-exempted exact files, only when they were just
  // re-verified against the durable MAC grant in this same controller tick.
  // Direct writes and non-amended retries pass nothing (behavior unchanged).
  const ownerScope = await verifiedOwnerExemptionForRetry(input.stateRoot, operation, input.scopeAmendment);
  const { allowedScope, forbiddenScope } = effectiveRepairScope(input.allowedScope, [...input.forbiddenScope, ...repairProtectedPaths(input.config, input.contract)], input.config, input.contract, input.scopeAmendment, ownerScope);
  const exactScopeExemptions = ownerScope && input.scopeAmendment ? [...input.scopeAmendment.exemptedPaths] : undefined;
  // Serialized under the per-operation coordination lock (re-validated inside):
  // a concurrent assembly that advanced the candidate first turns this into a
  // clean CANDIDATE_STALE instead of tearing the shared workspace.
  //
  // Scope-escape ONE-correction turn (IDENTICAL to DIRECT run.ts:732):
  // assembler keeps throwing unchanged (fail-closed, nothing applied).
  // FIRST scope escape per Repairer-attempt gets exactly ONE correction turn
  // with a precise diagnostic (escaped + hard/amendable + declare-via-
  // filesNeededOutsideScope + second-escape-terminal). NEVER echoes full
  // allowed/forbidden patterns ((a)=FALSE guard). Second escape or correction
  // timeout → ORIGINAL terminal kill. Correction counts against the EXISTING
  // repair budget (no new knob): allowed only when maxRepairs>=1 (same source
  // as DIRECT/wave: contract.repair.maxAttempts → config fallback → 2);
  // when used, run.ts consumes correctionUsed against maxRepairs (attempts +
  // corrections < max). Assembly re-validates fully on re-attempt (never apply
  // unapproved). Symlink/empty/digest/stale stay terminal (no correction).
  // Declaration-first BLOCKED routing preserved: correction declaring
  // filesNeededOutsideScope with NO changes → BLOCKED receipt (never PASS);
  // changes+declaration → CONFLICT fail-closed (correction error, not original).
  type RepairAssemblyOutcome = {
    session: WorkerSession;
    changeSet?: ChangeSetV1;
    candidate?: CandidateRevisionV1;
    impact?: import("./assembler.js").CandidateImpactV1;
    scopeBlocker?: RepairScopeBlockerReceiptV1;
  };
  const assembleRepairChangeSet = (changeSet: ChangeSetV1) =>
    assembleAndBindCandidateChangeSet({
      root: input.root,
      stateRoot: input.stateRoot,
      operationId: input.operationId,
      projectId: currentCandidate.projectId,
      taskId: input.taskId,
      baseCandidate: currentCandidate,
      changeSet,
      allowedScope,
      forbiddenScope,
      candidateId: `candidate:${input.operationId}:r${currentCandidate.revision + 1}`,
      workspace: currentCandidate.workspace,
      worktree: input.root,
      semanticAssessment: input.semanticAssessment,
      ...(exactScopeExemptions ? { exactScopeExemptions } : {}),
      ...(input.onScopeEscape ? { onScopeEscape: input.onScopeEscape } : {})
    });
  const repairMaxAttempts =
    (typeof (input.contract as { repair?: { maxAttempts?: unknown } }).repair?.maxAttempts === "number" &&
    Number.isSafeInteger((input.contract as { repair?: { maxAttempts?: unknown } }).repair?.maxAttempts) &&
    ((input.contract as { repair?: { maxAttempts?: unknown } }).repair?.maxAttempts as number) >= 0
      ? ((input.contract as { repair?: { maxAttempts?: unknown } }).repair?.maxAttempts as number)
      : typeof (input.config as { orchestration?: { worker?: { maxRepairAttempts?: unknown } } }).orchestration?.worker?.maxRepairAttempts === "number" &&
        Number.isSafeInteger((input.config as { orchestration?: { worker?: { maxRepairAttempts?: unknown } } }).orchestration?.worker?.maxRepairAttempts) &&
        ((input.config as { orchestration?: { worker?: { maxRepairAttempts?: unknown } } }).orchestration?.worker?.maxRepairAttempts as number) >= 0
        ? ((input.config as { orchestration?: { worker?: { maxRepairAttempts?: unknown } } }).orchestration?.worker?.maxRepairAttempts as number)
        : 2);
  // Luna round-3 REMAINING pre-offer gate (mirrors accepted wave tryReserve):
  // when the caller supplies remaining slots, remaining < 1 → direct assembly
  // with NO correction turn offered; otherwise the static max>=1 fallback.
  const allowRepairCorrection = input.escapeCorrectionRemainingBudget !== undefined
    ? input.escapeCorrectionRemainingBudget >= 1
    : repairMaxAttempts >= 1;
  if (!allowRepairCorrection) {
    const assembled = await assembleRepairChangeSet(initialChangeSet);
    await recordEvent(input.stateRoot, input.config, "harness.candidate.repair-assembled", {
      taskId: input.taskId,
      workUnitId: initialChangeSet.workUnitId,
      participantId: initialChangeSet.participantId,
      role: selection.role,
      candidateRevision: assembled.candidate.revision,
      candidateDigest: assembled.candidate.sourceDigest,
      impactDigest: assembled.impact.digest
    });
    return { session: isolated.session, changeSet: initialChangeSet, candidate: assembled.candidate, impact: assembled.impact };
  }
  const outcome = await withOneScopeEscapeCorrectionTurnV1<RepairAssemblyOutcome>({
    attempt: async () => {
      const assembled = await assembleRepairChangeSet(initialChangeSet);
      return { session: isolated.session, changeSet: initialChangeSet, candidate: assembled.candidate, impact: assembled.impact };
    },
    buildCorrectionPrompt: (details) => buildScopeEscapeCorrectionPrompt(details),
    executeCorrection: async (diagnostic) => {
      const correctionWorkUnitId = `${input.workUnitId}:escape-correction`;
      const correctionParticipantId = deterministicParticipantId(input.operationId, selection.logicalAgent, `${input.phase}:${correctionWorkUnitId}`);
      const fullCorrectionPrompt = `${input.prompt}\n\n${diagnostic}`;
      const correctionIsolated = await executeIsolatedCandidateMutation({
        root: input.root,
        operationId: input.operationId,
        taskId: input.taskId,
        workUnitId: correctionWorkUnitId,
        candidate: currentCandidate,
        config: input.config,
        contract: input.contract,
        execute: (correctionRoot) => input.execute(correctionRoot, correctionParticipantId, fullCorrectionPrompt),
        prepareWorkspace: input.prepareWorkspace
      });
      if (!correctionIsolated.changeSet) {
        // Declaration-first BLOCKED routing (same as initial no-mutation path):
        // schema-valid filesNeededOutsideScope with NO changes → BLOCKED when
        // genuinely outside scope; vacuous → session only; conflict/invalid
        // throws fail-closed (correction error, not original).
        const needed = parseRepairScopeBlockerFromSession(correctionIsolated.session);
        if (!needed) return { session: correctionIsolated.session };
        const forbidden = [...input.forbiddenScope, ...repairProtectedPaths(input.config, input.contract)];
        const partitioned = partitionRepairScopeBlockerFiles(needed, input.allowedScope, forbidden);
        if (partitioned.stripped.length) {
          await recordPaseoTrace(input.stateRoot, "candidate.repair.blocker.stripped", {
            operationId: input.operationId,
            taskId: input.taskId,
            workUnitId: correctionWorkUnitId,
            participantId: correctionParticipantId,
            mechanism: "DETERMINISTIC",
            declared: partitioned.declared,
            declaredCount: partitioned.declared.length,
            stripped: partitioned.stripped,
            strippedFiles: partitioned.stripped.map((entry) => entry.path),
            strippedCount: partitioned.stripped.length,
            genuinelyBlocked: partitioned.genuinelyBlocked,
            genuinelyBlockedFiles: partitioned.genuinelyBlocked.map((entry) => entry.path),
            genuinelyBlockedCount: partitioned.genuinelyBlocked.length,
          }).catch(() => undefined);
        }
        if (!partitioned.genuinelyBlocked.length) return { session: correctionIsolated.session };
        const blocker = createRepairScopeBlockerReceipt({
          operationId: input.operationId,
          taskId: input.taskId,
          workUnitId: correctionWorkUnitId,
          participantId: correctionParticipantId,
          filesNeededOutsideScope: partitioned.genuinelyBlocked,
        });
        const receiptFile = await writeRepairScopeBlockerReceipt(input.stateRoot, input.config, blocker);
        await verifyRepairScopeBlockerReceipt(receiptFile, blocker);
        await recordEvent(input.stateRoot, input.config, "harness.candidate.repair-scope-blocked", {
          taskId: input.taskId,
          workUnitId: correctionWorkUnitId,
          participantId: correctionParticipantId,
          role: selection.role,
          blockerDigest: blocker.digest,
          filesNeededOutsideScope: blocker.filesNeededOutsideScope,
        }).catch(() => undefined);
        return { session: correctionIsolated.session, scopeBlocker: blocker };
      }
      if (parseRepairScopeBlockerFromSession(correctionIsolated.session)) {
        throw new AehError("PARTICIPANT_PLAN_INVALID", "REPAIR_SCOPE_BLOCKER_CONFLICT: Repairer declared filesNeededOutsideScope while also producing a ChangeSet; the no-mutation blocker path requires no file changes.");
      }
      const assembled = await assembleRepairChangeSet(correctionIsolated.changeSet);
      return { session: correctionIsolated.session, changeSet: correctionIsolated.changeSet, candidate: assembled.candidate, impact: assembled.impact };
    },
    isTimeoutResult: (result) => isRepairCorrectionTimeoutSession(result.session),
    ...(input.escapeCorrectionRemainingBudget !== undefined
      ? { remainingBudget: input.escapeCorrectionRemainingBudget }
      : {}),
  });
  const final = outcome.result;
  if (final.candidate && final.changeSet && final.impact) {
    await recordEvent(input.stateRoot, input.config, "harness.candidate.repair-assembled", {
      taskId: input.taskId,
      workUnitId: final.changeSet.workUnitId,
      participantId: final.changeSet.participantId,
      role: selection.role,
      candidateRevision: final.candidate.revision,
      candidateDigest: final.candidate.sourceDigest,
      impactDigest: final.impact.digest
    });
  }
  if (outcome.correctionUsed) {
    await recordEvent(input.stateRoot, input.config, "harness.candidate.repair-escape-corrected", {
      taskId: input.taskId,
      workUnitId: input.workUnitId,
      participantId,
      role: selection.role,
    }).catch(() => undefined);
  }
  return { ...final, ...(outcome.correctionUsed ? { correctionUsed: true as const } : {}) };
}

export async function rejectRepairCandidateChangeSet(input: {
  root: string;
  stateRoot: string;
  operationId: string;
  taskId: string;
  workUnitId: string;
  config: HarnessProjectConfig;
  contract: TaskContract;
  rejectedChangeSet: ChangeSetV1;
  allowedScope: readonly string[];
  forbiddenScope: readonly string[];
  prepareWorkspace?: (isolatedRoot: string) => Promise<void>;
  semanticAssessment?: CandidateImpactAssessmentRuntimeV1;
  scopeAmendment?: RepairScopeAmendmentV1;
  onScopeEscape?: (record: CandidateScopeEscapeV1) => Promise<void> | void;
  /**
   * DETERMINISTIC REMAINING repair-budget slots for the pre-offer correction
   * gate (Luna round-3, same semantics as the apply path). When defined,
   * `remaining >= 1` decides the offer; when undefined, falls back to the
   * static `maxAttempts >= 1` check.
   */
  escapeCorrectionRemainingBudget?: number;
}): Promise<{ candidate: CandidateRevisionV1; impact: import("./assembler.js").CandidateImpactV1 }> {
  const operation = await loadOperation(input.stateRoot, input.operationId);
  const currentCandidate = operation.candidateRevision;
  if (!currentCandidate || currentCandidate.revision !== input.rejectedChangeSet.baseCandidateRevision + 1) {
    throw new AehError("CANDIDATE_STALE", "Rejected repair no longer matches the current CandidateRevision.");
  }
  const inverse = await captureInverseCandidateChangeSet({
    root: input.root,
    operationId: input.operationId,
    taskId: input.taskId,
    workUnitId: input.workUnitId,
    candidate: currentCandidate,
    config: input.config,
    contract: input.contract,
    rejectedChangeSet: input.rejectedChangeSet,
    prepareWorkspace: input.prepareWorkspace
  });
  if (!inverse) throw new AehError("CANDIDATE_STALE", "Rejected repair has no reversible source changes.");
  const rejectedOwnerScope = await verifiedOwnerExemptionForRetry(input.stateRoot, operation, input.scopeAmendment);
  const rejectedScope = effectiveRepairScope(input.allowedScope, [...input.forbiddenScope, ...repairProtectedPaths(input.config, input.contract)], input.config, input.contract, input.scopeAmendment, rejectedOwnerScope);
  const rejectedExactExemptions = rejectedOwnerScope && input.scopeAmendment ? [...input.scopeAmendment.exemptedPaths] : undefined;
  // Same per-operation serialization as the apply path above.
  //
  // Scope-escape ONE-correction turn (IDENTICAL helper, deterministic
  // rollback path): the inverse is a deterministic reverse (no MODEL worker
  // to re-invoke), so the single correction is a full re-validation
  // re-assembly of the SAME inverse. A scope escape is deterministic for a
  // frozen scope, so the correction re-escapes → ORIGINAL terminal kill
  // (second escape terminal, forensics preserved). Non-escapes (symlink/
  // empty/digest/stale) rethrow immediately with NO correction (helper
  // gate). Budget gating uses the SAME existing repair budget source as the
  // apply path (no new knob); when exhausted the assembly runs direct with
  // no correction turn offered.
  const assembleRejectChangeSet = () =>
    assembleAndBindCandidateChangeSet({
      root: input.root,
      stateRoot: input.stateRoot,
      operationId: input.operationId,
      projectId: currentCandidate.projectId,
      taskId: input.taskId,
      baseCandidate: currentCandidate,
      changeSet: inverse,
      allowedScope: rejectedScope.allowedScope,
      forbiddenScope: rejectedScope.forbiddenScope,
      candidateId: `candidate:${input.operationId}:r${currentCandidate.revision + 1}`,
      workspace: currentCandidate.workspace,
      worktree: input.root,
      semanticAssessment: input.semanticAssessment,
      ...(rejectedExactExemptions ? { exactScopeExemptions: rejectedExactExemptions } : {}),
      ...(input.onScopeEscape ? { onScopeEscape: input.onScopeEscape } : {})
    });
  const rejectMaxAttempts =
    (typeof (input.contract as { repair?: { maxAttempts?: unknown } }).repair?.maxAttempts === "number" &&
    Number.isSafeInteger((input.contract as { repair?: { maxAttempts?: unknown } }).repair?.maxAttempts) &&
    ((input.contract as { repair?: { maxAttempts?: unknown } }).repair?.maxAttempts as number) >= 0
      ? ((input.contract as { repair?: { maxAttempts?: unknown } }).repair?.maxAttempts as number)
      : typeof (input.config as { orchestration?: { worker?: { maxRepairAttempts?: unknown } } }).orchestration?.worker?.maxRepairAttempts === "number" &&
        Number.isSafeInteger((input.config as { orchestration?: { worker?: { maxRepairAttempts?: unknown } } }).orchestration?.worker?.maxRepairAttempts) &&
        ((input.config as { orchestration?: { worker?: { maxRepairAttempts?: unknown } } }).orchestration?.worker?.maxRepairAttempts as number) >= 0
        ? ((input.config as { orchestration?: { worker?: { maxRepairAttempts?: unknown } } }).orchestration?.worker?.maxRepairAttempts as number)
        : 2);
  // Luna round-3 REMAINING pre-offer gate (same as apply path): remaining < 1
  // → direct assembly with NO correction turn offered.
  const allowRejectCorrection = input.escapeCorrectionRemainingBudget !== undefined
    ? input.escapeCorrectionRemainingBudget >= 1
    : rejectMaxAttempts >= 1;
  let assembled: Awaited<ReturnType<typeof assembleAndBindCandidateChangeSet>>;
  if (!allowRejectCorrection) {
    assembled = await assembleRejectChangeSet();
  } else {
    const outcome = await withOneScopeEscapeCorrectionTurnV1<typeof assembled>({
      attempt: () => assembleRejectChangeSet(),
      buildCorrectionPrompt: (details) => buildScopeEscapeCorrectionPrompt(details),
      executeCorrection: async () => assembleRejectChangeSet(),
      ...(input.escapeCorrectionRemainingBudget !== undefined
        ? { remainingBudget: input.escapeCorrectionRemainingBudget }
        : {}),
    });
    assembled = outcome.result;
  }
  await recordEvent(input.stateRoot, input.config, "harness.candidate.repair-rejected", {
    taskId: input.taskId,
    workUnitId: input.workUnitId,
    rejectedCandidateRevision: currentCandidate.revision,
    rollbackCandidateRevision: assembled.candidate.revision,
    candidateDigest: assembled.candidate.sourceDigest
  });
  return { candidate: assembled.candidate, impact: assembled.impact };
}

/** Files that define the frozen task, validation policy, or runtime policy cannot be changed by repair — except exact files covered by a verified owner-scoped hard-protection grant on the single amended retry. */
export function repairProtectedPaths(config: HarnessProjectConfig, contract: TaskContract): string[] {
  // Canonical default-deny source: HARD-protected (never exemptible) plus the
  // amendable dependency-manifest denials. HARD is owned by repairScope.ts so
  // the exemption gates cannot drift from the deny source.
  const hard = repairHardProtectedPaths(config, contract);
  const amendable = new Set<string>();
  for (const raw of REPAIR_AMENDABLE_MANIFEST_PATHS) {
    const value = normalizeRepairScopePath(raw);
    if (!value || path.isAbsolute(value) || value.split("/").includes("..")) continue;
    amendable.add(value);
    amendable.add(`${value}/**`);
  }
  return [...new Set([...hard, ...amendable])].sort();
}

/**
 * DETERMINISTIC write-then-verify for the blocker receipt. The BLOCKED outcome
 * is only valid with a durable, schema-valid, digest-matching receipt. Read
 * the persisted file back and re-validate before surfacing; any mismatch
 * throws fail-closed (no suppression, no best-effort).
 */
async function verifyRepairScopeBlockerReceipt(
  receiptFile: string,
  blocker: RepairScopeBlockerReceiptV1,
): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(receiptFile, "utf8");
  } catch (error) {
    throw new AehError(
      "PARTICIPANT_PLAN_INVALID",
      `REPAIR_SCOPE_RECEIPT_NOT_DURABLE: blocker receipt could not be read back from ${receiptFile}: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new AehError(
      "PARTICIPANT_PLAN_INVALID",
      `REPAIR_SCOPE_RECEIPT_NOT_DURABLE: blocker receipt at ${receiptFile} is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  assertRepairScopeBlockerReceipt(parsed);
  const persisted = parsed as RepairScopeBlockerReceiptV1;
  if (persisted.digest !== blocker.digest) {
    throw new AehError(
      "PARTICIPANT_PLAN_INVALID",
      `REPAIR_SCOPE_RECEIPT_NOT_DURABLE: persisted blocker receipt digest does not match the declared blocker (${receiptFile}).`,
    );
  }
}

/**
 * DETERMINISTIC strip-and-trace partition for blocker declarations (H-NEW-7).
 *
 * A blocker declaration is only meaningful for files that are GENUINELY
 * outside the frozen scope (not matched by `allowedScope`) or explicitly
 * denied (`forbiddenScope`, including the default-deny protected paths).
 * Declared files that are already writable (in-scope and not denied) carry
 * no blocking force: they are stripped (filtered out) and traced as a
 * diagnostic preserving the model-confusion signal, never terminal.
 *
 * Authority analysis (decision-mechanism invariant):
 * - Stripping can never widen scope: every removed file was already writable
 *   under the frozen `allowedScope`/`forbiddenScope`, so dropping it from the
 *   blocker removes no deny and grants no write. The Repairer could already
 *   edit it without any amendment.
 * - The dangerous direction (adding files to the blocker, or widening the
 *   allowlist) is untouched: the remainder still flows through the existing
 *   blocker receipt → ledger-gated amendment path unchanged, and silent scope
 *   expansion still throws in the assembler.
 * - The abuse the old fail-closed gate guarded against (declaring a writable
 *   file to coax an amendment that widens scope) is impossible via strip: a
 *   stripped file never reaches the receipt, so it can never become an
 *   exempted path. Model imprecision in the non-authority-expanding direction
 *   must not kill the whole operation (cf. EMPTY_TEST_EVIDENCE refusal with
 *   in-scope `src/providers/validation/pact.ts` cited as blocked).
 *
 * Mechanism: DETERMINISTIC. Model content (declared paths + reasons),
 * deterministic gate (scope matching + trace).
 */
export function partitionRepairScopeBlockerFiles(
  needed: readonly { path: string; reason: string }[],
  allowedScope: readonly string[],
  forbiddenScope: readonly string[],
): {
  declared: string[];
  stripped: { path: string; reason: string }[];
  genuinelyBlocked: { path: string; reason: string }[];
} {
  const declared = needed.map((entry) => normalizeRepairScopePath(entry.path));
  const stripped: { path: string; reason: string }[] = [];
  const genuinelyBlocked: { path: string; reason: string }[] = [];
  for (const entry of needed) {
    const normalized = normalizeRepairScopePath(entry.path);
    const outOfAllowed = !matchesAnyRepairScope(normalized, allowedScope);
    const denied = matchesAnyRepairScope(normalized, forbiddenScope);
    if (!outOfAllowed && !denied) {
      stripped.push({ path: normalized, reason: entry.reason });
    } else {
      genuinelyBlocked.push({ path: normalized, reason: entry.reason });
    }
  }
  // Deterministic order: preserve the parser's locale-sorted declaration
  // order (parseRepairScopeBlockerFromSession already sorts by path).
  return { declared, stripped, genuinelyBlocked };
}

/**
 * DETERMINISTIC projection of a lead-approved amendment onto the effective
 * assembly scopes. The default-deny source is unchanged; exactly the
 * amendment-exempted paths are removed from the forbidden list. The amended
 * contract must already allow every exempted path (persisted allowlist
 * amendment + reseal); otherwise the retry fails closed with no auto-allow.
 * HARD-protected paths (frozen TaskContract, seal, validators,
 * acceptance/spec, policy) remain denied unless a verified owner-scoped
 * hard-protection grant covers exactly the exempted paths.
 */
function effectiveRepairScope(
  allowedScope: readonly string[],
  forbiddenScope: readonly string[],
  config: HarnessProjectConfig,
  contract: TaskContract,
  amendment: RepairScopeAmendmentV1 | undefined,
  ownerScope?: {
    grant: OwnerHardProtectionExemptionGrantV1;
    operationId: string;
    controllerEpoch: number;
    candidateRevision: number;
    candidateIdentityDigest: string;
    policyDigest: string;
    operationExecutionRevision: number;
    terminal: boolean;
  },
): { allowedScope: readonly string[]; forbiddenScope: readonly string[] } {
  if (!amendment) return { allowedScope, forbiddenScope };
  assertRepairScopeAmendment(amendment);
  if (amendment.taskId !== contract.task.id) {
    throw new AehError("PARTICIPANT_PLAN_INVALID", "REPAIR_SCOPE_AMENDMENT_TASK_MISMATCH: amendment belongs to another task.");
  }
  const contractAllowed = contract.scope?.allowed ?? [];
  for (const filePath of amendment.exemptedPaths) {
    if (!contractAllowed.includes(filePath) && !matchesAnyRepairScope(filePath, contractAllowed)) {
      throw new AehError(
        "PARTICIPANT_PLAN_INVALID",
        `REPAIR_SCOPE_AMENDMENT_NOT_SEALED: exempted path '${filePath}' is not in the amended TaskContract scope allowlist.`,
      );
    }
  }
  // HARD-protection gate: frozen TaskContract/seal/validators/acceptance/spec/
  // policy paths in the amendment stay denied and throw NON_EXEMPTIBLE —
  // UNLESS a verified owner-scoped grant covers them. The single gate lives
  // in filterForbiddenScopeForAmendment (no duplicated deny logic here); the
  // verified ownerScope flows straight through.
  const hardProtected = repairHardProtectedPaths(config, contract);
  return { allowedScope, forbiddenScope: filterForbiddenScopeForAmendment(forbiddenScope, amendment, hardProtected, ownerScope) };
}

/**
 * DETERMINISTIC owner-exemption resolution for an amended retry (controller
 * context only). Re-verifies the amendment-cited grant against durable state
 * (MAC under the live token, operation/epoch/live-identity binding, expiry,
 * ledger cross-check, exact coverage of everything the amendment exempts) and
 * returns the verified scope context for the sync filter. Any failure yields
 * undefined — the filter then throws NON_EXEMPTIBLE exactly as before (fail
 * closed). The in-memory amendment is never trusted on its own: only a
 * MAC-verified durable grant authorizes the projection.
 */
async function verifiedOwnerExemptionForRetry(
  stateRoot: string,
  operation: Awaited<ReturnType<typeof loadOperation>>,
  amendment: RepairScopeAmendmentV1 | undefined,
): Promise<
  | {
    grant: OwnerHardProtectionExemptionGrantV1;
    operationId: string;
    controllerEpoch: number;
    candidateRevision: number;
    candidateIdentityDigest: string;
    policyDigest: string;
    operationExecutionRevision: number;
    terminal: boolean;
  }
  | undefined
> {
  const exemptionId = amendment?.ownerExemption?.exemptionId;
  if (!amendment || !exemptionId) return undefined;
  const grant = operation.ownerExemptions?.[exemptionId];
  if (!grant) return undefined;
  try {
    const ledger = new HumanDecisionLedgerV2(path.join(resolveOperationStateRoot(stateRoot), ".harness", "security", "human-decisions.json"));
    await verifyOwnerHardProtectionExemption({
      operation,
      neededPaths: [...amendment.exemptedPaths],
      grant,
      ledger,
    });
    const liveCandidate = operation.candidateRevision;
    const livePolicyDigest = operation.resolvedOperationPolicy?.digest;
    const liveExecutionRevision = operation.operationExecutionRevision;
    if (!liveCandidate || typeof livePolicyDigest !== "string" || !Number.isSafeInteger(liveExecutionRevision)
      || liveExecutionRevision === undefined) return undefined;
    return {
      grant,
      operationId: operation.id,
      controllerEpoch: currentControllerEpoch(operation),
      candidateRevision: liveCandidate.revision,
      candidateIdentityDigest: liveCandidate.identityDigest,
      policyDigest: livePolicyDigest,
      operationExecutionRevision: liveExecutionRevision as number,
      terminal: isTerminalOperation(operation.status),
    };
  } catch {
    return undefined;
  }
}

function matchesAnyRepairScope(file: string, patterns: readonly string[]): boolean {
  const normalizedFile = normalizeRepairScopePath(file);
  return patterns.some((raw) => {
    const pattern = normalizeRepairScopePath(raw);
    if (!pattern) return false;
    if (pattern === "**" || raw === "**") return true;
    if (!normalizedFile) return false;
    return minimatch(normalizedFile, pattern, { dot: true });
  });
}

/**
 * DETERMINISTIC timeout detector for repair correction turns (return-path).
 * Mirrors waveExecutor local-path checks + scopeEscapeCorrection throw-path
 * patterns: exit 124, timeout status, STALLED_FIRST_ACTIVITY/DEADLINE, or
 * timeout text in session output. A timeout correction maps to ORIGINAL
 * terminal kill (helper rethrows first escape); non-timeout worker failure
 * returns the session (no candidate, fail-closed through normal accounting).
 */
function isRepairCorrectionTimeoutSession(session: WorkerSession): boolean {
  if (session.exitCode === 124) return true;
  const status = (session as { status?: string }).status;
  if (status === "timeout") return true;
  const killReason = (session as { killReason?: string }).killReason;
  if (killReason === "STALLED_FIRST_ACTIVITY" || killReason === "DEADLINE") return true;
  try {
    if (isScopeCorrectionTimeoutError(new Error(`${session.stderr ?? ""} ${session.stdout ?? ""}`))) return true;
  } catch {
    // Malformed session text is not a timeout.
  }
  return false;
}
