import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindBootstrapOperationPolicy,
  cancelOperation,
  createOperationId,
  extractWorkspaceId,
  startDetachedOperation
} from "../src/operations/controller.js";
import {
  bindOperationCandidate,
  bindOperationExecutionSemantics,
  bindProductChoiceExecutionSemantics,
  bindOperationParticipantExecution,
  bindResolvedOperationPolicy,
  claimControllerEpoch,
  currentControllerEpoch,
  completeOperationProductChoice,
  assertCurrentConsumedProductChoiceBinding,
  loadOperationProductChoiceCheckpoint,
  loadStaleConsumedProductChoiceCheckpointForReconfirmation,
  loadWaitingOperationProductChoiceCheckpointForReissue,
  markOperationProductChoiceConsumed,
  reissueOperationProductChoice,
  reconfirmStaleConsumedProductChoice,
  resumeOperationProductChoice,
  suspendOperationForProductChoice,
  loadOperation,
  operationEventsFile,
  operationFile,
  acknowledgeOperationLead,
  patchOperation,
  patchOperationMetadata,
  registerOperationAgent,
  saveOperation,
  setOperationStage,
  transitionOperationToTerminal,
  updateOperationMetadata,
  updateOperationParticipant,
  type OperationRecord
} from "../src/operations/state.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { compileExecutionBinding, compileResolvedOperationPolicy, type ResolvedOperationPolicyV1 } from "../src/architecture/executionIdentity.js";
import { HumanDecisionLedgerV2 } from "../src/security/humanDecision.js";
import { sha256Canonical, sha256Utf8 } from "../src/core/digest.js";
import { runShell } from "../src/utils/process.js";
import { resolveBaseRef } from "../src/core/git.js";

