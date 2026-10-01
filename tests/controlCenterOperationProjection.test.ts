import { describe, expect, it } from "vitest";
import { compileResolvedOperationPolicy, type ResolvedOperationPolicyV1 } from "../src/architecture/executionIdentity.js";
import { projectOperationRecordV1 } from "../src/control-center/operationProjection.js";
import { sha256Canonical } from "../src/core/digest.js";
import type { OperationParticipantRecord, OperationRecordV2 } from "../src/operations/state.js";
import { createCandidateRevisionV1, type CandidateRevisionInputV1, type CandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import type { ContinuationRecordV1, DecisionRequestV1 } from "../src/security/humanDecision.js";

const CREATED_AT = "2026-01-01T00:00:00.000Z";
const UPDATED_AT = "2026-01-01T00:05:00.000Z";
const STARTED_AT = "2026-01-01T00:00:30.000Z";
const EXPIRES_AT = "2026-01-02T00:00:00.000Z";
const REQUEST_ID = "request:11111111-1111-4111-8111-111111111111";
const OPERATION_ID = "OP-PROJECTION";
const PAYLOAD_REQUEST = "resolve the product choice";

function candidate(operationId: string, overrides: Partial<CandidateRevisionInputV1> = {}): CandidateRevisionV1 {
  return createCandidateRevisionV1({
    operationId,
    candidateId: `candidate:${operationId}:r1`,
    projectId: "project-1",
    taskId: "TASK-1",
    revision: 1,
    sourceDigest: sha256Canonical("source"),
    ...overrides
  });
}

function policy(operationId: string, current: CandidateRevisionV1, overrides: Partial<Omit<ResolvedOperationPolicyV1, "version" | "digest">> = {}): ResolvedOperationPolicyV1 {
  return compileResolvedOperationPolicy({
    projectId: current.projectId ?? "project-1",
    operationId,
    operationExecutionRevision: 1,
    candidateRevision: current.revision,
    candidateDigest: current.identityDigest,
    controllerEpoch: 3,
    intent: "projection test",
    route: "FORMAL_SDD",
    minimumAssurance: "STANDARD",
    policyVersions: {},
    policyDigests: {},
    validationPolicy: {},
    reviewPolicy: {},
    deliveryPolicy: {},
    knowledgePolicy: {},
    contextPolicy: {},
    allowedExternalEffects: [],
    humanDecisionRequirements: [],
    ...overrides
  });
}

function participant(id: string, status: OperationParticipantRecord["status"], overrides: Partial<OperationParticipantRecord> = {}): OperationParticipantRecord {
  return { id, status, registeredAt: CREATED_AT, ...overrides };
}

function waitingRecord(): OperationRecordV2 {
  const current = candidate(OPERATION_ID);
  const currentPolicy = policy(OPERATION_ID, current);
  const request: DecisionRequestV1 = {
    version: 1,
    requestId: REQUEST_ID,
    operationId: OPERATION_ID,
    candidate: current,
    operationExecutionRevision: 1,
    policyDigest: currentPolicy.digest,
    controllerEpoch: 3,
    issue: "Which option should apply?",
    authoritativeEvidence: [{ artifact: `.harness/operations/${OPERATION_ID}/result.json`, sha256: "a".repeat(64), description: "spec handoff" }],
    whatTried: ["derived from current requirements"],
    whyUnresolvable: "both options are semantics-preserving product directions",
    choices: [{ choiceId: "option-a", label: "Option A", description: "Keep the current contract.", consequences: ["stays stable"] }],
    workThatCanContinue: ["documentation"],
    resumeTarget: "SPEC_AUTHORING",
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT
  };
  const continuation: ContinuationRecordV1 = {
    version: 1,
    continuationId: "continuation:11111111-1111-4111-8111-111111111111",
    operationId: OPERATION_ID,
    candidate: current,
    operationExecutionRevision: 1,
    policyDigest: currentPolicy.digest,
    controllerEpoch: 3,
    resumeTarget: "SPEC_AUTHORING",
    reason: "PRODUCT_CHOICE",
    requestId: REQUEST_ID,
    checkpointArtifact: `.harness/operations/${OPERATION_ID}/continuations/checkpoint.json`,
    checkpointDigest: "b".repeat(64),
    requiredRevalidation: ["candidate-current", "operation-revision-current", "policy-current", "controller-epoch-current", "checkpoint-current"],
    state: "WAITING",
    suspendedAt: CREATED_AT,
    updatedAt: UPDATED_AT
  };
  return {
    version: 2,
    id: OPERATION_ID,
    kind: "change",
    status: "RUNNING",
    phase: "HUMAN_REQUIRED",
    root: "/tmp/projection",
    payload: { request: PAYLOAD_REQUEST },
    revision: 9,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    lastProgressAt: UPDATED_AT,
    startedAt: STARTED_AT,
    supervision: { required: false, materialized: false, generations: [] },
    stages: {},
    participants: {},
    progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 },
    candidateRevision: current,
    operationExecutionRevision: 1,
    resolvedOperationPolicy: currentPolicy,
    controller: { epoch: 3, ownerId: "controller:test", claimedAt: CREATED_AT },
    decisionRequest: request,
    continuation
  };
}

