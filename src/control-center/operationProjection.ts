import { assertResolvedOperationPolicyV1 } from "../architecture/executionIdentity.js";
import { currentControllerEpoch, type OperationParticipantRecord, type OperationRecordV2 } from "../operations/state.js";
import { candidateRevisionsEqual } from "../operations/v2Contracts.js";
import type { HumanDecisionBindingV2 } from "../security/humanDecision.js";
import {
  CONTROL_CENTER_CONTRACT_VERSION,
  controlCenterResourceId,
  type ControlCenterDecisionRequestV1,
  type ControlCenterOperationControlsV1,
  type ControlCenterOperationDetailProjectionV1,
  type ControlCenterOperationPauseProjectionV1,
  type ControlCenterParticipantProjectionV1
} from "./contracts.js";

export function projectOperationRecordV1(record: OperationRecordV2): ControlCenterOperationDetailProjectionV1 {
  const participants = Object.values(record.participants).map((participant) => projectParticipant(record.id, participant));
  const stages = Object.values(record.stages).map((stage) => ({
    name: stage.name,
    status: stage.status,
    revision: stage.revision,
    ...(stage.startedAt !== undefined ? { startedAt: stage.startedAt } : {}),
    ...(stage.finishedAt !== undefined ? { finishedAt: stage.finishedAt } : {}),
    ...(stage.message !== undefined ? { message: stage.message } : {}),
    ...(stage.artifact !== undefined ? { artifact: stage.artifact } : {})
  }));
  const candidate = record.candidateRevision;
  const decisionRequest = projectDecisionRequest(record);
  const pause = projectPause(record);
  return {
    version: CONTROL_CENTER_CONTRACT_VERSION,
    operationId: controlCenterResourceId("operation", record.id),
    kind: record.kind,
    status: record.status,
    phase: record.phase,
    revision: record.revision,
    ...(candidate?.projectId ? { projectId: controlCenterResourceId("project", candidate.projectId) } : {}),
    ...(candidate ? { candidateId: controlCenterResourceId("candidate", candidate.candidateId), candidateDigest: candidate.identityDigest } : {}),
    participantCount: participants.length,
    runningParticipantCount: participants.filter((participant) => participant.status === "RUNNING").length,
    completedParticipantCount: participants.filter((participant) => participant.status === "COMPLETED").length,
    failedParticipantCount: participants.filter((participant) => participant.status === "FAILED" || participant.status === "CANCELLED").length,
    blockedParticipantCount: participants.filter((participant) => participant.status === "BLOCKED").length,
    blockedStageCount: stages.filter((stage) => stage.status === "BLOCKED").length,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
    ...(record.finishedAt !== undefined ? { finishedAt: record.finishedAt } : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
    payloadSummary: `${record.kind} operation ${record.id}`,
    participants,
    stages,
    ...(decisionRequest ? { decisionRequest } : {}),
    ...(pause ? { pause } : {}),
    controls: projectControls(record)
  };
}

function projectControls(record: OperationRecordV2): ControlCenterOperationControlsV1 {
  const active = record.status === "QUEUED" || record.status === "RUNNING";
  const paused = record.phase === "PAUSED" && Boolean(record.pause);
  const hasCurrentIdentity = Boolean(record.candidateRevision && record.resolvedOperationPolicy && Number.isSafeInteger(record.operationExecutionRevision));
  return {
    pause: active && record.status === "RUNNING" && !paused && hasCurrentIdentity,
    resume: active && record.status === "RUNNING" && paused,
    cancel: active
  };
}

function projectPause(record: OperationRecordV2): ControlCenterOperationPauseProjectionV1 | undefined {
  if (record.phase !== "PAUSED" || !record.pause) return undefined;
  return {
    version: CONTROL_CENTER_CONTRACT_VERSION,
    resumePhase: record.pause.resumePhase,
    reason: record.pause.reason,
    requestedBy: record.pause.requestedBy,
    pausedAt: record.pause.pausedAt,
    activeParticipantIds: [...record.pause.drainReceipt.activeParticipantIds],
    activeProviderLeaseIds: [...record.pause.drainReceipt.activeProviderLeaseIds]
  };
}

function projectParticipant(operationId: string, participant: OperationParticipantRecord): ControlCenterParticipantProjectionV1 {
  return {
    version: CONTROL_CENTER_CONTRACT_VERSION,
    participantId: controlCenterResourceId("participant", participant.id),
    operationId: controlCenterResourceId("operation", operationId),
    ...(participant.logicalAgent !== undefined ? { logicalAgent: participant.logicalAgent } : {}),
    ...(participant.role !== undefined ? { role: participant.role } : {}),
    ...(participant.phase !== undefined ? { phase: participant.phase } : {}),
    status: participant.status,
    specializations: [],
    skills: [],
    tools: [],
    registeredAt: participant.registeredAt,
    ...(participant.startedAt !== undefined ? { startedAt: participant.startedAt } : {}),
    ...(participant.finishedAt !== undefined ? { finishedAt: participant.finishedAt } : {}),
    ...(participant.resultArtifact !== undefined ? { resultArtifact: participant.resultArtifact } : {}),
    ...(participant.error !== undefined ? { error: participant.error } : {})
  };
}

function projectDecisionRequest(record: OperationRecordV2): ControlCenterDecisionRequestV1 | undefined {
  if (record.status !== "RUNNING" || record.phase !== "HUMAN_REQUIRED") return undefined;
  const request = record.decisionRequest;
  const continuation = record.continuation;
  const candidate = record.candidateRevision;
  const policy = record.resolvedOperationPolicy;
  const operationExecutionRevision = record.operationExecutionRevision;
  if (!request || !continuation || continuation.state !== "WAITING" || !candidate || !policy
    || typeof operationExecutionRevision !== "number" || !Number.isSafeInteger(operationExecutionRevision) || operationExecutionRevision < 1
    || request.requestId !== continuation.requestId) return undefined;
  try { assertResolvedOperationPolicyV1(policy); } catch { return undefined; }
  const controllerEpoch = currentControllerEpoch(record);
  if (policy.operationId !== record.id || policy.operationExecutionRevision !== operationExecutionRevision
    || policy.candidateRevision !== candidate.revision || policy.candidateDigest !== candidate.identityDigest
    || policy.controllerEpoch !== controllerEpoch
    || (candidate.projectId && policy.projectId !== candidate.projectId)) return undefined;
  const binding: HumanDecisionBindingV2 = { operationId: record.id, candidate, operationExecutionRevision, policyDigest: policy.digest, controllerEpoch };
  if (!matchesDecisionBinding(request, binding) || !matchesDecisionBinding(continuation, binding)) return undefined;
  const { candidate: requestCandidate, ...requestFields } = request;
  return { ...requestFields, candidate: requestCandidate.identityDigest };
}

function matchesDecisionBinding(value: HumanDecisionBindingV2, binding: HumanDecisionBindingV2): boolean {
  return value.operationId === binding.operationId
    && candidateRevisionsEqual(value.candidate, binding.candidate)
    && value.operationExecutionRevision === binding.operationExecutionRevision
    && value.policyDigest === binding.policyDigest
    && value.controllerEpoch === binding.controllerEpoch;
}
