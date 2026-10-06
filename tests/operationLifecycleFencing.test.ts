import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import { evaluateOperationWake, operationLivenessPolicy, runOperationLivenessCheck } from "../src/operations/livenessV2.js";
import { cancelOperation } from "../src/operations/controller.js";
import {
  bindResolvedOperationPolicy,
  currentControllerEpoch,
  loadOperation,
  type OperationRecordV2,
} from "../src/operations/state.js";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { HumanDecisionLedgerV2 } from "../src/security/humanDecision.js";
import { createManagedRuntime, runtimeProjectId } from "../src/runtime/index.js";
import { recordOperationWakeAccepted } from "../src/operations/wakeBudget.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function runningOperation(root: string, id: string, lastProgressAt: string): OperationRecordV2 {
  const now = new Date().toISOString();
  return {
    version: 2,
    id,
    kind: "audit",
    status: "RUNNING",
    phase: "working",
    root,
    payload: { request: "lifecycle fencing repro" },
    revision: 1,
    createdAt: now,
    updatedAt: now,
    lastProgressAt,
    supervision: { required: false, materialized: false, generations: [] },
    stages: {},
    participants: {},
    progress: { expected: 1, registered: 1, running: 1, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 },
  } as OperationRecordV2;
}

const config = {
  version: 1,
  project: { name: "demo" },
  orchestration: { provider: "paseo" },
} as never;

