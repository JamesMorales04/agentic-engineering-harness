import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { sha256Canonical, sha256Utf8 } from "../core/digest.js";
import { computeWorktreeDigest } from "../core/git.js";
import { createTrustedOperationToolError } from "./toolDiagnostics.js";
import type { ExecutionBindingV3 } from "../architecture/executionIdentity.js";
import {
  activeOperationSupervisor,
  currentControllerEpoch,
  isTerminalOperation,
  loadOperation,
  resolveOperationStateRoot,
  updateOperationMetadata,
  withOperationCoordinationLock,
  type OperationParticipantRecord,
  type OperationRecordV2
} from "./state.js";

export const participantExecutionStateValuesV1 = [
  "CREATED", "READY", "ACTIVE", "WAITING_TOOL", "WAITING_PROVIDER", "PROGRESSING",
  "STALL_SUSPECTED", "RECOVERING", "COMPLETED", "FAILED", "CANCELLED"
] as const;
export type ParticipantExecutionStateV1 = (typeof participantExecutionStateValuesV1)[number];
export type ProgressLevelV1 = "HIGH" | "MEDIUM" | "LOW";

export const progressEvidenceKindValuesV1 = [
  "SOURCE_MUTATION", "CANDIDATE_REVISION", "TEST_RESULT", "VALIDATION_RESULT", "ARTIFACT_PRODUCED",
  "BLOCKER_RESOLVED", "STRUCTURED_RESULT_ACCEPTED", "NEW_RETRIEVAL", "TOOL_SUCCESS_NONREDUNDANT",
  "DEPENDENCY_DISCOVERY", "WORKGRAPH_ADVANCED", "PROVIDER_HEARTBEAT", "REASONING_ACTIVITY",
  "REPEATED_READ", "EQUIVALENT_TOOL_CALL", "PROVIDER_TURN_STARTED", "PROVIDER_TURN_COMPLETED",
  "TOOL_CALL_STARTED", "TOOL_CALL_COMPLETED", "TOOL_CALL_FAILED", "RETRIEVAL_REQUESTED", "RETRIEVAL_COMPLETED",
  "WAITING_TOOL", "WAITING_PROVIDER", "SESSION_READY",
  "PARTICIPANT_STARTED", "PARTICIPANT_TERMINAL"
] as const;
export type ProgressEvidenceKindV1 = (typeof progressEvidenceKindValuesV1)[number];

export interface ExecutionLivenessPolicyV1 {
  version: 1;
  hardDeadlineMs: number;
  progressLeaseMs: number;
  stallWindowMs: number;
  providerTurnDeadlineMs: number;
  defaultToolDeadlineMs: number;
  maxNoProgressRenewals: number;
  maxParticipantRestarts: number;
  maxLocalRetriesPerFailure: number;
  softBudgetThreshold: number;
  toolDeadlinesMs: Record<string, number>;
}

export interface EconomicEnvelopeV1 {
  version: 1;
  initialProviderTurns: number;
  supervisorProviderTurns: number;
  hardProviderTurns: number;
  maxLocalRetries: number;
  maxParticipantRestarts: number;
  softThreshold: number;
  hardToolCalls?: number;
  hardTotalTokens?: number;
  hardCostUsd?: number;
  hardDeadlineAt?: string;
}

export interface OwnerEconomicBoundaryRequirementV1 {
  version: 1;
  kind: "OWNER_ECONOMIC_BOUNDARY";
  scope: "PARTICIPANT" | "OPERATION";
  operationId: string;
  participantId: string;
  participantGeneration: string;
  executionBindingDigest: string;
  candidateDigest: string;
  policyDigest: string;
  controllerEpoch: number;
  budget: "HARD_TOOL_CALLS" | "HARD_TOTAL_TOKENS" | "HARD_COST_USD";
  configuredLimit: number;
  observed: number | null;
  usageCoverage: "COMPLETE" | "PARTIAL" | "UNKNOWN";
  evidenceRefs: string[];
  reason: string;
  state: "WAITING";
  createdAt: string;
  digest: string;
}

export interface OwnerEconomicBoundarySignalV1 {
  budget: OwnerEconomicBoundaryRequirementV1["budget"];
  configuredLimit: number;
  observed: number | null;
  usageCoverage: OwnerEconomicBoundaryRequirementV1["usageCoverage"];
  evidenceRefs: string[];
  reason: string;
}

export interface ProgressLeaseV1 {
  version: 1;
  operationId: string;
  operationExecutionRevision: number;
  candidateRevision: number;
  candidateDigest: string;
  policyDigest: string;
  controllerEpoch: number;
  participantId: string;
  participantGeneration: string;
  leaseId: string;
  issuedAt: string;
  expiresAt: string;
  renewalCount: number;
  noProgressRenewalCount: number;
  renewedThroughEvidenceDigest: string | null;
  renewedBy: "CONTROLLER" | "SUPERVISOR" | "LEAD" | null;
  renewedBySessionId: string | null;
  digest: string;
}

export interface ParticipantExecutionLivenessV1 {
  version: 1;
  state: ParticipantExecutionStateV1;
  startedAt?: string;
  lastActivityAt?: string;
  lastMeaningfulProgressAt?: string;
  firstToolCallAt?: string;
  firstMutationAt?: string;
  lastSuccessfulToolCall?: { toolName: string; callId?: string; at: string; argumentsDigest: string };
  waitingSinceAt?: string;
  waitingKind?: "TOOL" | "PROVIDER";
  waitingToolName?: string;
  waitingDeadlineAt?: string;
  toolCallsBeforeFirstMutation: number;
  turnsBeforeFirstMutation: number | null;
  providerTurns: number;
  currentProviderTurnBudget: number;
  toolCallCount: number;
  repositoryMutationCount: number;
  artifactCount: number;
  validationCount: number;
  noProgressRenewals: number;
  localRetryCount: number;
  participantRestarts: number;
  progressLease?: ProgressLeaseV1;
  lastActivityEventDigest?: string;
  lastRecoveryDecision?: SupervisorRecoveryDecisionV1;
  sourceBaselineDigest?: string;
}

export interface ExecutionActivityEventV1 {
  version: 1;
  eventId: string;
  operationId: string;
  operationExecutionRevision: number;
  candidateRevision: number;
  candidateDigest: string;
  executionBindingDigest: string;
  policyDigest: string;
  controllerEpoch: number;
  participantId: string;
  participantGeneration: string;
  role: string;
  phase: string;
  provider: string;
  model: string;
  sessionId: string;
  kind: ProgressEvidenceKindV1;
  level: ProgressLevelV1;
  observedAt: string;
  evidenceId: string;
  evidenceDigest: string;
  toolName?: string;
  toolCallId?: string;
  argumentsDigest?: string;
}

export const supervisorRecoveryActionValuesV1 = [
  "CONTINUE", "RESUME_SAME_SESSION", "ROTATE_SESSION", "RETRY_PARTICIPANT", "RETRIEVE_SKILL", "REPLAN",
  "SPLIT_WORK", "REASSIGN", "FAIL", "ESCALATE_TO_LEAD"
] as const;
export type SupervisorRecoveryActionV1 = (typeof supervisorRecoveryActionValuesV1)[number];

export interface SupervisorRecoveryDecisionV1 {
  version: 1;
  operationId: string;
  operationExecutionRevision: number;
  candidateRevision: number;
  candidateDigest: string;
  executionBindingDigest: string;
  policyDigest: string;
  controllerEpoch: number;
  participantId: string;
  participantGeneration: string;
  observedProviderTurns: number;
  actorRole: "SUPERVISOR" | "LEAD";
  actorSessionId: string;
  skillId?: string;
  skillProjectionDigest?: string;
  action: SupervisorRecoveryActionV1;
  application: "REQUESTED" | "APPLIED" | "ADVISORY_ONLY" | "ESCALATE_TO_LEAD";
  evidenceIds: string[];
  reason: string;
  decidedAt: string;
  digest: string;
}

const eventSchema = z.object({
  version: z.literal(1), eventId: z.string().min(1), operationId: z.string().min(1),
  operationExecutionRevision: z.number().int().positive(), candidateRevision: z.number().int().positive(),
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/), executionBindingDigest: z.string().regex(/^[a-f0-9]{64}$/), policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  controllerEpoch: z.number().int().nonnegative(), participantId: z.string().min(1), participantGeneration: z.string().min(1),
  role: z.string().min(1), phase: z.string().min(1), provider: z.string().min(1), model: z.string().min(1), sessionId: z.string().min(1),
  kind: z.enum(progressEvidenceKindValuesV1), level: z.enum(["HIGH", "MEDIUM", "LOW"]), observedAt: z.string().datetime(),
  evidenceId: z.string().min(1), evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  toolName: z.string().optional(), toolCallId: z.string().optional(), argumentsDigest: z.string().regex(/^[a-f0-9]{64}$/).optional()
}).strict();

