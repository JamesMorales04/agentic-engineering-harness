import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import { cancelOperation, executeOperation } from "../src/operations/controller.js";
import { notifyOperationCompletion, operationCompletionFile, registerOperationCompletionTarget } from "../src/operations/completion.js";
import {
  acknowledgeOperationLead,
  bindOperationLead,
  bindResolvedOperationPolicy,
  claimControllerEpoch,
  currentControllerEpoch,
  loadOperation,
  markTerminalDelivered,
  registerSupervisorGeneration,
  saveOperation,
  transitionOperationToTerminal,
  updateOperationParticipant,
  updateSupervisorGeneration,
  type OperationRecordV2
} from "../src/operations/state.js";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { HumanDecisionLedgerV2 } from "../src/security/humanDecision.js";
import { createManagedRuntime, runtimeProjectId } from "../src/runtime/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-lifecycle-regression-"));
  roots.push(root);
  return root;
}

function operation(root: string, id = "AUDIT-LIFECYCLE"): OperationRecordV2 {
  const now = new Date().toISOString();
  return {
    version: 2,
    id,
    kind: "audit",
    status: "RUNNING",
    phase: "reviewing",
    root,
    payload: { request: "lifecycle regression" },
    revision: 1,
    createdAt: now,
    updatedAt: now,
    lastProgressAt: now,
    supervision: { required: true, materialized: false, generations: [] },
    stages: {},
    participants: {},
    progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 }
  };
}

async function bindCancellationDecision(root: string, operationId: string, actorId: string): Promise<void> {
  const current = await loadOperation(root, operationId);
  const candidate = current.candidateRevision!;
  const policy = compileResolvedOperationPolicy({
    projectId: candidate.projectId!, operationId,
    operationExecutionRevision: current.operationExecutionRevision!,
    candidateRevision: candidate.revision,
    candidateDigest: candidate.identityDigest,
    controllerEpoch: currentControllerEpoch(current),
    intent: "lifecycle cancellation test", route: "DIRECT", minimumAssurance: "STANDARD",
    policyVersions: { resolvedOperationPolicy: "1" }, policyDigests: {}, validationPolicy: {}, reviewPolicy: {}, deliveryPolicy: {}, knowledgePolicy: {}, contextPolicy: {},
    allowedExternalEffects: [], humanDecisionRequirements: []
  });
  const bound = await bindResolvedOperationPolicy(root, operationId, policy);
  const ledger = new HumanDecisionLedgerV2(path.join(root, ".harness", "security", "human-decisions.json"));
  await ledger.record({
    operationId, candidate, operationExecutionRevision: bound.operationExecutionRevision!, policyDigest: policy.digest,
    controllerEpoch: currentControllerEpoch(bound), purpose: { kind: "OPERATION_CONTROL", command: "CANCEL" }, kind: "CANCEL",
    actorId, reason: "explicit cancellation test request", createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000)
  });
}

