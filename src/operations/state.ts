import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { IntentDecisionV1 } from "../audit/intentDecision.js";
import { assertCurrentCandidateBinding, assertCandidateRevisionV1, createCandidateRevisionV1, evaluateTerminalGate, candidateRevisionsEqual, type CandidateRevisionV1, type ParticipantReceiptV1 } from "./v2Contracts.js";
import { canonicalSerialize, sha256Canonical, sha256Utf8 } from "../core/digest.js";
import { computeWorktreeDigest } from "../core/git.js";
import { assertWorkspaceMatchesCandidate } from "../candidates/identity.js";
import { assertExecutionBindingV2, assertResolvedOperationPolicyV1, type ExecutionBindingV2, type ResolvedOperationPolicyV1 } from "../architecture/executionIdentity.js";

export type OperationKind = "audit" | "run" | "change";
export type OperationStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
export type OperationStageStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "BLOCKED" | "SKIPPED";
export type OperationParticipantStatus = "REGISTERED" | "IDLE" | "RUNNING" | "COMPLETED" | "FAILED" | "BLOCKED" | "CANCELLED";
export type SupervisorGenerationStatus = "INITIALIZING" | "ACTIVE" | "DRAINING" | "ARCHIVED" | "FAILED";

export const OPERATION_KIND_VALUES = ["audit", "run", "change"] as const satisfies readonly OperationKind[];
export const OPERATION_STATUS_VALUES = ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"] as const satisfies readonly OperationStatus[];
export const OPERATION_TERMINAL_STATUS_VALUES = ["SUCCEEDED", "FAILED", "CANCELLED"] as const satisfies readonly Extract<OperationStatus, "SUCCEEDED" | "FAILED" | "CANCELLED">[];

/**
 * The controller may move work from queued to running or to a terminal state
 * when a complete operation result is already available. Direct metadata
 * patches still cannot claim queued work succeeded; terminal records are
 * otherwise immutable and idempotent.
 */
export function isAllowedOperationStatusTransition(from: OperationStatus, to: OperationStatus): boolean {
  if (from === to) return true;
  if (isTerminal(from)) return false;
  if (from === "QUEUED") return to === "RUNNING" || to === "SUCCEEDED" || to === "FAILED" || to === "CANCELLED";
  return to === "SUCCEEDED" || to === "FAILED" || to === "CANCELLED";
}

export interface AuditOperationPayload { request: string; files?: string[]; domains?: string[]; risk?: "low" | "medium" | "high"; reviewers?: string[]; intentDecision?: IntentDecisionV1; }
export interface RunOperationPayload { taskId: string; profile?: string; priority?: number; intentDecision?: IntentDecisionV1; }
export interface ChangeOperationPayload { request: string; title?: string; taskId?: string; files?: string[]; domains?: string[]; acceptance?: string[]; risk?: "low" | "medium" | "high"; profile?: string; priority?: number; intentDecision?: IntentDecisionV1; }
export type OperationPayload = AuditOperationPayload | RunOperationPayload | ChangeOperationPayload;

export interface OperationAgentRecord { id: string; role?: string; phase?: string; workspaceId?: string; transport?: string; registeredAt: string; }
export interface OperationLeadBinding { agentId: string; source?: string; generation: number; boundAt: string; acknowledgedRevision: number; acknowledgedAt?: string; }
export interface OperationSupervisorGeneration {
  generation: number;
  agentId?: string;
  status: SupervisorGenerationStatus;
  createdAt: string;
  activatedAt?: string;
  drainingAt?: string;
  archivedAt?: string;
  checkpointArtifact?: string;
  contextRatio?: number;
  initializationAttempt?: number;
  initializationDispatchedAt?: string;
  initializationCompletedAt?: string;
  initializationEvidence?: string;
  error?: string;
}
export interface OperationSupervisionState { required: boolean; materialized: boolean; activeGeneration?: number; generations: OperationSupervisorGeneration[]; latestConsolidationRevision?: number; latestConsolidationArtifact?: string; }
export interface OperationStageRecord { name: string; status: OperationStageStatus; revision: number; startedAt?: string; finishedAt?: string; message?: string; artifact?: string; }
export interface OperationParticipantRecord { id: string; logicalAgent?: string; role?: string; stage?: string; phase?: string; parentSupervisorGeneration?: number; parentAgentId?: string; workspaceId?: string; transport?: string; status: OperationParticipantStatus; registeredAt: string; startedAt?: string; finishedAt?: string; resultArtifact?: string; executionBinding?: ExecutionBindingV2; error?: string; }
export interface OperationProgress { expected: number; registered: number; running: number; completed: number; failed: number; blocked: number; }
export interface OperationNotificationState { lastLeadWakeRevision: number; lastLeadWakeAt?: string; lastLeadWakeReason?: string; terminalDelivered: boolean; attempts: number; lastError?: string; }
export interface OperationIntentState { request?: string; classification?: "AUDIT" | "CHANGE" | "RUN"; route?: "NO_AGENT" | "DIRECT" | "DELEGATED" | "FORMAL_SDD"; assurance?: "NONE" | "STANDARD" | "ELEVATED" | "CRITICAL"; risk?: "low" | "medium" | "high"; priority?: number; semanticDecision?: IntentDecisionV1; }
export interface OperationControllerBinding { epoch: number; ownerId: string; claimedAt: string; previousOwnerId?: string; tokenDigest?: string; pid?: number; }

export interface OperationRecordV1 {
  version: 1; id: string; kind: "audit" | "run"; status: OperationStatus; phase: string; root: string;
  payload: AuditOperationPayload | RunOperationPayload; createdAt: string; updatedAt: string; startedAt?: string; finishedAt?: string;
  pid?: number; workspaceId?: string; workspaceWarning?: string; agents?: OperationAgentRecord[]; cleanupWarnings?: string[]; result?: Record<string, unknown>; error?: string;
}
export interface OperationRecordV2 {
  version: 2; id: string; kind: OperationKind; status: OperationStatus; phase: string; root: string; workspaceRoot?: string;
  payload: OperationPayload; revision: number; createdAt: string; updatedAt: string; lastProgressAt: string; startedAt?: string; finishedAt?: string;
  pid?: number; workspaceId?: string; workspaceWarning?: string; intent?: OperationIntentState; lead?: OperationLeadBinding;
  supervision: OperationSupervisionState; stages: Record<string, OperationStageRecord>; participants: Record<string, OperationParticipantRecord>;
  progress: OperationProgress; notification: OperationNotificationState; agents?: OperationAgentRecord[]; cleanupWarnings?: string[]; result?: Record<string, unknown>; error?: string;
  candidateRevision?: CandidateRevisionV1; participantReceipts?: Record<string, ParticipantReceiptV1>;
  /** Changes only when operation execution semantics change; record revision remains event/order identity. */
  operationExecutionRevision?: number;
  executionSemanticsDigest?: string;
  resolvedOperationPolicy?: ResolvedOperationPolicyV1;
  controller?: OperationControllerBinding;
}
export type OperationRecord = OperationRecordV1 | OperationRecordV2;
export interface TerminalOperationTransition { record: OperationRecordV2; transitioned: boolean; }
export interface OperationEvent { version: 1; operationId: string; revision: number; at: string; type: string; status: OperationStatus; phase: string; changed?: string[]; details?: Record<string, unknown>; }

/** Private durable outbox field. It is removed when an operation is loaded. */
interface StoredOperationRecord extends OperationRecordV2 { _pendingOperationEvent?: OperationEvent; }

const OPERATIONS_DIR = ".harness/operations";
const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 30_000;

