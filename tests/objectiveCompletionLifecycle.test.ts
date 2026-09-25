import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Canonical } from "../src/core/digest.js";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { currentObjectiveIdentityV1, evaluateAcceptanceOracleV1, persistAcceptanceOracleArtifactV1, type AcceptanceOracleDispositionV1, type EvidenceBundleV1 } from "../src/architecture/acceptanceOracle.js";
import { evaluateObjectiveCompletionV1, type ObjectiveCompletionInputV1 } from "../src/architecture/objectiveCompletion.js";
import { bindResolvedOperationPolicy, claimControllerEpoch, currentControllerEpoch, loadOperation, transitionOperationToTerminal, type OperationRecordV2 } from "../src/operations/state.js";
import { resolveOperationStateRoot } from "../src/operations/state.js";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";

const roots: string[] = [];
const previousEnv = {
  id: process.env.AEH_OPERATION_ID,
  control: process.env.AEH_CONTROL_ROOT,
  redirect: process.env.AEH_OPERATION_STATE_REDIRECT
};

afterEach(async () => {
  for (const [key, value] of Object.entries({ AEH_OPERATION_ID: previousEnv.id, AEH_CONTROL_ROOT: previousEnv.control, AEH_OPERATION_STATE_REDIRECT: previousEnv.redirect })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function prepareAcceptedOperation(id: string): Promise<{ root: string; operation: OperationRecordV2; result: Record<string, unknown> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-objective-completion-lifecycle-"));
  roots.push(root);
  const now = new Date().toISOString();
  await saveOwnedOperation(root, {
    version: 2,
    id,
    kind: "run",
    status: "RUNNING",
    phase: "accepting",
    root,
    payload: { taskId: `task-${id}` },
    revision: 1,
    createdAt: now,
    updatedAt: now,
    lastProgressAt: now,
    supervision: { required: false, materialized: false, generations: [] },
    stages: {},
    participants: {},
    progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 }
  });
  let operation = await loadOperation(root, id);
  const candidate = operation.candidateRevision!;
  const policy = compileResolvedOperationPolicy({
    projectId: candidate.projectId!,
    operationId: id,
    operationExecutionRevision: operation.operationExecutionRevision!,
    candidateRevision: candidate.revision,
    candidateDigest: candidate.identityDigest,
    controllerEpoch: currentControllerEpoch(operation),
    intent: "objective completion lifecycle regression",
    route: "DIRECT",
    minimumAssurance: "STANDARD",
    policyVersions: { resolvedOperationPolicy: "1" },
    policyDigests: {},
    validationPolicy: {},
    reviewPolicy: { leadAcceptance: false, leadAcceptanceDirect: false },
    deliveryPolicy: {},
    knowledgePolicy: {},
    contextPolicy: {},
    allowedExternalEffects: [],
    humanDecisionRequirements: []
  });
  await bindResolvedOperationPolicy(root, id, policy);
  operation = await loadOperation(root, id);
  const identity = currentObjectiveIdentityV1(operation);
  const assertionId = "assertion:current-objective";
  const bundleBody = {
    version: 1 as const,
    identity,
    candidate: identity.candidate,
    impactDigest: sha256Canonical({ impact: "empty objective fixture" }),
    compilationDigest: sha256Canonical({ assertions: [] }),
    requirements: [{ version: 1 as const, id: `verification:${assertionId}`, assertionId, statement: "current candidate satisfies the fixture requirement", minimumAssurance: "STANDARD" as const, validationRequirementIds: ["validation:unit"], reviewDimensions: [], leadRequired: false }],
    evidence: [{ version: 1 as const, id: `validation:validation:unit:${assertionId}`, assertionId, kind: "VALIDATION" as const, status: "PASS" as const, identity, strength: "STANDARD" as const, provenance: { sourceId: "unit-test", digest: sha256Canonical({ result: "PASS" }) } }]
  };
  const bundle: EvidenceBundleV1 = { ...bundleBody, digest: sha256Canonical(bundleBody) };
  const acceptanceOracle: AcceptanceOracleDispositionV1 = evaluateAcceptanceOracleV1(bundle, { minimumAssurance: "STANDARD", minimumIndependentReviewers: 0, providerDiversity: false, requiredDimensions: [] });
  expect(acceptanceOracle.disposition).toBe("ACCEPTED");
  const artifact = await persistAcceptanceOracleArtifactV1(resolveOperationStateRoot(root), bundle, acceptanceOracle);
  const objectiveCompletion: ObjectiveCompletionInputV1 = {
    version: 1,
    identity,
    workspaceCandidate: identity.candidate,
    workGraph: { requiredWorkUnitIds: [], accountedWorkUnitIds: [] },
    validation: { requiredAssertionIds: [assertionId], evidence: [{ assertionId, status: "PASS", identity }] },
    review: { requiredAssertionIds: [], evidence: [] },
    acceptance: { disposition: "ACCEPTED", requiredAssertionIds: [assertionId], coveredAssertionIds: [assertionId], identity },
    certification: { required: false },
    delivery: { required: false, disposition: "NOT_REQUIRED" },
    findings: [],
    participants: [],
    terminalIdentity: identity
  };
  const objectiveCompletionDecision = evaluateObjectiveCompletionV1(objectiveCompletion);
  expect(objectiveCompletionDecision.complete).toBe(true);
  return { root, operation, result: { acceptanceOracle, acceptanceOracleArtifact: artifact, objectiveCompletion, objectiveCompletionDecision } };
}

describe("managed objective completion terminal gate", () => {
  it("succeeds only with a persisted current oracle disposition and complete objective evidence", async () => {
    const context = await prepareAcceptedOperation("OBJECTIVE-TERMINAL-CURRENT");
    const terminal = await transitionOperationToTerminal(context.root, context.operation.id, { status: "SUCCEEDED", phase: "finished", result: context.result });
    expect(terminal.transitioned).toBe(true);
    expect(terminal.record.status).toBe("SUCCEEDED");
  });

  it("rejects old-epoch objective identity at terminalization after controller takeover", async () => {
    const context = await prepareAcceptedOperation("OBJECTIVE-TERMINAL-STALE-EPOCH");
    const objective = context.result.objectiveCompletion as ObjectiveCompletionInputV1;
    const priorIdentity = objective.identity;
    await claimControllerEpoch(context.root, context.operation.id, `controller:takeover:${context.operation.id}`);
    const takenOver = await loadOperation(context.root, context.operation.id);
    const policy = compileResolvedOperationPolicy({
      projectId: takenOver.candidateRevision!.projectId!,
      operationId: takenOver.id,
      operationExecutionRevision: takenOver.operationExecutionRevision!,
      candidateRevision: takenOver.candidateRevision!.revision,
      candidateDigest: takenOver.candidateRevision!.identityDigest,
      controllerEpoch: currentControllerEpoch(takenOver),
      intent: "objective completion lifecycle regression",
      route: "DIRECT",
      minimumAssurance: "STANDARD",
      policyVersions: { resolvedOperationPolicy: "1" },
      policyDigests: {},
      validationPolicy: {},
      reviewPolicy: { leadAcceptance: false, leadAcceptanceDirect: false },
      deliveryPolicy: {},
      knowledgePolicy: {},
      contextPolicy: {},
      allowedExternalEffects: [],
      humanDecisionRequirements: []
    });
    await bindResolvedOperationPolicy(context.root, context.operation.id, policy);
    const currentIdentity = currentObjectiveIdentityV1(await loadOperation(context.root, context.operation.id));
    expect(currentIdentity.controllerEpoch).toBe(priorIdentity.controllerEpoch + 1);
    expect(currentIdentity.policyDigest).not.toBe(priorIdentity.policyDigest);
    const staleObjective = {
      ...objective,
      identity: priorIdentity,
      acceptance: { ...objective.acceptance, identity: priorIdentity },
      terminalIdentity: priorIdentity
    };
    await expect(transitionOperationToTerminal(context.root, context.operation.id, {
      status: "SUCCEEDED",
      phase: "finished",
      result: { ...context.result, objectiveCompletion: staleObjective }
    })).rejects.toThrow("OBJECTIVE_COMPLETION_IDENTITY_STALE");
  });

  it("requires objective acceptance coverage to match the persisted oracle disposition", async () => {
    const context = await prepareAcceptedOperation("OBJECTIVE-TERMINAL-COVERAGE");
    const objective = context.result.objectiveCompletion as ObjectiveCompletionInputV1;
    const mismatchedObjective = { ...objective, acceptance: { ...objective.acceptance, requiredAssertionIds: [], coveredAssertionIds: [] } };
    expect(evaluateObjectiveCompletionV1(mismatchedObjective).complete).toBe(true);
    await expect(transitionOperationToTerminal(context.root, context.operation.id, {
      status: "SUCCEEDED",
      phase: "finished",
      result: { ...context.result, objectiveCompletion: mismatchedObjective }
    })).rejects.toThrow("OBJECTIVE_COMPLETION_ORACLE_COVERAGE_STALE");
  });
});
