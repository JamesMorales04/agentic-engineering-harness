import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import type { IntentDecisionV1 } from "../audit/intentDecision.js";
import type { ChangePreflightV1 } from "../core/triage.js";
import { assertCurrentCandidateBinding, assertCandidateRevisionV1, createCandidateRevisionV1, evaluateTerminalGate, candidateRevisionsEqual, type CandidateRevisionV1, type ParticipantReceiptV1 } from "./v2Contracts.js";
import { canonicalSerialize, sha256Canonical, sha256Utf8 } from "../core/digest.js";
import { computeWorktreeDigest } from "../core/git.js";
import { assertWorkspaceMatchesCandidate } from "../candidates/identity.js";
import { assertExecutionBindingV2, assertResolvedOperationPolicyV1, type ExecutionBindingV2, type ResolvedOperationPolicyV1 } from "../architecture/executionIdentity.js";
import { evaluateObjectiveCompletionV1, type ObjectiveCompletionInputV1 } from "../architecture/objectiveCompletion.js";
import { currentObjectiveIdentityV1, loadCurrentAcceptanceOracleArtifactV1, type AcceptanceOracleDispositionV1 } from "../architecture/acceptanceOracle.js";
import { HumanDecisionLedgerV2, assertContinuationRecordV1, assertDecisionRequestV1, type ContinuationRecordV1, type DecisionRequestV1, type HumanDecisionBindingV2, type HumanDecisionV2, type OperationControlCommandV1 } from "../security/humanDecision.js";

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

export interface OperationAgentRecord { id: string; role?: string; phase?: string; workspaceId?: string; transport?: string; registeredAt: string; executionBinding?: ExecutionBindingV2; }
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

export const operationPauseRevalidationValuesV1 = [
  "candidate-current",
  "operation-revision-current",
  "policy-current",
  "controller-epoch-current",
  "continuation-current"
] as const;
export type OperationPauseRevalidationV1 = (typeof operationPauseRevalidationValuesV1)[number];

/** Proof that the controller observed no active mutable writer before PAUSED. */
export interface OperationPauseDrainReceiptV1 {
  activeParticipantIds: string[];
  activeProviderLeaseIds: string[];
  observedAt: string;
}

/**
 * Durable PAUSED suspension record. It overlays the saved resume phase and is
 * removed only by a controller-owned resume that revalidates the full binding.
 */
export interface OperationPauseRecordV1 extends HumanDecisionBindingV2 {
  version: 1;
  resumePhase: string;
  reason: string;
  requestedBy: string;
  requestedAt: string;
  pausedAt: string;
  drainReceipt: OperationPauseDrainReceiptV1;
  requiredRevalidation: OperationPauseRevalidationV1[];
  state: "PAUSED";
}

export function assertOperationPauseRecordV1(value: unknown): OperationPauseRecordV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("OPERATION_PAUSE_RECORD_INVALID: pause record must be an object.");
  const record = value as OperationPauseRecordV1;
  if (record.version !== 1 || record.state !== "PAUSED") throw new Error("OPERATION_PAUSE_RECORD_INVALID: unsupported pause record version or state.");
  assertCandidateRevisionV1(record.candidate);
  if (!Number.isSafeInteger(record.operationExecutionRevision) || record.operationExecutionRevision < 1) throw new Error("OPERATION_PAUSE_RECORD_INVALID: operationExecutionRevision must be a positive safe integer.");
  if (!/^[a-f0-9]{64}$/.test(record.policyDigest)) throw new Error("OPERATION_PAUSE_RECORD_INVALID: policyDigest must be a lowercase SHA-256 digest.");
  if (!Number.isSafeInteger(record.controllerEpoch) || record.controllerEpoch < 0) throw new Error("OPERATION_PAUSE_RECORD_INVALID: controllerEpoch must be a non-negative safe integer.");
  if (typeof record.operationId !== "string" || !record.operationId.trim() || record.candidate.operationId !== record.operationId) throw new Error("OPERATION_PAUSE_RECORD_INVALID: operation identity is incomplete.");
  if (typeof record.resumePhase !== "string" || !record.resumePhase.trim()) throw new Error("OPERATION_PAUSE_RECORD_INVALID: resumePhase is required.");
  if (typeof record.reason !== "string" || !record.reason.trim()) throw new Error("OPERATION_PAUSE_RECORD_INVALID: reason is required.");
  if (typeof record.requestedBy !== "string" || !record.requestedBy.startsWith("human:")) throw new Error("OPERATION_PAUSE_RECORD_INVALID: requestedBy must be a paired human actor.");
  if (Number.isNaN(Date.parse(record.requestedAt)) || Number.isNaN(Date.parse(record.pausedAt))) throw new Error("OPERATION_PAUSE_RECORD_INVALID: pause instants are invalid.");
  if (!record.drainReceipt || !Array.isArray(record.drainReceipt.activeParticipantIds) || !Array.isArray(record.drainReceipt.activeProviderLeaseIds)
    || Number.isNaN(Date.parse(record.drainReceipt.observedAt))) throw new Error("OPERATION_PAUSE_RECORD_INVALID: drain receipt is incomplete.");
  if (!Array.isArray(record.requiredRevalidation) || record.requiredRevalidation.length !== operationPauseRevalidationValuesV1.length
    || new Set(record.requiredRevalidation).size !== operationPauseRevalidationValuesV1.length
    || operationPauseRevalidationValuesV1.some((item) => !record.requiredRevalidation.includes(item))) {
    throw new Error("OPERATION_PAUSE_RECORD_INVALID: requiredRevalidation must contain every current-identity check exactly once.");
  }
  return record;
}