export function resolveOperationStateRoot(root: string): string {
  const configured = process.env.AEH_OPERATION_STATE_REDIRECT === "1" && process.env.AEH_OPERATION_ID?.trim()
    ? process.env.AEH_CONTROL_ROOT?.trim()
    : undefined;
  return path.resolve(configured || root);
}
export function operationFile(root: string, operationId: string): string { return path.resolve(resolveOperationStateRoot(root), OPERATIONS_DIR, `${safeId(operationId)}.json`); }
export function operationArtifactDir(root: string, operationId: string): string { return path.resolve(resolveOperationStateRoot(root), OPERATIONS_DIR, safeId(operationId)); }
export function operationEventsFile(root: string, operationId: string): string { return path.join(operationArtifactDir(root, operationId), "events.ndjson"); }

export async function loadOperation(root: string, operationId: string): Promise<OperationRecordV2> {
  const stateRoot = resolveOperationStateRoot(root);
  const file = operationFile(stateRoot, operationId);
  const initial = await readStoredOperation(file);
  if (!initial.pendingEvent) return initial.record;
  return withOperationLock(file, async () => {
    const stored = await readStoredOperation(file);
    await recoverPendingOperationEvent(stateRoot, file, stored);
    return stored.record;
  });
}
export async function saveOperation(root: string, record: OperationRecord): Promise<void> {
  const normalized = normalizeOperationRecord(record);
  // A newly created operation starts at execution-semantics revision 1. Loading
  // an existing record without this field does not take this creation path and
  // remains an explicit unsupported-revision error at execution boundaries.
  normalized.operationExecutionRevision ??= 1;
  const sourceRoot = path.resolve(normalized.root);
  if (!normalized.candidateRevision) {
    const candidate = createCandidateRevisionV1({
      operationId: normalized.id,
      candidateId: `candidate:${normalized.id}:r1`,
      projectId: `project:${sha256Utf8(sourceRoot).slice(0, 24)}`,
      taskId: normalized.kind === "run" ? (normalized.payload as RunOperationPayload).taskId : normalized.id,
      revision: 1,
      sourceDigest: await computeWorktreeDigest(sourceRoot),
      worktree: sourceRoot,
      createdAt: normalized.createdAt
    });
    normalized.candidateRevision = candidate;
  }
  const stateRoot = resolveOperationStateRoot(root);
  const file = operationFile(stateRoot, normalized.id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await withOperationLock(file, async () => {
    const stored = await readStoredOperation(file).catch((error: unknown) => { if (isNotFound(error)) return undefined; throw error; });
    if (stored) {
      await recoverPendingOperationEvent(stateRoot, file, stored);
      throw new Error(`AEH_OPERATION_EXISTS: operation '${normalized.id}' is already durable; mutate it through its lifecycle API.`);
    }
    if (normalized.candidateRevision) await assertWorkspaceMatchesCandidate(normalized.candidateRevision.worktree ?? sourceRoot, normalized.candidateRevision);
    await commitOperationRecord(stateRoot, file, normalized, "operation.created", ["status", "phase", "candidateRevision"]);
  });
}
export async function patchOperation(root: string, operationId: string, patch: Partial<OperationRecordV2>): Promise<OperationRecordV2> { return mutateOperation(root, operationId, patch, true, "operation.updated"); }
export async function patchOperationMetadata(root: string, operationId: string, patch: Partial<OperationRecordV2>): Promise<OperationRecordV2> { return mutateOperation(root, operationId, patch, false, "operation.metadata"); }
export async function updateOperationMetadata(root: string, operationId: string, update: (current: OperationRecordV2, now: string) => Partial<OperationRecordV2>): Promise<OperationRecordV2> {
  return mutateOperation(root, operationId, {}, false, "operation.metadata", (current, _revision, now) => ({ ...current, ...update(current, now) }), true);
}

export async function transitionOperationToTerminal(root: string, operationId: string, patch: Partial<OperationRecordV2> & { status: "SUCCEEDED" | "FAILED" | "CANCELLED" }): Promise<TerminalOperationTransition> {
  const stateRoot = resolveOperationStateRoot(root); const file = operationFile(stateRoot, operationId); await fs.mkdir(path.dirname(file), { recursive: true });
  return withOperationLock(file, async () => {
    const stored = await readStoredOperation(file);
    await recoverPendingOperationEvent(stateRoot, file, stored);
    let current = stored.record;
    assertControllerEpoch(current, controllerEpochFromEnvironment(), "terminal transition");
    if (isTerminal(current.status)) return { record: current, transitioned: false };
    if (!isAllowedOperationStatusTransition(current.status, patch.status)) throw new Error(`Invalid operation status transition ${current.status} -> ${patch.status}.`);
    if (patch.status === "SUCCEEDED") {
      if (!current.candidateRevision) throw new Error("V2_TERMINAL_GATE_REJECTED: successful operations require a current candidate revision.");
      await assertWorkspaceMatchesCandidate(candidateWorkspaceRoot(current, current.candidateRevision), current.candidateRevision);
    }
    if (patch.status === "SUCCEEDED" && Object.keys(current.participants).length === 0 && Object.keys(current.participantReceipts ?? {}).length === 0) {
      current = await createControllerTerminalReceipt(stateRoot, current, patch);
    }
    if (patch.status === "SUCCEEDED") assertSuccessTerminalEvidence(current);
    const now = new Date().toISOString(); const revision = current.revision + 1; const participants = settleParticipants(current.participants, patch.status, now); const supervision = settleSupervision(current.supervision, now);
    const next = normalizeOperationRecord({ ...current, ...patch, version: 2, id: current.id, kind: current.kind, revision, updatedAt: now, lastProgressAt: now, finishedAt: patch.finishedAt ?? now, participants, progress: deriveProgress(participants), supervision, stages: { ...current.stages, finished: { name: "finished", status: terminalStageStatus(patch.status), revision, startedAt: now, finishedAt: now } } } as OperationRecordV2);
    if (patch.status === "SUCCEEDED" && next.candidateRevision) await assertWorkspaceMatchesCandidate(candidateWorkspaceRoot(next, next.candidateRevision), next.candidateRevision);
    await commitOperationRecord(stateRoot, file, next, "operation.terminal", ["status", "phase", "participants", "progress", "supervision"]); return { record: next, transitioned: true };
  });
}

export async function bindOperationLead(root: string, operationId: string, agentId: string, source?: string): Promise<OperationRecordV2> { return mutateOperation(root, operationId, {}, true, "operation.lead.bound", (current, revision, now) => ({ ...current, revision, updatedAt: now, lastProgressAt: now, lead: { agentId: requiredId(agentId), source, generation: (current.lead?.generation ?? 0) + 1, boundAt: now, acknowledgedRevision: revision, acknowledgedAt: now }, notification: { ...current.notification, lastLeadWakeRevision: revision, lastLeadWakeAt: now, lastLeadWakeReason: "operation-started" } })); }

export function currentControllerEpoch(record: OperationRecordV2): number { return record.controller?.epoch ?? 0; }

/** The epoch a controller process was launched with, if it identifies itself as a controller. */
export function controllerEpochFromEnvironment(): number | undefined {
  const raw = process.env.AEH_CONTROLLER_EPOCH?.trim();
  if (!raw) return undefined;
  const epoch = Number.parseInt(raw, 10);
  return Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : undefined;
}

export function assertControllerEpoch(record: OperationRecordV2, expected: number | undefined, action: string): void {
  if (expected === undefined) return;
  const current = currentControllerEpoch(record);
  if (expected !== current) throw new Error(`V2_CONTROLLER_FENCED: ${action} was requested by controller epoch ${expected}, but the operation is owned by controller epoch ${current}.`);
}

/** Claim durable monotonic controller ownership. Every takeover increments the epoch and mints a new controller token. */
export async function claimControllerEpoch(root: string, operationId: string, ownerId: string, options: { pid?: number } = {}): Promise<OperationRecordV2> {
  const previousEpoch = process.env.AEH_CONTROLLER_EPOCH;
  const token = crypto.randomBytes(32).toString("hex");
  delete process.env.AEH_CONTROLLER_EPOCH;
  try {
    const record = await mutateOperation(root, operationId, {}, true, "operation.controller.claimed", (current, revision, now) => ({
      ...current,
      revision,
      updatedAt: now,
      lastProgressAt: now,
      participants: Object.fromEntries(Object.entries(current.participants).map(([id, participant]) => [id, { ...participant, executionBinding: undefined }])),
      resolvedOperationPolicy: undefined,
      controller: {
        epoch: currentControllerEpoch(current) + 1,
        ownerId: requiredId(ownerId),
        claimedAt: now,
        tokenDigest: sha256Utf8(token),
        ...(options.pid ? { pid: options.pid } : {}),
        ...(current.controller?.ownerId ? { previousOwnerId: current.controller.ownerId } : {})
      }
    }));
    process.env.AEH_CONTROLLER_TOKEN = token;
    return record;
  } finally {
    if (previousEpoch !== undefined) process.env.AEH_CONTROLLER_EPOCH = previousEpoch;
  }
}

/** The controller token a controller process was launched with, if any. */
export function controllerTokenFromEnvironment(): string | undefined {
  return process.env.AEH_CONTROLLER_TOKEN?.trim() || undefined;
}

/**
 * Controller authority is not just a self-declared epoch: the caller must hold
 * the secret minted at claim time, whose digest is the only durable copy.
 */
export function assertControllerToken(record: OperationRecordV2, action: string): void {
  const expected = record.controller?.tokenDigest;
  if (!expected) throw new Error(`V2_CONTROLLER_FENCED: ${action} requires a claimed controller token.`);
  const token = controllerTokenFromEnvironment();
  if (!token || sha256Utf8(token) !== expected) throw new Error(`V2_CONTROLLER_FENCED: ${action} requires the current controller token.`);
}
export async function acknowledgeOperationLead(root: string, operationId: string, revision: number, reason?: string): Promise<OperationRecordV2> {
  return mutateOperation(root, operationId, {}, false, "operation.metadata", (current, _revision, now) => {
    if (current.revision !== revision) throw new Error(`AEH_OPERATION_ACK_REVISION_MISMATCH: requested revision ${revision}, current revision ${current.revision}.`);
    return {
      ...current,
      lead: current.lead ? { ...current.lead, acknowledgedRevision: Math.max(current.lead.acknowledgedRevision, revision), acknowledgedAt: now } : undefined,
      notification: { ...current.notification, lastLeadWakeRevision: Math.max(current.notification.lastLeadWakeRevision, revision), lastLeadWakeAt: now, lastLeadWakeReason: reason ?? current.notification.lastLeadWakeReason }
    };
  }, true);
}
export async function markTerminalDelivered(root: string, operationId: string, attempts: number, error?: string): Promise<OperationRecordV2> { return updateOperationMetadata(root, operationId, (current, now) => ({ notification: { ...current.notification, lastLeadWakeRevision: error ? current.notification.lastLeadWakeRevision : current.revision, lastLeadWakeAt: error ? current.notification.lastLeadWakeAt : now, lastLeadWakeReason: error ? current.notification.lastLeadWakeReason : "terminal", terminalDelivered: !error, attempts, lastError: error } })); }

export async function bindOperationCandidate(root: string, operationId: string, candidate: CandidateRevisionV1): Promise<OperationRecordV2> {
  assertCandidateRevisionV1(candidate);
  return mutateOperation(root, operationId, {}, true, "operation.candidate.bound", async (current, revision, now) => {
    if (!Number.isSafeInteger(current.operationExecutionRevision) || current.operationExecutionRevision! < 1) throw new Error("UNSUPPORTED_OPERATION_EXECUTION_REVISION: migrate this operation record before candidate assembly.");
    if (isTerminal(current.status)) throw new Error("V2_CANDIDATE_BINDING_REJECTED: terminal operations cannot bind a new CandidateRevision.");
    if (candidate.operationId !== current.id) throw new Error("V2_CANDIDATE_BINDING_REJECTED: candidate operation does not match the operation record.");
    if (!current.candidateRevision) {
      if (candidate.revision !== 1) throw new Error("V2_CANDIDATE_BINDING_REJECTED: the first CandidateRevision must start at revision 1.");
    } else {
      assertCandidateRevisionV1(current.candidateRevision);
      if (current.candidateRevision.operationId !== candidate.operationId) throw new Error("V2_CANDIDATE_BINDING_REJECTED: candidate operation does not match the current candidate.");
      if (candidate.revision !== current.candidateRevision.revision + 1) throw new Error("V2_CANDIDATE_BINDING_REJECTED: candidate revision must advance by exactly one revision.");
      if (candidate.parentCandidateId !== current.candidateRevision.candidateId) throw new Error("V2_CANDIDATE_BINDING_REJECTED: candidate parent must be the current CandidateRevision.");
      if (candidate.projectId !== current.candidateRevision.projectId || candidate.taskId !== current.candidateRevision.taskId) throw new Error("V2_CANDIDATE_BINDING_REJECTED: candidate project and task identity must remain on the current lineage.");
    }
    await assertWorkspaceMatchesCandidate(path.resolve(candidate.worktree ?? current.workspaceRoot ?? current.root), candidate);
    const participants = Object.fromEntries(Object.entries(current.participants).map(([id, participant]) => [id, { ...participant, executionBinding: undefined }]));
    return { ...current, candidateRevision: candidate, operationExecutionRevision: current.operationExecutionRevision! + 1, resolvedOperationPolicy: undefined, participants, revision, updatedAt: now, lastProgressAt: now };
  }, true);
}

export async function bindResolvedOperationPolicy(root: string, operationId: string, policy: ResolvedOperationPolicyV1): Promise<OperationRecordV2> {
  assertResolvedOperationPolicyV1(policy);
  return mutateOperation(root, operationId, {}, true, "operation.policy.bound", (current, revision, now) => {
    if (policy.operationId !== current.id) throw new Error("EXECUTION_POLICY_STALE: policy belongs to a different operation.");
    if (!current.candidateRevision || current.candidateRevision.identityDigest !== policy.candidateDigest || current.candidateRevision.revision !== policy.candidateRevision) throw new Error("EXECUTION_POLICY_STALE: policy does not bind the current candidate.");
    if (current.candidateRevision.projectId && current.candidateRevision.projectId !== policy.projectId) throw new Error("EXECUTION_POLICY_STALE: policy belongs to a different project.");
    if (current.operationExecutionRevision !== policy.operationExecutionRevision || !Number.isSafeInteger(current.operationExecutionRevision)) throw new Error("EXECUTION_POLICY_STALE: policy does not bind the current operation execution revision.");
    if (currentControllerEpoch(current) !== policy.controllerEpoch) throw new Error("EXECUTION_POLICY_STALE: policy does not bind the current controller epoch.");
    if (current.resolvedOperationPolicy && canonicalSerialize(current.resolvedOperationPolicy) !== canonicalSerialize(policy)) throw new Error("EXECUTION_POLICY_RECOMPILE_REQUIRED: execution semantics changed without advancing operationExecutionRevision.");
    return { ...current, resolvedOperationPolicy: policy, revision, updatedAt: now, lastProgressAt: now };
  });
}

export async function bindOperationExecutionSemantics(root: string, operationId: string, executionSemanticsDigest: string): Promise<OperationRecordV2> {
  if (!/^[a-f0-9]{64}$/.test(executionSemanticsDigest)) throw new Error("EXECUTION_SEMANTICS_INVALID: semantics digest must be a lowercase SHA-256 digest.");
  return mutateOperation(root, operationId, {}, true, "operation.execution-semantics.bound", (current, revision, now) => {
    if (!Number.isSafeInteger(current.operationExecutionRevision) || current.operationExecutionRevision! < 1) throw new Error("UNSUPPORTED_OPERATION_EXECUTION_REVISION: migrate this operation record before execution planning.");
    if (current.executionSemanticsDigest === executionSemanticsDigest) return { ...current, revision, updatedAt: now, lastProgressAt: now };
    const changed = current.executionSemanticsDigest !== undefined;
    const participants = changed ? Object.fromEntries(Object.entries(current.participants).map(([id, participant]) => [id, { ...participant, executionBinding: undefined }])) : current.participants;
    return { ...current, executionSemanticsDigest, ...(changed ? { operationExecutionRevision: current.operationExecutionRevision! + 1, resolvedOperationPolicy: undefined, participants } : {}), revision, updatedAt: now, lastProgressAt: now };
  });
}

export async function recordParticipantReceipt(root: string, operationId: string, receipt: ParticipantReceiptV1): Promise<OperationRecordV2> {
  const current = await loadOperation(root, operationId);
  if (!current.candidateRevision) throw new Error("V2_RECEIPT_REJECTED: operation has no current candidate revision.");
  await assertWorkspaceMatchesCandidate(candidateWorkspaceRoot(current, current.candidateRevision), current.candidateRevision);
  const decision = evaluateTerminalGate(receipt, { operationId, candidate: current.candidateRevision });
  if (!decision.allowed) throw new Error(`V2_RECEIPT_REJECTED: ${decision.reasons.map((reason) => reason.code).join(",")}`);
  return mutateOperation(root, operationId, {}, true, "operation.participant.receipt", async (latest, revision, now) => {
    if (!latest.candidateRevision) throw new Error("V2_RECEIPT_REJECTED: operation lost its current candidate revision.");
    if (!latest.participants[receipt.participantId]) throw new Error(`V2_RECEIPT_REJECTED: participant '${receipt.participantId}' is not registered for this operation.`);
    assertCurrentCandidateBinding(receipt.candidateBinding ?? receipt.candidate!, latest.candidateRevision);
    await assertWorkspaceMatchesCandidate(candidateWorkspaceRoot(latest, latest.candidateRevision), latest.candidateRevision);
    const previous = latest.participants[receipt.participantId];
    const status: OperationParticipantStatus = receipt.outcome === "SUCCEEDED" ? "COMPLETED" : receipt.outcome === "FAILED" ? "FAILED" : "CANCELLED";
    const participants = previous ? { ...latest.participants, [receipt.participantId]: { ...previous, status, finishedAt: previous.finishedAt ?? now, resultArtifact: (receipt.persistedArtifact ?? receipt.artifact)?.artifactId } } : latest.participants;
    return { ...latest, revision, updatedAt: now, lastProgressAt: now, participants, participantReceipts: { ...(latest.participantReceipts ?? {}), [receipt.receiptId]: receipt }, progress: deriveProgress(participants) };
  });
}

export async function setOperationStage(root: string, operationId: string, name: string, status: OperationStageStatus, options: { message?: string; artifact?: string } = {}): Promise<OperationRecordV2> {
  return mutateOperation(root, operationId, {}, true, "operation.stage", (current, revision, now) => { const previous = current.stages[name]; const terminal = ["COMPLETED", "FAILED", "BLOCKED", "SKIPPED"].includes(status); const stage: OperationStageRecord = { name, status, revision, startedAt: previous?.startedAt ?? (status === "RUNNING" ? now : undefined), finishedAt: terminal ? now : undefined, message: options.message ?? previous?.message, artifact: options.artifact ?? previous?.artifact }; return { ...current, revision, updatedAt: now, lastProgressAt: now, phase: name, stages: { ...current.stages, [name]: stage } }; });
}

export async function registerSupervisorGeneration(root: string, operationId: string, input: { agentId?: string; materialized: boolean; checkpointArtifact?: string; status?: SupervisorGenerationStatus; initializationAttempt?: number }): Promise<OperationRecordV2> {
  return mutateOperation(root, operationId, {}, true, "operation.supervisor.registered", (current, revision, now) => {
    const generations = current.supervision.generations.map((item) => item.status === "ACTIVE" ? { ...item, status: "DRAINING" as const, drainingAt: item.drainingAt ?? now } : item);
    const generation = Math.max(0, ...generations.map((item) => item.generation)) + 1;
    const status = input.status ?? "ACTIVE";
    generations.push({ generation, agentId: input.agentId, status, createdAt: now, activatedAt: status === "ACTIVE" ? now : undefined, checkpointArtifact: input.checkpointArtifact, initializationAttempt: input.initializationAttempt });
    const active = generations.find((item) => item.status === "ACTIVE");
    return { ...current, revision, updatedAt: now, lastProgressAt: now, supervision: { ...current.supervision, required: true, materialized: current.supervision.materialized || input.materialized, activeGeneration: active?.generation, generations } };
  });
}
export async function updateSupervisorGeneration(root: string, operationId: string, generation: number, patch: Partial<OperationSupervisorGeneration>): Promise<OperationRecordV2> { return mutateOperation(root, operationId, {}, true, "operation.supervisor.updated", (current, revision, now) => { let generations = current.supervision.generations.map((item) => item.generation === generation ? { ...item, ...patch } : item); if (patch.status === "ACTIVE") generations = generations.map((item) => item.generation !== generation && item.status === "ACTIVE" ? { ...item, status: "DRAINING" as const, drainingAt: item.drainingAt ?? now } : item); const active = generations.find((item) => item.status === "ACTIVE"); return { ...current, revision, updatedAt: now, lastProgressAt: now, supervision: { ...current.supervision, activeGeneration: active?.generation, generations } }; }); }
export function activeOperationSupervisor(record: OperationRecordV2): OperationSupervisorGeneration | undefined { const generation = record.supervision.activeGeneration; return generation === undefined ? undefined : record.supervision.generations.find((item) => item.generation === generation && item.status === "ACTIVE"); }
export function initializingOperationSupervisor(record: OperationRecordV2): OperationSupervisorGeneration | undefined { return [...record.supervision.generations].reverse().find((item) => item.status === "INITIALIZING"); }
export function recoverableOperationSupervisor(record: OperationRecordV2): OperationSupervisorGeneration | undefined { return activeOperationSupervisor(record) ?? initializingOperationSupervisor(record); }

export async function registerOperationAgent(root: string, operationId: string, agent: Omit<OperationAgentRecord, "registeredAt"> & { logicalAgent?: string; parentAgentId?: string; parentSupervisorGeneration?: number }): Promise<OperationRecordV2> {
  return mutateOperation(root, operationId, {}, true, "operation.participant.registered", (current, revision, now) => { const existingAgents = current.agents ?? []; const previousAgent = existingAgents.find((item) => item.id === agent.id); const compatibility: OperationAgentRecord = { ...previousAgent, id: agent.id, role: agent.role ?? previousAgent?.role, phase: agent.phase ?? previousAgent?.phase, workspaceId: agent.workspaceId ?? previousAgent?.workspaceId, transport: agent.transport ?? previousAgent?.transport, registeredAt: previousAgent?.registeredAt ?? now }; const agents = [...existingAgents.filter((item) => item.id !== agent.id), compatibility]; const logicalAgent = agent.logicalAgent ?? agent.role; if (logicalAgent === "operation-supervisor") return { ...current, revision, updatedAt: now, lastProgressAt: now, agents }; const previous = current.participants[agent.id]; const participant: OperationParticipantRecord = { ...previous, id: agent.id, logicalAgent: logicalAgent ?? previous?.logicalAgent, role: agent.role ?? previous?.role, stage: agent.phase ?? previous?.stage, phase: agent.phase ?? previous?.phase, parentSupervisorGeneration: agent.parentSupervisorGeneration ?? previous?.parentSupervisorGeneration ?? current.supervision.activeGeneration, parentAgentId: agent.parentAgentId ?? previous?.parentAgentId ?? activeOperationSupervisor(current)?.agentId, workspaceId: agent.workspaceId ?? previous?.workspaceId, transport: agent.transport ?? previous?.transport, status: previous?.status ?? "REGISTERED", registeredAt: previous?.registeredAt ?? now }; const participants = { ...current.participants, [agent.id]: participant }; return { ...current, revision, updatedAt: now, lastProgressAt: now, agents, participants, progress: deriveProgress(participants) }; });
}
export async function bindOperationParticipantExecution(root: string, operationId: string, input: {
  participantId: string;
  logicalAgent: string;
  role: string;
  binding: ExecutionBindingV2;
}): Promise<OperationRecordV2> {
  return mutateOperation(root, operationId, {}, true, "operation.participant.execution-bound", (current, revision, now) => {
    const binding = input.binding;
    assertExecutionBindingV2(binding);
    if (!current.resolvedOperationPolicy) throw new Error("EXECUTION_POLICY_REQUIRED: participant binding requires a frozen ResolvedOperationPolicy.");
    assertResolvedOperationPolicyV1(current.resolvedOperationPolicy);
    if (binding.operationPolicyDigest !== current.resolvedOperationPolicy.digest) throw new Error("EXECUTION_POLICY_MISMATCH: participant binding does not use the operation's frozen policy.");
    if (!current.candidateRevision || current.candidateRevision.identityDigest !== binding.candidateDigest || current.candidateRevision.revision !== binding.candidateRevision) {
      throw new Error("V2_RESULT_PROVENANCE: execution binding candidate is no longer current.");
    }
    if (binding.version !== 2) throw new Error("UNSUPPORTED_EXECUTION_BINDING_VERSION: expected version 2; relaunch this participant with a current binding.");
    if (current.operationExecutionRevision === undefined || current.operationExecutionRevision !== binding.operationExecutionRevision) throw new Error("V2_RESULT_PROVENANCE: execution binding operation execution revision is stale or unsupported.");
    if (currentControllerEpoch(current) !== binding.controllerEpoch) throw new Error("V2_RESULT_PROVENANCE: execution binding controller epoch is stale.");
    const previous = current.participants[input.participantId];
    if (!previous || previous.role !== input.role || previous.logicalAgent !== input.logicalAgent) {
      throw new Error("V2_RESULT_PROVENANCE: execution binding participant is not registered for this role.");
    }
    if (binding.operationId !== current.id || binding.participantId !== input.participantId) throw new Error("V2_RESULT_PROVENANCE: execution binding operation or participant identity is stale.");
    const participants = {
      ...current.participants,
      [input.participantId]: {
        ...previous,
        executionBinding: binding
      }
    };
    return { ...current, revision, updatedAt: now, lastProgressAt: now, participants };
  });
}
export async function updateOperationParticipant(root: string, operationId: string, agentId: string, patch: Partial<Omit<OperationParticipantRecord, "id" | "registeredAt" | "executionBinding">>): Promise<OperationRecordV2> { return mutateOperation(root, operationId, {}, true, "operation.participant.updated", (current, revision, now) => { const previous = current.participants[agentId] ?? { id: agentId, status: "REGISTERED" as const, registeredAt: now }; const status = isParticipantTerminal(previous.status) && patch.status && patch.status !== previous.status ? previous.status : patch.status; const effectivePatch = status === undefined ? patch : { ...patch, status }; const next: OperationParticipantRecord = { ...previous, ...effectivePatch, id: agentId, registeredAt: previous.registeredAt, startedAt: effectivePatch.status === "RUNNING" ? previous.startedAt ?? now : effectivePatch.startedAt ?? previous.startedAt, finishedAt: isParticipantTerminal(effectivePatch.status ?? previous.status) ? effectivePatch.finishedAt ?? previous.finishedAt ?? now : effectivePatch.finishedAt ?? previous.finishedAt }; const participants = { ...current.participants, [agentId]: next }; return { ...current, revision, updatedAt: now, lastProgressAt: now, participants, progress: deriveProgress(participants) }; }); }
export async function registerCurrentOperationAgent(root: string, agent: Omit<OperationAgentRecord, "registeredAt"> & { logicalAgent?: string; parentAgentId?: string; parentSupervisorGeneration?: number }): Promise<void> { const operationId = currentOperationContext().id; if (!operationId) return; try { await registerOperationAgent(resolveOperationStateRoot(root), operationId, agent); } catch { /* stale direct execution metadata is non-authoritative */ } }
export function currentOperationContext(): { id?: string; kind?: string; workspaceId?: string; controlRoot?: string } { return { id: process.env.AEH_OPERATION_ID?.trim() || undefined, kind: process.env.AEH_OPERATION_KIND?.trim() || undefined, workspaceId: process.env.AEH_OPERATION_WORKSPACE_ID?.trim() || undefined, controlRoot: process.env.AEH_CONTROL_ROOT?.trim() || undefined }; }
export async function updateCurrentOperationPhase(root: string, phase: string): Promise<void> { const operationId = currentOperationContext().id; if (!operationId) return; try { await setOperationStage(resolveOperationStateRoot(root), operationId, phase, "RUNNING"); } catch { /* direct/non-controller */ } }

export function normalizeOperationRecord(record: OperationRecord): OperationRecordV2 {
  if (record.version === 2) { const participants = record.participants ?? {}; return { ...record, version: 2 as const, revision: Math.max(1, record.revision || 1), lastProgressAt: record.lastProgressAt || record.updatedAt, supervision: record.supervision ?? defaultSupervision(record.kind), stages: record.stages ?? {}, participants, progress: record.progress ?? deriveProgress(participants), notification: record.notification ?? defaultNotification(), controller: record.controller ?? { epoch: 0, ownerId: "controller:none", claimedAt: record.createdAt } }; }
  const participants: Record<string, OperationParticipantRecord> = {};
  for (const agent of record.agents ?? []) { if (agent.role === "operation-supervisor") continue; participants[agent.id] = { id: agent.id, logicalAgent: agent.role, role: agent.role, stage: agent.phase, phase: agent.phase, workspaceId: agent.workspaceId, transport: agent.transport, status: "REGISTERED", registeredAt: agent.registeredAt }; }
  const normalized = { ...record, version: 2 as const, kind: record.kind, payload: record.payload, revision: 1, lastProgressAt: record.updatedAt, intent: inferIntent(record.kind, record.payload), supervision: defaultSupervision(record.kind), stages: record.phase ? { [record.phase]: { name: record.phase, status: isTerminal(record.status) ? terminalStageStatus(record.status) : "RUNNING", revision: 1, startedAt: record.startedAt, finishedAt: record.finishedAt } } : {}, participants, progress: deriveProgress(participants), notification: defaultNotification() };
  return normalized;
}

async function mutateOperation(root: string, operationId: string, patch: Partial<OperationRecordV2>, touchRevision: boolean, eventType: string, custom?: (current: OperationRecordV2, revision: number, now: string) => OperationRecordV2 | Promise<OperationRecordV2>, allowTerminalCustom = false): Promise<OperationRecordV2> {
  const stateRoot = resolveOperationStateRoot(root); const file = operationFile(stateRoot, operationId); await fs.mkdir(path.dirname(file), { recursive: true });
  return withOperationLock(file, async () => {
    const stored = await readStoredOperation(file);
    await recoverPendingOperationEvent(stateRoot, file, stored);
    const current = stored.record;
    assertControllerEpoch(current, controllerEpochFromEnvironment(), `operation mutation '${eventType}'`);
    if (patch.status && current.status === "QUEUED" && patch.status === "SUCCEEDED") throw new Error("Invalid operation status transition QUEUED -> SUCCEEDED.");
    if (patch.status && !isTerminal(current.status) && !isAllowedOperationStatusTransition(current.status, patch.status)) throw new Error(`Invalid operation status transition ${current.status} -> ${patch.status}.`);
    if (isTerminal(current.status) && custom && !allowTerminalCustom) return current;
    const guardedPatch = guardTerminalTransition(current, patch);
    const now = new Date().toISOString();
    const revision = touchRevision ? current.revision + 1 : current.revision;
    // Mutation callbacks receive the loaded record itself and can mutate nested
    // state in place. Capture every lifecycle-owned execution identity before a
    // callback can alias or re-key its containing objects.
    const executionIdentitySnapshot = snapshotExecutionIdentity(current);
    const candidate = custom ? await custom(current, revision, now) : ({ ...current, ...guardedPatch, version: 2, id: current.id, kind: current.kind, revision, updatedAt: now, lastProgressAt: touchRevision ? now : current.lastProgressAt } as OperationRecordV2);
    const next = normalizeOperationRecord(candidate);
    if (!sameOptionalCandidate(current.candidateRevision, next.candidateRevision)) {
      if (eventType !== "operation.candidate.bound") throw new Error("V2_CANDIDATE_IMMUTABLE: CandidateRevision changes must use the candidate binding lifecycle.");
      if (current.candidateRevision && next.candidateRevision?.revision !== current.candidateRevision.revision + 1) throw new Error("V2_CANDIDATE_IMMUTABLE: CandidateRevision must advance by exactly one revision.");
      if (!current.candidateRevision && next.candidateRevision?.revision !== 1) throw new Error("V2_CANDIDATE_IMMUTABLE: the first CandidateRevision must start at revision 1.");
    }
    assertExecutionIdentityTransition(next, eventType, executionIdentitySnapshot);
    await commitOperationRecord(stateRoot, file, next, eventType, Object.keys(patch));
    return next;
  });
}

interface ExecutionIdentityTransitionSnapshot {
  readonly operationExecutionRevision: number | undefined;
  readonly executionSemanticsDigest: string | undefined;
  readonly resolvedOperationPolicyCanonical: string | undefined;
  readonly participantIds: ReadonlySet<string>;
  readonly canonicalByParticipantId: ReadonlyMap<string, string | undefined>;
}

function snapshotExecutionIdentity(record: OperationRecordV2): ExecutionIdentityTransitionSnapshot {
  const participants = record.participants;
  const participantIds = new Set(Object.keys(participants));
  const canonicalByParticipantId = new Map<string, string | undefined>();
  for (const participantId of participantIds) {
    const binding = participants[participantId]?.executionBinding;
    canonicalByParticipantId.set(participantId, binding === undefined ? undefined : canonicalSerialize(binding));
  }
  return {
    operationExecutionRevision: record.operationExecutionRevision,
    executionSemanticsDigest: record.executionSemanticsDigest,
    resolvedOperationPolicyCanonical: record.resolvedOperationPolicy ? canonicalSerialize(record.resolvedOperationPolicy) : undefined,
    participantIds,
    canonicalByParticipantId
  };
}

function assertExecutionIdentityTransition(
  next: OperationRecordV2,
  eventType: string,
  snapshot: ExecutionIdentityTransitionSnapshot
): void {
  const semanticsEvent = "operation.execution-semantics.bound";
  const semanticsChanged = snapshot.executionSemanticsDigest !== next.executionSemanticsDigest;
  if (semanticsChanged && eventType !== semanticsEvent) {
    throw new Error("EXECUTION_SEMANTICS_IMMUTABLE: executionSemanticsDigest may change only through operation.execution-semantics.bound.");
  }
  if (eventType === semanticsEvent && next.executionSemanticsDigest !== undefined && !/^[a-f0-9]{64}$/.test(next.executionSemanticsDigest)) {
    throw new Error("EXECUTION_SEMANTICS_INVALID: semantics digest must be a lowercase SHA-256 digest.");
  }

  const semanticsRebind = eventType === semanticsEvent && snapshot.executionSemanticsDigest !== undefined && semanticsChanged;
  const canInvalidate = new Set(["operation.candidate.bound", "operation.controller.claimed"]);
  if (semanticsRebind) canInvalidate.add(semanticsEvent);
  assertOperationPolicyTransition(snapshot.resolvedOperationPolicyCanonical, next.resolvedOperationPolicy, eventType, canInvalidate);
  const bindingParticipantIds = new Set([...snapshot.participantIds, ...Object.keys(next.participants)]);
  const bindingChanges = [...bindingParticipantIds].flatMap((id) => {
    const previousHasBinding = snapshot.participantIds.has(id)
      && snapshot.canonicalByParticipantId.get(id) !== undefined;
    const previousCanonical = previousHasBinding ? snapshot.canonicalByParticipantId.get(id) : undefined;
    const following = next.participants[id]?.executionBinding;
    const followingHasBinding = following !== undefined;
    const followingCanonical = followingHasBinding ? canonicalSerialize(following) : undefined;
    if (previousHasBinding === followingHasBinding && (!previousHasBinding || previousCanonical === followingCanonical)) return [];
    return [{ participantId: id, following }];
  });
  if (bindingChanges.length && eventType === "operation.participant.execution-bound") {
    if (bindingChanges.length !== 1 || !bindingChanges[0].following) throw new Error("EXECUTION_BINDING_IMMUTABLE: participant binding lifecycle may only create or replace one execution binding.");
    assertExecutionBindingV2(bindingChanges[0].following);
  } else if (bindingChanges.length && canInvalidate.has(eventType)) {
    if (bindingChanges.some(({ following }) => following !== undefined)) throw new Error("EXECUTION_BINDING_IMMUTABLE: candidate assembly, controller takeover, and execution-semantics recompilation may only invalidate execution bindings.");
  } else if (bindingChanges.length) {
    throw new Error("EXECUTION_BINDING_IMMUTABLE: execution bindings may change only through participant binding, candidate assembly, controller takeover, or execution-semantics recompilation.");
  }

  if (semanticsRebind) {
    if (next.resolvedOperationPolicy !== undefined) throw new Error("EXECUTION_POLICY_IMMUTABLE: changed execution semantics must clear the frozen ResolvedOperationPolicy.");
    if (Object.values(next.participants).some((participant) => participant.executionBinding !== undefined)) {
      throw new Error("EXECUTION_BINDING_IMMUTABLE: changed execution semantics must clear every participant execution binding.");
    }
  }

  assertOperationExecutionRevisionTransition(snapshot, next, eventType, semanticsChanged);
}

function assertOperationExecutionRevisionTransition(
  snapshot: ExecutionIdentityTransitionSnapshot,
  next: OperationRecordV2,
  eventType: string,
  semanticsChanged: boolean
): void {
  const previous = snapshot.operationExecutionRevision;
  const following = next.operationExecutionRevision;
  const candidateEvent = "operation.candidate.bound";
  const semanticsEvent = "operation.execution-semantics.bound";

  if (eventType === candidateEvent || eventType === semanticsEvent) {
    if (!Number.isSafeInteger(previous) || previous! < 1) {
      throw new Error("UNSUPPORTED_OPERATION_EXECUTION_REVISION: migrate this operation record before changing execution identity.");
    }
    const advances = eventType === candidateEvent
      || (eventType === semanticsEvent && snapshot.executionSemanticsDigest !== undefined && semanticsChanged);
    const expected = previous! + (advances ? 1 : 0);
    if (following !== expected) {
      throw new Error("OPERATION_EXECUTION_REVISION_INVALID: operationExecutionRevision may advance exactly once only for candidate binding or changed, previously bound execution semantics.");
    }
    return;
  }

  if (following !== previous) {
    throw new Error("OPERATION_EXECUTION_REVISION_INVALID: operationExecutionRevision is initialized only at operation creation and cannot change through generic operation events.");
  }
}
/**
 * A frozen ResolvedOperationPolicy changes only through its explicit lifecycle:
 * `operation.policy.bound` may create a policy or rebind the complete unchanged
 * canonical value; candidate assembly, controller takeover and
 * execution-semantics recompilation may only clear it. Every other change fails
 * closed. The comparison uses the complete canonical policy value captured
 * before any mutation callback could alter the loaded record, so a changed body
 * cannot hide behind a retained declared digest or an in-place mutation.
 */
function assertOperationPolicyTransition(currentCanonical: string | undefined, next: ResolvedOperationPolicyV1 | undefined, eventType: string, invalidatingEvents: ReadonlySet<string>): void {
  if (eventType === "operation.policy.bound") {
    if (next === undefined) throw new Error("EXECUTION_POLICY_IMMUTABLE: operation.policy.bound must persist a frozen ResolvedOperationPolicy.");
    assertResolvedOperationPolicyV1(next);
    const nextCanonical = canonicalSerialize(next);
    if (currentCanonical === undefined || currentCanonical === nextCanonical) return;
    throw new Error("EXECUTION_POLICY_IMMUTABLE: a bound ResolvedOperationPolicy may be rebound only with the complete unchanged canonical value.");
  }
  const nextCanonical = next === undefined ? undefined : canonicalSerialize(next);
  if (currentCanonical === nextCanonical) return;
  if (invalidatingEvents.has(eventType)) {
    if (next !== undefined) throw new Error("EXECUTION_POLICY_IMMUTABLE: candidate assembly, controller takeover, and execution-semantics recompilation may only clear a frozen ResolvedOperationPolicy.");
    return;
  }
  throw new Error("EXECUTION_POLICY_IMMUTABLE: frozen ResolvedOperationPolicy changes require candidate assembly, controller takeover, or execution-semantics recompilation.");
}
function sameOptionalCandidate(left: CandidateRevisionV1 | undefined, right: CandidateRevisionV1 | undefined): boolean {
  return left === undefined || right === undefined ? left === right : candidateRevisionsEqual(left, right);
}
async function commitOperationRecord(root: string, file: string, record: OperationRecordV2, type: string, changed?: string[], details?: Record<string, unknown>): Promise<void> {
  const event: OperationEvent = { version: 1, operationId: record.id, revision: record.revision, at: new Date().toISOString(), type, status: record.status, phase: record.phase, changed, details };
  await fs.mkdir(path.dirname(operationEventsFile(root, record.id)), { recursive: true });
  await writeStoredRecord(file, record, event);
  await persistOperationEvent(root, event);
  await writeRecord(file, record);
}
async function readStoredOperation(file: string): Promise<{ record: OperationRecordV2; pendingEvent?: OperationEvent }> {
  const raw = JSON.parse(await fs.readFile(file, "utf8")) as StoredOperationRecord;
  const { _pendingOperationEvent: pendingEvent, ...record } = raw;
  return { record: normalizeOperationRecord(record as OperationRecord), pendingEvent };
}
async function recoverPendingOperationEvent(root: string, file: string, stored: { record: OperationRecordV2; pendingEvent?: OperationEvent }): Promise<void> {
  if (!stored.pendingEvent) return;
  if (stored.pendingEvent.operationId !== stored.record.id || stored.pendingEvent.revision !== stored.record.revision) {
    throw new Error(`AEH_OPERATION_EVENT_OUTBOX_INVALID: pending event does not match operation ${stored.record.id} revision ${stored.record.revision}.`);
  }
  await persistOperationEvent(root, stored.pendingEvent);
  await writeRecord(file, stored.record);
  stored.pendingEvent = undefined;
}
async function persistOperationEvent(root: string, event: OperationEvent): Promise<void> {
  const file = operationEventsFile(root, event.operationId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  let content = await fs.readFile(file, "utf8").catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") return "";
    throw error;
  });
  const lines = content.split("\n");
  const terminated = content.endsWith("\n");
  const completeLineCount = terminated ? lines.length - 1 : Math.max(0, lines.length - 1);
  const target = JSON.stringify(event);
  for (let index = 0; index < completeLineCount; index++) {
    if (!lines[index]) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(lines[index]); }
    catch { throw new Error(`AEH_OPERATION_EVENT_LOG_CORRUPT: invalid event at line ${index + 1} in ${file}.`); }
    if (JSON.stringify(parsed) === target) return;
  }
  if (!terminated && lines.length > 0 && lines[lines.length - 1]) {
    const trailingLine = lines[lines.length - 1]!;
    try {
      const parsed = JSON.parse(trailingLine) as unknown;
      if (JSON.stringify(parsed) === target) {
        await fs.appendFile(file, "\n");
        return;
      }
      await fs.appendFile(file, "\n");
    } catch {
      const lastNewline = content.lastIndexOf("\n");
      await fs.truncate(file, lastNewline + 1);
      content = content.slice(0, lastNewline + 1);
    }
  }
  const handle = await fs.open(file, "a");
  try {
    await handle.writeFile(`${target}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function writeStoredRecord(file: string, record: OperationRecordV2, pendingEvent: OperationEvent): Promise<void> {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const stored: StoredOperationRecord = { ...record, _pendingOperationEvent: pendingEvent };
  await fs.writeFile(temp, `${JSON.stringify(stored, null, 2)}\n`);
  try { await fs.rename(temp, file); } finally { await fs.rm(temp, { force: true }).catch(() => undefined); }
}
async function writeRecord(file: string, record: OperationRecordV2): Promise<void> { const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`; await fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`); try { await fs.rename(temp, file); } finally { await fs.rm(temp, { force: true }).catch(() => undefined); } }
export async function withOperationCoordinationLock<T>(root: string, operationId: string, action: () => Promise<T>): Promise<T> { const stateRoot = resolveOperationStateRoot(root); const file = `${operationFile(stateRoot, operationId)}.coordination`; await fs.mkdir(path.dirname(file), { recursive: true }); return withOperationLock(file, action); }
async function withOperationLock<T>(file: string, action: () => Promise<T>): Promise<T> { const lock = `${file}.lock`; const deadline = Date.now() + LOCK_TIMEOUT_MS; for (;;) { let handle: Awaited<ReturnType<typeof fs.open>> | undefined; try { handle = await fs.open(lock, "wx"); try { await handle.writeFile(`${process.pid}\n`); return await action(); } finally { await handle.close().catch(() => undefined); await fs.rm(lock, { force: true }).catch(() => undefined); } } catch (error) { if (handle) { await handle.close().catch(() => undefined); await fs.rm(lock, { force: true }).catch(() => undefined); throw error; } if (!isAlreadyExists(error)) throw error; if (await canRecoverLock(lock)) { await fs.rm(lock, { force: true }).catch(() => undefined); continue; } if (Date.now() >= deadline) throw new Error(`Timed out acquiring operation state lock for ${path.basename(file)}.`); await delay(LOCK_RETRY_MS); } } }
async function canRecoverLock(lock: string): Promise<boolean> { try { const [rawPid, stat] = await Promise.all([fs.readFile(lock, "utf8").catch(() => ""), fs.stat(lock)]); const ownerPid = Number.parseInt(rawPid.trim(), 10); if (Number.isInteger(ownerPid) && ownerPid > 0 && !processAlive(ownerPid)) return true; return Date.now() - stat.mtimeMs > STALE_LOCK_MS; } catch { return true; } }
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

function guardTerminalTransition(current: OperationRecordV2, patch: Partial<OperationRecordV2>): Partial<OperationRecordV2> { if (!isTerminal(current.status)) return patch; const { status: _status, phase: _phase, result: _result, error: _error, finishedAt: _finishedAt, ...metadata } = patch; return metadata; }
function deriveProgress(participants: Record<string, OperationParticipantRecord>): OperationProgress { const values = Object.values(participants); return { expected: values.length, registered: values.filter((item) => item.status === "REGISTERED" || item.status === "IDLE").length, running: values.filter((item) => item.status === "RUNNING").length, completed: values.filter((item) => item.status === "COMPLETED").length, failed: values.filter((item) => item.status === "FAILED" || item.status === "CANCELLED").length, blocked: values.filter((item) => item.status === "BLOCKED").length }; }
function assertSuccessTerminalEvidence(record: OperationRecordV2): void {
  if (!record.candidateRevision) throw new Error("V2_TERMINAL_GATE_REJECTED: successful operations require a current candidate revision.");
  if (!Object.keys(record.participantReceipts ?? {}).length) throw new Error("V2_TERMINAL_GATE_REJECTED: successful operations require at least one terminal receipt.");
  for (const participant of Object.values(record.participants)) {
    const receipt = Object.values(record.participantReceipts ?? {}).find((item) => item.participantId === participant.id);
    if (!receipt) throw new Error(`V2_TERMINAL_GATE_REJECTED: participant ${participant.id} has no terminal receipt.`);
    const decision = evaluateTerminalGate(receipt, { operationId: record.id, candidate: record.candidateRevision });
    if (!decision.allowed) throw new Error(`V2_TERMINAL_GATE_REJECTED: ${decision.reasons.map((reason) => reason.code).join(",")}`);
  }
}

async function createControllerTerminalReceipt(stateRoot: string, record: OperationRecordV2, patch: Partial<OperationRecordV2>): Promise<OperationRecordV2> {
  if (!record.candidateRevision) throw new Error("V2_TERMINAL_GATE_REJECTED: successful operations require a current candidate revision.");
  await assertWorkspaceMatchesCandidate(candidateWorkspaceRoot(record, record.candidateRevision), record.candidateRevision);
  const now = new Date().toISOString();
  const artifactId = `controller-terminal-${record.id}.json`;
  const artifactPath = path.join(operationArtifactDir(stateRoot, record.id), artifactId);
  const content = `${JSON.stringify({ operationId: record.id, candidate: record.candidateRevision, result: patch.result ?? null, createdAt: now })}\n`;
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  await fs.writeFile(artifactPath, content, { encoding: "utf8", mode: 0o600 });
  try { await assertWorkspaceMatchesCandidate(candidateWorkspaceRoot(record, record.candidateRevision), record.candidateRevision); }
  catch (error) { await fs.rm(artifactPath, { force: true }).catch(() => undefined); throw error; }
  const artifactDigest = sha256Utf8(content);
  const contractDigest = sha256Canonical(record.payload);
  const provenanceDigest = sha256Utf8(`${record.candidateRevision.identityDigest}:${artifactDigest}`);
  const receipt: ParticipantReceiptV1 = {
    version: 1,
    receiptId: `receipt:controller:${record.id}:${record.revision + 1}`,
    operationId: record.id,
    participantId: `controller:${record.id}`,
    role: "operation-controller",
    phase: record.phase,
    candidate: record.candidateRevision,
    outcome: "SUCCEEDED",
    runtimeTerminal: { kind: "runtime-terminal", eventId: `terminal:${record.id}:${record.revision + 1}`, observedAt: now, terminal: true, status: "SUCCEEDED", exitCode: 0 },
    contract: { contractId: `operation:${record.id}`, contractDigest, valid: true },
    artifact: { artifactId: path.relative(stateRoot, artifactPath).replaceAll("\\", "/"), artifactDigest, persisted: true, persistedAt: now },
    provenance: { provenanceId: `provenance:${record.id}:${record.revision + 1}`, provenanceDigest, source: "operation-controller", valid: true },
    settled: true,
    createdAt: now
  };
  return { ...record, participantReceipts: { ...(record.participantReceipts ?? {}), [receipt.receiptId]: receipt } };
}

function candidateWorkspaceRoot(record: OperationRecordV2, candidate: CandidateRevisionV1): string {
  return path.resolve(candidate.worktree ?? record.workspaceRoot ?? record.root);
}
function settleParticipants(participants: Record<string, OperationParticipantRecord>, status: Extract<OperationStatus, "SUCCEEDED" | "FAILED" | "CANCELLED">, finishedAt: string): Record<string, OperationParticipantRecord> { const participantStatus: OperationParticipantStatus = status === "SUCCEEDED" ? "COMPLETED" : status === "FAILED" ? "FAILED" : "CANCELLED"; return Object.fromEntries(Object.entries(participants).map(([id, participant]) => isParticipantTerminal(participant.status) ? [id, participant] : [id, { ...participant, status: participantStatus, finishedAt: participant.finishedAt ?? finishedAt }])); }
function isParticipantTerminal(status: OperationParticipantStatus): boolean { return status === "COMPLETED" || status === "FAILED" || status === "CANCELLED"; }
function settleSupervision(supervision: OperationSupervisionState, at: string): OperationSupervisionState { return { ...supervision, activeGeneration: undefined, generations: supervision.generations.map((generation) => generation.status === "ACTIVE" || generation.status === "INITIALIZING" ? { ...generation, status: "DRAINING" as const, drainingAt: generation.drainingAt ?? at } : generation) }; }
function defaultSupervision(kind: OperationKind): OperationSupervisionState { return { required: kind === "audit" || kind === "change", materialized: false, generations: [] }; }
function defaultNotification(): OperationNotificationState { return { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 }; }
function inferIntent(kind: OperationKind, payload: OperationPayload): OperationIntentState { if (kind === "audit") { const audit = payload as AuditOperationPayload; return { request: audit.request, classification: "AUDIT", risk: audit.risk }; } if (kind === "change") { const change = payload as ChangeOperationPayload; return { request: change.request, classification: "CHANGE", risk: change.risk, priority: change.priority }; } return { classification: "RUN", priority: (payload as RunOperationPayload).priority }; }
function terminalStageStatus(status: OperationStatus): OperationStageStatus { return status === "SUCCEEDED" ? "COMPLETED" : status === "CANCELLED" ? "SKIPPED" : "FAILED"; }
export function isTerminalOperation(status: OperationStatus): boolean { return isTerminal(status); }
function isTerminal(status: OperationStatus): boolean { return status === "SUCCEEDED" || status === "FAILED" || status === "CANCELLED"; }
function requiredId(value: string): string { const trimmed = value.trim(); if (!trimmed) throw new Error("agent id is required"); return trimmed; }
function safeId(value: string): string { if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`Invalid operation id '${value}'.`); return value; }
function isAlreadyExists(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EEXIST"); }
function isNotFound(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT"); }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
