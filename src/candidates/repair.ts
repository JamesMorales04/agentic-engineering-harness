import { sha256Canonical } from "../core/digest.js";
import { AehError } from "../core/errors.js";
import type { HarnessProjectConfig, TaskContract, WorkerSession } from "../core/types.js";
import type { AgentExecutionSelection } from "../agents/types.js";
import type { ExecutionCatalogV1 } from "../architecture/executionCatalog.js";
import { loadOperation } from "../operations/state.js";
import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { deterministicParticipantId } from "../security/executionLease.js";
import { recordEvent } from "../telemetry/events.js";
import fs from "node:fs/promises";
import path from "node:path";
import { minimatch } from "minimatch";
import { assembleCandidateChangeSet, type CandidateImpactAssessmentRuntimeV1, type CandidateScopeEscapeV1, type ChangeSetV1 } from "./assembler.js";
import { captureInverseCandidateChangeSet, executeIsolatedCandidateMutation } from "./direct.js";
import { bindAssembledCandidate } from "./binding.js";
import {
  assertRepairScopeBlockerReceipt,
  createRepairScopeBlockerReceipt,
  parseRepairScopeBlockerFromSession,
  writeRepairScopeBlockerReceipt,
  filterForbiddenScopeForAmendment,
  assertRepairScopeAmendment,
  repairHardProtectedPaths,
  findRepairHardProtectedViolations,
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
  execute: (isolatedRoot: string, participantId: string) => Promise<WorkerSession>;
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
}): Promise<RepairCandidateMutationResultV1> {
  assertCompiledRepairer(input.selection, input.executionCatalog);
  const operation = await loadOperation(input.stateRoot, input.operationId);
  const currentCandidate = operation.candidateRevision;
  if (!currentCandidate) throw new AehError("CANDIDATE_STALE", `Operation ${input.operationId} has no current CandidateRevision for Repairer execution.`);
  if (currentCandidate.taskId && currentCandidate.taskId !== input.taskId) throw new AehError("CANDIDATE_STALE", "Repairer candidate belongs to another task.");

  const participantId = deterministicParticipantId(input.operationId, input.selection.logicalAgent, `${input.phase}:${input.workUnitId}`);
  const isolated = await executeIsolatedCandidateMutation({
    root: input.root,
    operationId: input.operationId,
    taskId: input.taskId,
    workUnitId: input.workUnitId,
    candidate: currentCandidate,
    config: input.config,
    contract: input.contract,
    execute: (isolatedRoot) => input.execute(isolatedRoot, participantId),
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
    assertBlockerFilesAreActuallyBlocked(needed.map((entry) => entry.path), input.allowedScope, [...input.forbiddenScope, ...repairProtectedPaths(input.config, input.contract)]);
    const blocker = createRepairScopeBlockerReceipt({
      operationId: input.operationId,
      taskId: input.taskId,
      workUnitId: input.workUnitId,
      participantId,
      filesNeededOutsideScope: needed,
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
      role: input.selection.role,
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

  const { allowedScope, forbiddenScope } = effectiveRepairScope(input.allowedScope, [...input.forbiddenScope, ...repairProtectedPaths(input.config, input.contract)], input.config, input.contract, input.scopeAmendment);
  const assembled = await assembleCandidateChangeSet({
    root: input.root,
    operationId: input.operationId,
    projectId: currentCandidate.projectId,
    taskId: input.taskId,
    currentCandidate,
    changeSet: isolated.changeSet,
    allowedScope,
    forbiddenScope,
    candidateId: `candidate:${input.operationId}:r${currentCandidate.revision + 1}`,
    workspace: currentCandidate.workspace,
    worktree: input.root,
    semanticAssessment: input.semanticAssessment,
    ...(input.onScopeEscape ? { onScopeEscape: input.onScopeEscape } : {})
  });
  await bindAssembledCandidate({ root: input.root, stateRoot: input.stateRoot, operationId: input.operationId, baseCandidate: currentCandidate, candidate: assembled.candidate, changeSet: isolated.changeSet });
  await recordEvent(input.stateRoot, input.config, "harness.candidate.repair-assembled", {
    taskId: input.taskId,
    workUnitId: isolated.changeSet.workUnitId,
    participantId: isolated.changeSet.participantId,
    role: input.selection.role,
    candidateRevision: assembled.candidate.revision,
    candidateDigest: assembled.candidate.sourceDigest,
    impactDigest: assembled.impact.digest
  });
  return { session: isolated.session, changeSet: isolated.changeSet, candidate: assembled.candidate, impact: assembled.impact };
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
  const rejectedScope = effectiveRepairScope(input.allowedScope, [...input.forbiddenScope, ...repairProtectedPaths(input.config, input.contract)], input.config, input.contract, input.scopeAmendment);
  const assembled = await assembleCandidateChangeSet({
    root: input.root,
    operationId: input.operationId,
    projectId: currentCandidate.projectId,
    taskId: input.taskId,
    currentCandidate,
    changeSet: inverse,
    allowedScope: rejectedScope.allowedScope,
    forbiddenScope: rejectedScope.forbiddenScope,
    candidateId: `candidate:${input.operationId}:r${currentCandidate.revision + 1}`,
    workspace: currentCandidate.workspace,
    worktree: input.root,
    semanticAssessment: input.semanticAssessment,
    ...(input.onScopeEscape ? { onScopeEscape: input.onScopeEscape } : {})
  });
  await bindAssembledCandidate({ root: input.root, stateRoot: input.stateRoot, operationId: input.operationId, baseCandidate: currentCandidate, candidate: assembled.candidate, changeSet: inverse });
  await recordEvent(input.stateRoot, input.config, "harness.candidate.repair-rejected", {
    taskId: input.taskId,
    workUnitId: input.workUnitId,
    rejectedCandidateRevision: currentCandidate.revision,
    rollbackCandidateRevision: assembled.candidate.revision,
    candidateDigest: assembled.candidate.sourceDigest
  });
  return { candidate: assembled.candidate, impact: assembled.impact };
}

/** Files that define the frozen task, validation policy, or runtime policy cannot be changed by repair. */
export function repairProtectedPaths(config: HarnessProjectConfig, contract: TaskContract): string[] {
  // Canonical default-deny source: HARD-protected (never exemptible) plus the
  // amendable dependency-manifest denials. HARD is owned by repairScope.ts so
  // the exemption gates cannot drift from the deny source.
  const hard = repairHardProtectedPaths(config, contract);
  const amendable = new Set<string>();
  for (const raw of REPAIR_AMENDABLE_MANIFEST_PATHS) {
    const value = raw.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
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
 * DETERMINISTIC guard: a blocker declaration is only valid when every
 * declared file is actually outside the frozen scope (not matched by
 * `allowedScope`) or explicitly denied (`forbiddenScope`, including the
 * default-deny protected paths). Declaring an already-writable file as a
 * blocker is rejected fail-closed so the channel cannot be abused to widen
 * scope. Model content, deterministic gate.
 */
function assertBlockerFilesAreActuallyBlocked(
  files: readonly string[],
  allowedScope: readonly string[],
  forbiddenScope: readonly string[],
): void {
  const invalid = files.filter((file) => {
    const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
    const outOfAllowed = !matchesAnyRepairScope(normalized, allowedScope);
    const denied = matchesAnyRepairScope(normalized, forbiddenScope);
    return !outOfAllowed && !denied;
  });
  if (invalid.length) {
    throw new AehError(
      "PARTICIPANT_PLAN_INVALID",
      `REPAIR_SCOPE_BLOCKER_NOT_BLOCKED: declared needed file(s) are already within the frozen scope: ${invalid.join(", ")}.`,
    );
  }
}

/**
 * DETERMINISTIC projection of a lead-approved amendment onto the effective
 * assembly scopes. The default-deny source is unchanged; exactly the
 * amendment-exempted paths are removed from the forbidden list. The amended
 * contract must already allow every exempted path (persisted allowlist
 * amendment + reseal); otherwise the retry fails closed with no auto-allow.
 * HARD-protected paths (frozen TaskContract, seal, validators,
 * acceptance/spec, policy) are never exemptible even with an approval.
 */
function effectiveRepairScope(
  allowedScope: readonly string[],
  forbiddenScope: readonly string[],
  config: HarnessProjectConfig,
  contract: TaskContract,
  amendment: RepairScopeAmendmentV1 | undefined,
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
  // HARD-protection gate (never exemptible): an approved blocker cannot make
  // frozen TaskContract/seal/validators/acceptance/spec/policy paths writable.
  const hardViolations = findRepairHardProtectedViolations(amendment.exemptedPaths, config, contract);
  if (hardViolations.length) {
    throw new AehError(
      "PARTICIPANT_PLAN_INVALID",
      `REPAIR_SCOPE_AMENDMENT_NON_EXEMPTIBLE: exempted path(s) are never exemptible (frozen TaskContract, seal, validators, acceptance/spec, policy): ${hardViolations.join(", ")}.`,
    );
  }
  const hardProtected = repairHardProtectedPaths(config, contract);
  return { allowedScope, forbiddenScope: filterForbiddenScopeForAmendment(forbiddenScope, amendment, hardProtected) };
}

function matchesAnyRepairScope(file: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => pattern === "**" || minimatch(file, pattern, { dot: true }));
}
