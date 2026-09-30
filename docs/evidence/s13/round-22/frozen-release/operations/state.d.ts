import type { IntentDecisionV1 } from "../audit/intentDecision.js";
import type { ChangePreflightV1 } from "../core/triage.js";
import { type CandidateAssemblyReceiptV1, type CandidateRevisionV1, type ParticipantReceiptV1 } from "./v2Contracts.js";
import { type ExecutionBindingV2, type ResolvedOperationPolicyV1 } from "../architecture/executionIdentity.js";
import { type ContinuationRecordV1, type DecisionRequestV1, type HumanDecisionBindingV2, type HumanDecisionV2, type OperationControlCommandV1 } from "../security/humanDecision.js";
export type OperationKind = "audit" | "run" | "change";
export type OperationStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
export type OperationStageStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "BLOCKED" | "SKIPPED";
export type OperationParticipantStatus = "REGISTERED" | "IDLE" | "RUNNING" | "COMPLETED" | "FAILED" | "BLOCKED" | "CANCELLED";
export type SupervisorGenerationStatus = "INITIALIZING" | "ACTIVE" | "DRAINING" | "ARCHIVED" | "FAILED";
export declare const OPERATION_KIND_VALUES: readonly ["audit", "run", "change"];
export declare const OPERATION_STATUS_VALUES: readonly ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"];
export declare const OPERATION_TERMINAL_STATUS_VALUES: readonly ["SUCCEEDED", "FAILED", "CANCELLED"];
/**
 * The controller may move work from queued to running or to a terminal state
 * when a complete operation result is already available. Direct metadata
 * patches still cannot claim queued work succeeded; terminal records are
 * otherwise immutable and idempotent.
 */