const roots: string[] = [];
const previousControllerEnv = Object.fromEntries(["AEH_OPERATION_ID", "AEH_CONTROL_ROOT", "AEH_OPERATION_STATE_REDIRECT", "AEH_CONTROLLER_EPOCH", "AEH_CONTROLLER_TOKEN"].map((key) => [key, process.env[key]])) as Record<string, string | undefined>;
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
  for (const [key, value] of Object.entries(previousControllerEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-operation-test-"));
  roots.push(root);
  return root;
}

async function seed(
  root: string,
  overrides: Partial<OperationRecord> = {}
): Promise<OperationRecord> {
  const record: OperationRecord = {
    version: 1,
    id: "AUDIT-1",
    kind: "audit",
    status: "QUEUED",
    phase: "queued",
    root,
    payload: { request: "review" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  };
  process.env.AEH_OPERATION_ID = record.id;
  process.env.AEH_CONTROL_ROOT = root;
  process.env.AEH_OPERATION_STATE_REDIRECT = "1";
  await saveOperation(root, record);
  if (!["SUCCEEDED", "FAILED", "CANCELLED"].includes(record.status)) {
    await claimControllerEpoch(root, record.id, `controller:test:${record.id}`, { pid: process.pid });
  }
  return loadOperation(root, record.id);
}

async function seedBoundExecution(
  root: string,
  operationId: string,
  participantId: string
): Promise<{ binding: ReturnType<typeof compileExecutionBinding> }> {
  await seed(root, { id: operationId, status: "RUNNING", phase: "implementation" });
  await registerOperationAgent(root, operationId, {
    id: participantId,
    logicalAgent: "implementer",
    role: "Implementer",
    phase: "implementation"
  });
  const current = await loadOperation(root, operationId);
  const candidate = current.candidateRevision!;
  const policy = compileResolvedOperationPolicy({
    projectId: candidate.projectId!,
    operationId,
    operationExecutionRevision: current.operationExecutionRevision!,
    candidateRevision: candidate.revision,
    candidateDigest: candidate.identityDigest,
    controllerEpoch: currentControllerEpoch(current),
    intent: "generic participant update guard",
    route: "DIRECT",
    minimumAssurance: "STANDARD",
    policyVersions: { resolvedOperationPolicy: "1" },
    policyDigests: {},
    validationPolicy: {},
    reviewPolicy: {},
    deliveryPolicy: {},
    knowledgePolicy: {},
    contextPolicy: {},
    allowedExternalEffects: [],
    humanDecisionRequirements: []
  });
  const bound = await bindResolvedOperationPolicy(root, operationId, policy);
  const binding = compileExecutionBinding({
    operationId,
    operationExecutionRevision: bound.operationExecutionRevision!,
    candidateRevision: candidate.revision,
    candidateDigest: candidate.identityDigest,
    controllerEpoch: currentControllerEpoch(bound),
    executionBlueprintDigest: sha256Canonical({ blueprint: participantId }),
    operationPolicyDigest: policy.digest,
    participantId,
    participantGeneration: "generation-1",
    roleInvocationPolicyDigest: sha256Canonical({ role: participantId }),
    skillManifestDigest: sha256Canonical({ skill: participantId }),
    runtime: { runtimeId: "codex", provider: "openai", modelId: "test-model", model: "test-model", sessionId: `session-${participantId}` },
    contextManifestDigest: sha256Canonical({ context: participantId }),
    promptManifestDigest: sha256Canonical({ prompt: participantId }),
    outputContract: "implementer",
    leaseIdentities: []
  });
  await bindOperationParticipantExecution(root, operationId, { participantId, logicalAgent: "implementer", role: "Implementer", binding });
  return { binding };
}

async function compilePolicyForCurrentIdentity(
  root: string,
  operationId: string,
  overrides: {
    intent?: string;
    operationExecutionRevision?: number;
    candidateRevision?: number;
    controllerEpoch?: number;
    reviewPolicy?: unknown;
  } = {}
): Promise<ResolvedOperationPolicyV1> {
  const current = await loadOperation(root, operationId);
  const candidate = current.candidateRevision!;
  return compileResolvedOperationPolicy({
    projectId: candidate.projectId!,
    operationId,
    operationExecutionRevision: overrides.operationExecutionRevision ?? current.operationExecutionRevision!,
    candidateRevision: overrides.candidateRevision ?? candidate.revision,
    candidateDigest: candidate.identityDigest,
    controllerEpoch: overrides.controllerEpoch ?? currentControllerEpoch(current),
    intent: overrides.intent ?? "focused policy lifecycle",
    route: "DIRECT",
    minimumAssurance: "STANDARD",
    policyVersions: { resolvedOperationPolicy: "1" },
    policyDigests: {},
    validationPolicy: {},
    reviewPolicy: overrides.reviewPolicy ?? {},
    deliveryPolicy: {},
    knowledgePolicy: {},
    contextPolicy: {},
    allowedExternalEffects: [],
    humanDecisionRequirements: []
  });
}

async function bindTestPolicyForCurrentIdentity(root: string, operationId: string): Promise<Awaited<ReturnType<typeof loadOperation>>> {
  const policy = await compilePolicyForCurrentIdentity(root, operationId);
  await bindResolvedOperationPolicy(root, operationId, policy);
  return loadOperation(root, operationId);
}

async function createConsumedTestProductChoice(root: string, operationId: string) {
  const record = await seed(root, { id: operationId, kind: "change", payload: { request: "Implement a formal change." }, status: "RUNNING", phase: "spec-authoring" });
  const current = await bindTestPolicyForCurrentIdentity(root, record.id);
  const content = {
    issue: "Choose the product requirement behavior.",
    authoritativeEvidence: [{ artifact: ".harness/results/spec-manager.json", sha256: "a".repeat(64), description: "Accepted Spec Manager result." }],
    whatTried: ["Compared the existing contract and current behavior."],
    whyUnresolvable: "Both product behaviors satisfy the current request.",
    choices: [{ choiceId: "explicit", label: "Require explicit confirmation", description: "Make the decision visible to users.", consequences: ["Adds a confirmation requirement."] }],
    workThatCanContinue: []
  };
  const suspended = await suspendOperationForProductChoice(root, record.id, content, { version: 1, resumeTarget: "SPEC_AUTHORING", taskId: record.id });
  const request = suspended.decisionRequest!;
  const ledger = new HumanDecisionLedgerV2(path.resolve(root, ".harness", "security", "human-decisions.json"));
  const binding = {
    operationId: record.id,
    candidate: current.candidateRevision!,
    operationExecutionRevision: current.operationExecutionRevision!,
    policyDigest: current.resolvedOperationPolicy!.digest,
    controllerEpoch: currentControllerEpoch(current)
  };
  const decision = await ledger.recordProductChoice({
    ...binding,
    purpose: { kind: "PRODUCT_CHOICE", requestId: request.requestId, choiceId: "explicit" },
    kind: "CHOOSE",
    actorId: "human:control-center:paired-test",
    reason: "Require explicit confirmation."
  }, request.requestId);
  await ledger.consumeExact(binding, decision.purpose, decision.decisionId, decision.actorId);
  const consumed = await markOperationProductChoiceConsumed(root, record.id, { requestId: request.requestId, decisionId: decision.decisionId, choiceId: "explicit" });
  return { current: await loadOperation(root, record.id), consumed, decision, ledger };
}

async function recordTestCancellationDecision(root: string, operationId: string): Promise<void> {
  const operation = await bindTestPolicyForCurrentIdentity(root, operationId);
  const ledger = new HumanDecisionLedgerV2(path.resolve(root, ".harness", "security", "human-decisions.json"));
  await ledger.record({
    operationId,
    candidate: operation.candidateRevision!,
    operationExecutionRevision: operation.operationExecutionRevision!,
    policyDigest: operation.resolvedOperationPolicy!.digest,
    controllerEpoch: currentControllerEpoch(operation),
    purpose: { kind: "OPERATION_CONTROL", command: "CANCEL" },
    kind: "CANCEL",
    actorId: "human:test:cancellation",
    reason: "explicit cancellation test fixture",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000)
  });
}

type ParticipantPatch = Parameters<typeof updateOperationParticipant>[3];

function hostileParticipantPatch(patch: Record<string, unknown>): ParticipantPatch {
  return patch as unknown as ParticipantPatch;
}

describe("operation controller state", () => {
  it("persists legacy records atomically and normalizes them to v2", async () => {
    const root = await tempRoot();
    const record = await seed(root);
    expect(await loadOperation(root, record.id)).toEqual(
      expect.objectContaining({
        version: 2,
        id: record.id,
        kind: record.kind,
        status: record.status,
        phase: record.phase,
        root,
        payload: record.payload,
        revision: 2,
        operationExecutionRevision: 1,
        supervision: expect.objectContaining({ required: true, materialized: false }),
        participants: {},
        progress: expect.objectContaining({ expected: 0, completed: 0, running: 0 })
      })
    );
  });

  it("does not infer an execution revision when an existing durable operation lacks one", async () => {
    const root = await tempRoot();
    const record = await seed(root, { status: "RUNNING" });
    const file = path.join(root, ".harness", "operations", `${record.id}.json`);
    const stored = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    delete stored.operationExecutionRevision;
    await fs.writeFile(file, `${JSON.stringify(stored, null, 2)}\n`);
    const current = await loadOperation(root, record.id);
    expect(current.operationExecutionRevision).toBeUndefined();
    const candidate = current.candidateRevision!;
    await expect(bindOperationCandidate(root, record.id, createCandidateRevisionV1({
      operationId: record.id, candidateId: `candidate:${record.id}:r2`, projectId: candidate.projectId, taskId: candidate.taskId,
      revision: candidate.revision + 1, parentCandidateId: candidate.candidateId, sourceDigest: candidate.sourceDigest, worktree: root
    }))).rejects.toThrow("UNSUPPORTED_OPERATION_EXECUTION_REVISION");
  });

  it("serializes concurrent patches without corrupting the operation file", async () => {
    const root = await tempRoot();
    const record = await seed(root, { status: "RUNNING", phase: "executing" });
    await Promise.all([
      patchOperation(root, record.id, { phase: "planning" }),
      patchOperation(root, record.id, { workspaceId: "workspace-op" }),
      patchOperation(root, record.id, { workspaceWarning: "diagnostic" })
    ]);
    const current = await loadOperation(root, record.id);
    expect(current.status).toBe("RUNNING");
    expect(current.workspaceId).toBe("workspace-op");
    expect(current.workspaceWarning).toBe("diagnostic");
    expect(["planning", "executing"]).toContain(current.phase);
  });

  it("serializes concurrent agent registration without losing participants", async () => {
    const root = await tempRoot();
    const record = await seed(root, { status: "RUNNING", phase: "review" });
    await Promise.all([
      registerOperationAgent(root, record.id, {
        id: "reviewer-1",
        role: "security-reviewer",
        transport: "sdk"
      }),
      registerOperationAgent(root, record.id, {
        id: "reviewer-2",
        role: "architecture-reviewer",
        transport: "sdk"
      })
    ]);
    const current = await loadOperation(root, record.id);
    expect(current.agents?.map((agent) => agent.id).sort()).toEqual([
      "reviewer-1",
      "reviewer-2"
    ]);
  });

  it("grants exactly one concurrent caller ownership of the terminal transition", async () => {
    const root = await tempRoot();
    const record = await seed(root, { status: "RUNNING", phase: "reviewing" });
    const [success, cancellation] = await Promise.all([
      transitionOperationToTerminal(root, record.id, {
        status: "SUCCEEDED",
        phase: "finished",
        finishedAt: "2026-08-13T00:00:00.000Z",
        result: { status: "PASS" }
      }),
      transitionOperationToTerminal(root, record.id, {
        status: "CANCELLED",
        phase: "cancelled",
        finishedAt: "2026-08-13T00:00:01.000Z"
      })
    ]);

    expect([success.transitioned, cancellation.transitioned].sort()).toEqual([false, true]);
    const current = await loadOperation(root, record.id);
    expect(["SUCCEEDED", "CANCELLED"]).toContain(current.status);
    expect(success.record.status).toBe(current.status);
    expect(cancellation.record.status).toBe(current.status);
  });

  it("does not let late phase/final patches resurrect a cancelled operation", async () => {
    const root = await tempRoot();
    const record = await seed(root, {
      status: "CANCELLED",
      phase: "cancelled",
      finishedAt: "2026-08-12T21:00:00.000Z"
    });
    await patchOperation(root, record.id, {
      status: "SUCCEEDED",
      phase: "finished",
      result: { status: "PASS" }
    });
    await patchOperation(root, record.id, { phase: "review" });
    const current = await loadOperation(root, record.id);
    expect(current.status).toBe("CANCELLED");
    expect(current.phase).toBe("cancelled");
    expect(current.finishedAt).toBe("2026-08-12T21:00:00.000Z");
  });

  it("rejects an impossible active-state transition without corrupting the record", async () => {
    const root = await tempRoot();
    const record = await seed(root, { status: "QUEUED", phase: "queued" });
    await expect(patchOperation(root, record.id, { status: "SUCCEEDED", phase: "finished" })).rejects.toThrow("Invalid operation status transition QUEUED -> SUCCEEDED");
    expect(await loadOperation(root, record.id)).toMatchObject({ status: "QUEUED", phase: "queued", revision: 2 });
  });

  it("does not let custom lifecycle mutations change a terminal operation", async () => {
    const root = await tempRoot();
    const record = await seed(root, { status: "CANCELLED", phase: "cancelled", finishedAt: "2026-08-12T21:00:00.000Z" });
    const before = await loadOperation(root, record.id);
    await setOperationStage(root, record.id, "late-worker", "RUNNING");
    await registerOperationAgent(root, record.id, { id: "late-worker", role: "implementer" });
    await updateOperationParticipant(root, record.id, "late-worker", { status: "COMPLETED", resultArtifact: "late.json" });
    const current = await loadOperation(root, record.id);
    expect(current).toEqual(before);
  });

  it("rejects a generic participant update that introduces a fresh participant carrying an execution binding", async () => {
    const root = await tempRoot();
    const operationId = "RUN-BINDING-FRESH";
    const { binding } = await seedBoundExecution(root, operationId, "implementer-1");
    const before = await loadOperation(root, operationId);

    await expect(
      updateOperationParticipant(root, operationId, "fresh-participant", hostileParticipantPatch({ role: "Implementer", executionBinding: binding }))
    ).rejects.toThrow("EXECUTION_BINDING_IMMUTABLE");

    const after = await loadOperation(root, operationId);
    expect(after).toEqual(before);
    expect(after.participants["fresh-participant"]).toBeUndefined();
    expect(after.revision).toBe(before.revision);
  });

  it("rejects generic participant updates that clear or replace an existing execution binding", async () => {
    const root = await tempRoot();
    const operationId = "RUN-BINDING-IMMUTABLE";
    const participantId = "implementer-1";
    const { binding } = await seedBoundExecution(root, operationId, participantId);
    const bound = await loadOperation(root, operationId);
    expect(bound.participants[participantId]?.executionBinding?.digest).toBe(binding.digest);

    const invalidBinding = { ...binding, runtime: { ...binding.runtime, sessionId: "session-mutated-under-stale-digest" } };
    await expect(
      bindOperationParticipantExecution(root, operationId, { participantId, logicalAgent: "implementer", role: "Implementer", binding: invalidBinding })
    ).rejects.toThrow("EXECUTION_BINDING_INVALID");

    const { version: _version, digest: _digest, ...bindingBody } = binding;
    const replacement = compileExecutionBinding({ ...bindingBody, participantGeneration: "generation-2" });
    await expect(
      updateOperationParticipant(root, operationId, participantId, hostileParticipantPatch({ executionBinding: replacement }))
    ).rejects.toThrow("EXECUTION_BINDING_IMMUTABLE");
    await expect(
      updateOperationParticipant(root, operationId, participantId, hostileParticipantPatch({ executionBinding: undefined }))
    ).rejects.toThrow("EXECUTION_BINDING_IMMUTABLE");
    const sameDeclaredDigestMutation = { ...binding, runtime: { ...binding.runtime, sessionId: "session-mutated-under-stale-digest" } };
    expect(sameDeclaredDigestMutation.digest).toBe(binding.digest);
    await expect(
      updateOperationParticipant(root, operationId, participantId, hostileParticipantPatch({ executionBinding: sameDeclaredDigestMutation }))
    ).rejects.toThrow("EXECUTION_BINDING_IMMUTABLE");

    const after = await loadOperation(root, operationId);
    expect(after).toEqual(bound);
    expect(after.participants[participantId]?.executionBinding?.digest).toBe(binding.digest);

    const progressed = await updateOperationParticipant(root, operationId, participantId, { status: "RUNNING", stage: "implementation" });
    expect(progressed.participants[participantId]).toEqual(expect.objectContaining({ status: "RUNNING", stage: "implementation", executionBinding: binding }));
  });

  it("rejects an in-place execution binding session mutation performed by an updateOperationMetadata callback", async () => {
    const root = await tempRoot();
    const operationId = "RUN-BINDING-CALLBACK-IN-PLACE";
    const participantId = "implementer-1";
    const { binding } = await seedBoundExecution(root, operationId, participantId);
    const before = await loadOperation(root, operationId);
    expect(before.participants[participantId]?.executionBinding?.digest).toBe(binding.digest);
    const file = path.join(root, ".harness", "operations", `${operationId}.json`);
    const recordBytes = await fs.readFile(file);

    const mutatedUnderStaleDigest = { ...binding, runtime: { ...binding.runtime, sessionId: "session-mutated-under-stale-digest" } };
    expect(mutatedUnderStaleDigest.digest).toBe(binding.digest);
    expect(sha256Canonical(mutatedUnderStaleDigest)).not.toBe(sha256Canonical(binding));

    await expect(
      updateOperationMetadata(root, operationId, (current) => {
        current.participants[participantId]!.executionBinding!.runtime.sessionId = "session-mutated-under-stale-digest";
        return {};
      })
    ).rejects.toThrow("EXECUTION_BINDING_IMMUTABLE");

    expect(await fs.readFile(file)).toEqual(recordBytes);
    const after = await loadOperation(root, operationId);
    expect(after).toEqual(before);
    expect(after.participants[participantId]?.executionBinding).toEqual(binding);
    expect(after.revision).toBe(before.revision);
  });

  it("rejects re-keying a participant to hide an in-place execution binding mutation from the pre-callback participant set", async () => {
    const root = await tempRoot();
    const operationId = "RUN-BINDING-CALLBACK-REKEY";
    const participantId = "implementer-1";
    const aliasId = "implementer-1-alias";
    const { binding } = await seedBoundExecution(root, operationId, participantId);
    const before = await loadOperation(root, operationId);
    expect(before.participants[participantId]?.executionBinding?.digest).toBe(binding.digest);
    expect(before.participants[aliasId]).toBeUndefined();
    const file = path.join(root, ".harness", "operations", `${operationId}.json`);
    const recordBytes = await fs.readFile(file);

    await expect(
      updateOperationMetadata(root, operationId, (current) => {
        const participant = current.participants[participantId]!;
        participant.executionBinding!.runtime.sessionId = "session-mutated-under-stale-digest";
        delete current.participants[participantId];
        current.participants[aliasId] = participant;
        return {};
      })
    ).rejects.toThrow("EXECUTION_BINDING_IMMUTABLE");

    expect(await fs.readFile(file)).toEqual(recordBytes);
    const after = await loadOperation(root, operationId);
    expect(after).toEqual(before);
    expect(after.participants[aliasId]).toBeUndefined();
    expect(after.participants[participantId]?.executionBinding).toEqual(binding);
    expect(after.revision).toBe(before.revision);
  });

  it("rejects every generic operation path that tries to add or clear a frozen ResolvedOperationPolicy", async () => {
    const root = await tempRoot();
    const operationId = "RUN-POLICY-GENERIC";
    await seed(root, { id: operationId, status: "RUNNING", phase: "implementation" });
    const policy = await compilePolicyForCurrentIdentity(root, operationId);
    const before = await loadOperation(root, operationId);

    await expect(patchOperation(root, operationId, { resolvedOperationPolicy: policy })).rejects.toThrow("EXECUTION_POLICY_IMMUTABLE");
    await expect(patchOperationMetadata(root, operationId, { resolvedOperationPolicy: policy })).rejects.toThrow("EXECUTION_POLICY_IMMUTABLE");
    await expect(updateOperationMetadata(root, operationId, () => ({ resolvedOperationPolicy: policy }))).rejects.toThrow("EXECUTION_POLICY_IMMUTABLE");
    const afterAddAttempts = await loadOperation(root, operationId);
    expect(afterAddAttempts).toEqual(before);
    expect(afterAddAttempts.resolvedOperationPolicy).toBeUndefined();

    const bound = await bindResolvedOperationPolicy(root, operationId, policy);
    expect(bound.resolvedOperationPolicy).toEqual(policy);

    await expect(patchOperation(root, operationId, { resolvedOperationPolicy: undefined })).rejects.toThrow("EXECUTION_POLICY_IMMUTABLE");
    await expect(patchOperationMetadata(root, operationId, { resolvedOperationPolicy: undefined })).rejects.toThrow("EXECUTION_POLICY_IMMUTABLE");
    await expect(updateOperationMetadata(root, operationId, () => ({ resolvedOperationPolicy: undefined }))).rejects.toThrow("EXECUTION_POLICY_IMMUTABLE");
    const afterClearAttempts = await loadOperation(root, operationId);
    expect(afterClearAttempts).toEqual(bound);
    expect(afterClearAttempts.resolvedOperationPolicy).toEqual(policy);
  });

  it("rejects a same-declared-digest policy body mutation and leaves the durable record byte-for-byte unchanged", async () => {
    const root = await tempRoot();
    const operationId = "RUN-POLICY-SAME-DIGEST";
    await seed(root, { id: operationId, status: "RUNNING", phase: "implementation" });
    const policy = await compilePolicyForCurrentIdentity(root, operationId);
    const bound = await bindResolvedOperationPolicy(root, operationId, policy);
    const file = path.join(root, ".harness", "operations", `${operationId}.json`);
    const recordBytes = await fs.readFile(file);

    const tampered: ResolvedOperationPolicyV1 = { ...policy, intent: "tampered-under-retained-digest" };
    const replacement = await compilePolicyForCurrentIdentity(root, operationId, { intent: "replacement" });
    expect(tampered.digest).toBe(policy.digest);
    expect(sha256Canonical(tampered)).not.toBe(sha256Canonical(policy));
    expect(replacement.digest).not.toBe(policy.digest);

    await expect(patchOperation(root, operationId, { resolvedOperationPolicy: tampered })).rejects.toThrow("EXECUTION_POLICY_IMMUTABLE");
    await expect(patchOperationMetadata(root, operationId, { resolvedOperationPolicy: tampered })).rejects.toThrow("EXECUTION_POLICY_IMMUTABLE");
    await expect(updateOperationMetadata(root, operationId, () => ({ resolvedOperationPolicy: tampered }))).rejects.toThrow("EXECUTION_POLICY_IMMUTABLE");
    await expect(patchOperation(root, operationId, { resolvedOperationPolicy: replacement })).rejects.toThrow("EXECUTION_POLICY_IMMUTABLE");
    await expect(updateOperationMetadata(root, operationId, () => ({ resolvedOperationPolicy: replacement }))).rejects.toThrow("EXECUTION_POLICY_IMMUTABLE");

    expect(await fs.readFile(file)).toEqual(recordBytes);
    const after = await loadOperation(root, operationId);
    expect(after).toEqual(bound);
    expect(after.revision).toBe(bound.revision);
    expect(after.operationExecutionRevision).toBe(bound.operationExecutionRevision);
    expect(after.resolvedOperationPolicy).toEqual(policy);

    const progressed = await patchOperation(root, operationId, { phase: "review" });
    expect(progressed.phase).toBe("review");
    expect(progressed.resolvedOperationPolicy).toEqual(policy);
  });

  it("rejects an in-place policy mutation performed by an updateOperationMetadata callback", async () => {
    const root = await tempRoot();
    const operationId = "RUN-POLICY-CALLBACK-IN-PLACE";
    await seed(root, { id: operationId, status: "RUNNING", phase: "implementation" });
    const policy = await compilePolicyForCurrentIdentity(root, operationId);
    const bound = await bindResolvedOperationPolicy(root, operationId, policy);
    const file = path.join(root, ".harness", "operations", `${operationId}.json`);
    const recordBytes = await fs.readFile(file);

    await expect(updateOperationMetadata(root, operationId, (current) => {
      current.resolvedOperationPolicy!.intent = "in-place-tampered-under-retained-digest";
      return {};
    })).rejects.toThrow("EXECUTION_POLICY_IMMUTABLE");

    expect(await fs.readFile(file)).toEqual(recordBytes);
    const after = await loadOperation(root, operationId);
    expect(after).toEqual(bound);
    expect(after.resolvedOperationPolicy).toEqual(policy);
    expect(after.resolvedOperationPolicy!.intent).toBe(policy.intent);
  });

  it("validates the explicit policy binding lifecycle and refuses in-place policy replacement", async () => {
    const root = await tempRoot();
    const operationId = "RUN-POLICY-BINDING";
    await seed(root, { id: operationId, status: "RUNNING", phase: "implementation" });
    const current = await loadOperation(root, operationId);

    const valid = await compilePolicyForCurrentIdentity(root, operationId);
    const invalid: ResolvedOperationPolicyV1 = { ...valid, digest: "0".repeat(64) };
    await expect(bindResolvedOperationPolicy(root, operationId, invalid)).rejects.toThrow("RESOLVED_OPERATION_POLICY_INVALID");
    await expect(bindResolvedOperationPolicy(root, operationId, await compilePolicyForCurrentIdentity(root, operationId, { operationExecutionRevision: current.operationExecutionRevision! + 1 }))).rejects.toThrow("EXECUTION_POLICY_STALE");
    await expect(bindResolvedOperationPolicy(root, operationId, await compilePolicyForCurrentIdentity(root, operationId, { candidateRevision: current.candidateRevision!.revision + 1 }))).rejects.toThrow("EXECUTION_POLICY_STALE");
    await expect(bindResolvedOperationPolicy(root, operationId, await compilePolicyForCurrentIdentity(root, operationId, { controllerEpoch: currentControllerEpoch(current) + 1 }))).rejects.toThrow("EXECUTION_POLICY_STALE");
    expect((await loadOperation(root, operationId)).resolvedOperationPolicy).toBeUndefined();

    const policy = await compilePolicyForCurrentIdentity(root, operationId, { intent: "initial" });
    const bound = await bindResolvedOperationPolicy(root, operationId, policy);
    expect(bound.resolvedOperationPolicy).toEqual(policy);
    expect(bound.operationExecutionRevision).toBe(current.operationExecutionRevision);

    const replacement = await compilePolicyForCurrentIdentity(root, operationId, { intent: "replacement", reviewPolicy: { independentReviewRequired: true } });
    expect(replacement.digest).not.toBe(policy.digest);
    await expect(bindResolvedOperationPolicy(root, operationId, replacement)).rejects.toThrow("EXECUTION_POLICY_RECOMPILE_REQUIRED");

    const equivalent = await compilePolicyForCurrentIdentity(root, operationId, { intent: "initial" });
    expect(sha256Canonical(equivalent)).toBe(sha256Canonical(policy));
    const rebound = await bindResolvedOperationPolicy(root, operationId, equivalent);
    expect(rebound.resolvedOperationPolicy).toEqual(policy);
    expect(rebound.revision).toBe(bound.revision + 1);
    expect(rebound.operationExecutionRevision).toBe(bound.operationExecutionRevision);
  });

  it("clears the frozen policy and execution bindings only through candidate assembly", async () => {
    const root = await tempRoot();
    const operationId = "RUN-POLICY-CANDIDATE";
    const participantId = "implementer-1";
    const { binding } = await seedBoundExecution(root, operationId, participantId);
    const bound = await loadOperation(root, operationId);
    const candidate = bound.candidateRevision!;
    const policy = bound.resolvedOperationPolicy!;
    expect(policy).toBeDefined();
    expect(bound.participants[participantId]?.executionBinding?.digest).toBe(binding.digest);

    const advanced = createCandidateRevisionV1({
      operationId,
      candidateId: `candidate:${operationId}:r${candidate.revision + 1}`,
      projectId: candidate.projectId,
      taskId: candidate.taskId,
      revision: candidate.revision + 1,
      parentCandidateId: candidate.candidateId,
      sourceDigest: candidate.sourceDigest,
      worktree: root
    });
    const afterCandidate = await bindOperationCandidate(root, operationId, advanced);
    expect(afterCandidate.resolvedOperationPolicy).toBeUndefined();
    expect(afterCandidate.participants[participantId]?.executionBinding).toBeUndefined();
    expect(afterCandidate.operationExecutionRevision).toBe(bound.operationExecutionRevision! + 1);

    await expect(patchOperation(root, operationId, { resolvedOperationPolicy: policy })).rejects.toThrow("EXECUTION_POLICY_IMMUTABLE");
    await expect(bindResolvedOperationPolicy(root, operationId, policy)).rejects.toThrow("EXECUTION_POLICY_STALE");
    expect((await loadOperation(root, operationId)).resolvedOperationPolicy).toBeUndefined();
  });

  it("clears the frozen policy and execution bindings only through controller takeover", async () => {
    const root = await tempRoot();
    const operationId = "RUN-POLICY-TAKEOVER";
    const participantId = "implementer-1";
    await seedBoundExecution(root, operationId, participantId);
    const bound = await loadOperation(root, operationId);
    const policy = bound.resolvedOperationPolicy!;
    const claimed = await claimControllerEpoch(root, operationId, "controller:takeover");
    expect(claimed.controller?.epoch).toBe(currentControllerEpoch(bound) + 1);
    expect(claimed.resolvedOperationPolicy).toBeUndefined();
    expect(claimed.participants[participantId]?.executionBinding).toBeUndefined();

    await expect(patchOperation(root, operationId, { resolvedOperationPolicy: policy })).rejects.toThrow("EXECUTION_POLICY_IMMUTABLE");
    await expect(bindResolvedOperationPolicy(root, operationId, policy)).rejects.toThrow("EXECUTION_POLICY_STALE");
    expect((await loadOperation(root, operationId)).resolvedOperationPolicy).toBeUndefined();
  });

  it("clears the frozen policy only when execution semantics actually change", async () => {
    const root = await tempRoot();
    const operationId = "RUN-POLICY-SEMANTICS";
    await seed(root, { id: operationId, status: "RUNNING", phase: "implementation" });
    const policy = await compilePolicyForCurrentIdentity(root, operationId);
    const seeded = await bindResolvedOperationPolicy(root, operationId, policy);

    const initial = await bindOperationExecutionSemantics(root, operationId, sha256Canonical({ semantics: "r1" }));
    expect(initial.resolvedOperationPolicy).toEqual(policy);
    expect(initial.operationExecutionRevision).toBe(seeded.operationExecutionRevision);

    const changed = await bindOperationExecutionSemantics(root, operationId, sha256Canonical({ semantics: "r2" }));
    expect(changed.resolvedOperationPolicy).toBeUndefined();
    expect(changed.operationExecutionRevision).toBe(seeded.operationExecutionRevision! + 1);

    await expect(patchOperation(root, operationId, { resolvedOperationPolicy: policy })).rejects.toThrow("EXECUTION_POLICY_IMMUTABLE");
    await expect(bindResolvedOperationPolicy(root, operationId, policy)).rejects.toThrow("EXECUTION_POLICY_STALE");
  });

  it("rejects every generic operation path that tries to add, replace, or clear executionSemanticsDigest", async () => {
    const root = await tempRoot();
    const operationId = "RUN-SEMANTICS-GENERIC";
    await seed(root, { id: operationId, status: "RUNNING", phase: "implementation" });
    const before = await loadOperation(root, operationId);
    const file = path.join(root, ".harness", "operations", `${operationId}.json`);
    const recordBytes = await fs.readFile(file);
    const d1 = sha256Canonical({ semantics: "generic-d1" });
    const d2 = sha256Canonical({ semantics: "generic-d2" });

    await expect(patchOperation(root, operationId, { executionSemanticsDigest: d1 })).rejects.toThrow();
    await expect(patchOperationMetadata(root, operationId, { executionSemanticsDigest: d1 })).rejects.toThrow();
    await expect(updateOperationMetadata(root, operationId, () => ({ executionSemanticsDigest: d1 }))).rejects.toThrow();
    await expect(updateOperationMetadata(root, operationId, (current) => {
      current.executionSemanticsDigest = d1;
      return { ...current };
    })).rejects.toThrow();

    expect(await fs.readFile(file)).toEqual(recordBytes);
    const afterAddAttempts = await loadOperation(root, operationId);
    expect(afterAddAttempts).toEqual(before);
    expect(afterAddAttempts.executionSemanticsDigest).toBeUndefined();
    expect(afterAddAttempts.operationExecutionRevision).toBe(before.operationExecutionRevision);

    const bound = await bindOperationExecutionSemantics(root, operationId, d1);
    expect(bound.executionSemanticsDigest).toBe(d1);
    expect(bound.operationExecutionRevision).toBe(before.operationExecutionRevision);
    const boundBytes = await fs.readFile(file);

    await expect(patchOperation(root, operationId, { executionSemanticsDigest: d2 })).rejects.toThrow();
    await expect(patchOperationMetadata(root, operationId, { executionSemanticsDigest: d2 })).rejects.toThrow();
    await expect(updateOperationMetadata(root, operationId, () => ({ executionSemanticsDigest: d2 }))).rejects.toThrow();
    await expect(patchOperation(root, operationId, { executionSemanticsDigest: undefined })).rejects.toThrow();
    await expect(patchOperationMetadata(root, operationId, { executionSemanticsDigest: undefined })).rejects.toThrow();
    await expect(updateOperationMetadata(root, operationId, () => ({ executionSemanticsDigest: undefined }))).rejects.toThrow();
    await expect(updateOperationMetadata(root, operationId, (current) => {
      current.executionSemanticsDigest = d2;
      return { ...current };
    })).rejects.toThrow();
    await expect(updateOperationMetadata(root, operationId, (current) => {
      current.executionSemanticsDigest = undefined;
      return { ...current };
    })).rejects.toThrow();

    expect(await fs.readFile(file)).toEqual(boundBytes);
    const afterMutationAttempts = await loadOperation(root, operationId);
    expect(afterMutationAttempts).toEqual(bound);
    expect(afterMutationAttempts.executionSemanticsDigest).toBe(d1);
    expect(afterMutationAttempts.operationExecutionRevision).toBe(bound.operationExecutionRevision);

    const progressed = await patchOperation(root, operationId, { phase: "review" });
    expect(progressed.phase).toBe("review");
    expect(progressed.executionSemanticsDigest).toBe(d1);
  });

  it("rejects generic alias mutation of an existing operationExecutionRevision", async () => {
    const root = await tempRoot();
    const operationId = "RUN-REVISION-PRESENT-GENERIC";
    await seed(root, { id: operationId, status: "RUNNING", phase: "implementation" });
    const before = await loadOperation(root, operationId);
    expect(before.operationExecutionRevision).toBe(1);
    const file = path.join(root, ".harness", "operations", `${operationId}.json`);
    const recordBytes = await fs.readFile(file);

    await expect(patchOperation(root, operationId, { operationExecutionRevision: 2 })).rejects.toThrow(/OPERATION_EXECUTION_REVISION/);
    await expect(patchOperationMetadata(root, operationId, { operationExecutionRevision: 2 })).rejects.toThrow(/OPERATION_EXECUTION_REVISION/);
    await expect(updateOperationMetadata(root, operationId, () => ({ operationExecutionRevision: 2 }))).rejects.toThrow(/OPERATION_EXECUTION_REVISION/);
    await expect(updateOperationMetadata(root, operationId, (current) => {
      current.operationExecutionRevision = 2;
      return { ...current };
    })).rejects.toThrow(/OPERATION_EXECUTION_REVISION/);
    await expect(updateOperationMetadata(root, operationId, (current) => {
      current.operationExecutionRevision = undefined;
      return { ...current };
    })).rejects.toThrow(/OPERATION_EXECUTION_REVISION/);

    expect(await fs.readFile(file)).toEqual(recordBytes);
    const after = await loadOperation(root, operationId);
    expect(after).toEqual(before);
    expect(after.operationExecutionRevision).toBe(1);
  });

  it("rejects generic synthesis of a missing operationExecutionRevision and preserves unsupported execution boundaries", async () => {
    const root = await tempRoot();
    const operationId = "RUN-REVISION-ABSENT-GENERIC";
    const record = await seed(root, { id: operationId, status: "RUNNING", phase: "implementation" });
    const file = path.join(root, ".harness", "operations", `${record.id}.json`);
    const stored = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    delete stored.operationExecutionRevision;
    await fs.writeFile(file, `${JSON.stringify(stored, null, 2)}\n`);
    const before = await loadOperation(root, operationId);
    expect(before.operationExecutionRevision).toBeUndefined();
    const recordBytes = await fs.readFile(file);

    // The Director reproduced this exact legacy upgrade: absent -> revision 1.
    await expect(patchOperation(root, operationId, { operationExecutionRevision: 1 })).rejects.toThrow(/OPERATION_EXECUTION_REVISION/);
    await expect(patchOperation(root, operationId, { operationExecutionRevision: 9 })).rejects.toThrow(/OPERATION_EXECUTION_REVISION/);
    await expect(patchOperationMetadata(root, operationId, { operationExecutionRevision: 9 })).rejects.toThrow(/OPERATION_EXECUTION_REVISION/);
    await expect(updateOperationMetadata(root, operationId, () => ({ operationExecutionRevision: 9 }))).rejects.toThrow(/OPERATION_EXECUTION_REVISION/);
    await expect(updateOperationMetadata(root, operationId, (current) => {
      current.operationExecutionRevision = 9;
      return { ...current };
    })).rejects.toThrow(/OPERATION_EXECUTION_REVISION/);

    expect(await fs.readFile(file)).toEqual(recordBytes);
    const after = await loadOperation(root, operationId);
    expect(after).toEqual(before);
    expect(after.operationExecutionRevision).toBeUndefined();

    const candidate = after.candidateRevision!;
    await expect(bindOperationCandidate(root, operationId, createCandidateRevisionV1({
      operationId, candidateId: `candidate:${operationId}:r2`, projectId: candidate.projectId, taskId: candidate.taskId,
      revision: candidate.revision + 1, parentCandidateId: candidate.candidateId, sourceDigest: candidate.sourceDigest, worktree: root
    }))).rejects.toThrow("UNSUPPORTED_OPERATION_EXECUTION_REVISION");
    await expect(bindOperationExecutionSemantics(root, operationId, sha256Canonical({ semantics: "absent-revision" }))).rejects.toThrow("UNSUPPORTED_OPERATION_EXECUTION_REVISION");
    expect(await fs.readFile(file)).toEqual(recordBytes);
  });

  it("binds a first semantics digest without advancing execution identity and keeps same-digest binds append-only", async () => {
    const root = await tempRoot();
    const operationId = "RUN-SEMANTICS-IDENTITY";
    await seed(root, { id: operationId, status: "RUNNING", phase: "implementation" });
    const policy = await compilePolicyForCurrentIdentity(root, operationId);
    const withPolicy = await bindResolvedOperationPolicy(root, operationId, policy);
    const d1 = sha256Canonical({ semantics: "identity-r1" });

    const first = await bindOperationExecutionSemantics(root, operationId, d1);
    expect(first.executionSemanticsDigest).toBe(d1);
    expect(first.operationExecutionRevision).toBe(withPolicy.operationExecutionRevision);
    expect(first.resolvedOperationPolicy).toEqual(policy);
    expect(first.revision).toBe(withPolicy.revision + 1);

    const same = await bindOperationExecutionSemantics(root, operationId, d1);
    expect(same.executionSemanticsDigest).toBe(d1);
    expect(same.operationExecutionRevision).toBe(withPolicy.operationExecutionRevision);
    expect(same.resolvedOperationPolicy).toEqual(policy);
    expect(same.revision).toBe(first.revision + 1);

    const events = (await fs.readFile(operationEventsFile(root, operationId), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; revision: number });
    const semanticsEvents = events.filter((event) => event.type === "operation.execution-semantics.bound");
    expect(semanticsEvents.map((event) => event.revision)).toEqual([first.revision, same.revision]);
  });

  it("rejects a generic future semantics digest and replaces the bound digest through its owner exactly once", async () => {
    const root = await tempRoot();
    const operationId = "RUN-SEMANTICS-PREEMPT";
    const participantId = "implementer-1";
    const { binding } = await seedBoundExecution(root, operationId, participantId);
    const bound = await loadOperation(root, operationId);
    const policy = bound.resolvedOperationPolicy!;
    expect(policy).toBeDefined();
    expect(bound.participants[participantId]?.executionBinding?.digest).toBe(binding.digest);

    const { version: _version, digest: _digest, ...bindingBody } = binding;
    await registerOperationAgent(root, operationId, { id: "implementer-2", logicalAgent: "implementer", role: "Implementer", phase: "implementation" });
    await bindOperationParticipantExecution(root, operationId, {
      participantId: "implementer-2",
      logicalAgent: "implementer",
      role: "Implementer",
      binding: compileExecutionBinding({
        ...bindingBody,
        participantId: "implementer-2",
        participantGeneration: "generation-2",
        runtime: { ...bindingBody.runtime, sessionId: "session-implementer-2" }
      })
    });
    const withBindings = await loadOperation(root, operationId);
    expect(withBindings.participants[participantId]?.executionBinding).toBeDefined();
    expect(withBindings.participants["implementer-2"]?.executionBinding).toBeDefined();
    expect(withBindings.resolvedOperationPolicy).toEqual(policy);

    const d1 = sha256Canonical({ semantics: "owner-r1" });
    const d2 = sha256Canonical({ semantics: "owner-r2" });
    const first = await bindOperationExecutionSemantics(root, operationId, d1);
    expect(first.executionSemanticsDigest).toBe(d1);
    expect(first.operationExecutionRevision).toBe(withBindings.operationExecutionRevision);
    expect(first.resolvedOperationPolicy).toEqual(policy);
    expect(first.participants[participantId]?.executionBinding?.digest).toBe(binding.digest);

    const file = path.join(root, ".harness", "operations", `${operationId}.json`);
    const preemptedBytes = await fs.readFile(file);
    await expect(patchOperation(root, operationId, { executionSemanticsDigest: d2 })).rejects.toThrow();
    await expect(patchOperationMetadata(root, operationId, { executionSemanticsDigest: d2 })).rejects.toThrow();
    await expect(updateOperationMetadata(root, operationId, () => ({ executionSemanticsDigest: d2 }))).rejects.toThrow();
    await expect(updateOperationMetadata(root, operationId, (current) => {
      current.executionSemanticsDigest = d2;
      return { ...current };
    })).rejects.toThrow();
    expect(await fs.readFile(file)).toEqual(preemptedBytes);
    const afterPreemption = await loadOperation(root, operationId);
    expect(afterPreemption).toEqual(first);
    expect(afterPreemption.executionSemanticsDigest).toBe(d1);

    const changed = await bindOperationExecutionSemantics(root, operationId, d2);
    expect(changed.executionSemanticsDigest).toBe(d2);
    expect(changed.operationExecutionRevision).toBe(first.operationExecutionRevision! + 1);
    expect(changed.resolvedOperationPolicy).toBeUndefined();
    expect(changed.participants[participantId]?.executionBinding).toBeUndefined();
    expect(changed.participants["implementer-2"]?.executionBinding).toBeUndefined();
    expect(changed.revision).toBe(first.revision + 1);

    const reloaded = await loadOperation(root, operationId);
    expect(reloaded.operationExecutionRevision).toBe(first.operationExecutionRevision! + 1);
    expect(reloaded.executionSemanticsDigest).toBe(d2);
  });

  it("rejects an acknowledgement for a stale revision inside the durable mutation boundary", async () => {
    const root = await tempRoot();
    const record = await seed(root, { status: "RUNNING", phase: "planning" });
    const bound = await (await import("../src/operations/state.js")).bindOperationLead(root, record.id, "lead-1", "test");
    const staleRevision = bound.revision;
    const current = await setOperationStage(root, record.id, "review", "RUNNING");
    await expect(acknowledgeOperationLead(root, record.id, current.revision, "lead-2", currentControllerEpoch(current), "wrong-lead")).rejects.toThrow("AEH_OPERATION_ACK_ACTOR_MISMATCH");
    await expect(acknowledgeOperationLead(root, record.id, current.revision, "lead-1", currentControllerEpoch(current) - 1, "stale-epoch")).rejects.toThrow("AEH_OPERATION_ACK_EPOCH_MISMATCH");
    await expect(acknowledgeOperationLead(root, record.id, staleRevision, "lead-1", currentControllerEpoch(current), "stale-read")).rejects.toThrow("AEH_OPERATION_ACK_REVISION_MISMATCH");
    expect((await loadOperation(root, record.id)).lead?.acknowledgedRevision).toBeLessThan(current.revision);
  });

  it("cancels registered agents without requiring a Paseo list discovery", async () => {
    const root = await tempRoot();
    const record = await seed(root, {
      status: "RUNNING",
      phase: "review",
      agents: [
        {
          id: "reviewer-1",
          role: "security-reviewer",
          transport: "sdk",
          registeredAt: new Date().toISOString()
        },
        {
          id: "reviewer-2",
          role: "architecture-reviewer",
          transport: "sdk",
          registeredAt: new Date().toISOString()
        }
      ]
    });
    await recordTestCancellationDecision(root, record.id);
    const run = vi.fn(async (command: string) => {
      if (command === "paseo stop 'reviewer-1'" || command === "paseo stop 'reviewer-2'") {
        return { exitCode: 0, stdout: "stopped", stderr: "", durationMs: 1 };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const trace = vi.fn(async () => undefined);

    const cancelled = await cancelOperation(root, record.id, {
      run: run as never,
      trace: trace as never
    });
    expect(cancelled.status).toBe("CANCELLED");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.some(([command]) => String(command).includes("paseo ls"))).toBe(false);
    expect(trace).toHaveBeenCalledWith(
      root,
      "cleanup.discovery",
      expect.objectContaining({ source: "operation-state", agentCount: 2 })
    );
  });

  it("rejects cancellation without a current scoped human decision before changing controller epoch", async () => {
    const root = await tempRoot();
    const record = await seed(root, { status: "RUNNING", phase: "review" });
    const before = await bindTestPolicyForCurrentIdentity(root, record.id);
    await expect(cancelOperation(root, record.id, {
      run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 })) as never,
      trace: vi.fn(async () => undefined) as never
    })).rejects.toThrow("no current HumanDecision");
    const after = await loadOperation(root, record.id);
    expect(currentControllerEpoch(after)).toBe(currentControllerEpoch(before));
    expect(after.status).toBe("RUNNING");
  });

  it("starts a detached controller process and records its pid", async () => {
    const root = await tempRoot();
    const unref = vi.fn();
    const spawnProcess = vi.fn(() => ({ pid: 4242, unref }));
    const record = await startDetachedOperation(
      root,
      "audit",
      { request: "review" },
      {
        nodeExecutable: "/usr/bin/node",
        entryFile: "/pkg/dist/main.js",
        spawnProcess: spawnProcess as never
      }
    );
    expect(record).toEqual(
      expect.objectContaining({
        version: 2,
        kind: "audit",
        status: "QUEUED",
        phase: "dispatched",
        pid: 4242
      })
    );
    expect(spawnProcess).toHaveBeenCalledWith(
      "/usr/bin/node",
      ["/pkg/dist/main.js", "operation", "execute", record.id, root],
      expect.objectContaining({ detached: true, stdio: "ignore" })
    );
    expect(unref).toHaveBeenCalledTimes(1);
    expect((await loadOperation(root, record.id)).pid).toBe(4242);
  });

  it("terminalizes an asynchronously failed detached controller spawn", async () => {
    const root = await tempRoot();
    let onError: ((error: Error) => void) | undefined;
    const child = {
      pid: 4243,
      unref: vi.fn(),
      once: vi.fn((event: string, handler: (error: Error) => void) => {
        if (event === "error") onError = handler;
        return child;
      })
    };
    const record = await startDetachedOperation(root, "audit", { request: "review" }, {
      nodeExecutable: "/usr/bin/node",
      entryFile: "/pkg/dist/main.js",
      spawnProcess: vi.fn(() => child) as never
    });

    onError?.(new Error("spawn EACCES"));
    await vi.waitFor(async () => expect((await loadOperation(root, record.id)).status).toBe("FAILED"));
    expect((await loadOperation(root, record.id)).phase).toBe("spawn-failed");
  });

  it("cancels a detached direct-process handle registered by runShell", async () => {
    if (process.platform === "win32") return;
    const root = await tempRoot();
    const record = await seed(root, {
      status: "RUNNING",
      phase: "executing",
      agents: [{ id: "reviewer-1", role: "reviewer", registeredAt: new Date().toISOString() }]
    });
    await bindTestPolicyForCurrentIdentity(root, record.id);
    const previous = {
      id: process.env.AEH_OPERATION_ID,
      kind: process.env.AEH_OPERATION_KIND,
      root: process.env.AEH_CONTROL_ROOT,
      redirect: process.env.AEH_OPERATION_STATE_REDIRECT
    };
    process.env.AEH_OPERATION_ID = record.id;
    process.env.AEH_OPERATION_KIND = "audit";
    process.env.AEH_CONTROL_ROOT = root;
    process.env.AEH_OPERATION_STATE_REDIRECT = "1";
    const running = runShell(`${shellQuote(process.execPath)} -e ${shellQuote("setTimeout(()=>{},60000)")}`, { cwd: root, timeoutMs: 60_000 });
    const handles = path.join(root, ".harness", "operations", `${record.id}.processes`);
    try {
      await vi.waitFor(async () => expect((await fs.readdir(handles)).length).toBeGreaterThan(0));
      const cancelled = await cancelOperation(root, record.id, {
        run: vi.fn(async () => ({ exitCode: 0, stdout: "stopped", stderr: "", durationMs: 1 })) as never,
        trace: vi.fn(async () => undefined) as never,
        humanActorId: "human:control-center:test-session"
      });
      const result = await running;
      expect(cancelled.status).toBe("CANCELLED");
      expect(result.exitCode).not.toBe(0);
    } finally {
      restoreEnv("AEH_OPERATION_ID", previous.id);
      restoreEnv("AEH_OPERATION_KIND", previous.kind);
      restoreEnv("AEH_CONTROL_ROOT", previous.root);
      restoreEnv("AEH_OPERATION_STATE_REDIRECT", previous.redirect);
    }
  }, 10_000);

  it("cancels detached descendants that are outside the controller process group", async () => {
    if (process.platform !== "linux") return;
    const root = await tempRoot();
    const descendantFile = path.join(root, "descendant.pid");
    const script = [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      "const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });",
      "fs.writeFileSync(process.argv[1], String(descendant.pid));",
      "setInterval(() => {}, 60000);"
    ].join(" ");
    const controller = spawn(process.execPath, ["-e", script, descendantFile], {
      cwd: root,
      detached: true,
      stdio: "ignore"
    });
    const record = await seed(root, {
      status: "RUNNING",
      phase: "executing",
      pid: controller.pid
    });
    await bindTestPolicyForCurrentIdentity(root, record.id);
    let descendantPid: number | undefined;
    try {
      await vi.waitFor(async () => {
        descendantPid = Number(await fs.readFile(descendantFile, "utf8"));
        expect(descendantPid).toBeGreaterThan(0);
      });
      const cancelled = await cancelOperation(root, record.id, {
        run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 })) as never,
        trace: vi.fn(async () => undefined) as never,
        humanActorId: "human:control-center:test-session"
      });
      expect(cancelled.status).toBe("CANCELLED");
      await vi.waitFor(async () => {
        expect(await isLiveLinuxProcess(descendantPid!)).toBe(false);
      }, { timeout: 3_000, interval: 50 });
    } finally {
      if (controller.pid) {
        try { process.kill(-controller.pid, "SIGKILL"); } catch { /* already stopped */ }
      }
      if (descendantPid) {
        try { process.kill(-descendantPid, "SIGKILL"); } catch { /* already stopped */ }
      }
    }
  }, 10_000);

  it("extracts workspace ids from nested Paseo JSON", () => {
    expect(
      extractWorkspaceId(
        JSON.stringify({
          requestId: "x",
          workspace: { id: "workspace-abc", cwd: "/repo" }
        })
      )
    ).toBe("workspace-abc");
  });

  it("creates stable-shaped operation ids", () => {
    expect(createOperationId("audit", "same-seed")).toMatch(
      /^AUDIT-\d{8}T\d{6}Z-[a-f0-9]{8}$/
    );
  });

  it("persists a scoped product-choice continuation and resumes SPEC_AUTHORING only after current-policy revalidation", async () => {
    const root = await tempRoot();
    const record = await seed(root, { status: "RUNNING", phase: "spec-authoring" });
    const current = await bindTestPolicyForCurrentIdentity(root, record.id);
    const beforeExecutionRevision = current.operationExecutionRevision!;
    const content = {
      issue: "Choose the product requirement behavior.",
      authoritativeEvidence: [{ artifact: ".harness/results/spec-manager.json", sha256: "a".repeat(64), description: "Accepted Spec Manager result." }],
      whatTried: ["Compared the existing contract and current behavior."],
      whyUnresolvable: "Both product behaviors satisfy the current request.",
      choices: [{ choiceId: "explicit", label: "Require explicit confirmation", description: "Make the decision visible to users.", consequences: ["Adds a confirmation requirement."] }],
      workThatCanContinue: ["Read-only discovery can continue."]
    };
    const suspended = await suspendOperationForProductChoice(root, record.id, content, { version: 1, resumeTarget: "SPEC_AUTHORING", taskId: record.id });
    expect(suspended).toMatchObject({ phase: "HUMAN_REQUIRED", status: "RUNNING", decisionRequest: { resumeTarget: "SPEC_AUTHORING", operationExecutionRevision: beforeExecutionRevision }, continuation: { state: "WAITING", reason: "PRODUCT_CHOICE" } });
    await expect(loadOperationProductChoiceCheckpoint(root, record.id)).resolves.toMatchObject({ taskId: record.id, resumeTarget: "SPEC_AUTHORING" });

    const request = suspended.decisionRequest!;
    const ledger = new HumanDecisionLedgerV2(path.resolve(root, ".harness", "security", "human-decisions.json"));
    const decision = await ledger.recordProductChoice({
      operationId: record.id,
      candidate: current.candidateRevision!,
      operationExecutionRevision: current.operationExecutionRevision!,
      policyDigest: current.resolvedOperationPolicy!.digest,
      controllerEpoch: currentControllerEpoch(current),
      purpose: { kind: "PRODUCT_CHOICE", requestId: request.requestId, choiceId: "explicit" },
      kind: "CHOOSE",
      actorId: "human:control-center:paired-test",
      reason: "Require explicit confirmation."
    }, request.requestId);
    await ledger.consumeExact({ operationId: current.id, candidate: current.candidateRevision!, operationExecutionRevision: current.operationExecutionRevision!, policyDigest: current.resolvedOperationPolicy!.digest, controllerEpoch: currentControllerEpoch(current) }, decision.purpose, decision.decisionId, decision.actorId);
    const consumed = await markOperationProductChoiceConsumed(root, record.id, { requestId: request.requestId, decisionId: decision.decisionId, choiceId: "explicit" });
    expect(consumed).toMatchObject({ phase: "REVALIDATING", decisionRequest: undefined, continuation: { state: "CHOICE_CONSUMED", selectedDecisionId: decision.decisionId, selectedChoiceId: "explicit" } });

    const semanticsBound = await bindProductChoiceExecutionSemantics(root, record.id, { requirementDigest: "b".repeat(64), decisionId: decision.decisionId, choiceId: "explicit" });
    expect(semanticsBound.operationExecutionRevision).toBe(beforeExecutionRevision + 1);
    expect(semanticsBound.resolvedOperationPolicy).toBeUndefined();
    expect(semanticsBound.continuation).toMatchObject({ state: "CHOICE_CONSUMED", appliedRequirementDigest: "b".repeat(64) });
    const reboundPolicy = await compilePolicyForCurrentIdentity(root, record.id);
    await bindResolvedOperationPolicy(root, record.id, reboundPolicy);
    const resumed = await resumeOperationProductChoice(root, record.id);
    expect(resumed).toMatchObject({ phase: "spec-authoring", continuation: { state: "RESUMING", selectedChoiceId: "explicit", operationExecutionRevision: beforeExecutionRevision + 1, policyDigest: reboundPolicy.digest, controllerEpoch: currentControllerEpoch(resumed) } });
    const completed = await completeOperationProductChoice(root, record.id);
    expect(completed.continuation).toBeUndefined();
    expect(completed.decisionRequest).toBeUndefined();
  });

  it("rejects consumed product choices when decision or current execution, policy, or controller binding drifts", async () => {
    const root = await tempRoot();
    const { current, consumed, decision } = await createConsumedTestProductChoice(root, "AUDIT-CHOICE-STALE-BINDING");
    const continuation = consumed.continuation!;
    const selectedBinding = continuation.selectedDecisionBinding!;
    expect(() => assertCurrentConsumedProductChoiceBinding(current, continuation, selectedBinding)).not.toThrow();

    const alteredDecisionBindings = [
      { ...selectedBinding, operationExecutionRevision: selectedBinding.operationExecutionRevision + 1 },
      { ...selectedBinding, policyDigest: selectedBinding.policyDigest === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64) },
      { ...selectedBinding, controllerEpoch: selectedBinding.controllerEpoch + 1 }
    ];
    for (const altered of alteredDecisionBindings) {
      expect(() => assertCurrentConsumedProductChoiceBinding(current, continuation, altered)).toThrow("DECISION_CONTINUATION_DECISION_BINDING_STALE");
    }
    expect(decision.operationExecutionRevision).toBe(selectedBinding.operationExecutionRevision);

    const changedRevisionPolicy = await compilePolicyForCurrentIdentity(root, current.id, { operationExecutionRevision: current.operationExecutionRevision! + 1 });
    const changedPolicy = await compilePolicyForCurrentIdentity(root, current.id, { intent: "changed product-choice policy identity" });
    const nextEpoch = currentControllerEpoch(current) + 1;
    const changedEpochPolicy = await compilePolicyForCurrentIdentity(root, current.id, { controllerEpoch: nextEpoch });
    const changedOperations = [
      { ...current, operationExecutionRevision: current.operationExecutionRevision! + 1, resolvedOperationPolicy: changedRevisionPolicy },
      { ...current, resolvedOperationPolicy: changedPolicy },
      { ...current, controller: { ...current.controller!, epoch: nextEpoch }, resolvedOperationPolicy: changedEpochPolicy }
    ];
    for (const changed of changedOperations) {
      expect(() => assertCurrentConsumedProductChoiceBinding(changed, continuation, selectedBinding)).toThrow("DECISION_CONTINUATION_BINDING_STALE");
    }
  });

  it("rejects checkpoint envelope tampering and stale current bindings across execution revision, policy, and controller epoch", async () => {
    const tamperedFields = ["operationExecutionRevision", "policyDigest", "controllerEpoch"] as const;
    for (const field of tamperedFields) {
      const root = await tempRoot();
      const { consumed } = await createConsumedTestProductChoice(root, `AUDIT-CHOICE-CHECKPOINT-TAMPER-${field}`);
      const record = await loadOperation(root, consumed.id);
      const continuation = record.continuation!;
      const checkpointFile = path.resolve(root, continuation.checkpointArtifact);
      const envelope = JSON.parse(await fs.readFile(checkpointFile, "utf8")) as { binding: Record<string, unknown> };
      if (field === "operationExecutionRevision") envelope.binding[field] = Number(envelope.binding[field]) + 1;
      else if (field === "controllerEpoch") envelope.binding[field] = Number(envelope.binding[field]) + 1;
      else envelope.binding[field] = envelope.binding[field] === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
      const content = `${JSON.stringify(envelope, null, 2)}\n`;
      await fs.writeFile(checkpointFile, content, "utf8");
      const forgedRecord = { ...record, continuation: { ...continuation, checkpointDigest: sha256Utf8(content) } };
      await fs.writeFile(operationFile(root, record.id), `${JSON.stringify(forgedRecord, null, 2)}\n`, "utf8");
      await expect(loadOperationProductChoiceCheckpoint(root, record.id)).rejects.toThrow("DECISION_CONTINUATION_CHECKPOINT_BINDING_STALE");
    }

    for (const field of tamperedFields) {
      const root = await tempRoot();
      const { consumed } = await createConsumedTestProductChoice(root, `AUDIT-CHOICE-CURRENT-STALE-${field}`);
      const record = await loadOperation(root, consumed.id);
      let stale: typeof record;
      if (field === "operationExecutionRevision") {
        const nextRevision = record.operationExecutionRevision! + 1;
        stale = { ...record, operationExecutionRevision: nextRevision, resolvedOperationPolicy: await compilePolicyForCurrentIdentity(root, record.id, { operationExecutionRevision: nextRevision }) };
      } else if (field === "policyDigest") {
        stale = { ...record, resolvedOperationPolicy: await compilePolicyForCurrentIdentity(root, record.id, { intent: "current policy changed after choice consumption" }) };
      } else {
        const nextEpoch = currentControllerEpoch(record) + 1;
        stale = { ...record, controller: { ...record.controller!, epoch: nextEpoch }, resolvedOperationPolicy: await compilePolicyForCurrentIdentity(root, record.id, { controllerEpoch: nextEpoch }) };
      }
      await fs.writeFile(operationFile(root, record.id), `${JSON.stringify(stale, null, 2)}\n`, "utf8");
      await expect(loadOperationProductChoiceCheckpoint(root, record.id)).rejects.toThrow("DECISION_CONTINUATION_CHECKPOINT_BINDING_STALE");
    }
  });

  it("reissues only an intact unanswered checkpoint after controller epoch takeover", async () => {
    const root = await tempRoot();
    const record = await seed(root, { id: "AUDIT-CHOICE-REISSUE-TAKEOVER", status: "RUNNING", phase: "spec-authoring" });
    const current = await bindTestPolicyForCurrentIdentity(root, record.id);
    const suspended = await suspendOperationForProductChoice(root, record.id, {
      issue: "Choose the product requirement behavior.",
      authoritativeEvidence: [{ artifact: ".harness/results/spec-manager.json", sha256: "a".repeat(64), description: "Accepted Spec Manager result." }],
      whatTried: ["Compared the existing contract and current behavior."],
      whyUnresolvable: "Both product behaviors satisfy the current request.",
      choices: [{ choiceId: "explicit", label: "Require explicit confirmation", description: "Make the decision visible to users.", consequences: ["Adds a confirmation requirement."] }],
      workThatCanContinue: []
    }, { version: 1, resumeTarget: "SPEC_AUTHORING", taskId: record.id });
    const oldRequestId = suspended.decisionRequest!.requestId;
    const oldEpoch = currentControllerEpoch(current);

    const takenOver = await claimControllerEpoch(root, record.id, "controller:test:takeover");
    expect(currentControllerEpoch(takenOver)).toBe(oldEpoch + 1);
    await bindResolvedOperationPolicy(root, record.id, await compilePolicyForCurrentIdentity(root, record.id));
    const oldCheckpoint = await loadWaitingOperationProductChoiceCheckpointForReissue(root, record.id);
    const reissued = await reissueOperationProductChoice(root, record.id, oldCheckpoint);

    expect(reissued.decisionRequest).toMatchObject({ operationExecutionRevision: current.operationExecutionRevision, controllerEpoch: oldEpoch + 1 });
    expect(reissued.decisionRequest!.requestId).not.toBe(oldRequestId);
    expect(reissued.continuation).toMatchObject({ state: "WAITING", operationExecutionRevision: current.operationExecutionRevision, controllerEpoch: oldEpoch + 1 });
    await expect(loadOperationProductChoiceCheckpoint(root, record.id)).resolves.toMatchObject({ taskId: record.id, resumeTarget: "SPEC_AUTHORING" });
  });

  it("recovers the semantics-bound crash window through deterministic bootstrap policy binding and preserves an already rebound policy", async () => {
    const root = await tempRoot();
    const { current, consumed, decision } = await createConsumedTestProductChoice(root, "CHANGE-CHOICE-BOOTSTRAP-RECOVERY");
    const requirementDigest = "c".repeat(64);
    const semanticsBound = await bindProductChoiceExecutionSemantics(root, current.id, {
      requirementDigest,
      decisionId: decision.decisionId,
      choiceId: "explicit"
    });
    expect(semanticsBound.resolvedOperationPolicy).toBeUndefined();
    expect(semanticsBound.continuation).toMatchObject({ state: "CHOICE_CONSUMED", appliedRequirementDigest: requirementDigest });
    await expect(loadOperationProductChoiceCheckpoint(root, current.id)).rejects.toThrow("DECISION_AUTHORITY_REQUIRED");

    const config = { version: 1, project: { name: "bootstrap-recovery-test" } } as never;
    const recovered = await bindBootstrapOperationPolicy(root, config, semanticsBound, "FORMAL_SDD", "STANDARD");
    expect(recovered.resolvedOperationPolicy).toMatchObject({ operationId: current.id, operationExecutionRevision: current.operationExecutionRevision! + 1, controllerEpoch: currentControllerEpoch(current) });
    expect(recovered.continuation!.selectedDecisionBinding).toEqual(consumed.continuation!.selectedDecisionBinding);
    await expect(loadOperationProductChoiceCheckpoint(root, current.id)).resolves.toMatchObject({ taskId: current.id, resumeTarget: "SPEC_AUTHORING" });

    const frozenPolicy = recovered.resolvedOperationPolicy!;
    const restartedWithChangedConfig = await bindBootstrapOperationPolicy(root, { ...config, delivery: { github: { enabled: true } } } as never, recovered, "FORMAL_SDD", "STANDARD");
    expect(restartedWithChangedConfig.resolvedOperationPolicy).toEqual(frozenPolicy);
    expect(restartedWithChangedConfig.revision).toBe(recovered.revision);

    const resumed = await resumeOperationProductChoice(root, current.id);
    expect(resumed).toMatchObject({ status: "RUNNING", phase: "spec-authoring", continuation: { state: "RESUMING", appliedRequirementDigest: requirementDigest, selectedDecisionId: decision.decisionId } });
    expect(resumed.continuation!.selectedDecisionBinding).toEqual(consumed.continuation!.selectedDecisionBinding);
  });

  it("turns a consumed choice stale after controller takeover into a fresh durable HUMAN_REQUIRED request", async () => {
    const root = await tempRoot();
    const { current, decision, consumed } = await createConsumedTestProductChoice(root, "CHANGE-CHOICE-RECONFIRM-TAKEOVER");
    const requirementDigest = "d".repeat(64);
    await bindProductChoiceExecutionSemantics(root, current.id, { requirementDigest, decisionId: decision.decisionId, choiceId: "explicit" });
    const oldDecisionBinding = consumed.continuation!.selectedDecisionBinding!;

    const takenOver = await claimControllerEpoch(root, current.id, "controller:test:reconfirm");
    expect(currentControllerEpoch(takenOver)).toBe(oldDecisionBinding.controllerEpoch + 1);
    const config = { version: 1, project: { name: "bootstrap-reconfirm-test" } } as never;
    const reboundPolicy = await bindBootstrapOperationPolicy(root, config, takenOver, "FORMAL_SDD", "STANDARD");
    expect(reboundPolicy.resolvedOperationPolicy!.controllerEpoch).toBe(oldDecisionBinding.controllerEpoch + 1);
    expect(reboundPolicy.continuation!.selectedDecisionBinding).toEqual(oldDecisionBinding);
    await expect(loadOperationProductChoiceCheckpoint(root, current.id)).rejects.toThrow("DECISION_CONTINUATION_CHECKPOINT_BINDING_STALE");

    const historicalCheckpoint = await loadStaleConsumedProductChoiceCheckpointForReconfirmation(root, current.id);
    const reconsented = await reconfirmStaleConsumedProductChoice(root, current.id, {
      issue: "The prior decision expired with the former controller epoch. Confirm a current choice.",
      authoritativeEvidence: [{ artifact: ".harness/results/spec-manager.json", sha256: "a".repeat(64), description: "Accepted Spec Manager result." }],
      whatTried: ["Revalidated the saved product choice after controller takeover."],
      whyUnresolvable: "The prior controller-scoped choice is stale.",
      choices: [{ choiceId: "explicit", label: "Require explicit confirmation", description: "Make the decision visible to users.", consequences: ["Adds a confirmation requirement."] }],
      workThatCanContinue: []
    }, historicalCheckpoint);

    expect(reconsented).toMatchObject({ status: "RUNNING", phase: "HUMAN_REQUIRED", decisionRequest: { operationId: current.id, controllerEpoch: oldDecisionBinding.controllerEpoch + 1 }, continuation: { state: "WAITING" } });
    expect(reconsented.decisionRequest!.requestId).not.toBe(consumed.continuation!.requestId);
    expect(reconsented.continuation!.selectedDecisionId).toBeUndefined();
    expect(reconsented.continuation!.selectedDecisionBinding).toBeUndefined();
    await expect(loadOperationProductChoiceCheckpoint(root, current.id)).resolves.toEqual(historicalCheckpoint);
  });

  it("falls back from an unavailable configured base ref to the current branch", async () => {
    const root = await tempRoot();
    await runShell("git init -q && git config user.email aeh@example.invalid && git config user.name aeh && git commit --allow-empty -qm baseline && git branch -M fixture-base", { cwd: root, timeoutMs: 30_000 });
    const resolved = await resolveBaseRef(root, "main");
    expect(resolved.ref).toBe("fixture-base");
    expect(resolved.fallbackFrom).toBe("main");
  });
});

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function isLiveLinuxProcess(pid: number): Promise<boolean> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const closingParen = stat.lastIndexOf(")");
    return closingParen >= 0 && stat.slice(closingParen + 2).trim().split(/\s+/)[0] !== "Z";
  } catch {
    return false;
  }
}