export function progressLevelForEvidenceV1(kind: ProgressEvidenceKindV1): ProgressLevelV1 {
  switch (kind) {
    case "SOURCE_MUTATION": case "CANDIDATE_REVISION": case "TEST_RESULT": case "VALIDATION_RESULT":
    case "ARTIFACT_PRODUCED": case "BLOCKER_RESOLVED": case "STRUCTURED_RESULT_ACCEPTED": return "HIGH";
    case "NEW_RETRIEVAL": case "TOOL_SUCCESS_NONREDUNDANT": case "DEPENDENCY_DISCOVERY": case "WORKGRAPH_ADVANCED": return "MEDIUM";
    default: return "LOW";
  }
}

export function initialParticipantLivenessV1(binding: ExecutionBindingV3, policy: ExecutionLivenessPolicyV1, economic: EconomicEnvelopeV1, at = new Date(), operationCreatedAt = at.toISOString(), rootHardDeadlineAt?: string): ParticipantExecutionLivenessV1 {
  const now = at.toISOString();
  const createdAtMs = Date.parse(operationCreatedAt);
  const rootDeadlineMs = rootHardDeadlineAt ? Date.parse(rootHardDeadlineAt) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(rootDeadlineMs) && rootDeadlineMs !== Number.POSITIVE_INFINITY) throw new Error("EXECUTION_LIVENESS_DEADLINE_INVALID: operation creation or inherited hard-deadline timestamp is invalid.");
  const hardDeadline = Math.min(createdAtMs + policy.hardDeadlineMs, rootDeadlineMs);
  const expiresAt = new Date(Math.min(at.getTime() + policy.progressLeaseMs, hardDeadline)).toISOString();
  const leaseBody = {
    version: 1 as const,
    operationId: binding.operationId,
    operationExecutionRevision: binding.operationExecutionRevision,
    candidateRevision: binding.candidateRevision,
    candidateDigest: binding.candidateDigest,
    policyDigest: binding.operationPolicyDigest,
    controllerEpoch: binding.controllerEpoch,
    participantId: binding.participantId,
    participantGeneration: binding.participantGeneration,
    leaseId: `progress-lease:${sha256Canonical({ operationId: binding.operationId, participantId: binding.participantId, generation: binding.participantGeneration }).slice(0, 24)}`,
    issuedAt: now,
    expiresAt,
    renewalCount: 0,
    noProgressRenewalCount: 0,
    renewedThroughEvidenceDigest: null,
    renewedBy: null,
    renewedBySessionId: null
  };
  const progressLease = { ...leaseBody, digest: sha256Canonical(leaseBody) };
  return {
    version: 1, state: "ACTIVE", startedAt: now, lastActivityAt: now,
    toolCallsBeforeFirstMutation: 0, turnsBeforeFirstMutation: null, providerTurns: 0,
    currentProviderTurnBudget: economic.initialProviderTurns, toolCallCount: 0,
    repositoryMutationCount: 0, artifactCount: 0, validationCount: 0,
    noProgressRenewals: 0, localRetryCount: 0, participantRestarts: 0, progressLease
  };
}

export async function initializeParticipantLivenessV1(root: string, operationId: string, participantId: string, binding: ExecutionBindingV3, at = new Date()): Promise<void> {
  const stateRoot = resolveOperationStateRoot(root);
  const sourceBaselineDigest = await computeWorktreeDigest(root).catch(() => undefined);
  await updateOperationMetadata(stateRoot, operationId, (operation) => {
    const participant = operation.participants[participantId];
    if (!participant || participant.executionBinding?.digest !== binding.digest || participant.executionLiveness) return {};
    assertCurrentBinding(operation, participant, binding);
    const resolvedPolicy = operation.resolvedOperationPolicy;
    const policy = resolvedPolicy?.executionLiveness;
    if (!policy || !resolvedPolicy) throw new Error("EXECUTION_LIVENESS_POLICY_REQUIRED: participant cannot start without the frozen operation liveness policy.");
    return {
      participants: {
        ...operation.participants,
        [participantId]: { ...participant, executionLiveness: { ...initialParticipantLivenessV1(binding, policy, resolvedPolicy.economicEnvelope, at, operation.createdAt, operation.origin?.rootHardDeadlineAt), ...(sourceBaselineDigest ? { sourceBaselineDigest } : {}) } }
      }
    };
  });
}