export interface OperationRecordV1 {
  version: 1; id: string; kind: "audit" | "run"; status: OperationStatus; phase: string; root: string;
  payload: AuditOperationPayload | RunOperationPayload; createdAt: string; updatedAt: string; startedAt?: string; finishedAt?: string;
  pid?: number; workspaceId?: string; workspaceWarning?: string; agents?: OperationAgentRecord[]; cleanupWarnings?: string[]; result?: Record<string, unknown>; error?: string;
}
export interface OperationRecordV2 {
  version: 2; id: string; kind: OperationKind; status: OperationStatus; phase: string; root: string; workspaceRoot?: string;
  payload: OperationPayload; revision: number; createdAt: string; updatedAt: string; lastProgressAt: string; startedAt?: string; finishedAt?: string;
  pid?: number; workspaceId?: string; workspaceWarning?: string; intent?: OperationIntentState; lead?: OperationLeadBinding;
  changePreflight?: ChangePreflightV1;
  supervision: OperationSupervisionState; stages: Record<string, OperationStageRecord>; participants: Record<string, OperationParticipantRecord>;
  progress: OperationProgress; notification: OperationNotificationState; agents?: OperationAgentRecord[]; cleanupWarnings?: string[]; result?: Record<string, unknown>; error?: string;
  candidateRevision?: CandidateRevisionV1; participantReceipts?: Record<string, ParticipantReceiptV1>;
  /** Changes only when operation execution semantics change; record revision remains event/order identity. */
  operationExecutionRevision?: number;
  executionSemanticsDigest?: string;
  resolvedOperationPolicy?: ResolvedOperationPolicyV1;
  controller?: OperationControllerBinding;
  decisionRequest?: DecisionRequestV1;
  continuation?: ContinuationRecordV1;
  pause?: OperationPauseRecordV1;
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
      taskId: normalized.kind === "run"
        ? (normalized.payload as RunOperationPayload).taskId
        : normalized.kind === "change"
          ? ((normalized.payload as ChangeOperationPayload).taskId?.trim() || normalized.id)
          : normalized.id,
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
    await commitOperationRecord(stateRoot, file, normalized, "operation.created", ["status", "phase", "candidateRevision", "intent", "changePreflight"]);
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
    if (isTerminal(current.status)) return { record: current, transitioned: false };
    assertCurrentControllerOwner(current, "terminal transition");
    if (!isAllowedOperationStatusTransition(current.status, patch.status)) throw new Error(`Invalid operation status transition ${current.status} -> ${patch.status}.`);
    if (patch.status === "SUCCEEDED") {
      if (!current.candidateRevision) throw new Error("V2_TERMINAL_GATE_REJECTED: successful operations require a current candidate revision.");
      await assertWorkspaceMatchesCandidate(candidateWorkspaceRoot(current, current.candidateRevision), current.candidateRevision);
    }
    if (patch.status === "SUCCEEDED" && Object.keys(current.participants).length === 0 && Object.keys(current.participantReceipts ?? {}).length === 0) {
      current = await createControllerTerminalReceipt(stateRoot, current, patch);
    }
    if (patch.status === "SUCCEEDED") await assertSuccessTerminalEvidence(stateRoot, current, patch.result);
    const now = new Date().toISOString(); const revision = current.revision + 1; const participants = settleParticipants(current.participants, patch.status, now); const supervision = settleSupervision(current.supervision, now);
    const next = normalizeOperationRecord({ ...current, ...patch, version: 2, id: current.id, kind: current.kind, revision, updatedAt: now, lastProgressAt: now, finishedAt: patch.finishedAt ?? now, participants, progress: deriveProgress(participants), supervision, decisionRequest: undefined, continuation: undefined, pause: undefined, stages: { ...current.stages, finished: { name: "finished", status: terminalStageStatus(patch.status), revision, startedAt: now, finishedAt: now } } } as OperationRecordV2);
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

/** Require both the current durable epoch and its controller token for owner-only mutations. */
export function assertCurrentControllerOwner(record: OperationRecordV2, action: string): void {
  const expected = controllerEpochFromEnvironment();
  if (expected === undefined) throw new Error(`V2_CONTROLLER_FENCED: ${action} requires the current controller epoch.`);
  assertControllerEpoch(record, expected, action);
  assertControllerToken(record, action);
}

/** Claim durable monotonic controller ownership. Every takeover increments the epoch and mints a new controller token. */
export async function claimControllerEpoch(root: string, operationId: string, ownerId: string, options: {
  pid?: number;
  cause?: "cancellation";
  humanActorId?: string;
  expectedCancellation?: { operationExecutionRevision: number; candidateDigest: string; policyDigest: string; controllerEpoch: number };
} = {}): Promise<OperationRecordV2> {
  const token = crypto.randomBytes(32).toString("hex");
  const record = await mutateOperation(root, operationId, {}, true, "operation.controller.claimed", async (current, revision, now) => {
    if (isTerminal(current.status)) throw new Error("V2_CONTROLLER_FENCED: terminal operations cannot acquire controller ownership.");
    if (options.cause === "cancellation") await consumeControllerCancellationDecision(root, current, options);
    const currentOwner = controllerEpochFromEnvironment() === currentControllerEpoch(current)
      && Boolean(controllerTokenFromEnvironment())
      && current.controller?.tokenDigest === sha256Utf8(controllerTokenFromEnvironment()!);
    if (current.controller?.tokenDigest && !currentOwner && options.cause !== "cancellation") {
      const ownerPid = current.controller.pid;
      if (!ownerPid || processAlive(ownerPid)) throw new Error("V2_CONTROLLER_FENCED: a live or unproven controller owner cannot be displaced without an authorized cancellation.");
    }
    return {
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
    };
  });
  process.env.AEH_CONTROLLER_TOKEN = token;
  process.env.AEH_CONTROLLER_EPOCH = String(currentControllerEpoch(record));
  return record;
}

async function consumeControllerCancellationDecision(root: string, current: OperationRecordV2, options: {
  humanActorId?: string;
  expectedCancellation?: { operationExecutionRevision: number; candidateDigest: string; policyDigest: string; controllerEpoch: number };
}): Promise<void> {
  const candidate = current.candidateRevision;
  const policy = current.resolvedOperationPolicy;
  if (!candidate || !policy || !Number.isSafeInteger(current.operationExecutionRevision)) {
    throw new Error("AEH_CANCELLATION_AUTHORITY_REQUIRED: cancellation requires current candidate, execution revision, and frozen policy identity.");
  }
  assertResolvedOperationPolicyV1(policy);
  if (policy.operationId !== current.id || policy.operationExecutionRevision !== current.operationExecutionRevision
    || policy.candidateRevision !== candidate.revision || policy.candidateDigest !== candidate.identityDigest
    || policy.controllerEpoch !== currentControllerEpoch(current) || (candidate.projectId && policy.projectId !== candidate.projectId)) {
    throw new Error("AEH_CANCELLATION_POLICY_STALE: cancellation policy does not match the current operation, candidate, execution revision, project, and epoch.");
  }
  const expected = options.expectedCancellation;
  if (expected && (expected.operationExecutionRevision !== current.operationExecutionRevision
    || expected.candidateDigest !== candidate.identityDigest || expected.policyDigest !== policy.digest
    || expected.controllerEpoch !== currentControllerEpoch(current))) {
    throw new Error("AEH_CANCELLATION_POLICY_STALE: operation identity changed after cancellation was requested.");
  }
  const binding = {
    operationId: current.id,
    candidate,
    operationExecutionRevision: current.operationExecutionRevision!,
    policyDigest: policy.digest,
    controllerEpoch: currentControllerEpoch(current)
  };
  const purpose = { kind: "OPERATION_CONTROL" as const, command: "CANCEL" as const };
  const ledger = new HumanDecisionLedgerV2(path.resolve(resolveOperationStateRoot(root), ".harness", "security", "human-decisions.json"));
  const now = new Date();
  if (options.humanActorId) {
    const existing = (await ledger.active(binding, now)).some((decision) => decision.actorId === options.humanActorId
      && decision.kind === "CANCEL" && canonicalSerialize(decision.purpose) === canonicalSerialize(purpose));
    if (!existing) await ledger.record({
      ...binding,
      purpose,
      kind: "CANCEL",
      actorId: options.humanActorId,
      reason: "Authenticated Control Center cancellation request.",
      createdAt: now,
      expiresAt: new Date(now.getTime() + 10 * 60_000)
    });
  }
  const decision = await ledger.consume(binding, purpose, options.humanActorId, now);
  if (decision.kind !== "CANCEL") throw new Error("AEH_CANCELLATION_AUTHORITY_REQUIRED: a scoped human CANCEL decision is required.");
}

/** Bind detached-process identity without changing the current owner's epoch or token. */
export async function bindControllerProcess(root: string, operationId: string, pid: number): Promise<OperationRecordV2> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("V2_CONTROLLER_PROCESS_INVALID: controller pid must be a positive safe integer.");
  return mutateOperation(root, operationId, {}, true, "operation.controller.process-bound", (current, revision, now) => {
    if (!current.controller?.tokenDigest) throw new Error("V2_CONTROLLER_FENCED: controller process binding requires an owned operation.");
    return { ...current, revision, updatedAt: now, lastProgressAt: now, controller: { ...current.controller, pid } };
  });
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
export async function acknowledgeOperationLead(root: string, operationId: string, revision: number, actorId: string, expectedControllerEpoch: number, reason?: string): Promise<OperationRecordV2> {
  return mutateOperation(root, operationId, {}, false, "operation.lead.acknowledged", (current, _revision, now) => {
    if (currentControllerEpoch(current) !== expectedControllerEpoch) throw new Error("AEH_OPERATION_ACK_EPOCH_MISMATCH: controller epoch changed before acknowledgement.");
    if (!current.lead || current.lead.agentId !== requiredId(actorId)) throw new Error("AEH_OPERATION_ACK_ACTOR_MISMATCH: only the currently bound lead may acknowledge this operation.");
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
  return mutateOperation(root, operationId, {}, true, "operation.policy.bound", async (current, revision, now) => {
    if (policy.operationId !== current.id) throw new Error("EXECUTION_POLICY_STALE: policy belongs to a different operation.");
    if (!current.candidateRevision || current.candidateRevision.identityDigest !== policy.candidateDigest || current.candidateRevision.revision !== policy.candidateRevision) throw new Error("EXECUTION_POLICY_STALE: policy does not bind the current candidate.");
    if (current.candidateRevision.projectId && current.candidateRevision.projectId !== policy.projectId) throw new Error("EXECUTION_POLICY_STALE: policy belongs to a different project.");
    if (current.operationExecutionRevision !== policy.operationExecutionRevision || !Number.isSafeInteger(current.operationExecutionRevision)) throw new Error("EXECUTION_POLICY_STALE: policy does not bind the current operation execution revision.");
    if (currentControllerEpoch(current) !== policy.controllerEpoch) throw new Error("EXECUTION_POLICY_STALE: policy does not bind the current controller epoch.");
    if (current.resolvedOperationPolicy && canonicalSerialize(current.resolvedOperationPolicy) !== canonicalSerialize(policy)) throw new Error("EXECUTION_POLICY_RECOMPILE_REQUIRED: execution semantics changed without advancing operationExecutionRevision.");
    let continuation = current.continuation && assertContinuationRecordV1(current.continuation);
    if (continuation && continuation.state !== "WAITING" && continuation.appliedRequirementDigest) {
      const selectedBinding = continuation.selectedDecisionBinding!;
      if (!candidateRevisionsEqual(selectedBinding.candidate, current.candidateRevision!)) throw new Error("DECISION_CONTINUATION_BINDING_STALE: a consumed product choice cannot cross candidate changes.");
      const nextBinding: HumanDecisionBindingV2 = {
        operationId: current.id,
        candidate: current.candidateRevision!,
        operationExecutionRevision: current.operationExecutionRevision!,
        policyDigest: policy.digest,
        controllerEpoch: currentControllerEpoch(current)
      };
      if (nextBinding.operationExecutionRevision !== selectedBinding.operationExecutionRevision + 1
        || continuation.operationExecutionRevision !== nextBinding.operationExecutionRevision) {
        throw new Error("DECISION_CONTINUATION_BINDING_STALE: product-choice policy may bind only its single authorized execution revision.");
      }
      if (selectedBinding.controllerEpoch === policy.controllerEpoch) {
        if (!sameHumanDecisionBinding(continuation, nextBinding)) continuation = await rewriteProductChoiceCheckpointBinding(root, current, continuation, nextBinding);
      } else if (policy.controllerEpoch <= selectedBinding.controllerEpoch) {
        throw new Error("DECISION_CONTINUATION_BINDING_STALE: controller epoch did not advance monotonically past the consumed choice.");
      }
    }
    return { ...current, resolvedOperationPolicy: policy, ...(continuation ? { continuation: { ...continuation, updatedAt: now } } : {}), revision, updatedAt: now, lastProgressAt: now };
  });
}

export type ProductChoiceRequestContentV1 = Pick<DecisionRequestV1,
  "issue" | "authoritativeEvidence" | "whatTried" | "whyUnresolvable" | "choices" | "workThatCanContinue">;

/** Persist the complete DecisionRequest and controller continuation before exposing HUMAN_REQUIRED. */
export async function suspendOperationForProductChoice(
  root: string,
  operationId: string,
  content: ProductChoiceRequestContentV1,
  checkpoint: unknown,
  expiresInMs = 24 * 60 * 60_000
): Promise<OperationRecordV2> {
  if (!Number.isSafeInteger(expiresInMs) || expiresInMs < 60_000 || expiresInMs > 7 * 24 * 60 * 60_000) throw new Error("DECISION_REQUEST_EXPIRY_INVALID: expiry must be between one minute and seven days.");
  return mutateOperation(root, operationId, {}, true, "operation.human-decision.suspended", async (current, revision, now) => {
    assertCurrentControllerOwner(current, "product-choice suspension");
    const replacingConsumedChoice = current.continuation?.state === "RESUMING" && !current.decisionRequest;
    if (current.status !== "RUNNING" || current.phase === "HUMAN_REQUIRED" || (current.continuation && !replacingConsumedChoice)) throw new Error(`DECISION_REQUEST_STATE_INVALID: only active Spec Manager authoring without an unanswered continuation may suspend for a product choice (status=${current.status}, phase=${current.phase}, continuation=${current.continuation?.state ?? "none"}, decisionRequest=${current.decisionRequest ? "present" : "absent"}).`);
    const binding = currentDecisionBinding(current, "product-choice suspension");
    const requestId = `request:${crypto.randomUUID()}`;
    const createdAt = now;
    const expiresAt = new Date(Date.parse(now) + expiresInMs).toISOString();
    const request = assertDecisionRequestV1({
      version: 1,
      requestId,
      ...binding,
      issue: content.issue,
      authoritativeEvidence: content.authoritativeEvidence,
      whatTried: content.whatTried,
      whyUnresolvable: content.whyUnresolvable,
      choices: content.choices,
      workThatCanContinue: content.workThatCanContinue,
      resumeTarget: "SPEC_AUTHORING",
      createdAt,
      expiresAt
    });
    const continuationId = `continuation:${crypto.randomUUID()}`;
    const checkpointEnvelope = { version: 1, continuationId, requestId, operationId: current.id, binding, checkpoint };
    const checkpointText = `${JSON.stringify(checkpointEnvelope, null, 2)}\n`;
    if (Buffer.byteLength(checkpointText, "utf8") > 1_000_000) throw new Error("DECISION_CONTINUATION_CHECKPOINT_TOO_LARGE: continuation checkpoint exceeds one megabyte.");
    const checkpointDigest = sha256Utf8(checkpointText);
    const artifact = path.posix.join(".harness", "operations", safeId(current.id), "continuations", `${continuationId.slice("continuation:".length)}.json`);
    const file = path.resolve(resolveOperationStateRoot(root), artifact);
    await fs.mkdir(path.dirname(file), { recursive: true });
    try { await fs.writeFile(file, checkpointText, { encoding: "utf8", flag: "wx", mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("DECISION_CONTINUATION_COLLISION: create a new product-choice request.");
      throw error;
    }
    const continuation = assertContinuationRecordV1({
      version: 1,
      continuationId,
      ...binding,
      resumeTarget: "SPEC_AUTHORING",
      reason: "PRODUCT_CHOICE",
      requestId,
      checkpointArtifact: artifact,
      checkpointDigest,
      requiredRevalidation: ["candidate-current", "operation-revision-current", "policy-current", "controller-epoch-current", "checkpoint-current"],
      state: "WAITING",
      suspendedAt: now,
      updatedAt: now
    });
    const stages = {
      ...current.stages,
      "spec-authoring": {
        name: "spec-authoring",
        status: "BLOCKED" as const,
        revision,
        startedAt: current.stages["spec-authoring"]?.startedAt ?? now,
        finishedAt: now,
        message: "Waiting for a scoped product choice.",
        artifact: artifact
      }
    };
    return { ...current, revision, updatedAt: now, lastProgressAt: now, phase: "HUMAN_REQUIRED", decisionRequest: request, continuation, stages };
  });
}

export async function loadOperationProductChoiceCheckpoint(root: string, operationId: string): Promise<unknown> {
  const current = await loadOperation(root, operationId);
  const continuation = current.continuation;
  if (!continuation || continuation.resumeTarget !== "SPEC_AUTHORING") throw new Error("DECISION_CONTINUATION_MISSING: no supported product-choice continuation is stored.");
  assertContinuationRecordV1(continuation);
  const envelope = await readProductChoiceCheckpointEnvelope(root, current, continuation);
  const operationBinding = currentDecisionBinding(current, "product-choice checkpoint load");
  if (!sameHumanDecisionBinding(envelope.binding, continuation) || !sameHumanDecisionBinding(continuation, operationBinding)) {
    throw new Error("DECISION_CONTINUATION_CHECKPOINT_BINDING_STALE: checkpoint, saved continuation, and current operation bindings must match exactly.");
  }
  return envelope.checkpoint;
}

/** Read an intact WAITING checkpoint only to reissue its unanswered request under current authority. */
export async function loadWaitingOperationProductChoiceCheckpointForReissue(root: string, operationId: string): Promise<unknown> {
  const current = await loadOperation(root, operationId);
  const continuation = current.continuation;
  const request = current.decisionRequest;
  if (current.status !== "RUNNING" || current.phase !== "HUMAN_REQUIRED" || !continuation || continuation.state !== "WAITING" || !request) {
    throw new Error("DECISION_CONTINUATION_REISSUE_INVALID: only an unanswered HUMAN_REQUIRED choice can be reissued.");
  }
  assertContinuationRecordV1(continuation);
  assertDecisionRequestV1(request);
  const envelope = await readProductChoiceCheckpointEnvelope(root, current, continuation);
  const requestBinding = bindingFromDecisionRecord(request);
  if (!sameHumanDecisionBinding(envelope.binding, continuation) || !sameHumanDecisionBinding(requestBinding, continuation)
    || request.requestId !== continuation.requestId || request.operationId !== current.id
    || !current.candidateRevision || !candidateRevisionsEqual(current.candidateRevision, continuation.candidate)
    || current.operationExecutionRevision !== continuation.operationExecutionRevision) {
    throw new Error("DECISION_CONTINUATION_REISSUE_STALE: unanswered checkpoint is not bound to the current operation and saved request.");
  }
  return envelope.checkpoint;
}

/** Recovery-only checkpoint read for a consumed choice whose authority became stale after takeover. */
export async function loadStaleConsumedProductChoiceCheckpointForReconfirmation(root: string, operationId: string): Promise<unknown> {
  const current = await loadOperation(root, operationId);
  const continuation = current.continuation;
  if (!continuation) throw new Error("DECISION_CONTINUATION_MISSING: no consumed product-choice continuation is stored.");
  assertContinuationRecordV1(continuation);
  assertStaleConsumedChoiceEligible(current, continuation);
  const envelope = await readProductChoiceCheckpointEnvelope(root, current, continuation);
  await assertConsumedProductChoiceReceipt(root, continuation);
  return envelope.checkpoint;
}

/** Re-open a stale consumed product choice as a new scoped HUMAN_REQUIRED request. */
export async function reconfirmStaleConsumedProductChoice(
  root: string,
  operationId: string,
  content: ProductChoiceRequestContentV1,
  checkpoint: unknown
): Promise<OperationRecordV2> {
  const before = await loadOperation(root, operationId);
  const previousContinuation = before.continuation && assertContinuationRecordV1(before.continuation);
  const storedCheckpoint = await loadStaleConsumedProductChoiceCheckpointForReconfirmation(root, operationId);
  if (!previousContinuation || canonicalSerialize(storedCheckpoint) !== canonicalSerialize(checkpoint)) throw new Error("DECISION_CONTINUATION_RECONFIRMATION_CHECKPOINT_MISMATCH: reconsent must preserve the verified saved checkpoint.");
  return mutateOperation(root, operationId, {}, true, "operation.human-decision.reconfirmation-required", async (current, revision, now) => {
    assertCurrentControllerOwner(current, "stale product-choice reconfirmation");
    const continuation = current.continuation && assertContinuationRecordV1(current.continuation);
    if (!continuation || continuation.continuationId !== before.continuation?.continuationId || continuation.requestId !== before.continuation?.requestId) {
      throw new Error("DECISION_CONTINUATION_RECONFIRMATION_STALE: consumed continuation changed before reconsent.");
    }
    assertStaleConsumedChoiceEligible(current, continuation);
    const envelope = await readProductChoiceCheckpointEnvelope(root, current, continuation);
    await assertConsumedProductChoiceReceipt(root, continuation);
    if (canonicalSerialize(envelope.checkpoint) !== canonicalSerialize(checkpoint)) throw new Error("DECISION_CONTINUATION_RECONFIRMATION_CHECKPOINT_MISMATCH: saved checkpoint changed before reconsent.");

    const binding = currentDecisionBinding(current, "stale product-choice reconfirmation");
    const requestId = `request:${crypto.randomUUID()}`;
    const request = assertDecisionRequestV1({
      version: 1,
      requestId,
      ...binding,
      issue: content.issue,
      authoritativeEvidence: content.authoritativeEvidence,
      whatTried: content.whatTried,
      whyUnresolvable: content.whyUnresolvable,
      choices: content.choices,
      workThatCanContinue: content.workThatCanContinue,
      resumeTarget: "SPEC_AUTHORING",
      createdAt: now,
      expiresAt: new Date(Date.parse(now) + 24 * 60 * 60_000).toISOString()
    });
    const continuationId = `continuation:${crypto.randomUUID()}`;
    const checkpointEnvelope = { version: 1, continuationId, requestId, operationId: current.id, binding, checkpoint };
    const checkpointText = `${JSON.stringify(checkpointEnvelope, null, 2)}\n`;
    if (Buffer.byteLength(checkpointText, "utf8") > 1_000_000) throw new Error("DECISION_CONTINUATION_CHECKPOINT_TOO_LARGE: continuation checkpoint exceeds one megabyte.");
    const checkpointDigest = sha256Utf8(checkpointText);
    const artifact = path.posix.join(".harness", "operations", safeId(current.id), "continuations", `${continuationId.slice("continuation:".length)}.json`);
    const file = path.resolve(resolveOperationStateRoot(root), artifact);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, checkpointText, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const nextContinuation = assertContinuationRecordV1({
      version: 1,
      continuationId,
      ...binding,
      resumeTarget: "SPEC_AUTHORING",
      reason: "PRODUCT_CHOICE",
      requestId,
      checkpointArtifact: artifact,
      checkpointDigest,
      requiredRevalidation: ["candidate-current", "operation-revision-current", "policy-current", "controller-epoch-current", "checkpoint-current"],
      state: "WAITING",
      suspendedAt: now,
      updatedAt: now
    });
    return {
      ...current,
      revision,
      updatedAt: now,
      lastProgressAt: now,
      phase: "HUMAN_REQUIRED",
      decisionRequest: request,
      continuation: nextContinuation,
      stages: { ...current.stages, "spec-authoring": { name: "spec-authoring", status: "BLOCKED", revision, startedAt: current.stages["spec-authoring"]?.startedAt ?? now, finishedAt: now, message: "Prior product choice became stale; a new current-authority choice is required before resumption.", artifact } }
    };
  });
}

/**
 * Verify a consumed choice against both its original ledger binding and the
 * narrowly permitted post-choice execution revision. A consumed selection can
 * never be rebound across policy identity or controller epoch changes.
 */
export function assertCurrentConsumedProductChoiceBinding(
  current: OperationRecordV2,
  continuationInput: ContinuationRecordV1,
  decisionBinding: HumanDecisionBindingV2
): void {
  const continuation = assertContinuationRecordV1(continuationInput);
  const selectedBinding = continuation.selectedDecisionBinding;
  if (!selectedBinding || !sameHumanDecisionBinding(selectedBinding, decisionBinding)) {
    throw new Error("DECISION_CONTINUATION_DECISION_BINDING_STALE: consumed decision binding differs from its saved receipt identity.");
  }
  const currentBinding = currentDecisionBinding(current, "consumed product-choice validation");
  if (!sameHumanDecisionBinding(currentBinding, continuation)) {
    throw new Error("DECISION_CONTINUATION_BINDING_STALE: saved continuation does not match the current operation, candidate, revision, policy, and epoch.");
  }
  if (decisionBinding.operationId !== current.id || !current.candidateRevision
    || !candidateRevisionsEqual(decisionBinding.candidate, current.candidateRevision)
    || decisionBinding.controllerEpoch !== currentBinding.controllerEpoch) {
    throw new Error("DECISION_CONTINUATION_DECISION_BINDING_STALE: consumed decision belongs to another operation, candidate, or controller epoch.");
  }
  if (continuation.appliedRequirementDigest) {
    if (currentBinding.operationExecutionRevision !== decisionBinding.operationExecutionRevision + 1
      || continuation.operationExecutionRevision !== currentBinding.operationExecutionRevision) {
      throw new Error("DECISION_CONTINUATION_BINDING_STALE: only the single authorized product-choice revision may follow the consumed decision.");
    }
  } else if (!sameHumanDecisionBinding(currentBinding, decisionBinding)) {
    throw new Error("DECISION_CONTINUATION_DECISION_BINDING_STALE: consumed decision no longer matches the current operation policy identity.");
  }
}

interface ProductChoiceCheckpointEnvelopeV1 {
  version: 1;
  continuationId: string;
  requestId: string;
  operationId: string;
  binding: HumanDecisionBindingV2;
  checkpoint: unknown;
}

async function readProductChoiceCheckpointEnvelope(
  root: string,
  current: OperationRecordV2,
  continuation: ContinuationRecordV1
): Promise<ProductChoiceCheckpointEnvelopeV1> {
  const stateRoot = resolveOperationStateRoot(root);
  const file = path.resolve(stateRoot, continuation.checkpointArtifact);
  const relative = path.relative(stateRoot, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("DECISION_CONTINUATION_CHECKPOINT_PATH: checkpoint escaped the operation state root.");
  const content = await fs.readFile(file, "utf8");
  if (sha256Utf8(content) !== continuation.checkpointDigest) throw new Error("DECISION_CONTINUATION_CHECKPOINT_STALE: checkpoint content digest changed.");
  let raw: unknown;
  try { raw = JSON.parse(content) as unknown; }
  catch { throw new Error("DECISION_CONTINUATION_CHECKPOINT_INVALID: checkpoint envelope is not valid JSON."); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("DECISION_CONTINUATION_CHECKPOINT_INVALID: checkpoint envelope must be an object.");
  const envelope = raw as Record<string, unknown>;
  const expectedKeys = ["version", "continuationId", "requestId", "operationId", "binding", "checkpoint"];
  if (Object.keys(envelope).some((key) => !expectedKeys.includes(key)) || expectedKeys.some((key) => !(key in envelope))
    || envelope.version !== 1 || envelope.continuationId !== continuation.continuationId || envelope.requestId !== continuation.requestId || envelope.operationId !== current.id) {
    throw new Error("DECISION_CONTINUATION_CHECKPOINT_INVALID: checkpoint does not match the current continuation.");
  }
  const binding = assertCheckpointBinding(envelope.binding);
  if (!sameHumanDecisionBinding(binding, continuation)) throw new Error("DECISION_CONTINUATION_CHECKPOINT_BINDING_STALE: checkpoint binding differs from the saved continuation.");
  return { version: 1, continuationId: envelope.continuationId as string, requestId: envelope.requestId as string, operationId: envelope.operationId as string, binding, checkpoint: envelope.checkpoint };
}

function assertCheckpointBinding(value: unknown): HumanDecisionBindingV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("DECISION_CONTINUATION_CHECKPOINT_INVALID: checkpoint binding must be an object.");
  const binding = value as Record<string, unknown>;
  const expectedKeys = ["operationId", "candidate", "operationExecutionRevision", "policyDigest", "controllerEpoch"];
  if (Object.keys(binding).some((key) => !expectedKeys.includes(key)) || expectedKeys.some((key) => !(key in binding))) {
    throw new Error("DECISION_CONTINUATION_CHECKPOINT_INVALID: checkpoint binding has an invalid shape.");
  }
  assertCandidateRevisionV1(binding.candidate);
  if (typeof binding.operationId !== "string" || !binding.operationId.trim() || binding.candidate.operationId !== binding.operationId
    || !Number.isSafeInteger(binding.operationExecutionRevision) || (binding.operationExecutionRevision as number) < 1
    || typeof binding.policyDigest !== "string" || !/^[a-f0-9]{64}$/.test(binding.policyDigest)
    || !Number.isSafeInteger(binding.controllerEpoch) || (binding.controllerEpoch as number) < 0) {
    throw new Error("DECISION_CONTINUATION_CHECKPOINT_INVALID: checkpoint binding is malformed.");
  }
  return binding as unknown as HumanDecisionBindingV2;
}

function bindingFromDecisionRecord(value: HumanDecisionBindingV2): HumanDecisionBindingV2 {
  return assertCheckpointBinding({
    operationId: value.operationId,
    candidate: value.candidate,
    operationExecutionRevision: value.operationExecutionRevision,
    policyDigest: value.policyDigest,
    controllerEpoch: value.controllerEpoch
  });
}

function sameHumanDecisionBinding(left: HumanDecisionBindingV2, right: HumanDecisionBindingV2): boolean {
  return left.operationId === right.operationId
    && candidateRevisionsEqual(left.candidate, right.candidate)
    && left.operationExecutionRevision === right.operationExecutionRevision
    && left.policyDigest === right.policyDigest
    && left.controllerEpoch === right.controllerEpoch;
}

function assertStaleConsumedChoiceEligible(current: OperationRecordV2, continuation: ContinuationRecordV1): void {
  if (current.status !== "RUNNING" || continuation.state === "WAITING" || !continuation.appliedRequirementDigest
    || !continuation.selectedDecisionId || !continuation.selectedChoiceId || !continuation.selectedDecisionBinding) {
    throw new Error("DECISION_CONTINUATION_RECONFIRMATION_INVALID: only a consumed product choice with applied requirement semantics can be reconfirmed.");
  }
  const selected = continuation.selectedDecisionBinding;
  const currentBinding = currentDecisionBinding(current, "stale product-choice reconfirmation");
  if (selected.operationId !== current.id || !current.candidateRevision
    || !candidateRevisionsEqual(selected.candidate, current.candidateRevision)
    || !candidateRevisionsEqual(continuation.candidate, current.candidateRevision)
    || current.operationExecutionRevision !== selected.operationExecutionRevision + 1
    || continuation.operationExecutionRevision !== current.operationExecutionRevision) {
    throw new Error("DECISION_CONTINUATION_RECONFIRMATION_STALE: candidate or execution revision changed outside the single applied product-choice revision.");
  }
  if (sameHumanDecisionBinding(currentBinding, continuation)) throw new Error("DECISION_CONTINUATION_RECONFIRMATION_NOT_REQUIRED: consumed choice binding is already current.");
  if (currentBinding.controllerEpoch < selected.controllerEpoch) throw new Error("DECISION_CONTINUATION_RECONFIRMATION_STALE: current controller epoch moved backwards.");
}

async function assertConsumedProductChoiceReceipt(root: string, continuation: ContinuationRecordV1): Promise<void> {
  const selectedBinding = continuation.selectedDecisionBinding;
  if (!selectedBinding || !continuation.selectedDecisionId || !continuation.selectedChoiceId) throw new Error("DECISION_CONTINUATION_STATE_INVALID: consumed product-choice identity is incomplete.");
  const ledger = new HumanDecisionLedgerV2(path.join(resolveOperationStateRoot(root), ".harness", "security", "human-decisions.json"));
  const decision = await ledger.find(continuation.selectedDecisionId);
  if (!decision || decision.kind !== "CHOOSE" || decision.purpose.kind !== "PRODUCT_CHOICE"
    || decision.purpose.requestId !== continuation.requestId || decision.purpose.choiceId !== continuation.selectedChoiceId
    || !sameHumanDecisionBinding(decision, selectedBinding)
    || !await ledger.consumedExact(selectedBinding, decision.purpose, decision.decisionId, decision.actorId)) {
    throw new Error("DECISION_CONTINUATION_RECONFIRMATION_RECEIPT_INVALID: stale selection has no exact original consumed receipt.");
  }
}

async function rewriteProductChoiceCheckpointBinding(
  root: string,
  current: OperationRecordV2,
  continuation: ContinuationRecordV1,
  binding: HumanDecisionBindingV2,
  additional: Partial<Pick<ContinuationRecordV1, "appliedRequirementDigest">> = {}
): Promise<ContinuationRecordV1> {
  const previous = await readProductChoiceCheckpointEnvelope(root, current, continuation);
  assertCheckpointBinding(binding);
  if (binding.operationId !== current.id || !current.candidateRevision || !candidateRevisionsEqual(binding.candidate, current.candidateRevision)
    || binding.operationExecutionRevision !== current.operationExecutionRevision || binding.controllerEpoch !== currentControllerEpoch(current)) {
    throw new Error("DECISION_CONTINUATION_CHECKPOINT_BINDING_STALE: replacement checkpoint binding does not match the current operation identity.");
  }
  const envelope: ProductChoiceCheckpointEnvelopeV1 = { ...previous, binding };
  const content = `${JSON.stringify(envelope, null, 2)}\n`;
  if (Buffer.byteLength(content, "utf8") > 1_000_000) throw new Error("DECISION_CONTINUATION_CHECKPOINT_TOO_LARGE: continuation checkpoint exceeds one megabyte.");
  const artifact = path.posix.join(".harness", "operations", safeId(current.id), "continuations", `${continuation.continuationId.slice("continuation:".length)}-${crypto.randomUUID()}.json`);
  const file = path.resolve(resolveOperationStateRoot(root), artifact);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return assertContinuationRecordV1({ ...continuation, ...binding, ...additional, checkpointArtifact: artifact, checkpointDigest: sha256Utf8(content) });
}

/** Refresh an unanswered request after controller takeover; old epoch-bound submissions remain stale. */
export async function reissueOperationProductChoice(root: string, operationId: string, checkpoint: unknown): Promise<OperationRecordV2> {
  const before = await loadOperation(root, operationId);
  const previousContinuation = before.continuation && assertContinuationRecordV1(before.continuation);
  const storedCheckpoint = await loadWaitingOperationProductChoiceCheckpointForReissue(root, operationId);
  if (!previousContinuation || canonicalSerialize(storedCheckpoint) !== canonicalSerialize(checkpoint)) throw new Error("DECISION_CONTINUATION_REISSUE_CHECKPOINT_MISMATCH: reissue must preserve the verified saved checkpoint.");
  return mutateOperation(root, operationId, {}, true, "operation.human-decision.reissued", async (current, revision, now) => {
    assertCurrentControllerOwner(current, "product-choice request reissue");
    const previousRequest = current.decisionRequest && assertDecisionRequestV1(current.decisionRequest);
    const previousContinuation = current.continuation && assertContinuationRecordV1(current.continuation);
    if (!previousRequest || !previousContinuation || current.phase !== "HUMAN_REQUIRED" || previousContinuation.state !== "WAITING"
      || previousContinuation.continuationId !== before.continuation?.continuationId || previousContinuation.requestId !== before.continuation?.requestId) throw new Error("DECISION_REQUEST_STATE_INVALID: only an unchanged unanswered HUMAN_REQUIRED product choice can be rebound.");
    const binding = currentDecisionBinding(current, "product-choice request reissue");
    if (!candidateRevisionsEqual(previousContinuation.candidate, binding.candidate)
      || previousContinuation.operationExecutionRevision !== binding.operationExecutionRevision) {
      throw new Error("DECISION_CONTINUATION_STALE: candidate or execution semantics changed while the operation was suspended.");
    }
    const requestId = `request:${crypto.randomUUID()}`;
    const request = assertDecisionRequestV1({
      ...previousRequest,
      ...binding,
      requestId,
      createdAt: now,
      expiresAt: new Date(Date.parse(now) + 24 * 60 * 60_000).toISOString()
    });
    const continuationId = `continuation:${crypto.randomUUID()}`;
    const checkpointEnvelope = { version: 1, continuationId, requestId, operationId: current.id, binding, checkpoint };
    const checkpointText = `${JSON.stringify(checkpointEnvelope, null, 2)}\n`;
    const checkpointDigest = sha256Utf8(checkpointText);
    const artifact = path.posix.join(".harness", "operations", safeId(current.id), "continuations", `${continuationId.slice("continuation:".length)}.json`);
    const file = path.resolve(resolveOperationStateRoot(root), artifact);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, checkpointText, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const continuation = assertContinuationRecordV1({
      version: 1,
      continuationId,
      ...binding,
      resumeTarget: "SPEC_AUTHORING",
      reason: "PRODUCT_CHOICE",
      requestId,
      checkpointArtifact: artifact,
      checkpointDigest,
      requiredRevalidation: ["candidate-current", "operation-revision-current", "policy-current", "controller-epoch-current", "checkpoint-current"],
      state: "WAITING",
      suspendedAt: previousContinuation.suspendedAt,
      updatedAt: now
    });
    return {
      ...current,
      revision,
      updatedAt: now,
      lastProgressAt: now,
      phase: "HUMAN_REQUIRED",
      decisionRequest: request,
      continuation,
      stages: { ...current.stages, "spec-authoring": { ...current.stages["spec-authoring"], name: "spec-authoring", status: "BLOCKED", revision, message: "Waiting for a product choice under the current controller epoch.", artifact } }
    };
  });
}

/** Controller-owned transition after the ledger has atomically consumed the exact choice. */
export async function markOperationProductChoiceConsumed(root: string, operationId: string, input: { requestId: string; decisionId: string; choiceId: string }): Promise<OperationRecordV2> {
  return mutateOperation(root, operationId, {}, true, "operation.human-decision.consumed", (current, revision, now) => {
    assertCurrentControllerOwner(current, "product-choice consumption");
    const request = current.decisionRequest && assertDecisionRequestV1(current.decisionRequest);
    const continuation = current.continuation && assertContinuationRecordV1(current.continuation);
    if (!request || !continuation || current.phase !== "HUMAN_REQUIRED" || continuation.state !== "WAITING"
      || request.requestId !== input.requestId || continuation.requestId !== input.requestId) throw new Error("DECISION_REQUEST_STALE: no matching current product-choice request is awaiting a decision.");
    assertCurrentDecisionBinding(current, request, "product-choice consumption");
    const selectedDecisionBinding = currentDecisionBinding(current, "product-choice consumption");
    if (Date.parse(request.expiresAt) <= Date.parse(now)) throw new Error("DECISION_REQUEST_EXPIRED: the product-choice request has expired.");
    if (!request.choices.some((choice) => choice.choiceId === input.choiceId)) throw new Error("DECISION_CHOICE_INVALID: selected choice is not one of the request's bounded options.");
    if (!/^decision:[0-9a-f-]{36}$/i.test(input.decisionId)) throw new Error("DECISION_ID_INVALID: consumed HumanDecision id is malformed.");
    return {
      ...current,
      revision,
      updatedAt: now,
      lastProgressAt: now,
      phase: "REVALIDATING",
      decisionRequest: undefined,
      continuation: { ...continuation, state: "CHOICE_CONSUMED", selectedDecisionId: input.decisionId, selectedChoiceId: input.choiceId, selectedDecisionBinding, updatedAt: now }
    };
  });
}

/** Recompile operation semantics after the selected product choice has produced a revised sealed requirement contract. */
export async function bindProductChoiceExecutionSemantics(root: string, operationId: string, input: { requirementDigest: string; decisionId: string; choiceId: string; priorDecisionIds?: string[] }): Promise<OperationRecordV2> {
  if (!/^[a-f0-9]{64}$/.test(input.requirementDigest)) throw new Error("EXECUTION_SEMANTICS_INVALID: requirement digest must be a lowercase SHA-256 digest.");
  const priorDecisionIds = input.priorDecisionIds ?? [];
  if (priorDecisionIds.length > 16 || priorDecisionIds.some((id) => !/^decision:[0-9a-f-]{36}$/i.test(id)) || new Set(priorDecisionIds).size !== priorDecisionIds.length || priorDecisionIds.includes(input.decisionId)) throw new Error("DECISION_CONTINUATION_CHAIN_INVALID: prior product decision identities must be unique, valid and bounded.");
  const before = await loadOperation(root, operationId);
  if (before.continuation?.selectedDecisionId === input.decisionId && before.continuation.selectedChoiceId === input.choiceId
    && before.continuation.appliedRequirementDigest === input.requirementDigest) {
    assertCurrentConsumedProductChoiceBinding(before, before.continuation, before.continuation.selectedDecisionBinding!);
    return before;
  }
  return mutateOperation(root, operationId, {}, true, "operation.human-decision.semantics-bound", async (current, revision, now) => {
    assertCurrentControllerOwner(current, "product-choice semantics binding");
    const continuation = current.continuation && assertContinuationRecordV1(current.continuation);
    if (!continuation || (continuation.state !== "CHOICE_CONSUMED" && continuation.state !== "RESUMING") || continuation.selectedDecisionId !== input.decisionId || continuation.selectedChoiceId !== input.choiceId) throw new Error("DECISION_CONTINUATION_STATE_INVALID: revised product semantics require the consumed current product choice.");
    if (!Number.isSafeInteger(current.operationExecutionRevision) || current.operationExecutionRevision! < 1) throw new Error("UNSUPPORTED_OPERATION_EXECUTION_REVISION: migrate this operation record before product-choice resumption.");
    assertCurrentConsumedProductChoiceBinding(current, continuation, continuation.selectedDecisionBinding!);
    const executionSemanticsDigest = sha256Canonical({ previous: current.executionSemanticsDigest ?? null, priorDecisionIds, decisionId: input.decisionId, choiceId: input.choiceId, requirementDigest: input.requirementDigest });
    const participants = Object.fromEntries(Object.entries(current.participants).map(([id, participant]) => [id, { ...participant, executionBinding: undefined }]));
    const nextBinding: HumanDecisionBindingV2 = {
      operationId: current.id,
      candidate: current.candidateRevision!,
      operationExecutionRevision: current.operationExecutionRevision! + 1,
      policyDigest: continuation.policyDigest,
      controllerEpoch: currentControllerEpoch(current)
    };
    const projectedCurrent = { ...current, operationExecutionRevision: nextBinding.operationExecutionRevision };
    const reboundContinuation = await rewriteProductChoiceCheckpointBinding(root, projectedCurrent, continuation, nextBinding, { appliedRequirementDigest: input.requirementDigest });
    return {
      ...current,
      revision,
      updatedAt: now,
      lastProgressAt: now,
      operationExecutionRevision: current.operationExecutionRevision! + 1,
      executionSemanticsDigest,
      resolvedOperationPolicy: undefined,
      participants,
      continuation: { ...reboundContinuation, state: "CHOICE_CONSUMED", appliedRequirementDigest: input.requirementDigest, updatedAt: now }
    };
  });
}

/** Rebind a consumed continuation only after the controller has recompiled and bound the current policy. */
export async function resumeOperationProductChoice(root: string, operationId: string): Promise<OperationRecordV2> {
  await loadOperationProductChoiceCheckpoint(root, operationId);
  return mutateOperation(root, operationId, {}, true, "operation.human-decision.resumed", async (current, revision, now) => {
    assertCurrentControllerOwner(current, "product-choice continuation resume");
    const continuation = current.continuation && assertContinuationRecordV1(current.continuation);
    if (!continuation || (continuation.state !== "CHOICE_CONSUMED" && continuation.state !== "RESUMING") || !continuation.selectedDecisionId || !continuation.selectedChoiceId) throw new Error("DECISION_CONTINUATION_STATE_INVALID: a consumed product choice is required before resumption.");
    const binding = currentDecisionBinding(current, "product-choice continuation resume");
    if (!sameHumanDecisionBinding(continuation, binding)) throw new Error("DECISION_CONTINUATION_BINDING_STALE: current operation identity changed before continuation resume.");
    assertCurrentConsumedProductChoiceBinding(current, continuation, continuation.selectedDecisionBinding!);
    const envelope = await readProductChoiceCheckpointEnvelope(root, current, continuation);
    if (!sameHumanDecisionBinding(envelope.binding, continuation) || !sameHumanDecisionBinding(envelope.binding, binding)) {
      throw new Error("DECISION_CONTINUATION_CHECKPOINT_BINDING_STALE: checkpoint identity changed before continuation resume.");
    }
    const nextContinuation = assertContinuationRecordV1({
      ...continuation,
      state: "RESUMING",
      updatedAt: now
    });
    return {
      ...current,
      revision,
      updatedAt: now,
      lastProgressAt: now,
      phase: "spec-authoring",
      continuation: nextContinuation,
      stages: { ...current.stages, "spec-authoring": { ...current.stages["spec-authoring"], name: "spec-authoring", status: "RUNNING", revision, startedAt: now, finishedAt: undefined, message: "Resuming Spec Manager after validated product choice." } }
    };
  });
}

function operationControlLedger(root: string): HumanDecisionLedgerV2 {
  return new HumanDecisionLedgerV2(path.join(resolveOperationStateRoot(root), ".harness", "security", "human-decisions.json"));
}

function operationControlPurpose(command: OperationControlCommandV1): { kind: "OPERATION_CONTROL"; command: OperationControlCommandV1 } {
  return { kind: "OPERATION_CONTROL", command };
}

/** Record a scoped PAUSE control request for the current operation identity. */
export async function requestOperationPause(root: string, operationId: string, actorId: string, reason?: string): Promise<HumanDecisionV2> {
  const current = await loadOperation(root, operationId);
  if (isTerminalOperation(current.status)) throw new Error("OPERATION_CONTROL_TERMINAL: a terminal operation cannot be paused.");
  if (current.status !== "RUNNING") throw new Error("OPERATION_CONTROL_STATE_INVALID: only a running operation can be paused.");
  if (current.phase === "PAUSED" || current.pause) throw new Error("OPERATION_CONTROL_STATE_INVALID: the operation is already paused.");
  const binding = currentDecisionBinding(current, "pause request");
  const ledger = operationControlLedger(root);
  const now = new Date();
  const purpose = operationControlPurpose("PAUSE");
  const existing = (await ledger.active(binding, now)).find((decision) => decision.actorId === actorId && decision.kind === "PAUSE" && canonicalSerialize(decision.purpose) === canonicalSerialize(purpose));
  if (existing) return existing;
  return ledger.record({
    ...binding,
    purpose,
    kind: "PAUSE",
    actorId,
    reason: reason?.trim() || "Authenticated Control Center pause request.",
    createdAt: now,
    expiresAt: new Date(now.getTime() + 10 * 60_000)
  });
}

/** Record a scoped RESUME control request against a current PAUSED operation. */
export async function requestOperationResume(root: string, operationId: string, actorId: string, reason?: string): Promise<HumanDecisionV2> {
  const current = await loadOperation(root, operationId);
  if (isTerminalOperation(current.status)) throw new Error("OPERATION_CONTROL_TERMINAL: a terminal operation cannot be resumed.");
  if (current.phase !== "PAUSED" || !current.pause) throw new Error("OPERATION_CONTROL_STATE_INVALID: only a PAUSED operation can be resumed.");
  assertOperationPauseRecordV1(current.pause);
  const binding = currentDecisionBinding(current, "resume request");
  if (!sameHumanDecisionBinding(current.pause, binding)) throw new Error("OPERATION_CONTROL_BINDING_STALE: the pause record no longer matches the current operation, candidate, policy, execution revision, and controller epoch.");
  const ledger = operationControlLedger(root);
  const now = new Date();
  const purpose = operationControlPurpose("RESUME");
  const existing = (await ledger.active(binding, now)).find((decision) => decision.actorId === actorId && decision.kind === "RESUME" && canonicalSerialize(decision.purpose) === canonicalSerialize(purpose));
  if (existing) return existing;
  return ledger.record({
    ...binding,
    purpose,
    kind: "RESUME",
    actorId,
    reason: reason?.trim() || "Authenticated Control Center resume request.",
    createdAt: now,
    expiresAt: new Date(now.getTime() + 10 * 60_000)
  });
}

/** Read the unique current-binding operation-control decision, if any. */
export async function pendingOperationControl(root: string, operationId: string, command: OperationControlCommandV1): Promise<HumanDecisionV2 | undefined> {
  const current = await loadOperation(root, operationId);
  if (isTerminalOperation(current.status)) return undefined;
  let binding: HumanDecisionBindingV2;
  try { binding = currentDecisionBinding(current, `${command.toLowerCase()} control observation`); }
  catch { return undefined; }
  const ledger = operationControlLedger(root);
  const purpose = operationControlPurpose(command);
  const matches = (await ledger.active(binding, new Date())).filter((decision) => decision.kind === command && canonicalSerialize(decision.purpose) === canonicalSerialize(purpose));
  if (matches.length > 1) throw new Error(`OPERATION_CONTROL_AMBIGUOUS: multiple current ${command} controls are pending for this operation identity.`);
  return matches[0];
}

/**
 * Controller-owned pause application. Consumes the exact scoped PAUSE control
 * once and persists PAUSED with the drain receipt. A no-op when no current
 * control exists or the operation is not pausable.
 */
export async function pauseOperationIfRequested(root: string, operationId: string, drainReceipt: OperationPauseDrainReceiptV1): Promise<OperationRecordV2> {
  const decision = await pendingOperationControl(root, operationId, "PAUSE");
  if (!decision) return loadOperation(root, operationId);
  if (drainReceipt.activeParticipantIds.length || drainReceipt.activeProviderLeaseIds.length) return loadOperation(root, operationId);
  return mutateOperation(root, operationId, {}, true, "operation.control.paused", async (current, revision, now) => {
    assertCurrentControllerOwner(current, "operation pause");
    if (current.status !== "RUNNING") throw new Error("OPERATION_CONTROL_STATE_INVALID: only a running operation can be paused.");
    if (current.phase === "PAUSED" || current.pause) return current;
    const binding = currentDecisionBinding(current, "operation pause");
    if (!sameHumanDecisionBinding(decision, binding)) throw new Error("OPERATION_CONTROL_BINDING_STALE: pause control no longer matches the current operation, candidate, policy, execution revision, and controller epoch.");
    await operationControlLedger(root).consumeExact(binding, decision.purpose, decision.decisionId, decision.actorId);
    const pause: OperationPauseRecordV1 = {
      version: 1,
      ...binding,
      resumePhase: current.phase,
      reason: decision.reason,
      requestedBy: decision.actorId,
      requestedAt: decision.createdAt,
      pausedAt: now,
      drainReceipt,
      requiredRevalidation: [...operationPauseRevalidationValuesV1],
      state: "PAUSED"
    };
    return { ...current, revision, updatedAt: now, lastProgressAt: now, phase: "PAUSED", pause };
  });
}

async function applyOperationResume(root: string, operationId: string, decision: HumanDecisionV2): Promise<OperationRecordV2> {
  return mutateOperation(root, operationId, {}, true, "operation.control.resumed", async (current, revision, now) => {
    assertCurrentControllerOwner(current, "operation resume");
    if (current.status !== "RUNNING") throw new Error("OPERATION_CONTROL_STATE_INVALID: only a running paused operation can be resumed.");
    if (current.phase !== "PAUSED" || !current.pause) return current;
    const pause = assertOperationPauseRecordV1(current.pause);
    const binding = currentDecisionBinding(current, "operation resume");
    if (!sameHumanDecisionBinding(pause, binding)) throw new Error("OPERATION_CONTROL_BINDING_STALE: pause record no longer matches the current operation, candidate, policy, execution revision, and controller epoch.");
    if (!sameHumanDecisionBinding(decision, binding)) throw new Error("OPERATION_CONTROL_BINDING_STALE: resume control no longer matches the current operation, candidate, policy, execution revision, and controller epoch.");
    await operationControlLedger(root).consumeExact(binding, decision.purpose, decision.decisionId, decision.actorId);
    return { ...current, revision, updatedAt: now, lastProgressAt: now, phase: pause.resumePhase, pause: undefined };
  });
}

/**
 * Controller-owned wait for a scoped RESUME control. Exits on a terminal
 * operation or when the pause was already cleared by another current owner.
 */
export async function awaitOperationResume(root: string, operationId: string, options: { pollMs?: number } = {}): Promise<OperationRecordV2> {
  const pollMs = options.pollMs ?? 250;
  for (;;) {
    const current = await loadOperation(root, operationId);
    if (isTerminalOperation(current.status)) throw new Error(`OPERATION_CONTROL_TERMINAL: operation ${operationId} reached ${current.status} while paused.`);
    if (current.phase !== "PAUSED" || !current.pause) return current;
    if (!current.resolvedOperationPolicy) throw new Error("OPERATION_CONTROL_POLICY_REQUIRED: a paused operation must rebind its frozen policy before resume.");
    assertCurrentControllerOwner(current, "paused operation wait");
    const decision = await pendingOperationControl(root, operationId, "RESUME");
    if (decision) {
      try { return await applyOperationResume(root, operationId, decision); }
      catch (error) {
        const latest = await loadOperation(root, operationId).catch(() => current);
        if (latest.phase !== "PAUSED" || !latest.pause) return latest;
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Apply a pending PAUSE and, when paused, block until a scoped RESUME or terminal state. */
export async function operationControlCheckpoint(root: string, operationId: string, drainReceipt: OperationPauseDrainReceiptV1): Promise<OperationRecordV2> {
  const paused = await pauseOperationIfRequested(root, operationId, drainReceipt);
  if (paused.phase === "PAUSED" && paused.pause) return awaitOperationResume(root, operationId);
  return paused;
}

/** Rebind a recovered PAUSED record to the current controller identity after takeover. */
export async function rebindPauseRecordToCurrentIdentity(root: string, operationId: string): Promise<OperationRecordV2> {
  return mutateOperation(root, operationId, {}, true, "operation.control.recovered", (current, revision, now) => {
    assertCurrentControllerOwner(current, "paused operation recovery");
    if (!current.pause || current.phase !== "PAUSED") return current;
    assertOperationPauseRecordV1(current.pause);
    const binding = currentDecisionBinding(current, "paused operation recovery");
    return { ...current, revision, updatedAt: now, lastProgressAt: now, pause: { ...current.pause, ...binding, pausedAt: current.pause.pausedAt } };
  });
}

export async function completeOperationProductChoice(root: string, operationId: string): Promise<OperationRecordV2> {
  return mutateOperation(root, operationId, {}, true, "operation.human-decision.completed", (current, revision, now) => {
    assertCurrentControllerOwner(current, "product-choice continuation completion");
    if (!current.continuation || current.continuation.state !== "RESUMING" || !current.continuation.selectedDecisionId) throw new Error("DECISION_CONTINUATION_STATE_INVALID: only the active resumed product-choice continuation can complete.");
    return { ...current, revision, updatedAt: now, lastProgressAt: now, continuation: undefined, decisionRequest: undefined };
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
    if (!previous) {
      // The canonical Operation Supervisor is tracked in the supervision
      // generation list rather than the work-participant map, but its session
      // still needs a durable execution binding.
      const agents = current.agents ?? [];
      const agentIndex = agents.findIndex((agent) => agent.id === input.participantId);
      const agent = agentIndex >= 0 ? agents[agentIndex] : undefined;
      if (!agent || agent.role !== input.role || input.role !== "Operation Supervisor") {
        throw new Error("V2_RESULT_PROVENANCE: execution binding participant is not registered for this role.");
      }
      if (binding.operationId !== current.id || binding.participantId !== input.participantId) throw new Error("V2_RESULT_PROVENANCE: execution binding operation or participant identity is stale.");
      return {
        ...current,
        revision,
        updatedAt: now,
        lastProgressAt: now,
        agents: agents.map((item, index) => index === agentIndex ? { ...item, executionBinding: binding } : item)
      };
    }
    if (previous.role !== input.role || previous.logicalAgent !== input.logicalAgent) {
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
  if (record.version === 2) {
    const participants = record.participants ?? {};
    if (record.decisionRequest) assertDecisionRequestV1(record.decisionRequest);
    if (record.continuation) assertContinuationRecordV1(record.continuation);
    if (record.decisionRequest && (!record.continuation || record.continuation.state !== "WAITING")) throw new Error("DECISION_CONTINUATION_STATE_INVALID: only a waiting continuation may expose its DecisionRequest.");
    if (record.continuation?.state === "WAITING" && !record.decisionRequest) throw new Error("DECISION_CONTINUATION_STATE_INVALID: a waiting continuation requires its DecisionRequest.");
    if (record.phase === "HUMAN_REQUIRED" && (!record.decisionRequest || !record.continuation || record.continuation.state !== "WAITING")) throw new Error("DECISION_CONTINUATION_STATE_INVALID: HUMAN_REQUIRED requires a current waiting DecisionRequest and continuation.");
    return { ...record, version: 2 as const, revision: Math.max(1, record.revision || 1), lastProgressAt: record.lastProgressAt || record.updatedAt, supervision: record.supervision ?? defaultSupervision(record.kind), stages: record.stages ?? {}, participants, progress: record.progress ?? deriveProgress(participants), notification: record.notification ?? defaultNotification(), controller: record.controller ?? { epoch: 0, ownerId: "controller:none", claimedAt: record.createdAt } };
  }
  const participants: Record<string, OperationParticipantRecord> = {};
  for (const agent of record.agents ?? []) { if (agent.role === "operation-supervisor") continue; participants[agent.id] = { id: agent.id, logicalAgent: agent.role, role: agent.role, stage: agent.phase, phase: agent.phase, workspaceId: agent.workspaceId, transport: agent.transport, status: "REGISTERED", registeredAt: agent.registeredAt }; }
  const normalized = { ...record, version: 2 as const, kind: record.kind, payload: record.payload, revision: 1, lastProgressAt: record.updatedAt, intent: inferIntent(record.kind, record.payload), supervision: defaultSupervision(record.kind), stages: record.phase ? { [record.phase]: { name: record.phase, status: isTerminal(record.status) ? terminalStageStatus(record.status) : "RUNNING", revision: 1, startedAt: record.startedAt, finishedAt: record.finishedAt } } : {}, participants, progress: deriveProgress(participants), notification: defaultNotification() };
  return normalized;
}

function currentDecisionBinding(record: OperationRecordV2, action: string): HumanDecisionBindingV2 {
  const candidate = record.candidateRevision;
  const policy = record.resolvedOperationPolicy;
  if (!candidate || !policy || !Number.isSafeInteger(record.operationExecutionRevision)) throw new Error(`DECISION_AUTHORITY_REQUIRED: ${action} requires current candidate, execution revision, and frozen policy.`);
  assertResolvedOperationPolicyV1(policy);
  const binding: HumanDecisionBindingV2 = {
    operationId: record.id,
    candidate,
    operationExecutionRevision: record.operationExecutionRevision!,
    policyDigest: policy.digest,
    controllerEpoch: currentControllerEpoch(record)
  };
  assertCurrentDecisionBinding(record, binding, action);
  return binding;
}

function assertCurrentDecisionBinding(record: OperationRecordV2, binding: HumanDecisionBindingV2, action: string): void {
  const candidate = record.candidateRevision;
  const policy = record.resolvedOperationPolicy;
  if (!candidate || !policy || binding.operationId !== record.id || !candidateRevisionsEqual(binding.candidate, candidate)
    || binding.operationExecutionRevision !== record.operationExecutionRevision || binding.policyDigest !== policy.digest
    || binding.controllerEpoch !== currentControllerEpoch(record)
    || policy.operationId !== record.id || policy.operationExecutionRevision !== record.operationExecutionRevision
    || policy.candidateRevision !== candidate.revision || policy.candidateDigest !== candidate.identityDigest
    || policy.controllerEpoch !== currentControllerEpoch(record)
    || (candidate.projectId && policy.projectId !== candidate.projectId)) {
    throw new Error(`DECISION_BINDING_STALE: ${action} does not match the current operation, candidate, execution revision, policy, and controller epoch.`);
  }
}

async function mutateOperation(root: string, operationId: string, patch: Partial<OperationRecordV2>, touchRevision: boolean, eventType: string, custom?: (current: OperationRecordV2, revision: number, now: string) => OperationRecordV2 | Promise<OperationRecordV2>, allowTerminalCustom = false): Promise<OperationRecordV2> {
  const stateRoot = resolveOperationStateRoot(root); const file = operationFile(stateRoot, operationId); await fs.mkdir(path.dirname(file), { recursive: true });
  return withOperationLock(file, async () => {
    const stored = await readStoredOperation(file);
    await recoverPendingOperationEvent(stateRoot, file, stored);
    const current = stored.record;
    if (patch.status && current.status === "QUEUED" && patch.status === "SUCCEEDED") throw new Error("Invalid operation status transition QUEUED -> SUCCEEDED.");
    if (patch.status && !isTerminal(current.status) && !isAllowedOperationStatusTransition(current.status, patch.status)) throw new Error(`Invalid operation status transition ${current.status} -> ${patch.status}.`);
    if (isTerminal(current.status) && custom && !allowTerminalCustom) return current;
    const guardedPatch = guardTerminalTransition(current, patch);
    if (isTerminal(current.status) && Object.keys(guardedPatch).length === 0 && !allowTerminalCustom) return current;
    if (eventType !== "operation.controller.claimed" && eventType !== "operation.lead.acknowledged") assertCurrentControllerOwner(current, `operation mutation '${eventType}'`);
    const now = new Date().toISOString();
    const revision = touchRevision ? current.revision + 1 : current.revision;
    // Mutation callbacks receive the loaded record itself and can mutate nested
    // state in place. Capture every lifecycle-owned execution identity before a
    // callback can alias or re-key its containing objects.
    const executionIdentitySnapshot = snapshotExecutionIdentity(current);
    const controllerSnapshot = canonicalSerialize(current.controller ?? null);
    const candidate = custom ? await custom(current, revision, now) : ({ ...current, ...guardedPatch, version: 2, id: current.id, kind: current.kind, revision, updatedAt: now, lastProgressAt: touchRevision ? now : current.lastProgressAt } as OperationRecordV2);
    const next = normalizeOperationRecord(candidate);
    if (isTerminal(current.status) && (next.status !== current.status || next.phase !== current.phase
      || next.finishedAt !== current.finishedAt || !sameCanonicalOptional(next.result, current.result)
      || next.error !== current.error)) {
      throw new Error("V2_TERMINAL_IMMUTABLE: terminal status, result, error, phase, and finish time cannot change through metadata mutation.");
    }
    if (!sameOptionalCandidate(current.candidateRevision, next.candidateRevision)) {
      if (eventType !== "operation.candidate.bound") throw new Error("V2_CANDIDATE_IMMUTABLE: CandidateRevision changes must use the candidate binding lifecycle.");
      if (current.candidateRevision && next.candidateRevision?.revision !== current.candidateRevision.revision + 1) throw new Error("V2_CANDIDATE_IMMUTABLE: CandidateRevision must advance by exactly one revision.");
      if (!current.candidateRevision && next.candidateRevision?.revision !== 1) throw new Error("V2_CANDIDATE_IMMUTABLE: the first CandidateRevision must start at revision 1.");
    }
    assertExecutionIdentityTransition(next, eventType, executionIdentitySnapshot);
    assertControllerTransition(controllerSnapshot, next.controller, eventType);
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
  const productChoiceSemanticsEvent = "operation.human-decision.semantics-bound";
  const semanticsChanged = snapshot.executionSemanticsDigest !== next.executionSemanticsDigest;
  if (semanticsChanged && eventType !== semanticsEvent && eventType !== productChoiceSemanticsEvent) {
    throw new Error("EXECUTION_SEMANTICS_IMMUTABLE: executionSemanticsDigest may change only through operation.execution-semantics.bound.");
  }
  if ((eventType === semanticsEvent || eventType === productChoiceSemanticsEvent) && next.executionSemanticsDigest !== undefined && !/^[a-f0-9]{64}$/.test(next.executionSemanticsDigest)) {
    throw new Error("EXECUTION_SEMANTICS_INVALID: semantics digest must be a lowercase SHA-256 digest.");
  }

  const semanticsRebind = (eventType === semanticsEvent || eventType === productChoiceSemanticsEvent) && snapshot.executionSemanticsDigest !== undefined && semanticsChanged;
  const canInvalidate = new Set(["operation.candidate.bound", "operation.controller.claimed"]);
  if (semanticsRebind) canInvalidate.add(semanticsEvent);
  if (eventType === productChoiceSemanticsEvent) canInvalidate.add(productChoiceSemanticsEvent);
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
  if (eventType === productChoiceSemanticsEvent) {
    if (!semanticsChanged || next.operationExecutionRevision !== snapshot.operationExecutionRevision! + 1
      || next.resolvedOperationPolicy !== undefined
      || Object.values(next.participants).some((participant) => participant.executionBinding !== undefined)) {
      throw new Error("DECISION_EXECUTION_REBIND_REQUIRED: product-choice semantics must advance the execution revision, clear policy, and invalidate participant bindings.");
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
  const productChoiceSemanticsEvent = "operation.human-decision.semantics-bound";

  if (eventType === candidateEvent || eventType === semanticsEvent || eventType === productChoiceSemanticsEvent) {
    if (!Number.isSafeInteger(previous) || previous! < 1) {
      throw new Error("UNSUPPORTED_OPERATION_EXECUTION_REVISION: migrate this operation record before changing execution identity.");
    }
    const advances = eventType === candidateEvent || eventType === productChoiceSemanticsEvent
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
function assertControllerTransition(currentCanonical: string, next: OperationControllerBinding | undefined, eventType: string): void {
  if (eventType === "operation.controller.claimed") return;
  const nextCanonical = canonicalSerialize(next ?? null);
  if (currentCanonical === nextCanonical) return;
  if (eventType === "operation.controller.process-bound") {
    const current = JSON.parse(currentCanonical) as OperationControllerBinding | null;
    if (!current || !next || !Number.isSafeInteger(next.pid) || next.pid! < 1
      || next.epoch !== current.epoch
      || next.ownerId !== current.ownerId
      || next.tokenDigest !== current.tokenDigest
      || next.claimedAt !== current.claimedAt
      || next.previousOwnerId !== current.previousOwnerId) {
      throw new Error("V2_CONTROLLER_BINDING_IMMUTABLE: process binding may update only the current controller pid.");
    }
    return;
  }
  throw new Error("V2_CONTROLLER_BINDING_IMMUTABLE: controller ownership changes require the claim lifecycle.");
}
function sameOptionalCandidate(left: CandidateRevisionV1 | undefined, right: CandidateRevisionV1 | undefined): boolean {
  return left === undefined || right === undefined ? left === right : candidateRevisionsEqual(left, right);
}
function sameCanonicalOptional(left: unknown, right: unknown): boolean {
  return left === undefined || right === undefined ? left === right : canonicalSerialize(left) === canonicalSerialize(right);
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
const coordinationLockOwner = new AsyncLocalStorage<string>();
export async function withOperationCoordinationLock<T>(root: string, operationId: string, action: () => Promise<T>): Promise<T> {
  const stateRoot = resolveOperationStateRoot(root);
  const file = `${operationFile(stateRoot, operationId)}.coordination`;
  const key = path.resolve(file);
  // A controller-owned flow may re-enter its own coordination scope (for
  // example supervisor initialization issuing context authorization). Only the
  // holding async context is re-entrant; other callers still serialize on the
  // durable file lock.
  if (coordinationLockOwner.getStore() === key) return action();
  await fs.mkdir(path.dirname(file), { recursive: true });
  return withOperationLock(file, () => coordinationLockOwner.run(key, action));
}
async function withOperationLock<T>(file: string, action: () => Promise<T>): Promise<T> { const lock = `${file}.lock`; const deadline = Date.now() + LOCK_TIMEOUT_MS; for (;;) { let handle: Awaited<ReturnType<typeof fs.open>> | undefined; try { handle = await fs.open(lock, "wx"); try { await handle.writeFile(`${process.pid}\n`); return await action(); } finally { await handle.close().catch(() => undefined); await fs.rm(lock, { force: true }).catch(() => undefined); } } catch (error) { if (handle) { await handle.close().catch(() => undefined); await fs.rm(lock, { force: true }).catch(() => undefined); throw error; } if (!isAlreadyExists(error)) throw error; if (await canRecoverLock(lock)) { await fs.rm(lock, { force: true }).catch(() => undefined); continue; } if (Date.now() >= deadline) throw new Error(`Timed out acquiring operation state lock for ${path.basename(file)}.`); await delay(LOCK_RETRY_MS); } } }
async function canRecoverLock(lock: string): Promise<boolean> { try { const [rawPid, stat] = await Promise.all([fs.readFile(lock, "utf8").catch(() => ""), fs.stat(lock)]); const ownerPid = Number.parseInt(rawPid.trim(), 10); if (Number.isInteger(ownerPid) && ownerPid > 0 && !processAlive(ownerPid)) return true; return Date.now() - stat.mtimeMs > STALE_LOCK_MS; } catch { return true; } }
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

function guardTerminalTransition(current: OperationRecordV2, patch: Partial<OperationRecordV2>): Partial<OperationRecordV2> { if (!isTerminal(current.status)) return patch; const { status: _status, phase: _phase, result: _result, error: _error, finishedAt: _finishedAt, ...metadata } = patch; return metadata; }
function deriveProgress(participants: Record<string, OperationParticipantRecord>): OperationProgress { const values = Object.values(participants); return { expected: values.length, registered: values.filter((item) => item.status === "REGISTERED" || item.status === "IDLE").length, running: values.filter((item) => item.status === "RUNNING").length, completed: values.filter((item) => item.status === "COMPLETED").length, failed: values.filter((item) => item.status === "FAILED" || item.status === "CANCELLED").length, blocked: values.filter((item) => item.status === "BLOCKED").length }; }
async function assertSuccessTerminalEvidence(stateRoot: string, record: OperationRecordV2, result?: Record<string, unknown>): Promise<void> {
  if (!record.candidateRevision) throw new Error("V2_TERMINAL_GATE_REJECTED: successful operations require a current candidate revision.");
  if (!Object.keys(record.participantReceipts ?? {}).length) throw new Error("V2_TERMINAL_GATE_REJECTED: successful operations require at least one terminal receipt.");
  for (const participant of Object.values(record.participants)) {
    const receipt = Object.values(record.participantReceipts ?? {}).find((item) => item.participantId === participant.id);
    if (!receipt) throw new Error(`V2_TERMINAL_GATE_REJECTED: participant ${participant.id} has no terminal receipt.`);
    const decision = evaluateTerminalGate(receipt, { operationId: record.id, candidate: record.candidateRevision });
    if (!decision.allowed) throw new Error(`V2_TERMINAL_GATE_REJECTED: ${decision.reasons.map((reason) => reason.code).join(",")}`);
  }
  if (record.kind === "audit") return;
  const objective = result?.objectiveCompletion as ObjectiveCompletionInputV1 | undefined;
  const reportedDecision = result?.objectiveCompletionDecision as ReturnType<typeof evaluateObjectiveCompletionV1> | undefined;
  const reportedOracle = result?.acceptanceOracle as AcceptanceOracleDispositionV1 | undefined;
  if (!objective || !reportedDecision || !reportedOracle || typeof result?.acceptanceOracleArtifact !== "string") {
    throw new Error("OBJECTIVE_COMPLETION_REQUIRED: successful managed change/run operations require durable objective completion, current AcceptanceOracle disposition, and oracle artifact reference.");
  }
  const identity = currentObjectiveIdentityV1(record);
  if (reportedOracle.disposition !== "ACCEPTED" || sha256Canonical(reportedOracle.identity) !== sha256Canonical(identity)
    || objective.acceptance.disposition !== "ACCEPTED" || sha256Canonical(objective.identity) !== sha256Canonical(identity)) {
    throw new Error("OBJECTIVE_COMPLETION_IDENTITY_STALE: current operation does not match the accepted candidate/policy/execution/epoch evidence.");
  }
  const artifact = await loadCurrentAcceptanceOracleArtifactV1(stateRoot, record);
  if (!artifact || artifact.disposition.digest !== reportedOracle.digest) throw new Error("ACCEPTANCE_ORACLE_ARTIFACT_REQUIRED: successful terminalization requires the persisted current AcceptanceOracle disposition consumed by the run.");
  if (sha256Canonical(artifact.disposition) !== sha256Canonical(reportedOracle)
    || sha256Canonical(objective.acceptance.requiredAssertionIds) !== sha256Canonical(artifact.disposition.requiredAssertionIds)
    || sha256Canonical(objective.acceptance.coveredAssertionIds) !== sha256Canonical(artifact.disposition.coveredAssertionIds)) {
    throw new Error("OBJECTIVE_COMPLETION_ORACLE_COVERAGE_STALE: completion assertion coverage does not match the persisted current AcceptanceOracle disposition.");
  }
  const decision = evaluateObjectiveCompletionV1(objective);
  if (!decision.complete || sha256Canonical(decision) !== sha256Canonical(reportedDecision)) {
    throw new Error(`OBJECTIVE_COMPLETION_REJECTED: deterministic Definition of Done failed: ${decision.blockers.map((item) => item.code).join(",")}`);
  }
  for (const participant of Object.values(record.participants)) {
    const snapshot = objective.participants.find((item) => item.id === participant.id);
    if (!snapshot || snapshot.status !== participant.status || (participant.status === "REGISTERED" || participant.status === "IDLE" || participant.status === "RUNNING") && !snapshot.required) {
      throw new Error(`OBJECTIVE_PARTICIPANT_SNAPSHOT_STALE: completion does not account for current participant '${participant.id}' state.`);
    }
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