describe("A4 wake-exhaustion hang", () => {
  it("routes exhausted stall budgets with a RUNNING stalled participant to a terminal bounded controller action", async () => {
    const now = Date.now();
    const old = new Date(now - 20 * 60_000).toISOString();
    const operation = runningOperation("/tmp", "AUDIT-A4-UNIT", old);
    (operation as any).participants = {
      "worker-1": {
        id: "worker-1",
        status: "RUNNING",
        registeredAt: old,
        startedAt: old,
        executionLiveness: {
          version: 1,
          state: "STALL_SUSPECTED",
          startedAt: old,
          lastActivityAt: old,
          lastMeaningfulProgressAt: old,
          toolCallsBeforeFirstMutation: 0,
          turnsBeforeFirstMutation: null,
          providerTurns: 1,
          currentProviderTurnBudget: 8,
          toolCallCount: 1,
          repositoryMutationCount: 0,
          artifactCount: 0,
          validationCount: 0,
          noProgressRenewals: 0,
          localRetryCount: 0,
          participantRestarts: 0,
        },
      },
    };
    const policy = operationLivenessPolicy(config, operation);
    expect(policy.supervisorStallWakeLimit).toBe(2);
    expect(policy.leadWakeLimit).toBe(1);
    const decision = evaluateOperationWake(operation, policy, now, 2, 1, 0);
    expect(decision.target).toBe("controller");
    expect(decision.reason).toBe("stalled");
    expect(decision.message).toContain("STALL_WAKE_EXHAUSTED");
  });

  it("keeps exhausted stall budgets without a stalled participant as no-action (existing hotfix behavior)", async () => {
    const now = Date.now();
    const old = new Date(now - 20 * 60_000).toISOString();
    const operation = runningOperation("/tmp", "AUDIT-A4-NOPART", old);
    const policy = operationLivenessPolicy(config, operation);
    const decision = evaluateOperationWake(operation, policy, now, 2, 1, 0);
    expect(decision.target).toBe("none");
  });

  it("fails the operation with STALL_WAKE_EXHAUSTED and forensics via the watchdog path", async () => {
    const root = await tempRoot("aeh-a4-watchdog-");
    const nowMs = Date.now();
    const old = new Date(nowMs - 20 * 60_000).toISOString();
    const record = runningOperation(root, "AUDIT-A4-WATCHDOG", old);
    (record as any).participants = {
      "worker-1": {
        id: "worker-1",
        status: "RUNNING",
        registeredAt: old,
        startedAt: old,
        executionLiveness: {
          version: 1,
          state: "STALL_SUSPECTED",
          startedAt: old,
          lastActivityAt: old,
          lastMeaningfulProgressAt: old,
          toolCallsBeforeFirstMutation: 0,
          turnsBeforeFirstMutation: null,
          providerTurns: 1,
          currentProviderTurnBudget: 8,
          toolCallCount: 1,
          repositoryMutationCount: 0,
          artifactCount: 0,
          validationCount: 0,
          noProgressRenewals: 0,
          localRetryCount: 0,
          participantRestarts: 0,
        },
      },
    };
    await saveOwnedOperation(root, record);
    const owned = await loadOperation(root, record.id);
    await recordOperationWakeAccepted(root, record.id, owned.revision, "supervisor", "stalled");
    await recordOperationWakeAccepted(root, record.id, owned.revision, "supervisor", "stalled");
    await recordOperationWakeAccepted(root, record.id, owned.revision, "lead", "stalled");
    const dispatch = vi.fn(async () => {
      throw new Error("dispatch must not be called after wake exhaustion");
    });
    const decision = await runOperationLivenessCheck(root, config, record.id, {
      dispatch: dispatch as never,
      inspect: (async () => ({ status: "idle" })) as never,
      trace: (async () => undefined) as never,
      now: () => nowMs,
      sleep: async () => undefined,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(decision.target).toBe("none");
    expect(decision.reason).toBe("terminal");
    expect(decision.message).toContain("STALL_WAKE_EXHAUSTED");
    const terminal = await loadOperation(root, record.id);
    expect(terminal.status).toBe("FAILED");
    expect(terminal.error).toContain("STALL_WAKE_EXHAUSTED");
    expect(terminal.result).toEqual(
      expect.objectContaining({ stallWakeExhausted: expect.objectContaining({ code: "STALL_WAKE_EXHAUSTED" }) }),
    );
  });
});

describe("A5 cancel fencing wedge", () => {
  async function bindCancellationDecision(root: string, operationId: string, actorId: string): Promise<void> {
    const current = await loadOperation(root, operationId);
    const candidate = current.candidateRevision!;
    const policy = compileResolvedOperationPolicy({
      projectId: candidate.projectId!,
      operationId,
      operationExecutionRevision: current.operationExecutionRevision!,
      candidateRevision: candidate.revision,
      candidateDigest: candidate.identityDigest,
      controllerEpoch: currentControllerEpoch(current),
      intent: "cancel fencing test",
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
    const bound = await bindResolvedOperationPolicy(root, operationId, policy);
    const ledger = new HumanDecisionLedgerV2(path.join(root, ".harness", "security", "human-decisions.json"));
    await ledger.record({
      operationId,
      candidate,
      operationExecutionRevision: bound.operationExecutionRevision!,
      policyDigest: policy.digest,
      controllerEpoch: currentControllerEpoch(bound),
      purpose: { kind: "OPERATION_CONTROL", command: "CANCEL" },
      kind: "CANCEL",
      actorId,
      reason: "explicit cancellation test request",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
  }

  it("terminalizes UNCERTAIN provider leases after bounded stop→inspect retries with a fenced-lease receipt and digest", async () => {
    const root = await tempRoot("aeh-a5-cancel-");
    const now = new Date().toISOString();
    const record: OperationRecordV2 = {
      version: 2,
      id: "AUDIT-A5-FENCING",
      kind: "audit",
      status: "RUNNING",
      phase: "reviewing",
      root,
      payload: { request: "cancel fencing" },
      revision: 1,
      createdAt: now,
      updatedAt: now,
      lastProgressAt: now,
      supervision: { required: true, materialized: false, generations: [] },
      stages: {},
      participants: {},
      progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
      notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 },
    };
    await saveOwnedOperation(root, record);
    await bindCancellationDecision(root, record.id, "human:cancel-fencing-test");
    const current = await loadOperation(root, record.id);
    const runtime = await createManagedRuntime({
      root,
      projectId: runtimeProjectId(root),
      ownerId: `provider-controller:${record.id}:${current.controller!.epoch}`,
    });
    const lease = await runtime.acquireProviderLease({
      provider: "opencode",
      workspaceId: "operation-ws",
      mode: "write",
      lifecycle: {
        operationId: current.id,
        candidateDigest: current.candidateRevision!.identityDigest,
        operationExecutionRevision: current.operationExecutionRevision!,
        policyDigest: current.resolvedOperationPolicy!.digest,
        controllerTokenDigest: current.controller!.tokenDigest!,
        controllerEpoch: current.controller!.epoch,
        participantId: "participant-cancel-test",
        sessionId: "sess-uncertain-1",
        providerStatus: "UNCERTAIN",
      },
    });
    const run = vi.fn(async () => ({ exitCode: 0, stdout: "stopped", stderr: "", durationMs: 1 }));
    const terminal = await cancelOperation(root, record.id, {
      run: run as never,
      trace: (async () => undefined) as never,
      notifyCompletion: (async () => undefined) as never,
      humanActorId: "human:cancel-fencing-test",
      inspectProviderSession: async () => ({ status: "uncertain" }),
    });
    const stopCalls = (run.mock.calls as unknown as Array<unknown[]>).filter(([command]) => String(command).includes("sess-uncertain-1"));
    expect(stopCalls).toHaveLength(3);
    expect(terminal.status).toBe("FAILED");
    expect(terminal.phase).toBe("UNCERTAIN_EXTERNAL_EFFECTS");
    expect(terminal.error).toContain("UNCERTAIN_EXTERNAL_EFFECTS");
    const receipt = (terminal.result as any)?.uncertainExternalEffects;
    expect(receipt).toEqual(
      expect.objectContaining({
        version: 1,
        kind: "cancellation-uncertain-external-effects",
        operationId: record.id,
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        leases: expect.arrayContaining([
          expect.objectContaining({ leaseId: lease.leaseId, sessionId: "sess-uncertain-1", observedStatus: "uncertain" }),
        ]),
      }),
    );
    expect(terminal.error).toContain(receipt.digest);
    expect(terminal.cleanupWarnings?.join("; ")).toContain("remains fenced");
    const snapshot = await (
      await createManagedRuntime({ root, projectId: runtimeProjectId(root), ownerId: "observer" })
    ).snapshot();
    expect(snapshot.providerLeases.some((item) => item.leaseId === lease.leaseId)).toBe(true);
  });
});