/** Persist deterministic, identity-bound evidence. LOW activity is recorded but never renews a lease. */
export async function recordParticipantExecutionActivityV1(
  root: string,
  operationId: string,
  participantId: string,
  input: { kind: ProgressEvidenceKindV1; evidenceId: string; evidenceDigest: string; observedAt?: Date; toolName?: string; toolCallId?: string; argumentsDigest?: string }
): Promise<ExecutionActivityEventV1 | undefined> {
  const stateRoot = resolveOperationStateRoot(root);
  let ownerBoundarySignal: OwnerEconomicBoundarySignalV1 | undefined;
  let progressBudgetBoundary: OwnerEconomicBoundarySignalV1 | undefined;
  const recorded = await withOperationCoordinationLock(stateRoot, operationId, async () => {
    const operation = await loadOperation(stateRoot, operationId);
    const participant = operation.participants[participantId];
    const binding = participant?.executionBinding;
    if (!participant || !binding || isTerminalOperation(operation.status) || operation.ownerEconomicBoundary) return undefined;
    if (operation.resolvedOperationPolicy?.digest !== binding.operationPolicyDigest
      || operation.operationExecutionRevision !== binding.operationExecutionRevision
      || operation.candidateRevision?.identityDigest !== binding.candidateDigest
      || currentControllerEpoch(operation) !== binding.controllerEpoch) return undefined;
    const at = (input.observedAt ?? new Date()).toISOString();
    const level = progressLevelForEvidenceV1(input.kind);
    const currentLiveness = participant.executionLiveness;
    const economic = operation.resolvedOperationPolicy?.economicEnvelope;
    if (input.kind === "PROVIDER_TURN_STARTED" && operation.resolvedOperationPolicy) {
      try { await assertConfiguredUsageBudgets(stateRoot, operation, operation.resolvedOperationPolicy.economicEnvelope); }
      catch (error) {
        if (error instanceof OwnerEconomicBoundaryError) {
          ownerBoundarySignal = error.signal;
          return undefined;
        }
        throw error;
      }
    }
    if (input.kind === "PROVIDER_TURN_STARTED" && currentLiveness && economic) {
      if (currentLiveness.providerTurns >= economic.hardProviderTurns) {
        await updateOperationMetadata(stateRoot, operation.id, (current) => {
          const latest = current.participants[participantId];
          if (!latest?.executionBinding || latest.executionBinding.digest !== binding.digest || !latest.executionLiveness || latest.executionLiveness.state === "STALL_SUSPECTED") return {};
          return { participants: { ...current.participants, [participantId]: { ...latest, executionLiveness: { ...latest.executionLiveness, state: "STALL_SUSPECTED" } } } };
        });
        return undefined;
      }
      if (currentLiveness.providerTurns >= currentLiveness.currentProviderTurnBudget) {
        await updateOperationMetadata(stateRoot, operation.id, (current) => {
          const latest = current.participants[participantId];
          if (!latest?.executionBinding || latest.executionBinding.digest !== binding.digest || !latest.executionLiveness || latest.executionLiveness.state === "STALL_SUSPECTED") return {};
          return { participants: { ...current.participants, [participantId]: { ...latest, executionLiveness: { ...latest.executionLiveness, state: "STALL_SUSPECTED" } } } };
        });
        return undefined;
      }
    }
    const operationToolCallsBeforeEvent = sumParticipantToolCalls(operation);
    if (input.kind === "TOOL_CALL_STARTED" && economic?.hardToolCalls !== undefined && operationToolCallsBeforeEvent >= economic.hardToolCalls) {
      ownerBoundarySignal = {
        budget: "HARD_TOOL_CALLS", configuredLimit: economic.hardToolCalls, observed: operationToolCallsBeforeEvent,
        usageCoverage: "COMPLETE",
        evidenceRefs: (await readRecentActivity(stateRoot, operation.id, participant.id, binding.participantGeneration)).filter((event) => event.kind.startsWith("TOOL_CALL_")).map((event) => `activity://${operation.id}/${event.eventId}`).slice(-8),
        reason: "A further tool call would exceed the configured Owner hard tool-call ceiling."
      };
      return undefined;
    }
    if ((level === "HIGH" || level === "MEDIUM") && operation.resolvedOperationPolicy) {
      try { await assertConfiguredUsageBudgets(stateRoot, operation, operation.resolvedOperationPolicy.economicEnvelope); }
      catch (error) {
        if (error instanceof OwnerEconomicBoundaryError) progressBudgetBoundary = error.signal;
        else throw error;
      }
    }
    const eventBody = {
      version: 1 as const,
      operationId,
      operationExecutionRevision: binding.operationExecutionRevision,
      candidateRevision: binding.candidateRevision,
      candidateDigest: binding.candidateDigest,
      executionBindingDigest: binding.digest,
      policyDigest: binding.operationPolicyDigest,
      controllerEpoch: binding.controllerEpoch,
      participantId,
      participantGeneration: binding.participantGeneration,
      role: participant.role ?? "unknown",
      phase: participant.phase ?? "work",
      provider: binding.runtime.provider,
      model: binding.runtime.model,
      sessionId: binding.runtime.sessionId,
      kind: input.kind,
      level,
      observedAt: at,
      evidenceId: input.evidenceId,
      evidenceDigest: input.evidenceDigest,
      ...(input.toolName ? { toolName: input.toolName } : {}),
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      ...(input.argumentsDigest ? { argumentsDigest: input.argumentsDigest } : {})
    };
    const event = eventSchema.parse({ ...eventBody, eventId: `activity:${sha256Canonical(eventBody)}` });
    await appendActivityEvent(stateRoot, operationId, event);
    await updateOperationMetadata(stateRoot, operationId, (current) => {
      const latest = current.participants[participantId];
      if (!latest?.executionBinding || latest.executionBinding.digest !== binding.digest) return {};
      const liveness = latest.executionLiveness ?? initialParticipantLivenessV1(binding, current.resolvedOperationPolicy!.executionLiveness, current.resolvedOperationPolicy!.economicEnvelope, new Date(at), current.createdAt, current.origin?.rootHardDeadlineAt);
      const nextLiveness: ParticipantExecutionLivenessV1 = {
        ...liveness,
        state: level === "HIGH" || level === "MEDIUM" ? "PROGRESSING" : inferWaitingState(input.kind, liveness.state),
        lastActivityAt: at,
        ...(level === "HIGH" || level === "MEDIUM" ? { lastMeaningfulProgressAt: at } : {}),
        ...(input.kind === "TOOL_SUCCESS_NONREDUNDANT" && input.toolName ? {
          lastSuccessfulToolCall: { toolName: input.toolName, ...(input.toolCallId ? { callId: input.toolCallId } : {}), at, argumentsDigest: input.argumentsDigest ?? input.evidenceDigest }
        } : {}),
        lastActivityEventDigest: sha256Canonical(event)
      };
      if (input.kind === "WAITING_TOOL") {
        const livenessPolicy = current.resolvedOperationPolicy!.executionLiveness;
        const deadlineMs = livenessPolicy.toolDeadlinesMs[input.toolName ?? ""] ?? livenessPolicy.defaultToolDeadlineMs;
        nextLiveness.waitingSinceAt = at;
        nextLiveness.waitingKind = "TOOL";
        nextLiveness.waitingToolName = input.toolName ?? "unknown-tool";
        nextLiveness.waitingDeadlineAt = new Date(Date.parse(at) + deadlineMs).toISOString();
      } else if (input.kind === "PROVIDER_TURN_STARTED" || input.kind === "PROVIDER_HEARTBEAT" || input.kind === "WAITING_PROVIDER" || input.kind === "REASONING_ACTIVITY") {
        // Provider-turn wall time is measured from turn start. Heartbeat or
        // reasoning events are LOW activity: they neither renew the progress
        // lease nor extend the turn deadline.
        const deadlineMs = current.resolvedOperationPolicy!.executionLiveness.providerTurnDeadlineMs;
        if (input.kind === "PROVIDER_TURN_STARTED" || !nextLiveness.waitingSinceAt) nextLiveness.waitingSinceAt = at;
        nextLiveness.waitingKind = "PROVIDER";
        nextLiveness.waitingToolName = undefined;
        if (input.kind === "PROVIDER_TURN_STARTED" || !nextLiveness.waitingDeadlineAt) {
          nextLiveness.waitingDeadlineAt = new Date(Date.parse(nextLiveness.waitingSinceAt) + deadlineMs).toISOString();
        }
      } else if (input.kind === "TOOL_CALL_COMPLETED" || input.kind === "TOOL_CALL_FAILED" || input.kind === "TOOL_SUCCESS_NONREDUNDANT" || input.kind === "EQUIVALENT_TOOL_CALL") {
        nextLiveness.waitingSinceAt = undefined;
        nextLiveness.waitingKind = undefined;
        nextLiveness.waitingToolName = undefined;
        nextLiveness.waitingDeadlineAt = undefined;
      } else if (input.kind === "PROVIDER_TURN_COMPLETED") {
        nextLiveness.waitingSinceAt = undefined;
        nextLiveness.waitingKind = undefined;
        nextLiveness.waitingDeadlineAt = undefined;
      }
      if (input.kind === "SOURCE_MUTATION") {
        nextLiveness.repositoryMutationCount += 1;
        if (!nextLiveness.firstMutationAt) {
          nextLiveness.firstMutationAt = at;
          nextLiveness.turnsBeforeFirstMutation = nextLiveness.providerTurns;
        }
      }
      if ((input.kind === "TOOL_CALL_STARTED" || input.kind === "TOOL_CALL_COMPLETED" || input.kind === "TOOL_CALL_FAILED" || input.kind === "TOOL_SUCCESS_NONREDUNDANT") && !nextLiveness.firstToolCallAt) nextLiveness.firstToolCallAt = at;
      if ((input.kind === "TOOL_CALL_COMPLETED" || input.kind === "TOOL_CALL_FAILED" || input.kind === "TOOL_SUCCESS_NONREDUNDANT") && !nextLiveness.firstMutationAt) nextLiveness.toolCallsBeforeFirstMutation += 1;
      if (input.kind === "TOOL_CALL_COMPLETED" || input.kind === "TOOL_CALL_FAILED" || input.kind === "TOOL_SUCCESS_NONREDUNDANT" || input.kind === "EQUIVALENT_TOOL_CALL") nextLiveness.toolCallCount += 1;
      if (input.kind === "PROVIDER_TURN_STARTED") nextLiveness.providerTurns += 1;
      if (input.kind === "ARTIFACT_PRODUCED") nextLiveness.artifactCount += 1;
      if (input.kind === "VALIDATION_RESULT" || input.kind === "TEST_RESULT") nextLiveness.validationCount += 1;
      if ((level === "HIGH" || level === "MEDIUM") && nextLiveness.progressLease) {
        const policy = current.resolvedOperationPolicy!.executionLiveness;
        const economic = current.resolvedOperationPolicy!.economicEnvelope;
        const hardDeadline = hardDeadlineFor(current, policy.hardDeadlineMs);
        const withinTurnBudget = nextLiveness.providerTurns <= nextLiveness.currentProviderTurnBudget && nextLiveness.providerTurns <= economic.hardProviderTurns;
        const totalToolCalls = Object.values(current.participants).reduce((sum, item) => sum + (item.id === participantId ? nextLiveness.toolCallCount : item.executionLiveness?.toolCallCount ?? 0), 0);
        const withinToolBudget = economic.hardToolCalls === undefined || totalToolCalls <= economic.hardToolCalls;
        if (hardDeadline > Date.parse(at) && withinTurnBudget && withinToolBudget && !progressBudgetBoundary) {
          const priorLease = nextLiveness.progressLease;
          const leaseBody = {
            version: 1 as const,
            operationId: priorLease.operationId,
            operationExecutionRevision: priorLease.operationExecutionRevision,
            candidateRevision: priorLease.candidateRevision,
            candidateDigest: priorLease.candidateDigest,
            policyDigest: priorLease.policyDigest,
            controllerEpoch: priorLease.controllerEpoch,
            participantId: priorLease.participantId,
            participantGeneration: priorLease.participantGeneration,
            leaseId: priorLease.leaseId,
            issuedAt: at,
            expiresAt: new Date(Math.min(Date.parse(at) + policy.progressLeaseMs, hardDeadline)).toISOString(),
            renewalCount: priorLease.renewalCount + 1,
            noProgressRenewalCount: 0,
            renewedThroughEvidenceDigest: event.eventId,
            renewedBy: "CONTROLLER" as const,
            renewedBySessionId: "controller:verified-progress"
          };
          nextLiveness.progressLease = { ...leaseBody, digest: sha256Canonical(leaseBody) };
          nextLiveness.noProgressRenewals = 0;
        } else {
          nextLiveness.state = "STALL_SUSPECTED";
        }
      }
      const patch: Partial<OperationRecordV2> = {
        participants: { ...current.participants, [participantId]: { ...latest, executionLiveness: nextLiveness } },
        ...(level === "HIGH" || level === "MEDIUM" ? { lastProgressAt: at } : {})
      };
      return patch;
    });
    return event;
  });
  if (ownerBoundarySignal) {
    const operation = await loadOperation(stateRoot, operationId);
    const participant = operation.participants[participantId];
    if (participant) {
      await persistOwnerEconomicBoundaryV1(stateRoot, operation, participant, ownerBoundarySignal, input.observedAt ?? new Date());
      if (participant.executionBinding) await stopBoundParticipantSession(root, participant.executionBinding, participant.transport);
    }
    throw new OwnerEconomicBoundaryError(ownerBoundarySignal);
  }
  if (recorded && progressBudgetBoundary) {
    const operation = await loadOperation(stateRoot, operationId);
    const participant = operation.participants[participantId];
    if (participant?.executionBinding) await stopBoundParticipantSession(root, participant.executionBinding, participant.transport);
  }
  return recorded;
}