describe("operation lifecycle regressions", () => {
  it.each(["SUCCEEDED", "FAILED"] as const)("does not re-enter a %s operation", async (status) => {
    const root = await tempRoot();
    const record = operation(root, `TERMINAL-${status}`);
    await saveOwnedOperation(root, record);
    const terminal = await transitionOperationToTerminal(root, record.id, { status, phase: status.toLowerCase() });

    const runAudit = vi.fn();
    const result = await executeOperation(root, record.id, { runAudit: runAudit as never });

    expect(result.status).toBe(status);
    expect(runAudit).not.toHaveBeenCalled();
    expect((await loadOperation(root, record.id)).revision).toBe(terminal.record.revision);
  });

  it("restores operation routing environment after an in-process terminal read", async () => {
    const root = await tempRoot();
    const record = operation(root, "TERMINAL-ENV-RESTORE");
    const keys = [
      "AEH_CONTROL_ROOT",
      "AEH_OPERATION_ID",
      "AEH_OPERATION_KIND",
      "AEH_OPERATION_STATE_REDIRECT",
      "AEH_OPERATION_WORKSPACE_ID"
    ] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      for (const key of keys) delete process.env[key];
      await saveOperation(root, record);
      await claimControllerEpoch(root, record.id, `controller:test:${record.id}`);
      await transitionOperationToTerminal(root, record.id, { status: "SUCCEEDED", phase: "finished" });

      process.env.AEH_CONTROL_ROOT = "/tmp/aeh-stale-control-root";
      process.env.AEH_OPERATION_ID = "STALE-OPERATION";
      process.env.AEH_OPERATION_KIND = "audit";
      process.env.AEH_OPERATION_STATE_REDIRECT = "1";
      process.env.AEH_OPERATION_WORKSPACE_ID = "stale-workspace";

      const result = await executeOperation(root, record.id, { runAudit: vi.fn() as never });
      expect(result.status).toBe("SUCCEEDED");
      expect(Object.fromEntries(keys.map((key) => [key, process.env[key]]))).toEqual({
        AEH_CONTROL_ROOT: "/tmp/aeh-stale-control-root",
        AEH_OPERATION_ID: "STALE-OPERATION",
        AEH_OPERATION_KIND: "audit",
        AEH_OPERATION_STATE_REDIRECT: "1",
        AEH_OPERATION_WORKSPACE_ID: "stale-workspace"
      });
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("preserves the first terminal participant state and settles nonterminal participants", async () => {
    const root = await tempRoot();
    const record = operation(root);
    await saveOwnedOperation(root, record);
    await updateOperationParticipant(root, record.id, "worker-1", { status: "RUNNING" });
    await updateOperationParticipant(root, record.id, "worker-1", { status: "COMPLETED" });
    const preserved = await updateOperationParticipant(root, record.id, "worker-1", { status: "FAILED" });
    expect(preserved.participants["worker-1"]?.status).toBe("COMPLETED");

    await updateOperationParticipant(root, record.id, "worker-2", { status: "RUNNING" });
    const terminal = await transitionOperationToTerminal(root, record.id, { status: "FAILED", phase: "failed" });
    expect(terminal.record.participants["worker-2"]).toEqual(expect.objectContaining({ status: "FAILED", finishedAt: expect.any(String) }));
    expect(terminal.record.progress.running).toBe(0);
  });

  it("includes supervisor generations in cancellation cleanup", async () => {
    const root = await tempRoot();
    const record = operation(root, "CANCEL-CLEANUP");
    record.agents = [{ id: "worker-1", role: "reviewer", registeredAt: new Date().toISOString() }];
    await saveOwnedOperation(root, record);
    await bindCancellationDecision(root, record.id, "human:lifecycle-cancel-test");
    await registerSupervisorGeneration(root, record.id, { agentId: "supervisor-1", materialized: true });

    const run = vi.fn(async () => ({ exitCode: 0, stdout: "stopped", stderr: "", durationMs: 1 }));
    await cancelOperation(root, record.id, { run: run as never, trace: vi.fn(async () => undefined) as never, notifyCompletion: vi.fn(async () => undefined), humanActorId: "human:lifecycle-cancel-test" });

    expect(run.mock.calls.map(([command]) => String(command))).toEqual(expect.arrayContaining([
      "paseo stop 'worker-1'",
      "paseo stop 'supervisor-1'"
    ]));
    const current = await loadOperation(root, record.id);
    expect(current.status).toBe("CANCELLED");
  });

  it("releases an operation provider lease only after the current cancellation observes the session quiescent", async () => {
    const root = await tempRoot();
    const record = operation(root, "CANCEL-PROVIDER-LEASE");
    record.agents = [{ id: "provider-agent-1", role: "reviewer", registeredAt: new Date().toISOString() }];
    await saveOwnedOperation(root, record);
    await bindCancellationDecision(root, record.id, "human:lifecycle-cancel-test");
    const current = await loadOperation(root, record.id);
    const runtime = await createManagedRuntime({ root, projectId: runtimeProjectId(root), ownerId: `provider-controller:${record.id}:${current.controller!.epoch}` });
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
        sessionId: "provider-agent-1",
        providerStatus: "ACTIVE"
      }
    });
    let providerStatus = "working";
    const run = vi.fn(async () => {
      providerStatus = "idle";
      return { exitCode: 0, stdout: "stopped", stderr: "", durationMs: 1 };
    });

    const cancelled = await cancelOperation(root, record.id, {
      run: run as never,
      trace: vi.fn(async () => undefined) as never,
      humanActorId: "human:lifecycle-cancel-test",
      inspectProviderSession: async (_cwd, provider, sessionId) => provider === "opencode" && sessionId === "provider-agent-1" ? { status: providerStatus } : undefined
    });

    expect(cancelled.status).toBe("CANCELLED");
    expect(run.mock.calls.map(([command]) => String(command))).toContain("paseo stop 'provider-agent-1'");
    const snapshot = await (await createManagedRuntime({ root, projectId: runtimeProjectId(root), ownerId: "observer" })).snapshot();
    expect(snapshot.providerLeases.some((item) => item.leaseId === lease.leaseId)).toBe(false);
  });

  it("drains active supervisor generations when the operation terminalizes", async () => {
    const root = await tempRoot();
    const record = operation(root, "TERMINAL-SUPERVISOR");
    await saveOwnedOperation(root, record);
    await registerSupervisorGeneration(root, record.id, { agentId: "supervisor-1", materialized: true });
    const current = await loadOperation(root, record.id);
    const generation = current.supervision.generations[0]!.generation;
    await updateSupervisorGeneration(root, record.id, generation, { status: "ACTIVE" });

    const terminal = await transitionOperationToTerminal(root, record.id, { status: "SUCCEEDED", phase: "finished" });
    expect(terminal.record.supervision.activeGeneration).toBeUndefined();
    expect(terminal.record.supervision.generations[0]).toEqual(expect.objectContaining({ status: "DRAINING", drainingAt: expect.any(String) }));
  });

  it("keeps concurrent supervisor activations single-active", async () => {
    const root = await tempRoot();
    const record = operation(root, "SUPERVISOR-ACTIVE-RACE");
    await saveOwnedOperation(root, record);
    await registerSupervisorGeneration(root, record.id, { agentId: "supervisor-1", materialized: true });
    await registerSupervisorGeneration(root, record.id, { agentId: "supervisor-2", materialized: true, status: "INITIALIZING" });
    await registerSupervisorGeneration(root, record.id, { agentId: "supervisor-3", materialized: true, status: "INITIALIZING" });

    await Promise.all([
      updateSupervisorGeneration(root, record.id, 2, { status: "ACTIVE" }),
      updateSupervisorGeneration(root, record.id, 3, { status: "ACTIVE" })
    ]);
    const current = await loadOperation(root, record.id);
    const active = current.supervision.generations.filter((generation) => generation.status === "ACTIVE");
    expect(active).toHaveLength(1);
    expect(current.supervision.activeGeneration).toBe(active[0]?.generation);
  });

  it("repairs primary notification state when a SENT completion sidecar is found", async () => {
    const root = await tempRoot();
    const record = operation(root, "COMPLETION-REPAIR");
    await saveOwnedOperation(root, record);
    await bindOperationLead(root, record.id, "lead-1", "test");
    const terminal = await transitionOperationToTerminal(root, record.id, { status: "SUCCEEDED", phase: "finished" });
    await registerOperationCompletionTarget(root, record.id, "lead-1", "test", vi.fn(async () => undefined));
    await fs.writeFile(operationCompletionFile(root, record.id), `${JSON.stringify({ version: 1, operationId: record.id, agentId: "lead-1", source: "test", status: "SENT", registeredAt: new Date().toISOString(), attempts: 1, sentAt: new Date().toISOString() })}\n`);

    const dispatch = vi.fn(async () => ({ exitCode: 0, stdout: "unexpected", stderr: "", status: "working", transport: "sdk" as const }));
    await notifyOperationCompletion(root, terminal.record, { dispatch: dispatch as never, trace: vi.fn(async () => undefined) as never });

    expect(dispatch).not.toHaveBeenCalled();
    expect((await loadOperation(root, record.id)).notification.terminalDelivered).toBe(true);
  });

  it("preserves acknowledgement while terminal delivery metadata is updated", async () => {
    const root = await tempRoot();
    const record = operation(root, "ACK-METADATA-RACE");
    await saveOwnedOperation(root, record);
    await bindOperationLead(root, record.id, "lead-1", "test");
    const terminal = await transitionOperationToTerminal(root, record.id, { status: "SUCCEEDED", phase: "finished" });

    await Promise.all([
      acknowledgeOperationLead(root, record.id, terminal.record.revision, "lead-1", currentControllerEpoch(terminal.record), "test"),
      markTerminalDelivered(root, record.id, 1)
    ]);
    const current = await loadOperation(root, record.id);
    expect(current.lead?.acknowledgedRevision).toBe(current.revision);
    expect(current.notification.terminalDelivered).toBe(true);
  });
});
