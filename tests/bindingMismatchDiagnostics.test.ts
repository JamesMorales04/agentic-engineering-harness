import { describe, expect, it } from "vitest";
import { compileExecutionBinding, type ExecutionBindingV3 } from "../src/architecture/executionIdentity.js";
import { createCandidateRevisionV1, type CandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { sha256Canonical } from "../src/core/digest.js";
import type { OperationRecordV2 } from "../src/operations/state.js";
import { describeBindingMismatchV1 } from "../src/runtime/providerLifecycle.js";

const digest = (label: string) => sha256Canonical(label);

function candidate(): CandidateRevisionV1 {
  return createCandidateRevisionV1({
    operationId: "OP-LEASE",
    candidateId: "candidate:OP-LEASE:r2",
    projectId: "project-lease",
    taskId: "TASK-LEASE",
    revision: 2,
    sourceDigest: digest("source-lease")
  });
}

function policy(current: CandidateRevisionV1) {
  return compileResolvedOperationPolicy({
    projectId: current.projectId!,
    operationId: current.operationId,
    operationExecutionRevision: 3,
    candidateRevision: current.revision,
    candidateDigest: current.identityDigest,
    controllerEpoch: 1,
    intent: "lease mismatch diagnostics",
    route: "DELEGATED",
    minimumAssurance: "STANDARD",
    policyVersions: { resolvedOperationPolicy: "2" },
    policyDigests: {},
    validationPolicy: {},
    reviewPolicy: { leadAcceptance: false, leadAcceptanceDirect: false, independentReviewRequired: false, minimumIndependentReviewers: 0, providerDiversity: false },
    deliveryPolicy: {},
    knowledgePolicy: {},
    contextPolicy: {},
    allowedExternalEffects: [],
    humanDecisionRequirements: []
  });
}

function bindingFor(current: CandidateRevisionV1, sessionId: string, participantId: string): ExecutionBindingV3 {
  return compileExecutionBinding({
    operationId: current.operationId,
    operationExecutionRevision: 3,
    candidateRevision: current.revision,
    candidateDigest: current.identityDigest,
    controllerEpoch: 1,
    executionBlueprintDigest: digest("blueprint-lease"),
    operationPolicyDigest: policy(current).digest,
    participantId,
    participantGeneration: "generation:1",
    roleInvocationPolicyDigest: digest("role-policy-lease"),
    skillManifestDigest: digest("skills-lease"),
    runtime: { runtimeId: "paseo", provider: "test", modelId: "worker-model", model: "worker-model", sessionId },
    contextManifestDigest: digest("context-lease"),
    promptManifestDigest: digest("prompt-lease"),
    outputContract: "implementer",
    leaseIdentities: []
  });
}

function operation(current: CandidateRevisionV1): OperationRecordV2 {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    version: 2,
    id: current.operationId,
    kind: "change",
    status: "RUNNING",
    phase: "implementation",
    root: "/tmp/aeh-lease",
    payload: { request: "lease diagnostics" },
    revision: 9,
    createdAt: now,
    updatedAt: now,
    lastProgressAt: now,
    supervision: { required: false, materialized: false, generations: [] },
    stages: {},
    participants: {},
    progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 },
    candidateRevision: current,
    operationExecutionRevision: 3,
    resolvedOperationPolicy: policy(current),
    controller: { epoch: 1, ownerId: "controller-1", claimedAt: now }
  } as OperationRecordV2;
}

describe("binding mismatch diagnostics (lease staleness attribution)", () => {
  it("reports only the participant when the binding is current", () => {
    const current = candidate();
    const binding = bindingFor(current, "session-1", "participant:worker");
    expect(describeBindingMismatchV1(binding, operation(current), "participant:worker", "session-1")).toBe(
      "participant=participant:worker"
    );
  });

  it("names a stale execution revision with got/want values", () => {
    const current = candidate();
    const binding = bindingFor(current, "session-1", "participant:worker");
    const advanced = { ...operation(current), operationExecutionRevision: 4 };
    const detail = describeBindingMismatchV1(binding, advanced, "participant:worker", "session-1");
    expect(detail).toContain("participant=participant:worker");
    expect(detail).toContain("operationExecutionRevision");
    expect(detail).toContain("got 3");
    expect(detail).toContain("want 4");
  });

  it("names a participant mismatch and a rotated session", () => {
    const current = candidate();
    const binding = bindingFor(current, "session-1", "participant:worker");
    const detail = describeBindingMismatchV1(binding, operation(current), "participant:other", "session-2");
    expect(detail).toContain("bindingParticipantId");
    expect(detail).toContain("sessionId");
    expect(detail).toContain("session-1");
    expect(detail).toContain("session-2");
  });

  it("truncates overlong values to a fixed bound", () => {
    const current = candidate();
    const binding = bindingFor(current, "session-1", "participant:worker");
    const longId = `participant:${"x".repeat(200)}`;
    const detail = describeBindingMismatchV1(binding, operation(current), longId);
    expect(detail).toContain("...");
    expect(detail.length).toBeLessThan(1200);
  });

  it("never throws on missing candidate or policy (reports undefined)", () => {
    const current = candidate();
    const binding = bindingFor(current, "session-1", "participant:worker");
    const bare = { ...operation(current), candidateRevision: undefined, resolvedOperationPolicy: undefined };
    let detail = "";
    expect(() => {
      detail = describeBindingMismatchV1(binding, bare as OperationRecordV2, "participant:worker", "session-1");
    }).not.toThrow();
    expect(detail).toContain("candidateRevision");
    expect(detail).toContain("operationPolicyDigest");
  });
});