/** Convert Paseo timeline facts into deterministic progress evidence without retaining tool arguments. */
export async function recordPaseoRuntimeActivityV1(root: string, sessionId: string, envelope: { event?: Record<string, unknown>; receivedAt?: string }): Promise<void> {
  const operationId = process.env.AEH_OPERATION_ID?.trim();
  const event = envelope.event;
  if (!operationId || !event || typeof event.type !== "string") return;
  const stateRoot = resolveOperationStateRoot(root);
  const operation = await loadOperation(stateRoot, operationId).catch(() => undefined);
  if (!operation) return;
  const participant = Object.values(operation.participants).find((item) => item.executionBinding?.runtime.sessionId === sessionId);
  if (!participant?.executionBinding) return;
  const timestamp = typeof event.timestamp === "string" && Number.isFinite(Date.parse(event.timestamp)) ? event.timestamp : envelope.receivedAt ?? new Date().toISOString();
  if (event.type === "turn_started" || event.type === "turn_completed") {
    await recordParticipantExecutionActivityV1(root, operationId, participant.id, {
      kind: event.type === "turn_started" ? "PROVIDER_HEARTBEAT" : "PROVIDER_TURN_COMPLETED",
      evidenceId: String(event.turnId ?? `${event.type}:${timestamp}`),
      evidenceDigest: sha256Canonical({ type: event.type, turnId: event.turnId ?? null, provider: event.provider ?? null, usage: event.type === "turn_completed" ? event.usage ?? null : null }),
      observedAt: new Date(timestamp)
    });
    return;
  }
  if (event.type !== "timeline" || !event.item || typeof event.item !== "object" || Array.isArray(event.item)) return;
  const item = event.item as Record<string, unknown>;
  if (item.type !== "tool_call" || typeof item.name !== "string") return;
  const callId = typeof item.callId === "string" ? item.callId : undefined;
  const detail = item.detail && typeof item.detail === "object" && !Array.isArray(item.detail) ? item.detail as Record<string, unknown> : {};
  const normalizedArgs = normalizedActivityArguments(detail);
  const argumentsDigest = sha256Canonical(normalizedArgs);
  const status = typeof item.status === "string" ? item.status : "unknown";
  if (status === "running") {
    await recordParticipantExecutionActivityV1(root, operationId, participant.id, {
      kind: "TOOL_CALL_STARTED", evidenceId: callId ?? `tool-start:${timestamp}:${argumentsDigest.slice(0, 12)}`,
      evidenceDigest: argumentsDigest, toolName: item.name, ...(callId ? { toolCallId: callId } : {}), argumentsDigest, observedAt: new Date(timestamp)
    });
    await recordParticipantExecutionActivityV1(root, operationId, participant.id, {
      kind: "WAITING_TOOL", evidenceId: callId ?? `tool-start:${timestamp}:${argumentsDigest.slice(0, 12)}`,
      evidenceDigest: argumentsDigest, toolName: item.name, ...(callId ? { toolCallId: callId } : {}), argumentsDigest, observedAt: new Date(timestamp)
    });
    return;
  }
  if (status === "failed" || status === "canceled") {
    await recordParticipantExecutionActivityV1(root, operationId, participant.id, {
      kind: "TOOL_CALL_FAILED", evidenceId: callId ?? `tool-failure:${timestamp}:${argumentsDigest.slice(0, 12)}`,
      evidenceDigest: sha256Canonical({ argumentsDigest, error: safeActivityError(item.error) }), toolName: item.name, ...(callId ? { toolCallId: callId } : {}), argumentsDigest, observedAt: new Date(timestamp)
    });
    return;
  }
  if (status !== "completed") return;
  const prior = await readExecutionActivityEventsV1(root, operationId);
  const repeated = prior.some((previous) => previous.participantId === participant.id && previous.participantGeneration === participant.executionBinding!.participantGeneration && previous.toolName === item.name && previous.argumentsDigest === argumentsDigest && previous.kind === "TOOL_SUCCESS_NONREDUNDANT");
  const kind = repeated ? "EQUIVALENT_TOOL_CALL" : "TOOL_SUCCESS_NONREDUNDANT";
  await recordParticipantExecutionActivityV1(root, operationId, participant.id, {
    kind, evidenceId: callId ?? `tool-success:${timestamp}:${argumentsDigest.slice(0, 12)}`,
    evidenceDigest: sha256Canonical({ argumentsDigest, resultBytes: activityResultBytes(detail) }), toolName: item.name, ...(callId ? { toolCallId: callId } : {}), argumentsDigest, observedAt: new Date(timestamp)
  });
  if (["write", "edit", "shell"].includes(String(detail.type))) await observeParticipantSourceMutation(root, operationId, participant.id, timestamp);
}

async function observeParticipantSourceMutation(root: string, operationId: string, participantId: string, at: string): Promise<void> {
  const current = await loadOperation(resolveOperationStateRoot(root), operationId).catch(() => undefined);
  const participant = current?.participants[participantId];
  const binding = participant?.executionBinding;
  if (!current || !participant || !binding) return;
  const digest = await computeWorktreeDigest(root).catch(() => undefined);
  const baseline = participant.executionLiveness?.sourceBaselineDigest ?? current.candidateRevision?.sourceDigest;
  if (!digest || !baseline || digest === baseline) return;
  await recordParticipantExecutionActivityV1(root, operationId, participantId, {
    kind: "SOURCE_MUTATION", evidenceId: `source:${digest}`, evidenceDigest: digest, observedAt: new Date(at)
  });
  await updateOperationMetadata(resolveOperationStateRoot(root), operationId, (operation) => {
    const latest = operation.participants[participantId];
    if (!latest?.executionBinding || latest.executionBinding.digest !== binding.digest || !latest.executionLiveness) return {};
    return { participants: { ...operation.participants, [participantId]: { ...latest, executionLiveness: { ...latest.executionLiveness, sourceBaselineDigest: digest } } } };
  });
}