export declare function isAllowedOperationStatusTransition(from: OperationStatus, to: OperationStatus): boolean;
export interface AuditOperationPayload {
    request: string;
    files?: string[];
    domains?: string[];
    risk?: "low" | "medium" | "high";
    reviewers?: string[];
    intentDecision?: IntentDecisionV1;
}
export interface RunOperationPayload {
    taskId: string;
    profile?: string;
    priority?: number;
    intentDecision?: IntentDecisionV1;
}
export interface IssueIntakeRequestV1 {
    number: number;
    refresh?: boolean;
    force?: boolean;
}
export interface ChangeOperationPayload {
    request: string;
    title?: string;
    taskId?: string;
    files?: string[];
    domains?: string[];
    acceptance?: string[];
    risk?: "low" | "medium" | "high";
    profile?: string;
    priority?: number;
    intentDecision?: IntentDecisionV1;
    issueIntake?: IssueIntakeRequestV1;
}
export interface IssueIntakeTerminalEvidenceV1 {
    version: 1;
    taskId: string;
    route: string;
    normalizedBy: string;
    snapshot: {
        repository: string;
        number: number;
        contentSha256: string;
        path: string;
    };
    contract: {
        path: string;
        digest: string;
    };
    planner: {
        participantId?: string;
        sessionId?: string;
    };
    semanticAssessmentDigest?: string;
    traceability?: string;
    candidateAdvanced: boolean;
}
export type OperationPayload = AuditOperationPayload | RunOperationPayload | ChangeOperationPayload;
export interface OperationAgentRecord {
    id: string;
    role?: string;
    phase?: string;
    workspaceId?: string;
    transport?: string;
    registeredAt: string;
    executionBinding?: ExecutionBindingV2;
}
export interface OperationLeadBinding {
    agentId: string;
    source?: string;
    generation: number;
    boundAt: string;
    acknowledgedRevision: number;
    acknowledgedAt?: string;
}
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
export interface OperationSupervisionState {
    required: boolean;
    materialized: boolean;
    activeGeneration?: number;
    generations: OperationSupervisorGeneration[];
    latestConsolidationRevision?: number;
    latestConsolidationArtifact?: string;
}
export interface OperationStageRecord {
    name: string;
    status: OperationStageStatus;
    revision: number;
    startedAt?: string;
    finishedAt?: string;
    message?: string;
    artifact?: string;
}
export interface OperationParticipantRecord {
    id: string;
    logicalAgent?: string;
    role?: string;
    stage?: string;
    phase?: string;
    parentSupervisorGeneration?: number;
    parentAgentId?: string;
    workspaceId?: string;
    transport?: string;
    status: OperationParticipantStatus;
    registeredAt: string;
    startedAt?: string;
    finishedAt?: string;
    resultArtifact?: string;
    executionBinding?: ExecutionBindingV2;
    error?: string;
}
export interface OperationProgress {
    expected: number;
    registered: number;
    running: number;
    completed: number;
    failed: number;
    blocked: number;
}
export interface OperationNotificationState {
    lastLeadWakeRevision: number;
    lastLeadWakeAt?: string;
    lastLeadWakeReason?: string;
    terminalDelivered: boolean;
    attempts: number;
    lastError?: string;
}
export interface OperationIntentState {
    request?: string;
    classification?: "AUDIT" | "CHANGE" | "RUN";
    route?: "NO_AGENT" | "DIRECT" | "DELEGATED" | "FORMAL_SDD";
    assurance?: "NONE" | "STANDARD" | "ELEVATED" | "CRITICAL";
    risk?: "low" | "medium" | "high";
    priority?: number;
    semanticDecision?: IntentDecisionV1;
}
export interface OperationControllerBinding {
    epoch: number;
    ownerId: string;
    claimedAt: string;
    previousOwnerId?: string;
    tokenDigest?: string;
    pid?: number;
}
export declare const operationPauseRevalidationValuesV1: readonly ["candidate-current", "operation-revision-current", "policy-current", "controller-epoch-current", "continuation-current"];
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
export declare function assertOperationPauseRecordV1(value: unknown): OperationPauseRecordV1;
export interface OperationRecordV1 {
    version: 1;
    id: string;
    kind: "audit" | "run";
    status: OperationStatus;
    phase: string;
    root: string;
    payload: AuditOperationPayload | RunOperationPayload;
    createdAt: string;
    updatedAt: string;
    startedAt?: string;
    finishedAt?: string;
    pid?: number;
    workspaceId?: string;
    workspaceWarning?: string;
    agents?: OperationAgentRecord[];
    cleanupWarnings?: string[];
    result?: Record<string, unknown>;
    error?: string;
}
export interface OperationRecordV2 {
    version: 2;
    id: string;
    kind: OperationKind;
    status: OperationStatus;
    phase: string;
    root: string;
    workspaceRoot?: string;
    payload: OperationPayload;
    revision: number;
    createdAt: string;
    updatedAt: string;
    lastProgressAt: string;
    startedAt?: string;
    finishedAt?: string;
    pid?: number;
    workspaceId?: string;
    workspaceWarning?: string;
    intent?: OperationIntentState;
    lead?: OperationLeadBinding;
    changePreflight?: ChangePreflightV1;
    supervision: OperationSupervisionState;
    stages: Record<string, OperationStageRecord>;
    participants: Record<string, OperationParticipantRecord>;
    progress: OperationProgress;
    notification: OperationNotificationState;
    agents?: OperationAgentRecord[];
    cleanupWarnings?: string[];
    result?: Record<string, unknown>;
    error?: string;
    candidateRevision?: CandidateRevisionV1;
    participantReceipts?: Record<string, ParticipantReceiptV1>;
    /** Deterministic ASSEMBLING evidence: one receipt per successful candidate transition. */
    candidateAssemblyReceipts?: Record<string, CandidateAssemblyReceiptV1>;
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
export interface TerminalOperationTransition {
    record: OperationRecordV2;
    transitioned: boolean;
}
export interface OperationEvent {
    version: 1;
    operationId: string;
    revision: number;
    at: string;
    type: string;
    status: OperationStatus;
    phase: string;
    changed?: string[];
    details?: Record<string, unknown>;
}
export declare function resolveOperationStateRoot(root: string): string;
export declare function operationFile(root: string, operationId: string): string;
export declare function operationArtifactDir(root: string, operationId: string): string;
export declare function operationEventsFile(root: string, operationId: string): string;
export declare function loadOperation(root: string, operationId: string): Promise<OperationRecordV2>;
export declare function saveOperation(root: string, record: OperationRecord): Promise<void>;
export declare function patchOperation(root: string, operationId: string, patch: Partial<OperationRecordV2>): Promise<OperationRecordV2>;
export declare function patchOperationMetadata(root: string, operationId: string, patch: Partial<OperationRecordV2>): Promise<OperationRecordV2>;
export declare function updateOperationMetadata(root: string, operationId: string, update: (current: OperationRecordV2, now: string) => Partial<OperationRecordV2>): Promise<OperationRecordV2>;
export declare function transitionOperationToTerminal(root: string, operationId: string, patch: Partial<OperationRecordV2> & {
    status: "SUCCEEDED" | "FAILED" | "CANCELLED";
}): Promise<TerminalOperationTransition>;
export declare function bindOperationLead(root: string, operationId: string, agentId: string, source?: string): Promise<OperationRecordV2>;
/** Update a participant only when it is already durably registered; never upserts. Runtime session
 * identities are provenance, not automatically work participants (TARGET: the Semantic Assessor is
 * an AEH Agent, not automatically a WorkGraph Participant). */
export declare function updateRegisteredOperationParticipant(root: string, operationId: string, agentId: string, patch: Partial<Omit<OperationParticipantRecord, "id" | "registeredAt" | "executionBinding">>): Promise<OperationRecordV2 | undefined>;
export declare function currentControllerEpoch(record: OperationRecordV2): number;
/** The epoch a controller process was launched with, if it identifies itself as a controller. */
export declare function controllerEpochFromEnvironment(): number | undefined;
export declare function assertControllerEpoch(record: OperationRecordV2, expected: number | undefined, action: string): void;
/** Require both the current durable epoch and its controller token for owner-only mutations. */
export declare function assertCurrentControllerOwner(record: OperationRecordV2, action: string): void;
/** Claim durable monotonic controller ownership. Every takeover increments the epoch and mints a new controller token. */
export declare function claimControllerEpoch(root: string, operationId: string, ownerId: string, options?: {
    pid?: number;
    cause?: "cancellation";
    humanActorId?: string;
    expectedCancellation?: {
        operationExecutionRevision: number;
        candidateDigest: string;
        policyDigest: string;
        controllerEpoch: number;
    };
}): Promise<OperationRecordV2>;
/** Bind detached-process identity without changing the current owner's epoch or token. */
export declare function bindControllerProcess(root: string, operationId: string, pid: number): Promise<OperationRecordV2>;
/** The controller token a controller process was launched with, if any. */
export declare function controllerTokenFromEnvironment(): string | undefined;
/**
 * Controller authority is not just a self-declared epoch: the caller must hold
 * the secret minted at claim time, whose digest is the only durable copy.
 */
export declare function assertControllerToken(record: OperationRecordV2, action: string): void;
export declare function acknowledgeOperationLead(root: string, operationId: string, revision: number, actorId: string, expectedControllerEpoch: number, reason?: string): Promise<OperationRecordV2>;
export declare function markTerminalDelivered(root: string, operationId: string, attempts: number, error?: string): Promise<OperationRecordV2>;
export declare function bindOperationCandidate(root: string, operationId: string, candidate: CandidateRevisionV1): Promise<OperationRecordV2>;
export declare function bindResolvedOperationPolicy(root: string, operationId: string, policy: ResolvedOperationPolicyV1): Promise<OperationRecordV2>;
export type ProductChoiceRequestContentV1 = Pick<DecisionRequestV1, "issue" | "authoritativeEvidence" | "whatTried" | "whyUnresolvable" | "choices" | "workThatCanContinue">;
/** Persist the complete DecisionRequest and controller continuation before exposing HUMAN_REQUIRED. */
export declare function suspendOperationForProductChoice(root: string, operationId: string, content: ProductChoiceRequestContentV1, checkpoint: unknown, expiresInMs?: number): Promise<OperationRecordV2>;
export declare function loadOperationProductChoiceCheckpoint(root: string, operationId: string): Promise<unknown>;
/** Read an intact WAITING checkpoint only to reissue its unanswered request under current authority. */
export declare function loadWaitingOperationProductChoiceCheckpointForReissue(root: string, operationId: string): Promise<unknown>;
/** Recovery-only checkpoint read for a consumed choice whose authority became stale after takeover. */
export declare function loadStaleConsumedProductChoiceCheckpointForReconfirmation(root: string, operationId: string): Promise<unknown>;
/** Re-open a stale consumed product choice as a new scoped HUMAN_REQUIRED request. */
export declare function reconfirmStaleConsumedProductChoice(root: string, operationId: string, content: ProductChoiceRequestContentV1, checkpoint: unknown): Promise<OperationRecordV2>;
/**
 * Verify a consumed choice against both its original ledger binding and the
 * narrowly permitted post-choice execution revision. A consumed selection can
 * never be rebound across policy identity or controller epoch changes.
 */
export declare function assertCurrentConsumedProductChoiceBinding(current: OperationRecordV2, continuationInput: ContinuationRecordV1, decisionBinding: HumanDecisionBindingV2): void;
/** Refresh an unanswered request after controller takeover; old epoch-bound submissions remain stale. */
export declare function reissueOperationProductChoice(root: string, operationId: string, checkpoint: unknown): Promise<OperationRecordV2>;
/** Controller-owned transition after the ledger has atomically consumed the exact choice. */
export declare function markOperationProductChoiceConsumed(root: string, operationId: string, input: {
    requestId: string;
    decisionId: string;
    choiceId: string;
}): Promise<OperationRecordV2>;
/** Recompile operation semantics after the selected product choice has produced a revised sealed requirement contract. */
export declare function bindProductChoiceExecutionSemantics(root: string, operationId: string, input: {
    requirementDigest: string;
    decisionId: string;
    choiceId: string;
    priorDecisionIds?: string[];
}): Promise<OperationRecordV2>;
/** Rebind a consumed continuation only after the controller has recompiled and bound the current policy. */
export declare function resumeOperationProductChoice(root: string, operationId: string): Promise<OperationRecordV2>;
/** Record a scoped PAUSE control request for the current operation identity. */
export declare function requestOperationPause(root: string, operationId: string, actorId: string, reason?: string): Promise<HumanDecisionV2>;
/** Record a scoped RESUME control request against a current PAUSED operation. */
export declare function requestOperationResume(root: string, operationId: string, actorId: string, reason?: string): Promise<HumanDecisionV2>;
/** Read the unique current-binding operation-control decision, if any. */
export declare function pendingOperationControl(root: string, operationId: string, command: OperationControlCommandV1): Promise<HumanDecisionV2 | undefined>;
/**
 * Controller-owned pause application. Consumes the exact scoped PAUSE control
 * once and persists PAUSED with the drain receipt. A no-op when no current
 * control exists or the operation is not pausable.
 */
export declare function pauseOperationIfRequested(root: string, operationId: string, drainReceipt: OperationPauseDrainReceiptV1): Promise<OperationRecordV2>;
/**
 * Controller-owned wait for a scoped RESUME control. Exits on a terminal
 * operation or when the pause was already cleared by another current owner.
 */
export declare function awaitOperationResume(root: string, operationId: string, options?: {
    pollMs?: number;
}): Promise<OperationRecordV2>;
/** Apply a pending PAUSE and, when paused, block until a scoped RESUME or terminal state. */
export declare function operationControlCheckpoint(root: string, operationId: string, drainReceipt: OperationPauseDrainReceiptV1): Promise<OperationRecordV2>;
/** Rebind a recovered PAUSED record to the current controller identity after takeover. */
export declare function rebindPauseRecordToCurrentIdentity(root: string, operationId: string): Promise<OperationRecordV2>;
export declare function completeOperationProductChoice(root: string, operationId: string): Promise<OperationRecordV2>;
/**
 * A provisional bootstrap policy is bound before the WorkGraph/knowledge/validation semantics exist
 * so that early participants (Explorer, Planner, Librarian) have a frozen policy to launch under.
 * The first real execution-semantics binding supersedes it exactly once: the planning semantics
 * advance the operation execution revision, clear the provisional policy, and invalidate the
 * participant bindings issued under it. Without this the compiled policy would collide with the
 * provisional body and fail closed with EXECUTION_POLICY_RECOMPILE_REQUIRED (AEH-V2-0110).
 */
export declare function isProvisionalOperationPolicyV1(policy: ResolvedOperationPolicyV1 | undefined): boolean;
export declare function bindOperationExecutionSemantics(root: string, operationId: string, executionSemanticsDigest: string): Promise<OperationRecordV2>;
export declare function recordParticipantReceipt(root: string, operationId: string, receipt: ParticipantReceiptV1): Promise<OperationRecordV2>;
export interface CandidateAssemblyReceiptInputV1 {
    baseCandidate: CandidateRevisionV1;
    candidate: CandidateRevisionV1;
    changeSet: {
        operationId: string;
        taskId: string;
        workUnitId: string;
        participantId: string;
        baseCandidateRevision: number;
        baseCandidateDigest: string;
        patchDigest: string;
        derivation?: {
            originalChangeSetDigest: string;
            originalBaseCandidateRevision: number;
            originalBaseCandidateDigest: string;
        };
    };
}
/**
 * Record the deterministic ASSEMBLING receipt for a successful candidate transition. The source
 * bounded-work receipt — when the ChangeSet producer has a settled `SUCCEEDED` receipt bound to
 * the candidate the producer observed — is referenced by id and digest; the receipt itself is
 * never rewritten. Completion evidence then resolves the pre-assembly binding through this chain
 * (AEH-V2-0106). Assembly without a settled source receipt records lineage only and leaves
 * participant completion fail-closed.
 */
export declare function recordCandidateAssemblyReceipt(root: string, operationId: string, input: CandidateAssemblyReceiptInputV1): Promise<OperationRecordV2>;
export declare function setOperationStage(root: string, operationId: string, name: string, status: OperationStageStatus, options?: {
    message?: string;
    artifact?: string;
}): Promise<OperationRecordV2>;
export declare function registerSupervisorGeneration(root: string, operationId: string, input: {
    agentId?: string;
    materialized: boolean;
    checkpointArtifact?: string;
    status?: SupervisorGenerationStatus;
    initializationAttempt?: number;
}): Promise<OperationRecordV2>;
export declare function updateSupervisorGeneration(root: string, operationId: string, generation: number, patch: Partial<OperationSupervisorGeneration>): Promise<OperationRecordV2>;
export declare function activeOperationSupervisor(record: OperationRecordV2): OperationSupervisorGeneration | undefined;
export declare function initializingOperationSupervisor(record: OperationRecordV2): OperationSupervisorGeneration | undefined;
export declare function recoverableOperationSupervisor(record: OperationRecordV2): OperationSupervisorGeneration | undefined;
export declare function registerOperationAgent(root: string, operationId: string, agent: Omit<OperationAgentRecord, "registeredAt"> & {
    logicalAgent?: string;
    parentAgentId?: string;
    parentSupervisorGeneration?: number;
}): Promise<OperationRecordV2>;
export declare function bindOperationParticipantExecution(root: string, operationId: string, input: {
    participantId: string;
    logicalAgent: string;
    role: string;
    binding: ExecutionBindingV2;
}): Promise<OperationRecordV2>;
export declare function updateOperationParticipant(root: string, operationId: string, agentId: string, patch: Partial<Omit<OperationParticipantRecord, "id" | "registeredAt" | "executionBinding">>): Promise<OperationRecordV2>;
export declare function registerCurrentOperationAgent(root: string, agent: Omit<OperationAgentRecord, "registeredAt"> & {
    logicalAgent?: string;
    parentAgentId?: string;
    parentSupervisorGeneration?: number;
}): Promise<void>;
export declare function currentOperationContext(): {
    id?: string;
    kind?: string;
    workspaceId?: string;
    controlRoot?: string;
};
export declare function updateCurrentOperationPhase(root: string, phase: string): Promise<void>;
export declare function normalizeOperationRecord(record: OperationRecord): OperationRecordV2;
export declare function withOperationCoordinationLock<T>(root: string, operationId: string, action: () => Promise<T>): Promise<T>;
export declare function isTerminalOperation(status: OperationStatus): boolean;
