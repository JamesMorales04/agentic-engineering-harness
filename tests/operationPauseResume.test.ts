import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { initializeProject } from "../src/core/init.js";
import {
  awaitOperationResume,
  bindResolvedOperationPolicy,
  claimControllerEpoch,
  loadOperation,
  pauseOperationIfRequested,
  rebindPauseRecordToCurrentIdentity,
  requestOperationPause,
  requestOperationResume,
  transitionOperationToTerminal,
  type OperationPauseDrainReceiptV1,
  type OperationRecordV2
} from "../src/operations/state.js";
import { HumanDecisionLedgerV2 } from "../src/security/humanDecision.js";
import { saveOperation } from "../src/operations/state.js";

const operationEnvironmentKeys = [
  "AEH_CONTROL_ROOT",
  "AEH_OPERATION_ID",
  "AEH_OPERATION_KIND",
  "AEH_OPERATION_STATE_REDIRECT",
  "AEH_OPERATION_WORKSPACE_ID",
  "AEH_CONTROLLER_EPOCH",
  "AEH_CONTROLLER_TOKEN"
] as const;

const roots: string[] = [];
let previousEnvironment: Record<string, string | undefined> = {};

afterEach(async () => {
  for (const key of operationEnvironmentKeys) {
    const value = previousEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previousEnvironment = {};
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function queuedChangeOperation(root: string, id: string, request: string): OperationRecordV2 {
  const now = new Date().toISOString();
  return {
    version: 2,
    id,
    kind: "change",
    status: "RUNNING",
    phase: "spec-authoring",
    root,
    payload: { request },
    revision: 1,
    operationExecutionRevision: 1,
    createdAt: now,
    updatedAt: now,
    lastProgressAt: now,
    intent: { request, classification: "CHANGE", priority: 50 },
    supervision: { required: false, materialized: false, generations: [] },
    stages: { "spec-authoring": { name: "spec-authoring", status: "RUNNING", revision: 1, startedAt: now } },
    participants: {},
    progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 }
  };
}

function quiescent(now = new Date().toISOString()): OperationPauseDrainReceiptV1 {
  return { activeParticipantIds: [], activeProviderLeaseIds: [], observedAt: now };
}

async function ownedRunningOperation(): Promise<{ root: string; operationId: string }> {
  previousEnvironment = Object.fromEntries(operationEnvironmentKeys.map((key) => [key, process.env[key]]));
  for (const key of operationEnvironmentKeys) delete process.env[key];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-operation-pause-"));
  roots.push(root);
  await initializeProject(root);
  const operationId = "CHANGE-PAUSE-RESUME";
  await saveOperation(root, queuedChangeOperation(root, operationId, "exercise pause and resume"));
  const owned = await claimControllerEpoch(root, operationId, `controller:test:${operationId}`, { pid: process.pid });
  const candidate = owned.candidateRevision!;
  const policy = compileResolvedOperationPolicy({
    projectId: candidate.projectId ?? "project:test",
    operationId,
    operationExecutionRevision: owned.operationExecutionRevision!,
    candidateRevision: candidate.revision,
    candidateDigest: candidate.identityDigest,
    controllerEpoch: owned.controller?.epoch ?? 1,
    intent: "pause/resume regression",
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
    humanDecisionRequirements: []
  });
  await bindResolvedOperationPolicy(root, operationId, policy);
  return { root, operationId };
}

function ledger(root: string): HumanDecisionLedgerV2 {
  return new HumanDecisionLedgerV2(path.join(root, ".harness", "security", "human-decisions.json"));
}

describe("operation pause and resume", () => {
  it("pauses only after consuming the scoped control and a quiescent drain receipt", async () => {
    const { root, operationId } = await ownedRunningOperation();
    const decision = await requestOperationPause(root, operationId, "human:control-center:test");
    expect(decision.kind).toBe("PAUSE");
    expect(decision.purpose).toEqual({ kind: "OPERATION_CONTROL", command: "PAUSE" });

    const receipt = quiescent();
    const paused = await pauseOperationIfRequested(root, operationId, receipt);
    expect(paused.phase).toBe("PAUSED");
    expect(paused.pause).toMatchObject({
      version: 1,
      state: "PAUSED",
      resumePhase: "spec-authoring",
      requestedBy: "human:control-center:test",
      drainReceipt: { activeParticipantIds: [], activeProviderLeaseIds: [] }
    });
    expect(paused.pause?.requiredRevalidation).toEqual(["candidate-current", "operation-revision-current", "policy-current", "controller-epoch-current", "continuation-current"]);

    const replay = await pauseOperationIfRequested(root, operationId, quiescent());
    expect(replay.phase).toBe("PAUSED");
    await expect(ledger(root).consumeExact(
      { operationId: decision.operationId, candidate: decision.candidate, operationExecutionRevision: decision.operationExecutionRevision, policyDigest: decision.policyDigest, controllerEpoch: decision.controllerEpoch },
      decision.purpose,
      decision.decisionId,
      decision.actorId
    )).rejects.toThrow(/already been consumed or replayed/);
  });

  it("defers PAUSED while a mutable writer is still active", async () => {
    const { root, operationId } = await ownedRunningOperation();
    await requestOperationPause(root, operationId, "human:control-center:test");
    const deferred = await pauseOperationIfRequested(root, operationId, { ...quiescent(), activeParticipantIds: ["participant:writer"] });
    expect(deferred.phase).toBe("spec-authoring");
    expect(deferred.pause).toBeUndefined();

    const applied = await pauseOperationIfRequested(root, operationId, quiescent());
    expect(applied.phase).toBe("PAUSED");
  });

  it("resumes only with a current scoped RESUME control and restores the saved phase", async () => {
    const { root, operationId } = await ownedRunningOperation();
    await expect(requestOperationResume(root, operationId, "human:control-center:test")).rejects.toThrow(/only a PAUSED operation can be resumed/);
    await requestOperationPause(root, operationId, "human:control-center:test");
    await pauseOperationIfRequested(root, operationId, quiescent());

    const resumeDecision = await requestOperationResume(root, operationId, "human:control-center:test");
    const resumed = await awaitOperationResume(root, operationId, { pollMs: 5 });
    expect(resumed.phase).toBe("spec-authoring");
    expect(resumed.pause).toBeUndefined();
    await expect(ledger(root).consumeExact(
      { operationId: resumeDecision.operationId, candidate: resumeDecision.candidate, operationExecutionRevision: resumeDecision.operationExecutionRevision, policyDigest: resumeDecision.policyDigest, controllerEpoch: resumeDecision.controllerEpoch },
      resumeDecision.purpose,
      resumeDecision.decisionId,
      resumeDecision.actorId
    )).rejects.toThrow(/already been consumed or replayed/);
  });

  it("fails closed when a stale control no longer matches the current identity", async () => {
    const { root, operationId } = await ownedRunningOperation();
    const stalePause = await requestOperationPause(root, operationId, "human:control-center:test");
    const takeover = await claimControllerEpoch(root, operationId, "controller:test:takeover", { pid: process.pid });
    expect(takeover.controller?.epoch).toBeGreaterThan(stalePause.controllerEpoch);
    const record = await loadOperation(root, operationId);
    expect(record.resolvedOperationPolicy).toBeUndefined();
    expect(record.pause).toBeUndefined();
    const attempted = await pauseOperationIfRequested(root, operationId, quiescent());
    expect(attempted.phase).toBe("spec-authoring");
  });

  it("rebinds a recovered PAUSED record to the current controller identity", async () => {
    const { root, operationId } = await ownedRunningOperation();
    await requestOperationPause(root, operationId, "human:control-center:test");
    const paused = await pauseOperationIfRequested(root, operationId, quiescent());
    const takeover = await claimControllerEpoch(root, operationId, "controller:test:recovery", { pid: process.pid });
    const candidate = takeover.candidateRevision!;
    await bindResolvedOperationPolicy(root, operationId, compileResolvedOperationPolicy({
      projectId: candidate.projectId ?? "project:test",
      operationId,
      operationExecutionRevision: takeover.operationExecutionRevision!,
      candidateRevision: candidate.revision,
      candidateDigest: candidate.identityDigest,
      controllerEpoch: takeover.controller?.epoch ?? 1,
      intent: "pause/resume recovery",
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
      humanDecisionRequirements: []
    }));
    const rebound = await rebindPauseRecordToCurrentIdentity(root, operationId);
    expect(rebound.phase).toBe("PAUSED");
    expect(rebound.pause?.controllerEpoch).toBe(takeover.controller?.epoch);
    expect(rebound.pause?.policyDigest).toBe(rebound.resolvedOperationPolicy?.digest);
    expect(rebound.pause?.pausedAt).toBe(paused.pause?.pausedAt);
  });

  it("clears the pause record when a paused operation is cancelled", async () => {
    const { root, operationId } = await ownedRunningOperation();
    await requestOperationPause(root, operationId, "human:control-center:test");
    await pauseOperationIfRequested(root, operationId, quiescent());
    const cancelled = await transitionOperationToTerminal(root, operationId, { status: "CANCELLED", phase: "cancelled", finishedAt: new Date().toISOString() });
    expect(cancelled.transitioned).toBe(true);
    expect(cancelled.record.status).toBe("CANCELLED");
    expect(cancelled.record.pause).toBeUndefined();
  });
});