/** Only a bound Operation Supervisor or the bound Lead may renew; participant identity is never accepted as authority. */
export async function renewParticipantProgressLeaseV1(root: string, input: {
  operationId: string; participantId: string; actorSessionId: string; actorParticipantId?: string; expectedBindingDigest?: string; allowFailedParticipant?: boolean; at?: Date
}): Promise<ProgressLeaseV1> {
  const stateRoot = resolveOperationStateRoot(root);
  return withOperationCoordinationLock(stateRoot, input.operationId, async () => {
    const operation = await loadOperation(stateRoot, input.operationId);
    if (isTerminalOperation(operation.status)) throw new Error("PROGRESS_LEASE_RENEWAL_REJECTED: terminal operations cannot renew participant execution.");
    if (operation.ownerEconomicBoundary) throw new OwnerEconomicBoundaryError(requirementSignal(operation.ownerEconomicBoundary));
    const participant = operation.participants[input.participantId];
    const binding = participant?.executionBinding;
    if (!participant || !binding || !participant.executionLiveness?.progressLease) throw new Error("PROGRESS_LEASE_RENEWAL_REJECTED: participant has no current execution binding and lease.");
    if (["COMPLETED", "CANCELLED", "BLOCKED"].includes(participant.status) || participant.status === "FAILED" && input.allowFailedParticipant !== true) throw new Error("PROGRESS_LEASE_RENEWAL_REJECTED: terminal or blocked participants require a different bounded recovery action.");
    if (input.expectedBindingDigest && binding.digest !== input.expectedBindingDigest) throw new Error("PROGRESS_LEASE_IDENTITY_STALE: requested lease renewal cites another execution binding.");
    assertCurrentBinding(operation, participant, binding);
    const actor = authorizeLeaseRenewalActor(operation, input.actorSessionId, input.actorParticipantId);
    const at = input.at ?? new Date();
    const prior = participant.executionLiveness.progressLease;
    assertProgressLeaseV1(prior);
    const livenessPolicy = operation.resolvedOperationPolicy!.executionLiveness;
    const economic = operation.resolvedOperationPolicy!.economicEnvelope;
    try { await assertConfiguredUsageBudgets(stateRoot, operation, economic); }
    catch (error) {
      if (!(error instanceof OwnerEconomicBoundaryError)) throw error;
      await persistOwnerEconomicBoundaryV1(stateRoot, operation, participant, error.signal, at);
      await stopBoundParticipantSession(root, binding, participant.transport);
      throw error;
    }
    const activity = await readRecentActivity(stateRoot, operation.id, input.participantId, binding.participantGeneration);
    const meaningful = activity.filter((event) => (event.level === "HIGH" || event.level === "MEDIUM") && event.observedAt > prior.issuedAt);
    const evidenceDigest = meaningful.length ? sha256Canonical(meaningful.map((event) => event.eventId).sort()) : null;
    if (Date.parse(prior.expiresAt) <= at.getTime() && !evidenceDigest && participant.executionLiveness.state !== "STALL_SUSPECTED") throw new Error("PROGRESS_LEASE_EXPIRED: recovery after lease expiry requires a durable stall state or new meaningful evidence.");
    const noProgressRenewalCount = evidenceDigest ? 0 : prior.noProgressRenewalCount + 1;
    if (!evidenceDigest && noProgressRenewalCount > livenessPolicy.maxNoProgressRenewals) throw new Error("PROGRESS_LEASE_BUDGET_EXHAUSTED: meaningful progress or a different recovery action is required.");
    const operationToolCalls = sumParticipantToolCalls(operation);
    if (economic.hardToolCalls !== undefined && operationToolCalls >= economic.hardToolCalls) {
      const signal: OwnerEconomicBoundarySignalV1 = { budget: "HARD_TOOL_CALLS", configuredLimit: economic.hardToolCalls, observed: operationToolCalls, usageCoverage: "COMPLETE", evidenceRefs: (await readExecutionActivityEventsV1(stateRoot, operation.id)).filter((event) => event.kind.startsWith("TOOL_CALL_")).slice(-12).map((event) => `activity://${operation.id}/${event.eventId}`), reason: "Observed participant tool calls reached the configured Owner hard tool-call ceiling." };
      await persistOwnerEconomicBoundaryV1(stateRoot, operation, participant, signal, at);
      await stopBoundParticipantSession(root, binding, participant.transport);
      throw new OwnerEconomicBoundaryError(signal);
    }
    const actorProviderTurnCeiling = actor === "SUPERVISOR" ? economic.supervisorProviderTurns : economic.hardProviderTurns;
    const nextProviderTurnBudget = participant.executionLiveness.providerTurns >= participant.executionLiveness.currentProviderTurnBudget
      ? Math.min(actorProviderTurnCeiling, Math.max(participant.executionLiveness.currentProviderTurnBudget, participant.executionLiveness.providerTurns + economic.initialProviderTurns))
      : participant.executionLiveness.currentProviderTurnBudget;
    if (participant.executionLiveness.providerTurns >= actorProviderTurnCeiling && participant.executionLiveness.providerTurns >= participant.executionLiveness.currentProviderTurnBudget) {
      if (actor === "SUPERVISOR" && actorProviderTurnCeiling < economic.hardProviderTurns) throw new Error("SUPERVISOR_DELEGATION_EXHAUSTED: Supervisor provider-turn delegation is exhausted; escalate to the bound Lead within the frozen Owner envelope.");
      throw new Error("PARTICIPANT_PROVIDER_TURN_CEILING_REACHED: this participant cannot receive another provider turn under the frozen per-participant ceiling; request a bounded replan, rotation, split, or reassignment and continue with a new participant identity if authorized.");
    }
    const hardDeadline = hardDeadlineFor(operation, livenessPolicy.hardDeadlineMs);
    if (hardDeadline <= at.getTime()) throw new Error("OPERATION_HARD_DEADLINE_REACHED: the owner-delegated maximum execution deadline has elapsed.");
    const expiresAt = new Date(Math.min(at.getTime() + livenessPolicy.progressLeaseMs, hardDeadline)).toISOString();
    const nextBody = {
      version: 1 as const,
      operationId: prior.operationId,
      operationExecutionRevision: prior.operationExecutionRevision,
      candidateRevision: prior.candidateRevision,
      candidateDigest: prior.candidateDigest,
      policyDigest: prior.policyDigest,
      controllerEpoch: prior.controllerEpoch,
      participantId: prior.participantId,
      participantGeneration: prior.participantGeneration,
      leaseId: prior.leaseId,
      issuedAt: at.toISOString(),
      expiresAt,
      renewalCount: prior.renewalCount + 1,
      noProgressRenewalCount,
      renewedThroughEvidenceDigest: evidenceDigest,
      renewedBy: actor,
      renewedBySessionId: input.actorSessionId
    };
    const next = { ...nextBody, digest: sha256Canonical(nextBody) };
    await updateOperationMetadata(stateRoot, operation.id, (current) => {
      const latest = current.participants[input.participantId];
      if (!latest?.executionBinding || latest.executionBinding.digest !== binding.digest) throw new Error("PROGRESS_LEASE_IDENTITY_STALE: participant execution binding changed during renewal.");
      return { participants: { ...current.participants, [input.participantId]: { ...latest, executionLiveness: { ...(latest.executionLiveness ?? participant.executionLiveness!), progressLease: next, currentProviderTurnBudget: nextProviderTurnBudget, noProgressRenewals: noProgressRenewalCount, state: "ACTIVE" } } } };
    });
    await appendActivityEvent(stateRoot, operation.id, {
      version: 1,
      eventId: `lease-renewal:${next.digest}`,
      operationId: operation.id,
      operationExecutionRevision: binding.operationExecutionRevision,
      candidateRevision: binding.candidateRevision,
      candidateDigest: binding.candidateDigest,
      executionBindingDigest: binding.digest,
      policyDigest: binding.operationPolicyDigest,
      controllerEpoch: binding.controllerEpoch,
      participantId: participant.id,
      participantGeneration: binding.participantGeneration,
      role: participant.role ?? "unknown",
      phase: participant.phase ?? "work",
      provider: binding.runtime.provider,
      model: binding.runtime.model,
      sessionId: binding.runtime.sessionId,
      kind: "PARTICIPANT_STARTED",
      level: "LOW",
      observedAt: at.toISOString(),
      evidenceId: `progress-lease:${next.leaseId}`,
      evidenceDigest: next.digest
    });
    return next;
  });
}

async function assertConfiguredUsageBudgets(root: string, operation: OperationRecordV2, economic: EconomicEnvelopeV1): Promise<void> {
  if (economic.hardTotalTokens === undefined && economic.hardCostUsd === undefined) return;
  const { readOperationEfficiencyObservations, summarizeOperationEfficiencyV2 } = await import("../telemetry/efficiency.js");
  const observations = await readOperationEfficiencyObservations(root, operation.id);
  const summary = summarizeOperationEfficiencyV2(operation, observations);
  if (economic.hardTotalTokens !== undefined) {
    if (summary.budgets.tokenUsage.coverage !== "COMPLETE" || summary.budgets.tokenUsage.observed === null) throw new OwnerEconomicBoundaryError({
      budget: "HARD_TOTAL_TOKENS", configuredLimit: economic.hardTotalTokens, observed: null,
      usageCoverage: summary.budgets.tokenUsage.coverage, evidenceRefs: [`operation://${operation.id}/efficiency/v2`],
      reason: "Provider token usage is incomplete, so the configured Owner hard token ceiling cannot be verified."
    });
    if (summary.budgets.tokenUsage.observed >= economic.hardTotalTokens) throw new OwnerEconomicBoundaryError({
      budget: "HARD_TOTAL_TOKENS", configuredLimit: economic.hardTotalTokens, observed: summary.budgets.tokenUsage.observed,
      usageCoverage: "COMPLETE", evidenceRefs: [`operation://${operation.id}/efficiency/v2`],
      reason: "Observed provider token usage reached the configured Owner hard token ceiling."
    });
  }
  if (economic.hardCostUsd !== undefined) {
    if (summary.budgets.cost.coverage !== "COMPLETE" || summary.budgets.cost.observedUsd === null) throw new OwnerEconomicBoundaryError({
      budget: "HARD_COST_USD", configuredLimit: economic.hardCostUsd, observed: null,
      usageCoverage: summary.budgets.cost.coverage, evidenceRefs: [`operation://${operation.id}/efficiency/v2`],
      reason: "Provider cost usage is incomplete, so the configured Owner hard USD ceiling cannot be verified."
    });
    if (summary.budgets.cost.observedUsd >= economic.hardCostUsd) throw new OwnerEconomicBoundaryError({
      budget: "HARD_COST_USD", configuredLimit: economic.hardCostUsd, observed: summary.budgets.cost.observedUsd,
      usageCoverage: "COMPLETE", evidenceRefs: [`operation://${operation.id}/efficiency/v2`],
      reason: "Observed provider cost reached the configured Owner hard USD ceiling."
    });
  }
}

export async function inspectOwnerEconomicBoundaryV1(root: string, operation: OperationRecordV2): Promise<OwnerEconomicBoundarySignalV1 | undefined> {
  const economic = operation.resolvedOperationPolicy?.economicEnvelope;
  if (!economic || economic.hardTotalTokens === undefined && economic.hardCostUsd === undefined) return undefined;
  try { await assertConfiguredUsageBudgets(root, operation, economic); return undefined; }
  catch (error) { if (error instanceof OwnerEconomicBoundaryError) return error.signal; throw error; }
}

