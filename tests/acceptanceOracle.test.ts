import { describe, expect, it } from "vitest";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { currentObjectiveIdentityV1, evaluateAcceptanceOracleV1, type EvidenceBundleV1 } from "../src/architecture/acceptanceOracle.js";
import { evaluateObjectiveCompletionV1 } from "../src/architecture/objectiveCompletion.js";
import { sha256Canonical } from "../src/core/digest.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import type { OperationRecordV2 } from "../src/operations/state.js";

const digest = (value: unknown) => sha256Canonical(value);

function candidate() {
  return createCandidateRevisionV1({ operationId: "OP-S6", candidateId: "candidate:OP-S6:r1", projectId: "project-s6", taskId: "TASK-S6", revision: 1, sourceDigest: digest("source") });
}

function policy(epoch: number, candidateRevision = candidate()) {
  return compileResolvedOperationPolicy({
    projectId: candidateRevision.projectId!,
    operationId: candidateRevision.operationId,
    operationExecutionRevision: 1,
    candidateRevision: candidateRevision.revision,
    candidateDigest: candidateRevision.identityDigest,
    controllerEpoch: epoch,
    intent: "S6 acceptance test",
    route: "DELEGATED",
    minimumAssurance: "STANDARD",
    policyVersions: { resolvedOperationPolicy: "1" },
    policyDigests: {},
    validationPolicy: {},
    reviewPolicy: { leadAcceptance: true, leadAcceptanceDirect: false },
    deliveryPolicy: {},
    knowledgePolicy: {},
    contextPolicy: {},
    allowedExternalEffects: [],
    humanDecisionRequirements: []
  });
}

function operation(epoch: number): OperationRecordV2 {
  const currentCandidate = candidate();
  return {
    version: 2,
    id: currentCandidate.operationId,
    kind: "change",
    status: "RUNNING",
    phase: "executing",
    root: "/tmp/s6",
    payload: { request: "test", taskId: currentCandidate.taskId },
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastProgressAt: "2026-01-01T00:00:00.000Z",
    supervision: { required: false, materialized: false, generations: [] },
    stages: {},
    participants: {},
    progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 },
    candidateRevision: currentCandidate,
    operationExecutionRevision: 1,
    resolvedOperationPolicy: policy(epoch, currentCandidate),
    controller: { epoch, ownerId: `controller-${epoch}`, claimedAt: "2026-01-01T00:00:00.000Z" }
  };
}

describe("S6 AcceptanceOracle identity and evidence", () => {
  it("accepts a current validated policy at epoch zero", () => {
    const current = operation(0);
    expect(currentObjectiveIdentityV1(current)).toMatchObject({ operationId: current.id, policyDigest: current.resolvedOperationPolicy?.digest, controllerEpoch: 0 });
  });

  it("recompiles the policy digest on takeover and rejects old evidence and terminal identity", () => {
    const priorOperation = operation(0);
    const priorPolicy = priorOperation.resolvedOperationPolicy!;
    const currentCandidate = priorOperation.candidateRevision!;
    const { version: _version, digest: _digest, ...priorBody } = priorPolicy;
    const currentPolicy = compileResolvedOperationPolicy({ ...priorBody, controllerEpoch: 1 });
    expect(currentPolicy.digest).not.toBe(priorPolicy.digest);
    const currentOperation = { ...priorOperation, controller: { ...priorOperation.controller!, epoch: 1 }, resolvedOperationPolicy: currentPolicy };
    const priorIdentity = currentObjectiveIdentityV1(priorOperation);
    const currentIdentity = currentObjectiveIdentityV1(currentOperation);
    const requirements = [{ version: 1 as const, id: "verification:ASSERT-S6", assertionId: "ASSERT-S6", statement: "current assertion", minimumAssurance: "STANDARD" as const, validationRequirementIds: ["REQ-S6"], reviewDimensions: [], leadRequired: false }];
    const evidence = [{ version: 1 as const, id: "validation:REQ-S6:ASSERT-S6", assertionId: "ASSERT-S6", kind: "VALIDATION" as const, status: "PASS" as const, identity: priorIdentity, strength: "STANDARD" as const, provenance: { sourceId: "REQ-S6", digest: digest("prior-validation") } }];
    const bundleBody = { version: 1 as const, identity: currentIdentity, candidate: currentCandidate, impactDigest: digest("impact"), compilationDigest: digest("compilation"), requirements, evidence };
    const bundle: EvidenceBundleV1 = { ...bundleBody, digest: digest(bundleBody) };
    const oracle = evaluateAcceptanceOracleV1(bundle, { minimumAssurance: "STANDARD", minimumIndependentReviewers: 0, providerDiversity: false, requiredDimensions: [] });
    expect(oracle.disposition).toBe("REJECTED");
    expect(oracle.blockers.map((item) => item.code)).toContain("EVIDENCE_IDENTITY_STALE");

    const completion = evaluateObjectiveCompletionV1({
      version: 1,
      identity: currentIdentity,
      workspaceCandidate: currentCandidate,
      workGraph: { requiredWorkUnitIds: [], accountedWorkUnitIds: [] },
      validation: { requiredAssertionIds: [], evidence: [] },
      review: { requiredAssertionIds: [], evidence: [] },
      acceptance: { disposition: "ACCEPTED", requiredAssertionIds: [], coveredAssertionIds: [], identity: currentIdentity },
      certification: { required: false },
      delivery: { required: false, disposition: "NOT_REQUIRED" },
      findings: [],
      participants: [],
      terminalIdentity: priorIdentity
    });
    expect(completion.complete).toBe(false);
    expect(completion.blockers.map((item) => item.code)).toContain("TERMINAL_IDENTITY_MISMATCH");
  });
});