describe("Control Center operation projection", () => {
  it("projects bounded operation fields and leaves missing facts absent", () => {
    const record = waitingRecord();
    const projection = projectOperationRecordV1({ ...record, phase: "implementation", decisionRequest: undefined, continuation: undefined });
    expect(projection).toEqual({
      version: 1,
      operationId: OPERATION_ID,
      kind: "change",
      status: "RUNNING",
      phase: "implementation",
      revision: 9,
      projectId: "project-1",
      candidateId: `candidate:${OPERATION_ID}:r1`,
      candidateDigest: record.candidateRevision!.identityDigest,
      participantCount: 0,
      runningParticipantCount: 0,
      completedParticipantCount: 0,
      failedParticipantCount: 0,
      blockedParticipantCount: 0,
      blockedStageCount: 0,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      startedAt: STARTED_AT,
      payloadSummary: `change operation ${OPERATION_ID}`,
      participants: [],
      stages: [],
      controls: { pause: true, resume: false, cancel: true }
    });
    expect(projection).not.toHaveProperty("finishedAt");
    expect(projection).not.toHaveProperty("error");
    expect(projection).not.toHaveProperty("decisionRequest");
    expect(projection).not.toHaveProperty("pause");
    expect(projection.payloadSummary).not.toContain(PAYLOAD_REQUEST);
  });

  it("omits candidate identity when the durable record has none", () => {
    const record = waitingRecord();
    const projection = projectOperationRecordV1({
      ...record,
      candidateRevision: undefined,
      resolvedOperationPolicy: undefined,
      operationExecutionRevision: undefined,
      decisionRequest: undefined,
      continuation: undefined
    });
    expect(projection).not.toHaveProperty("projectId");
    expect(projection).not.toHaveProperty("candidateId");
    expect(projection).not.toHaveProperty("candidateDigest");
    expect(projection.participantCount).toBe(0);
  });

  it("derives participant counters from durable records and keeps cancelled as failed", () => {
    const participants: Record<string, OperationParticipantRecord> = {
      runner: participant("participant-runner", "RUNNING", { logicalAgent: "explorer", role: "Explorer", phase: "exploration", startedAt: "2026-01-01T00:00:10.000Z", error: "runtime detail" }),
      finisher: participant("participant-finisher", "COMPLETED", { logicalAgent: "implementer", role: "Implementer", phase: "implementation", startedAt: "2026-01-01T00:00:20.000Z", finishedAt: "2026-01-01T00:01:00.000Z", resultArtifact: `.harness/operations/${OPERATION_ID}/result.json` }),
      failed: participant("participant-failed", "FAILED", { logicalAgent: "reviewer", role: "Reviewer" }),
      cancelled: participant("participant-cancelled", "CANCELLED"),
      blocked: participant("participant-blocked", "BLOCKED", { phase: "review" }),
      registered: participant("participant-registered", "REGISTERED"),
      idle: participant("participant-idle", "IDLE")
    };
    const record = waitingRecord();
    const stages = {
      "spec-authoring": { name: "spec-authoring", status: "BLOCKED" as const, revision: 9, message: "Waiting for a current product choice.", artifact: `.harness/operations/${OPERATION_ID}/continuations/checkpoint.json` },
      implementation: { name: "implementation", status: "RUNNING" as const, revision: 8, startedAt: STARTED_AT }
    };
    const projection = projectOperationRecordV1({ ...record, phase: "implementation", decisionRequest: undefined, continuation: undefined, participants, stages });
    expect(projection.participantCount).toBe(7);
    expect(projection.runningParticipantCount).toBe(1);
    expect(projection.completedParticipantCount).toBe(1);
    expect(projection.failedParticipantCount).toBe(2);
    expect(projection.blockedParticipantCount).toBe(1);
    expect(projection.blockedStageCount).toBe(1);
    expect(projection.participants).toHaveLength(7);
    expect(projection.participants[0]).toEqual({
      version: 1,
      participantId: "participant-runner",
      operationId: OPERATION_ID,
      logicalAgent: "explorer",
      role: "Explorer",
      phase: "exploration",
      status: "RUNNING",
      error: "runtime detail",
      specializations: [],
      skills: [],
      tools: [],
      registeredAt: CREATED_AT,
      startedAt: "2026-01-01T00:00:10.000Z"
    });
    expect(projection.participants[1]).toMatchObject({
      participantId: "participant-finisher",
      status: "COMPLETED",
      finishedAt: "2026-01-01T00:01:00.000Z",
      resultArtifact: `.harness/operations/${OPERATION_ID}/result.json`
    });
    expect(projection.participants.find((item) => item.status === "BLOCKED")).toMatchObject({
      participantId: "participant-blocked",
      phase: "review",
      specializations: [],
      skills: [],
      tools: []
    });
    expect(projection.stages).toEqual([
      { name: "spec-authoring", status: "BLOCKED", revision: 9, message: "Waiting for a current product choice.", artifact: `.harness/operations/${OPERATION_ID}/continuations/checkpoint.json` },
      { name: "implementation", status: "RUNNING", revision: 8, startedAt: STARTED_AT }
    ]);
  });

  it("projects the exact current waiting decision with candidate identity and expiry", () => {
    const record = waitingRecord();
    const projection = projectOperationRecordV1(record);
    expect(projection.decisionRequest).toEqual({
      version: 1,
      requestId: REQUEST_ID,
      operationId: OPERATION_ID,
      operationExecutionRevision: 1,
      policyDigest: record.resolvedOperationPolicy!.digest,
      controllerEpoch: 3,
      issue: "Which option should apply?",
      authoritativeEvidence: [{ artifact: `.harness/operations/${OPERATION_ID}/result.json`, sha256: "a".repeat(64), description: "spec handoff" }],
      whatTried: ["derived from current requirements"],
      whyUnresolvable: "both options are semantics-preserving product directions",
      choices: [{ choiceId: "option-a", label: "Option A", description: "Keep the current contract.", consequences: ["stays stable"] }],
      workThatCanContinue: ["documentation"],
      resumeTarget: "SPEC_AUTHORING",
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
      candidate: record.candidateRevision!.identityDigest
    });
    expect(projection.decisionRequest!.candidate).toBe(record.candidateRevision!.identityDigest);
  });

  it("omits decisions that are terminal, non-waiting, or not human-required", () => {
    const record = waitingRecord();
    expect(projectOperationRecordV1({ ...record, status: "SUCCEEDED" })).not.toHaveProperty("decisionRequest");
    expect(projectOperationRecordV1({ ...record, status: "FAILED" })).not.toHaveProperty("decisionRequest");
    expect(projectOperationRecordV1({ ...record, status: "CANCELLED" })).not.toHaveProperty("decisionRequest");
    expect(projectOperationRecordV1({ ...record, status: "QUEUED" })).not.toHaveProperty("decisionRequest");
    expect(projectOperationRecordV1({ ...record, phase: "implementation" })).not.toHaveProperty("decisionRequest");
    expect(projectOperationRecordV1({ ...record, continuation: { ...record.continuation!, state: "RESUMING" } })).not.toHaveProperty("decisionRequest");
    expect(projectOperationRecordV1({ ...record, continuation: { ...record.continuation!, state: "CHOICE_CONSUMED" } })).not.toHaveProperty("decisionRequest");
    expect(projectOperationRecordV1({ ...record, continuation: undefined })).not.toHaveProperty("decisionRequest");
    expect(projectOperationRecordV1({ ...record, decisionRequest: undefined })).not.toHaveProperty("decisionRequest");
  });

  it("omits decisions whose request or continuation no longer matches current authority", () => {
    const record = waitingRecord();
    const rotatedCandidate = candidate(OPERATION_ID, { candidateId: `candidate:${OPERATION_ID}:r2`, revision: 2 });
    const changedPolicy = policy(OPERATION_ID, record.candidateRevision!, { intent: "changed authority" });
    expect(projectOperationRecordV1({ ...record, decisionRequest: { ...record.decisionRequest!, candidate: rotatedCandidate } })).not.toHaveProperty("decisionRequest");
    expect(projectOperationRecordV1({ ...record, decisionRequest: { ...record.decisionRequest!, operationId: "OP-OTHER" } })).not.toHaveProperty("decisionRequest");
    expect(projectOperationRecordV1({ ...record, decisionRequest: { ...record.decisionRequest!, operationExecutionRevision: 2 } })).not.toHaveProperty("decisionRequest");
    expect(projectOperationRecordV1({ ...record, decisionRequest: { ...record.decisionRequest!, policyDigest: "f".repeat(64) } })).not.toHaveProperty("decisionRequest");
    expect(projectOperationRecordV1({ ...record, decisionRequest: { ...record.decisionRequest!, controllerEpoch: 4 } })).not.toHaveProperty("decisionRequest");
    expect(projectOperationRecordV1({ ...record, decisionRequest: { ...record.decisionRequest!, requestId: "request:other" } })).not.toHaveProperty("decisionRequest");
    expect(projectOperationRecordV1({ ...record, continuation: { ...record.continuation!, candidate: rotatedCandidate } })).not.toHaveProperty("decisionRequest");
    expect(projectOperationRecordV1({ ...record, continuation: { ...record.continuation!, operationId: "OP-OTHER" } })).not.toHaveProperty("decisionRequest");
    expect(projectOperationRecordV1({ ...record, continuation: { ...record.continuation!, operationExecutionRevision: 2 } })).not.toHaveProperty("decisionRequest");
    expect(projectOperationRecordV1({ ...record, continuation: { ...record.continuation!, policyDigest: "e".repeat(64) } })).not.toHaveProperty("decisionRequest");
    expect(projectOperationRecordV1({ ...record, continuation: { ...record.continuation!, controllerEpoch: 5 } })).not.toHaveProperty("decisionRequest");
    expect(projectOperationRecordV1({ ...record, candidateRevision: rotatedCandidate })).not.toHaveProperty("decisionRequest");
    expect(projectOperationRecordV1({ ...record, resolvedOperationPolicy: changedPolicy })).not.toHaveProperty("decisionRequest");
    expect(projectOperationRecordV1({ ...record, resolvedOperationPolicy: undefined })).not.toHaveProperty("decisionRequest");
    expect(projectOperationRecordV1({ ...record, candidateRevision: undefined })).not.toHaveProperty("decisionRequest");
    expect(projectOperationRecordV1({ ...record, operationExecutionRevision: 2 })).not.toHaveProperty("decisionRequest");
    expect(projectOperationRecordV1({ ...record, operationExecutionRevision: undefined })).not.toHaveProperty("decisionRequest");
    expect(projectOperationRecordV1({ ...record, controller: { ...record.controller!, epoch: 4 } })).not.toHaveProperty("decisionRequest");
    expect(projectOperationRecordV1({ ...record, controller: undefined })).not.toHaveProperty("decisionRequest");
  });

  it("omits decisions whose frozen policy digest is inconsistent", () => {
    const record = waitingRecord();
    const digest = "c".repeat(64);
    const projection = projectOperationRecordV1({
      ...record,
      resolvedOperationPolicy: { ...record.resolvedOperationPolicy!, digest },
      decisionRequest: { ...record.decisionRequest!, policyDigest: digest },
      continuation: { ...record.continuation!, policyDigest: digest }
    });
    expect(projection).not.toHaveProperty("decisionRequest");
  });

  it("keeps blocked participant state, terminal status, and operation errors visible", () => {
    const record = waitingRecord();
    const blocked = projectOperationRecordV1({
      ...record,
      phase: "implementation",
      decisionRequest: undefined,
      continuation: undefined,
      error: "lease acquisition failed",
      participants: { blocked: participant("participant-blocked", "BLOCKED", { logicalAgent: "reviewer", role: "Reviewer", phase: "review" }) }
    });
    expect(blocked.error).toBe("lease acquisition failed");
    expect(blocked.participants.find((item) => item.status === "BLOCKED")).toMatchObject({ participantId: "participant-blocked" });
    const terminal = projectOperationRecordV1({ ...record, status: "FAILED", finishedAt: UPDATED_AT, error: "operation failed" });
    expect(terminal).toMatchObject({ status: "FAILED", finishedAt: UPDATED_AT, error: "operation failed" });
    expect(terminal).not.toHaveProperty("decisionRequest");
  });

  it("projects a PAUSED suspension with server-derived controls", () => {
    const record = waitingRecord();
    const paused = projectOperationRecordV1({
      ...record,
      phase: "PAUSED",
      pause: {
        version: 1,
        operationId: OPERATION_ID,
        candidate: record.candidateRevision!,
        operationExecutionRevision: 1,
        policyDigest: record.resolvedOperationPolicy!.digest,
        controllerEpoch: 3,
        resumePhase: "HUMAN_REQUIRED",
        reason: "Authenticated Control Center pause request.",
        requestedBy: "human:control-center:test",
        requestedAt: CREATED_AT,
        pausedAt: UPDATED_AT,
        drainReceipt: { activeParticipantIds: [], activeProviderLeaseIds: [], observedAt: UPDATED_AT },
        requiredRevalidation: ["candidate-current", "operation-revision-current", "policy-current", "controller-epoch-current", "continuation-current"],
        state: "PAUSED"
      }
    });
    expect(paused.controls).toEqual({ pause: false, resume: true, cancel: true });
    expect(paused.pause).toMatchObject({ resumePhase: "HUMAN_REQUIRED", requestedBy: "human:control-center:test", pausedAt: UPDATED_AT });
    expect(paused).not.toHaveProperty("decisionRequest");
  });

  it("does not mutate the durable record", () => {
    const record = waitingRecord();
    const before = structuredClone(record);
    projectOperationRecordV1(record);
    expect(record).toEqual(before);
  });
});