export async function inspectOwnerEconomicBoundaryAtTerminalV1(
  root: string,
  operation: OperationRecordV2,
  targetStatus: "SUCCEEDED" | "FAILED"
): Promise<OwnerEconomicBoundarySignalV1 | undefined> {
  const economic = operation.resolvedOperationPolicy?.economicEnvelope;
  if (!economic) return undefined;
  const { readOperationEfficiencyObservations, summarizeOperationEfficiencyV2 } = await import("../telemetry/efficiency.js");
  const observations = await readOperationEfficiencyObservations(root, operation.id);
  const summary = summarizeOperationEfficiencyV2(operation, observations, operation.finishedAt ?? operation.updatedAt);
  const continuationRequired = targetStatus === "FAILED";
  if (economic.hardTotalTokens !== undefined) {
    if (summary.budgets.tokenUsage.coverage !== "COMPLETE" || summary.budgets.tokenUsage.observed === null) return {
      budget: "HARD_TOTAL_TOKENS", configuredLimit: economic.hardTotalTokens, observed: null, usageCoverage: summary.budgets.tokenUsage.coverage,
      evidenceRefs: [`operation://${operation.id}/efficiency/v2`], reason: "Provider token usage is incomplete, so the configured Owner hard token ceiling cannot be verified at terminal state."
    };
    if (summary.budgets.tokenUsage.observed > economic.hardTotalTokens || continuationRequired && summary.budgets.tokenUsage.observed >= economic.hardTotalTokens) return {
      budget: "HARD_TOTAL_TOKENS", configuredLimit: economic.hardTotalTokens, observed: summary.budgets.tokenUsage.observed, usageCoverage: "COMPLETE",
      evidenceRefs: [`operation://${operation.id}/efficiency/v2`], reason: "Observed provider token usage exceeded the remaining Owner hard token allowance before terminal state."
    };
  }
  if (economic.hardCostUsd !== undefined) {
    if (summary.budgets.cost.coverage !== "COMPLETE" || summary.budgets.cost.observedUsd === null) return {
      budget: "HARD_COST_USD", configuredLimit: economic.hardCostUsd, observed: null, usageCoverage: summary.budgets.cost.coverage,
      evidenceRefs: [`operation://${operation.id}/efficiency/v2`], reason: "Provider cost usage is incomplete, so the configured Owner hard USD ceiling cannot be verified at terminal state."
    };
    if (summary.budgets.cost.observedUsd > economic.hardCostUsd || continuationRequired && summary.budgets.cost.observedUsd >= economic.hardCostUsd) return {
      budget: "HARD_COST_USD", configuredLimit: economic.hardCostUsd, observed: summary.budgets.cost.observedUsd, usageCoverage: "COMPLETE",
      evidenceRefs: [`operation://${operation.id}/efficiency/v2`], reason: "Observed provider cost exceeded the remaining Owner hard USD allowance before terminal state."
    };
  }
  if (economic.hardToolCalls !== undefined && Object.keys(operation.participants).length !== 0) {
    const participantCount = Object.values(operation.participants).filter((participant) => participant.role !== "Operation Supervisor" && participant.logicalAgent !== "supervisor").length;
    if (participantCount > 0 && summary.budgets.toolCalls.observed === null) return {
      budget: "HARD_TOOL_CALLS", configuredLimit: economic.hardToolCalls, observed: null, usageCoverage: "UNKNOWN",
      evidenceRefs: [`operation://${operation.id}/efficiency/v2`], reason: "Participant tool-call usage is incomplete, so the configured Owner hard tool-call ceiling cannot be verified at terminal state."
    };
    const observed = summary.budgets.toolCalls.observed;
    if (observed !== null && (observed > economic.hardToolCalls || continuationRequired && observed >= economic.hardToolCalls)) return {
      budget: "HARD_TOOL_CALLS", configuredLimit: economic.hardToolCalls, observed, usageCoverage: "COMPLETE",
      evidenceRefs: [`operation://${operation.id}/efficiency/v2`], reason: "Observed participant tool calls exceeded the remaining Owner hard tool-call allowance before terminal state."
    };
  }
  return undefined;
}

export async function requireOwnerEconomicBoundaryBeforeExternalEffectV1(root: string, operation: OperationRecordV2): Promise<void> {
  const liveness = operation.resolvedOperationPolicy?.executionLiveness;
  if (liveness) {
    const hardDeadline = hardDeadlineFor(operation, liveness.hardDeadlineMs);
    const now = Date.now();
    if (now >= hardDeadline) {
      const { expireOperationAtHardDeadline } = await import("./controller.js");
      await expireOperationAtHardDeadline(root, operation.id, new Date(now));
      throw new Error("OPERATION_HARD_DEADLINE_REACHED: controller expired and reconciled the operation before external-effect admission.");
    }
  }
  if (operation.ownerEconomicBoundary) throw new OwnerEconomicBoundaryError(requirementSignal(operation.ownerEconomicBoundary));
  const signal = await inspectOwnerEconomicBoundaryV1(root, operation);
  if (!signal) return;
  const participant = Object.values(operation.participants).filter((item) => item.executionBinding).sort((left, right) => {
    const l = Date.parse(left.executionLiveness?.lastActivityAt ?? left.startedAt ?? left.registeredAt);
    const r = Date.parse(right.executionLiveness?.lastActivityAt ?? right.startedAt ?? right.registeredAt);
    return r - l;
  })[0];
  await persistOwnerEconomicBoundaryV1(root, operation, participant, signal, new Date());
  if (participant?.executionBinding) await stopBoundParticipantSession(root, participant.executionBinding, participant.transport);
  throw new OwnerEconomicBoundaryError(signal);
}

export class OwnerEconomicBoundaryError extends Error {
  readonly signal: OwnerEconomicBoundarySignalV1;
  constructor(signal: OwnerEconomicBoundarySignalV1) {
    super(`OWNER_DECISION_REQUIRED: ${signal.reason}`);
    this.name = "OwnerEconomicBoundaryError";
    this.signal = signal;
  }
}

function requirementSignal(requirement: OwnerEconomicBoundaryRequirementV1): OwnerEconomicBoundarySignalV1 {
  return {
    budget: requirement.budget,
    configuredLimit: requirement.configuredLimit,
    observed: requirement.observed,
    usageCoverage: requirement.usageCoverage,
    evidenceRefs: requirement.evidenceRefs,
    reason: requirement.reason
  };
}

export async function persistOwnerEconomicBoundaryV1(root: string, operation: OperationRecordV2, participant: OperationParticipantRecord | undefined, signal: OwnerEconomicBoundarySignalV1, at: Date): Promise<void> {
  const binding = participant?.executionBinding;
  if (participant && !binding) throw new Error("OWNER_ECONOMIC_BOUNDARY_BINDING_REQUIRED: participant has no current execution binding.");
  const participantId = participant?.id ?? "controller:operation";
  const participantGeneration = binding?.participantGeneration ?? "controller";
  const executionBindingDigest = binding?.digest ?? sha256Canonical({ operationId: operation.id, candidateDigest: operation.candidateRevision?.identityDigest, policyDigest: operation.resolvedOperationPolicy?.digest, controllerEpoch: currentControllerEpoch(operation), scope: "OPERATION" });
  const body: Omit<OwnerEconomicBoundaryRequirementV1, "digest"> = {
    version: 1,
    kind: "OWNER_ECONOMIC_BOUNDARY",
    scope: participant ? "PARTICIPANT" : "OPERATION",
    operationId: operation.id,
    participantId,
    participantGeneration,
    executionBindingDigest,
    candidateDigest: binding?.candidateDigest ?? operation.candidateRevision?.identityDigest ?? sha256Canonical({ operationId: operation.id, noCandidate: true }),
    policyDigest: binding?.operationPolicyDigest ?? operation.resolvedOperationPolicy?.digest ?? sha256Canonical({ operationId: operation.id, noPolicy: true }),
    controllerEpoch: binding?.controllerEpoch ?? currentControllerEpoch(operation),
    budget: signal.budget,
    configuredLimit: signal.configuredLimit,
    observed: signal.observed,
    usageCoverage: signal.usageCoverage,
    evidenceRefs: [...new Set(signal.evidenceRefs)].slice(-16),
    reason: signal.reason.slice(0, 2_000),
    state: "WAITING",
    createdAt: at.toISOString()
  };
  const requirement: OwnerEconomicBoundaryRequirementV1 = { ...body, digest: sha256Canonical(body) };
  await updateOperationMetadata(root, operation.id, (current) => {
    if (current.ownerEconomicBoundary) return {};
    const latest = participant ? current.participants[participant.id] : undefined;
    if (isTerminalOperation(current.status)) return {};
    if (participant && (!latest?.executionBinding || latest.executionBinding.digest !== binding?.digest)) return {};
    return {
      phase: "HUMAN_REQUIRED",
      ownerEconomicBoundary: requirement,
      ...(participant && latest ? { participants: {
        ...current.participants,
        [participant.id]: {
          ...latest,
          executionLiveness: latest.executionLiveness ? { ...latest.executionLiveness, state: "STALL_SUSPECTED" } : latest.executionLiveness
        }
      } } : {})
    };
  }, { touchRevision: true, eventType: "operation.owner-economic-boundary" });
}

