import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileExecutionBinding, compileResolvedOperationPolicy, compileRoleInvocationPolicy } from "../src/architecture/executionIdentity.js";
import { sha256Canonical } from "../src/core/digest.js";
import {
  bindOperationCandidate,
  bindOperationLead,
  bindOperationParticipantExecution,
  bindResolvedOperationPolicy,
  currentControllerEpoch,
  loadOperation,
  registerOperationAgent,
  registerSupervisorGeneration,
  saveOperation,
  updateSupervisorGeneration,
  type OperationRecordV2,
} from "../src/operations/state.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { compileOperationOriginV1 } from "../src/operations/operationProvenance.js";
import { recordProviderTurnStarted } from "../src/workers/agentPrompt.js";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const digest = (value: unknown) => sha256Canonical(value);

// Fixture mirrors tests/executionLiveness.test.ts makeFixture({supervisor:true}):
// RUNNING change op + frozen policy + candidate r1 + implementer binding +
// supervisor agent + ACTIVE supervisor generation + supervisor binding.
async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-supervisor-turn-"));
  roots.push(root);
  const now = new Date();
  const timestamp = now.toISOString();
  const operationId = `CHANGE-${timestamp.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-supervisor`;
  const record = {
    version: 2,
    id: operationId,
    kind: "change",
    status: "RUNNING",
    phase: "review",
    root,
    payload: { request: "exercise supervisor turn binding" },
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastProgressAt: timestamp,
    origin: compileOperationOriginV1({
      kind: "USER_REQUEST",
      userTurnId: "owner-turn-supervisor",
      authorizationDigest: digest("auth:owner-turn-supervisor"),
      triggerEventId: "user.turn:owner-turn-supervisor",
      requestDigest: digest("request:owner-turn-supervisor"),
      recoveryDepth: 0,
      rootHardDeadlineAt: new Date(now.getTime() + 8 * 60 * 60_000).toISOString(),
      reason: "supervisor turn binding test",
      createdAt: timestamp,
    }),
    supervision: { required: true, materialized: false, generations: [] },
    stages: {},
    participants: {},
    progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 },
  } as unknown as OperationRecordV2;
  await saveOwnedOperation(root, record);
  let operation = await loadOperation(root, operationId);
  const candidate = operation.candidateRevision!;
  const policy = compileResolvedOperationPolicy({
    projectId: candidate.projectId!,
    operationId,
    operationExecutionRevision: operation.operationExecutionRevision!,
    candidateRevision: candidate.revision,
    candidateDigest: candidate.identityDigest,
    controllerEpoch: currentControllerEpoch(operation),
    intent: "exercise supervisor turn binding",
    route: "DIRECT",
    minimumAssurance: "STANDARD",
    policyVersions: { resolvedOperationPolicy: "2" },
    policyDigests: {},
    validationPolicy: {},
    reviewPolicy: {},
    deliveryPolicy: {},
    knowledgePolicy: {},
    contextPolicy: {},
    allowedExternalEffects: [],
    humanDecisionRequirements: [],
  });
  await bindResolvedOperationPolicy(root, operationId, policy);
  await bindOperationLead(root, operationId, "session:lead-current");
  const supervisorId = "participant:supervisor:1";
  await registerOperationAgent(root, operationId, {
    id: supervisorId,
    logicalAgent: "operation-supervisor",
    role: "Operation Supervisor",
    phase: "supervision",
  });
  await registerSupervisorGeneration(root, operationId, {
    agentId: "session:supervisor:1",
    materialized: true,
    status: "ACTIVE",
  });
  const supervisorRole = compileRoleInvocationPolicy({
    operationId,
    operationPolicyDigest: policy.digest,
    participantId: supervisorId,
    role: "Operation Supervisor",
    workUnitIds: ["supervise"],
    scope: ["operation/**"],
    competencies: ["recovery"],
    toolPack: { version: 1, required: [], optional: [], forbidden: [] },
    resourceClaims: [],
    outputContract: "supervisor",
    constraints: {},
  });
  const supervisorBinding = compileExecutionBinding({
    operationId,
    operationExecutionRevision: operation.operationExecutionRevision!,
    candidateRevision: candidate.revision,
    candidateDigest: candidate.identityDigest,
    controllerEpoch: currentControllerEpoch(operation),
    executionBlueprintDigest: digest("supervisor-blueprint"),
    operationPolicyDigest: policy.digest,
    participantId: supervisorId,
    participantGeneration: "generation:supervisor:1",
    roleInvocationPolicyDigest: supervisorRole.digest,
    skillManifestDigest: digest("supervisor-skills"),
    runtime: {
      runtimeId: "codex",
      provider: "test-provider",
      modelId: "test/model",
      model: "test-model",
      sessionId: "session:supervisor:1",
    },
    contextManifestDigest: digest("supervisor-context"),
    promptManifestDigest: digest("supervisor-prompt"),
    outputContract: "supervisor",
    leaseIdentities: [],
  });
  await bindOperationParticipantExecution(root, operationId, {
    participantId: supervisorId,
    logicalAgent: "operation-supervisor",
    role: "Operation Supervisor",
    binding: supervisorBinding,
  });
  return { root, operationId, supervisorId, supervisorBinding };
}

describe("supervisor turn-start binding (review consolidation race)", () => {
  // CHANGE-20261010T094326Z-e5358e9a: the first gated supervisor
  // consolidation continuation after a correct candidate-drift rotation died
  // with PARTICIPANT_PROVIDER_TURN_START_REJECTED because the gate reads
  // only operation.participants[] while supervisor bindings live in
  // operation.agents[]. Every supervisor continuation then fails
  // deterministically.
  it("admits a current supervisor binding against the ACTIVE generation", async () => {
    const { root, supervisorBinding } = await makeFixture();
    await expect(
      recordProviderTurnStarted(root, { executionBinding: supervisorBinding } as never, "test-provider"),
    ).resolves.toBeUndefined();
  });

  it("refuses a supervisor turn when its generation is DRAINING", async () => {
    const { root, operationId, supervisorBinding } = await makeFixture();
    const operation = await loadOperation(root, operationId);
    const generation = operation.supervision.generations.find((item) => item.status === "ACTIVE")!.generation;
    await updateSupervisorGeneration(root, operationId, generation, { status: "DRAINING" });
    await expect(
      recordProviderTurnStarted(root, { executionBinding: supervisorBinding } as never, "test-provider"),
    ).rejects.toThrow(/SUPERVISOR_GENERATION_NOT_ACTIVE/);
  });

  it("refuses a supervisor turn with a mismatched binding digest", async () => {
    const { root, supervisorBinding } = await makeFixture();
    const forged = { ...supervisorBinding, digest: "0".repeat(64) };
    await expect(
      recordProviderTurnStarted(root, { executionBinding: forged } as never, "test-provider"),
    ).rejects.toThrow(/SUPERVISOR_BINDING_MISMATCH/);
  });

  it("still refuses unknown participants fail-closed", async () => {
    const { root, supervisorBinding } = await makeFixture();
    const ghost = { ...supervisorBinding, participantId: "participant:ghost" };
    await expect(
      recordProviderTurnStarted(root, { executionBinding: ghost } as never, "test-provider"),
    ).rejects.toThrow(/PARTICIPANT_BINDING_ABSENT/);
  });
});