async function stopBoundParticipantSession(root: string, binding: ExecutionBindingV3, transport?: string): Promise<void> {
  if (!binding.runtime.sessionId || !transport?.startsWith("paseo")) return;
  try {
    const { stopManagedPaseoAgent } = await import("../paseo/runtimeCore.js");
    await stopManagedPaseoAgent(root, binding.runtime.sessionId).catch(() => undefined);
  } catch { /* provider-specific stop is best-effort; future turn admission remains fenced by durable request */ }
}

/** Persist a current Supervisor recovery decision; model text alone has no lifecycle effect. */
export async function decideParticipantRecoveryV1(root: string, input: {
  operationId: string;
  participantId: string;
  actorRole: "SUPERVISOR" | "LEAD";
  actorSessionId: string;
  action: SupervisorRecoveryActionV1;
  expectedBindingDigest: string;
  evidenceIds: string[];
  reason: string;
  at?: Date;
  skillId?: string;
  skillProjectionDigest?: string;
}): Promise<SupervisorRecoveryDecisionV1> {
  const stateRoot = resolveOperationStateRoot(root);
  const at = input.at ?? new Date();
  const decision = await withOperationCoordinationLock(stateRoot, input.operationId, async () => {
    const operation = await loadOperation(stateRoot, input.operationId);
    if (isTerminalOperation(operation.status)) throw createTrustedOperationToolError("SUPERVISOR_RECOVERY_STATE_STALE", "terminal operations cannot recover participants.", undefined, operation.id);
    if (operation.ownerEconomicBoundary) {
      const boundary = new OwnerEconomicBoundaryError(requirementSignal(operation.ownerEconomicBoundary));
      throw createTrustedOperationToolError("OPERATION_RECOVERY_OWNER_BOUNDARY", boundary.message, boundary, operation.id);
    }
    const supervisor = input.actorRole === "SUPERVISOR" ? activeOperationSupervisor(operation) : undefined;
    const actorBound = input.actorRole === "SUPERVISOR" ? supervisor?.agentId === input.actorSessionId : operation.lead?.agentId === input.actorSessionId;
    if (!actorBound) {
      const message = `only the current bound ${input.actorRole === "SUPERVISOR" ? "Supervisor generation" : "Lead session"} may decide participant recovery.`;
      if (input.actorRole === "LEAD") throw createTrustedOperationToolError("LEAD_RECOVERY_AUTHORITY_DENIED", message, undefined, operation.id);
      throw new Error(`SUPERVISOR_RECOVERY_AUTHORITY_DENIED: ${message}`);
    }
    const participant = operation.participants[input.participantId];
    const binding = participant?.executionBinding;
    if (!participant || !binding || !participant.executionLiveness) throw createTrustedOperationToolError("SUPERVISOR_RECOVERY_STATE_STALE", "participant has no current bound execution and liveness state.", undefined, operation.id);
    if (["COMPLETED", "CANCELLED", "BLOCKED"].includes(participant.status)) throw createTrustedOperationToolError("SUPERVISOR_RECOVERY_STATE_STALE", "completed, cancelled, or blocked participant work cannot be recovered.", undefined, operation.id);
    if (participant.status === "FAILED" && !["RESUME_SAME_SESSION", "RETRY_PARTICIPANT", "ROTATE_SESSION", "REPLAN", "SPLIT_WORK", "REASSIGN", "ESCALATE_TO_LEAD", "FAIL"].includes(input.action)) throw createTrustedOperationToolError("SUPERVISOR_RECOVERY_ACTION_REQUIRED", "failed participant work requires an explicit retry or replan action.", undefined, operation.id);
    if (binding.digest !== input.expectedBindingDigest) throw createTrustedOperationToolError("SUPERVISOR_RECOVERY_BINDING_STALE", "recovery request cites a different participant execution binding.", undefined, operation.id);
    assertCurrentBinding(operation, participant, binding);
    const evidenceEvents = (await readRecentActivity(stateRoot, operation.id, participant.id, binding.participantGeneration))
      .filter((event) => input.evidenceIds.includes(event.eventId));
    if (input.evidenceIds.length === 0 || evidenceEvents.length !== new Set(input.evidenceIds).size) throw createTrustedOperationToolError("SUPERVISOR_RECOVERY_EVIDENCE_REQUIRED", "decision must cite current participant activity evidence.", undefined, operation.id);
    const stale = evidenceEvents.some((event) => event.operationExecutionRevision !== binding.operationExecutionRevision
      || event.candidateDigest !== binding.candidateDigest || event.policyDigest !== binding.operationPolicyDigest
      || event.controllerEpoch !== binding.controllerEpoch || event.sessionId !== binding.runtime.sessionId);
    if (stale) throw createTrustedOperationToolError("SUPERVISOR_RECOVERY_EVIDENCE_STALE", "cited evidence belongs to a different participant execution identity.", undefined, operation.id);
    const now = at.toISOString();
    const policy = operation.resolvedOperationPolicy!.executionLiveness;
    const economic = operation.resolvedOperationPolicy!.economicEnvelope;
    if (input.action === "RETRY_PARTICIPANT" && participant.executionLiveness.localRetryCount >= Math.min(policy.maxLocalRetriesPerFailure, economic.maxLocalRetries)) throw new Error("PARTICIPANT_LOCAL_RETRY_BUDGET_EXHAUSTED: the frozen local retry allowance is exhausted for this participant generation.");
    if (input.action === "ROTATE_SESSION" && participant.executionLiveness.participantRestarts >= Math.min(policy.maxParticipantRestarts, economic.maxParticipantRestarts)) throw new Error("PARTICIPANT_RESTART_BUDGET_EXHAUSTED: the frozen participant restart allowance is exhausted.");
    const body = {
      version: 1 as const,
      operationId: operation.id,
      operationExecutionRevision: binding.operationExecutionRevision,
      candidateRevision: binding.candidateRevision,
      candidateDigest: binding.candidateDigest,
      executionBindingDigest: binding.digest,
      policyDigest: binding.operationPolicyDigest,
      controllerEpoch: binding.controllerEpoch,
      participantId: participant.id,
      participantGeneration: binding.participantGeneration,
      observedProviderTurns: participant.executionLiveness.providerTurns,
      actorRole: input.actorRole,
      actorSessionId: input.actorSessionId,
      action: input.action,
      application: input.action === "FAIL" ? "APPLIED" as const
        : input.action === "RETRIEVE_SKILL" ? "ADVISORY_ONLY" as const
        : ["ROTATE_SESSION", "REPLAN", "SPLIT_WORK", "REASSIGN"].includes(input.action) ? input.actorRole === "SUPERVISOR" ? "ESCALATE_TO_LEAD" as const : "REQUESTED" as const
        : input.action === "ESCALATE_TO_LEAD" ? "ESCALATE_TO_LEAD" as const
          : "REQUESTED" as const,
      ...(input.skillId ? { skillId: input.skillId } : {}),
      ...(input.skillProjectionDigest ? { skillProjectionDigest: input.skillProjectionDigest } : {}),
      evidenceIds: [...new Set(input.evidenceIds)].sort(),
      reason: input.reason.trim().slice(0, 2_000),
      decidedAt: now
    };
    if (!body.reason) throw new Error("SUPERVISOR_RECOVERY_REASON_REQUIRED: include a concise evidence-based reason.");
    const result: SupervisorRecoveryDecisionV1 = { ...body, digest: sha256Canonical(body) };
    await updateOperationMetadata(stateRoot, operation.id, (current) => {
      const latest = current.participants[participant.id];
      const latestActorBound = input.actorRole === "SUPERVISOR"
        ? activeOperationSupervisor(current)?.agentId === input.actorSessionId
        : current.lead?.agentId === input.actorSessionId;
      if (!latestActorBound && input.actorRole === "LEAD") throw createTrustedOperationToolError("LEAD_RECOVERY_AUTHORITY_DENIED", "the bound Lead changed while recording the recovery decision.", undefined, operation.id);
      if (!latest?.executionBinding || latest.executionBinding.digest !== binding.digest || !latestActorBound) throw new Error(`${input.actorRole}_RECOVERY_IDENTITY_STALE: recovery actor or participant binding changed while recording the decision.`);
      return {
        participants: {
          ...current.participants,
          [participant.id]: {
            ...latest,
            executionLiveness: {
              ...latest.executionLiveness!,
              state: "STALL_SUSPECTED",
              ...(input.action === "RETRY_PARTICIPANT" ? { localRetryCount: latest.executionLiveness!.localRetryCount + 1 } : {}),
              ...(input.action === "ROTATE_SESSION" ? { participantRestarts: latest.executionLiveness!.participantRestarts + 1 } : {}),
              lastRecoveryDecision: result
            }
          }
        }
      };
    });
    return result;
  });
  if (input.action === "CONTINUE" || input.action === "RESUME_SAME_SESSION" || input.action === "RETRY_PARTICIPANT") {
    try {
      await renewParticipantProgressLeaseV1(stateRoot, {
        operationId: input.operationId,
        participantId: input.participantId,
        actorSessionId: input.actorSessionId,
        expectedBindingDigest: decision.executionBindingDigest,
        allowFailedParticipant: input.action === "RESUME_SAME_SESSION" || input.action === "RETRY_PARTICIPANT",
        at
      });
    } catch (error) {
      if (input.actorRole === "LEAD" && error instanceof OwnerEconomicBoundaryError) {
        throw createTrustedOperationToolError("OPERATION_RECOVERY_OWNER_BOUNDARY", error.message, error, input.operationId);
      }
      throw error;
    }
  }
  if (input.action === "FAIL") {
    await updateOperationMetadata(stateRoot, input.operationId, (operation) => {
      const participant = operation.participants[input.participantId];
      if (!participant?.executionBinding || participant.executionBinding.participantGeneration !== decision.participantGeneration) throw new Error("SUPERVISOR_RECOVERY_IDENTITY_STALE: participant generation changed before failure was applied.");
      return { participants: { ...operation.participants, [participant.id]: { ...participant, status: "FAILED", finishedAt: decision.decidedAt, error: `Supervisor recovery decision: ${decision.reason}`, executionLiveness: { ...participant.executionLiveness!, state: "FAILED", lastRecoveryDecision: decision } } } };
    });
  }
  return decision;
}

export async function setParticipantExecutionStateV1(root: string, operationId: string, participantId: string, state: ParticipantExecutionStateV1, at = new Date()): Promise<void> {
  const stateRoot = resolveOperationStateRoot(root);
  await updateOperationMetadata(stateRoot, operationId, (operation) => {
    const participant = operation.participants[participantId];
    if (!participant) return {};
    const binding = participant.executionBinding;
    if (!binding) return {};
    assertCurrentBinding(operation, participant, binding);
    const liveness = participant.executionLiveness ?? initialParticipantLivenessV1(binding, operation.resolvedOperationPolicy!.executionLiveness, operation.resolvedOperationPolicy!.economicEnvelope, at, operation.createdAt, operation.origin?.rootHardDeadlineAt);
    return { participants: { ...operation.participants, [participantId]: { ...participant, executionLiveness: { ...liveness, state, lastActivityAt: at.toISOString() } } } };
  });
}

export async function readExecutionActivityEventsV1(root: string, operationId: string): Promise<ExecutionActivityEventV1[]> {
  const file = activityFile(root, operationId);
  const content = await fs.readFile(file, "utf8").catch(() => "");
  return content.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [eventSchema.parse(JSON.parse(line))]; } catch { return []; }
  });
}

export function participantLivenessSnapshotV1(participant: OperationParticipantRecord, now = Date.now()): ParticipantExecutionLivenessV1["state"] {
  const liveness = participant.executionLiveness;
  if (!liveness) return participant.status === "RUNNING" ? "ACTIVE" : participant.status === "COMPLETED" ? "COMPLETED" : participant.status === "FAILED" ? "FAILED" : participant.status === "CANCELLED" ? "CANCELLED" : "READY";
  if (liveness.state === "COMPLETED" || liveness.state === "FAILED" || liveness.state === "CANCELLED") return liveness.state;
  if (liveness.waitingDeadlineAt && Date.parse(liveness.waitingDeadlineAt) <= now) return "STALL_SUSPECTED";
  const lease = liveness.progressLease;
  if (lease && Date.parse(lease.expiresAt) <= now) return "STALL_SUSPECTED";
  return liveness.state;
}

export function hardDeadlineFor(operation: Pick<OperationRecordV2, "createdAt" | "origin">, hardDeadlineMs: number): number {
  const createdAt = Date.parse(operation.createdAt);
  const rootDeadline = operation.origin ? Date.parse(operation.origin.rootHardDeadlineAt) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(createdAt) || !Number.isFinite(rootDeadline) && rootDeadline !== Number.POSITIVE_INFINITY) throw new Error("EXECUTION_LIVENESS_DEADLINE_INVALID: operation creation or inherited hard-deadline timestamp is invalid.");
  return Math.min(createdAt + hardDeadlineMs, rootDeadline);
}

function assertCurrentBinding(operation: OperationRecordV2, participant: OperationParticipantRecord, binding: ExecutionBindingV3): void {
  if (operation.operationExecutionRevision !== binding.operationExecutionRevision || operation.candidateRevision?.revision !== binding.candidateRevision
    || operation.candidateRevision.identityDigest !== binding.candidateDigest || operation.resolvedOperationPolicy?.digest !== binding.operationPolicyDigest
    || currentControllerEpoch(operation) !== binding.controllerEpoch || participant.executionBinding?.digest !== binding.digest) {
    throw new Error("EXECUTION_LIVENESS_BINDING_STALE: operation, candidate, policy, controller epoch, or participant binding changed.");
  }
}

function authorizeLeaseRenewalActor(operation: OperationRecordV2, sessionId: string, participantId?: string): "SUPERVISOR" | "LEAD" {
  if (operation.lead?.agentId === sessionId) return "LEAD";
  const activeSupervisor = activeOperationSupervisor(operation);
  if (activeSupervisor?.agentId === sessionId) return "SUPERVISOR";
  throw new Error("PROGRESS_LEASE_AUTHORITY_DENIED: only the current bound Operation Supervisor or Lead may renew.");
}

async function readRecentActivity(root: string, operationId: string, participantId: string, generation: string): Promise<ExecutionActivityEventV1[]> {
  return (await readExecutionActivityEventsV1(root, operationId)).filter((event) => event.participantId === participantId && event.participantGeneration === generation);
}

function sumParticipantToolCalls(operation: OperationRecordV2): number {
  return Object.values(operation.participants).filter((participant) => participant.role !== "Operation Supervisor" && participant.logicalAgent !== "supervisor")
    .reduce((sum, participant) => sum + (participant.executionLiveness?.toolCallCount ?? 0), 0);
}

async function appendActivityEvent(root: string, operationId: string, event: ExecutionActivityEventV1): Promise<void> {
  const file = activityFile(root, operationId);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const existing = await fs.readFile(file, "utf8").catch(() => "");
  if (existing.split(/\r?\n/).some((line) => {
    if (!line) return false;
    try { return (JSON.parse(line) as { eventId?: unknown }).eventId === event.eventId; } catch { return false; }
  })) return;
  await fs.appendFile(file, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
}

function activityFile(root: string, operationId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(operationId)) throw new Error("INVALID_OPERATION_ID");
  return path.join(resolveOperationStateRoot(root), ".harness", "operations", operationId, "execution", "activity.ndjson");
}

function inferWaitingState(kind: ProgressEvidenceKindV1, prior: ParticipantExecutionStateV1): ParticipantExecutionStateV1 {
  if (kind === "WAITING_TOOL") return "WAITING_TOOL";
  if (kind === "PROVIDER_TURN_STARTED") return "WAITING_PROVIDER";
  if (kind === "PROVIDER_TURN_COMPLETED" || kind === "SESSION_READY") return "ACTIVE";
  if (kind === "WAITING_PROVIDER" || kind === "PROVIDER_HEARTBEAT" || kind === "REASONING_ACTIVITY") return "WAITING_PROVIDER";
  if (prior === "STALL_SUSPECTED" || prior === "RECOVERING") return prior;
  return "ACTIVE";
}

function normalizedActivityArguments(detail: Record<string, unknown>): unknown {
  const type = typeof detail.type === "string" ? detail.type : "untyped";
  const value = { ...detail };
  for (const key of Object.keys(value)) if (/token|password|secret|credential|authorization|cookie/i.test(key)) delete value[key];
  return { type, digestOnly: sha256Canonical(value), byteLength: Buffer.byteLength(JSON.stringify(value), "utf8") };
}

function safeActivityError(error: unknown): unknown {
  if (!error || typeof error !== "object" || Array.isArray(error)) return { type: typeof error };
  const value = error as Record<string, unknown>;
  return { code: value.code ?? value.name ?? null, messageDigest: typeof value.message === "string" ? sha256Utf8(value.message) : null };
}

function activityResultBytes(detail: Record<string, unknown>): number | null {
  const result = detail.output ?? detail.result;
  if (typeof result === "string") return Buffer.byteLength(result, "utf8");
  if (result === undefined) return null;
  return Buffer.byteLength(JSON.stringify(result), "utf8");
}

function assertProgressLeaseV1(value: ProgressLeaseV1): void {
  const { digest, ...body } = value;
  if (value.version !== 1 || !value.leaseId || !value.operationId || !value.participantId || !value.participantGeneration
    || !/^[a-f0-9]{64}$/.test(value.candidateDigest) || !/^[a-f0-9]{64}$/.test(value.policyDigest)
    || sha256Canonical(body) !== digest) throw new Error("PROGRESS_LEASE_INVALID: identity or digest is inconsistent.");
}
