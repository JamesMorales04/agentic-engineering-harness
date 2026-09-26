import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileExecutionBinding, compileResolvedOperationPolicy, type ExecutionBindingV2, type ResolvedOperationPolicyV1 } from "../src/architecture/executionIdentity.js";
import { sha256Canonical, sha256Utf8 } from "../src/core/digest.js";
import {
  bindOperationLead,
  bindOperationParticipantExecution,
  bindResolvedOperationPolicy,
  claimControllerEpoch,
  currentControllerEpoch,
  loadOperation,
  registerOperationAgent,
  type OperationRecordV2
} from "../src/operations/state.js";
import {
  ManagedRuntimeSupervisorV1,
  RuntimeOwnershipError,
  createManagedRuntime,
  readManagedRuntimeSnapshot,
  runWithOperationProviderLease,
  runtimeProjectId,
  type OperationProviderLifecycleInputV1,
  type ProviderLeaseLifecycleIdentityV1,
  type ProviderLeaseV1
} from "../src/runtime/index.js";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";

const ENV_KEYS = [
  "AEH_OPERATION_ID",
  "AEH_OPERATION_KIND",
  "AEH_OPERATION_WORKSPACE_ID",
  "AEH_CONTROL_ROOT",
  "AEH_OPERATION_STATE_REDIRECT",
  "AEH_CONTROLLER_TOKEN",
  "AEH_CONTROLLER_EPOCH"
] as const;

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const roots: string[] = [];
let operationSequence = 0;

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

interface LeaseFixture {
  root: string;
  operationId: string;
  participantId: string;
  provider: string;
  workspaceId: string;
  operation: OperationRecordV2;
  policy: ResolvedOperationPolicyV1;
  binding: ExecutionBindingV2;
}

type LeaseInputOverrides = Partial<Omit<OperationProviderLifecycleInputV1, "inspect" | "stop">> & Pick<OperationProviderLifecycleInputV1, "inspect" | "stop">;

function compilePolicy(operation: OperationRecordV2): ResolvedOperationPolicyV1 {
  const candidate = operation.candidateRevision;
  if (!candidate) throw new Error("provider lease fixture requires a candidate revision");
  return compileResolvedOperationPolicy({
    projectId: candidate.projectId!,
    operationId: operation.id,
    operationExecutionRevision: operation.operationExecutionRevision!,
    candidateRevision: candidate.revision,
    candidateDigest: candidate.identityDigest,
    controllerEpoch: currentControllerEpoch(operation),
    intent: "provider lease lifecycle test",
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
}

function compileBinding(input: {
  operation: OperationRecordV2;
  participantId: string;
  policy: ResolvedOperationPolicyV1;
  sessionId: string;
  operationExecutionRevision?: number;
}): ExecutionBindingV2 {
  const candidate = input.operation.candidateRevision;
  if (!candidate) throw new Error("provider lease fixture requires a candidate revision");
  const digest = (label: string) => sha256Canonical({ label, operationId: input.operation.id, participantId: input.participantId });
  return compileExecutionBinding({
    operationId: input.operation.id,
    operationExecutionRevision: input.operationExecutionRevision ?? input.operation.operationExecutionRevision!,
    candidateRevision: candidate.revision,
    candidateDigest: candidate.identityDigest,
    controllerEpoch: currentControllerEpoch(input.operation),
    executionBlueprintDigest: digest("blueprint"),
    operationPolicyDigest: input.policy.digest,
    participantId: input.participantId,
    participantGeneration: "generation:1",
    roleInvocationPolicyDigest: digest("role-policy"),
    skillManifestDigest: digest("skills"),
    runtime: { runtimeId: "paseo", provider: "paseo", modelId: "test-model", model: "test-model", sessionId: input.sessionId },
    contextManifestDigest: digest("context"),
    promptManifestDigest: digest("prompt"),
    outputContract: "implementer",
    leaseIdentities: []
  });
}

async function createFixture(options: { sessionId?: string } = {}): Promise<LeaseFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-provider-lease-"));
  roots.push(root);
  const operationId = `RUN-PROVIDER-LEASE-${++operationSequence}`;
  const participantId = "participant:implementer";
  const now = new Date().toISOString();
  await saveOwnedOperation(root, {
    version: 1,
    id: operationId,
    kind: "run",
    status: "RUNNING",
    phase: "implement",
    root,
    payload: { taskId: "TASK-PROVIDER-LEASE" },
    createdAt: now,
    updatedAt: now,
    operationExecutionRevision: 1
  } as never);
  await registerOperationAgent(root, operationId, { id: participantId, logicalAgent: "implementer", role: "Implementer", phase: "implement" });
  let operation = await loadOperation(root, operationId);
  const policy = compilePolicy(operation);
  operation = await bindResolvedOperationPolicy(root, operationId, policy);
  const binding = compileBinding({ operation, participantId, policy, sessionId: options.sessionId ?? "paseo-session-provider-lease" });
  operation = await bindOperationParticipantExecution(root, operationId, { participantId, logicalAgent: "implementer", role: "Implementer", binding });
  return { root, operationId, participantId, provider: "paseo", workspaceId: "workspace:provider-lease", operation, policy, binding };
}

function leaseInput(fixture: LeaseFixture, overrides: LeaseInputOverrides): OperationProviderLifecycleInputV1 {
  return {
    root: fixture.root,
    provider: fixture.provider,
    workspaceId: fixture.workspaceId,
    operationId: fixture.operationId,
    participantId: fixture.participantId,
    ...overrides
  };
}

async function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
}

async function claimNewEpoch(fixture: LeaseFixture): Promise<{ priorEpoch: number; currentEpoch: number }> {
  const priorEpoch = currentControllerEpoch(await loadOperation(fixture.root, fixture.operationId));
  await claimControllerEpoch(fixture.root, fixture.operationId, "controller:provider-lease-takeover");
  let operation = await loadOperation(fixture.root, fixture.operationId);
  const policy = compilePolicy(operation);
  operation = await bindResolvedOperationPolicy(fixture.root, fixture.operationId, policy);
  return { priorEpoch, currentEpoch: currentControllerEpoch(operation) };
}

async function seedPriorLease(fixture: LeaseFixture, options: {
  ownerEpoch: number;
  lifecycleEpoch: number;
  sessionId: string;
  lifecycle?: Partial<ProviderLeaseLifecycleIdentityV1>;
}): Promise<ProviderLeaseV1> {
  const operation = await loadOperation(fixture.root, fixture.operationId);
  const runtime = await createManagedRuntime({
    root: fixture.root,
    projectId: runtimeProjectId(fixture.root),
    ownerId: `provider-controller:${fixture.operationId}:${options.ownerEpoch}`
  });
  return runtime.acquireProviderLease({
    provider: fixture.provider,
    workspaceId: fixture.workspaceId,
    mode: "write",
    lifecycle: {
      operationId: fixture.operationId,
      candidateDigest: operation.candidateRevision!.identityDigest,
      operationExecutionRevision: operation.operationExecutionRevision!,
      policyDigest: operation.resolvedOperationPolicy?.digest ?? fixture.policy.digest,
      controllerTokenDigest: sha256Utf8(`provider-lease-prior-controller-token:${options.lifecycleEpoch}`),
      controllerEpoch: options.lifecycleEpoch,
      participantId: fixture.participantId,
      sessionId: options.sessionId,
      providerStatus: "ACTIVE",
      ...options.lifecycle
    }
  });
}

describe("runWithOperationProviderLease fault-injection", () => {
  it("serializes overlapping writes from the same operation controller and actor", async () => {
    const fixture = await createFixture({ sessionId: "session-single-writer" });
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<{ value: string; sessionId?: string }>();
    const first = settle(runWithOperationProviderLease(leaseInput(fixture, {
      sessionId: "session-single-writer",
      renewEveryMs: 3_600_000,
      inspect: async () => ({ status: "idle" }),
      stop: vi.fn(async () => undefined)
    }), async () => {
      started.resolve();
      return gate.promise;
    }));
    await started.promise;

    const secondAction = vi.fn(async () => ({ value: "must-not-run", sessionId: "session-single-writer" }));
    await expect(runWithOperationProviderLease(leaseInput(fixture, {
      sessionId: "session-single-writer",
      renewEveryMs: 3_600_000,
      inspect: async () => ({ status: "idle" }),
      stop: vi.fn(async () => undefined)
    }), secondAction)).rejects.toThrow("PASEO_PROVIDER_LEASE_TAKEOVER_BLOCKED");
    expect(secondAction).not.toHaveBeenCalled();

    gate.resolve({ value: "single-writer-turn-settled", sessionId: "session-single-writer" });
    await expect(first).resolves.toMatchObject({ ok: true, value: "single-writer-turn-settled" });
    expect(await readManagedRuntimeSnapshot(fixture.root)).toMatchObject({ providerLeases: [] });
  });

  it("binds an operation-owned Lead turn to the current Lead generation and rejects stale generations", async () => {
    const fixture = await createFixture({ sessionId: "lead-session" });
    const lead = await bindOperationLead(fixture.root, fixture.operationId, "lead-agent-1", "packed-lifecycle-test");
    const inspect = vi.fn(async (sessionId: string) => ({ status: sessionId === "lead-session" ? "idle" : "working" }));
    let acquired: ProviderLeaseV1 | undefined;
    const value = await runWithOperationProviderLease(leaseInput(fixture, {
      participantId: undefined,
      leadAgentId: "lead-agent-1",
      leadGeneration: lead.lead!.generation,
      sessionId: "lead-session",
      inspect,
      stop: vi.fn(async () => undefined)
    }), async () => {
      acquired = (await readManagedRuntimeSnapshot(fixture.root)).providerLeases[0];
      return { value: "lead-turn-settled", sessionId: "lead-session" };
    });

    expect(value).toBe("lead-turn-settled");
    expect(acquired?.lifecycle).toMatchObject({
      operationId: fixture.operationId,
      leadAgentId: "lead-agent-1",
      leadGeneration: lead.lead!.generation,
      sessionId: "lead-session",
      providerStatus: "ACTIVE"
    });
    expect(acquired?.lifecycle?.participantId).toBeUndefined();
    expect(inspect).toHaveBeenCalledWith("lead-session");
    const action = vi.fn(async () => ({ value: "must-not-run", sessionId: "lead-session" }));
    await expect(runWithOperationProviderLease(leaseInput(fixture, {
      participantId: undefined,
      leadAgentId: "lead-agent-1",
      leadGeneration: lead.lead!.generation + 1,
      sessionId: "lead-session",
      inspect,
      stop: vi.fn(async () => undefined)
    }), action)).rejects.toThrow("PASEO_PROVIDER_LEASE_LEAD_BINDING_STALE");
    expect(action).not.toHaveBeenCalled();
    expect((await readManagedRuntimeSnapshot(fixture.root)).providerLeases).toEqual([]);
  });

  it("acquires a durable write lease, renews it while the turn is pending, and releases it exactly once after the settled turn", async () => {
    const fixture = await createFixture({ sessionId: "session-alpha" });
    const releaseSpy = vi.spyOn(ManagedRuntimeSupervisorV1.prototype, "releaseProviderLease");
    const originalRenew = ManagedRuntimeSupervisorV1.prototype.renewProviderLease;
    const renewed = Promise.withResolvers<void>();
    const renewSpy = vi.spyOn(ManagedRuntimeSupervisorV1.prototype, "renewProviderLease").mockImplementation(async function (this: ManagedRuntimeSupervisorV1, leaseId: string, ttlMs?: number) {
      const result = await originalRenew.call(this, leaseId, ttlMs);
      renewed.resolve();
      return result;
    });
    vi.useFakeTimers();
    try {
      const ttlMs = 60_000;
      const renewEveryMs = 1_000;
      let initialLease: ProviderLeaseV1 | undefined;
      let renewedLease: ProviderLeaseV1 | undefined;
      const inspections: string[] = [];
      const stops: string[] = [];
      const outcome = await settle(runWithOperationProviderLease(leaseInput(fixture, {
        sessionId: "session-alpha",
        executionBinding: fixture.binding,
        ttlMs,
        renewEveryMs,
        inspect: async (sessionId) => { inspections.push(sessionId); return { status: "idle" }; },
        stop: async (sessionId) => { stops.push(sessionId); }
      }), async () => {
        initialLease = (await readManagedRuntimeSnapshot(fixture.root)).providerLeases[0];
        await vi.advanceTimersByTimeAsync(renewEveryMs);
        await renewed.promise;
        renewedLease = (await readManagedRuntimeSnapshot(fixture.root)).providerLeases[0];
        return { value: "provider-turn-settled", sessionId: "session-alpha" };
      }));

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.value).toBe("provider-turn-settled");
      expect(initialLease).toBeDefined();
      expect(renewedLease).toBeDefined();
      expect(initialLease!.mode).toBe("write");
      expect(initialLease!.provider).toBe(fixture.provider);
      expect(initialLease!.workspaceId).toBe(fixture.workspaceId);
      expect(initialLease!.ownerId).toMatch(new RegExp(`^provider-controller:${fixture.operationId}:${currentControllerEpoch(fixture.operation)}:provider-session:`));
      expect(initialLease!.lifecycle).toEqual({
        operationId: fixture.operationId,
        candidateDigest: fixture.operation.candidateRevision!.identityDigest,
        operationExecutionRevision: fixture.operation.operationExecutionRevision,
        policyDigest: fixture.policy.digest,
        controllerTokenDigest: sha256Utf8(process.env.AEH_CONTROLLER_TOKEN!),
        controllerEpoch: currentControllerEpoch(fixture.operation),
        participantId: fixture.participantId,
        participantGeneration: "generation:1",
        sessionId: "session-alpha",
        executionBindingDigest: fixture.binding.digest,
        providerStatus: "ACTIVE"
      });
      expect(Date.parse(renewedLease!.expiresAt)).toBeGreaterThan(Date.parse(initialLease!.expiresAt));
      expect(renewedLease!.lifecycle).toEqual(initialLease!.lifecycle);
      expect(renewSpy).toHaveBeenCalled();
      expect(stops).toEqual([]);
      expect(inspections).toEqual(["session-alpha"]);
      expect((await readManagedRuntimeSnapshot(fixture.root)).providerLeases).toEqual([]);
      expect(releaseSpy).toHaveBeenCalledTimes(1);
      expect(releaseSpy).toHaveBeenCalledWith(initialLease!.leaseId);
      const durable = await loadOperation(fixture.root, fixture.operationId);
      expect(durable.participants[fixture.participantId]!.executionBinding!.digest).toBe(fixture.binding.digest);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fences a resolved provider result and keeps the lease durable when renewal fails after the controller epoch changes", async () => {
    const fixture = await createFixture({ sessionId: "session-beta" });
    const releaseSpy = vi.spyOn(ManagedRuntimeSupervisorV1.prototype, "releaseProviderLease");
    const preClaimEpoch = currentControllerEpoch(fixture.operation);
    vi.useFakeTimers();
    try {
      const started = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<{ value: string; sessionId?: string }>();
      const inspections: string[] = [];
      const outcomePromise = settle(runWithOperationProviderLease(leaseInput(fixture, {
        sessionId: "session-beta",
        ttlMs: 60_000,
        renewEveryMs: 1_000,
        inspect: async (sessionId) => { inspections.push(sessionId); return { status: "idle" }; },
        stop: async () => undefined
      }), async () => {
        started.resolve();
        return gate.promise;
      }));
      await started.promise;
      await claimControllerEpoch(fixture.root, fixture.operationId, "controller:lease-renewal-fence");
      await vi.advanceTimersByTimeAsync(1_000);
      gate.resolve({ value: "late-provider-result", sessionId: "session-beta" });
      const outcome = await outcomePromise;

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(String(outcome.error)).toContain("PASEO_PROVIDER_LEASE_RENEWAL_FAILED");
      expect(String(outcome.error)).toContain("provider result was fenced");
      expect(inspections).toEqual([]);
      const snapshot = await readManagedRuntimeSnapshot(fixture.root);
      expect(snapshot.providerLeases).toHaveLength(1);
      expect(snapshot.providerLeases[0]!.lifecycle).toMatchObject({ providerStatus: "ACTIVE", controllerEpoch: preClaimEpoch, sessionId: "session-beta" });
      expect(releaseSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a stale controller stop a provider session while handling a late provider error", async () => {
    const fixture = await createFixture({ sessionId: "session-stale-cleanup" });
    const inspections: string[] = [];
    const stops: string[] = [];
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<{ value: string; sessionId?: string }>();
    const outcomePromise = settle(runWithOperationProviderLease(leaseInput(fixture, {
      sessionId: "session-stale-cleanup",
      renewEveryMs: 3_600_000,
      inspect: async (sessionId) => { inspections.push(sessionId); return { status: "working" }; },
      stop: async (sessionId) => { stops.push(sessionId); }
    }), async () => {
      started.resolve();
      return gate.promise;
    }));

    await started.promise;
    await claimControllerEpoch(fixture.root, fixture.operationId, "controller:stale-provider-cleanup");
    gate.reject(new Error("provider call failed after controller takeover"));
    const outcome = await outcomePromise;

    expect(outcome.ok).toBe(false);
    expect(inspections).toEqual([]);
    expect(stops).toEqual([]);
    const snapshot = await readManagedRuntimeSnapshot(fixture.root);
    expect(snapshot.providerLeases).toHaveLength(1);
    expect(snapshot.providerLeases[0]!.lifecycle).toMatchObject({ providerStatus: "ACTIVE", sessionId: "session-stale-cleanup" });
  });

  it("keeps a timed-out session fenced as UNCERTAIN when inspection is unavailable and stop fails, blocking other owners", async () => {
    const fixture = await createFixture();
    const releaseSpy = vi.spyOn(ManagedRuntimeSupervisorV1.prototype, "releaseProviderLease");
    const inspections: string[] = [];
    const stops: string[] = [];
    const outcome = await settle(runWithOperationProviderLease(leaseInput(fixture, {
      sessionId: "session-uncertain",
      renewEveryMs: 3_600_000,
      inspect: async (sessionId) => { inspections.push(sessionId); return undefined; },
      stop: async (sessionId) => { stops.push(sessionId); throw new Error("PASEO_PROVIDER_STOP_FAILED: provider unavailable."); }
    }), async () => { throw new Error("PASEO_PROVIDER_TIMEOUT: provider turn timed out after 300s."); }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(String(outcome.error)).toContain("PASEO_PROVIDER_TIMEOUT");
    expect(inspections).toEqual(["session-uncertain"]);
    expect(stops).toEqual(["session-uncertain"]);
    expect(releaseSpy).not.toHaveBeenCalled();

    const snapshot = await readManagedRuntimeSnapshot(fixture.root);
    expect(snapshot.providerLeases).toHaveLength(1);
    expect(snapshot.providerLeases[0]!.lifecycle).toMatchObject({
      providerStatus: "UNCERTAIN",
      sessionId: "session-uncertain",
      controllerEpoch: currentControllerEpoch(fixture.operation)
    });

    const otherOwner = await createManagedRuntime({ root: fixture.root, projectId: runtimeProjectId(fixture.root), ownerId: "provider-controller:other-owner" });
    await expect(otherOwner.acquireProviderLease({ provider: fixture.provider, workspaceId: fixture.workspaceId, mode: "write" })).rejects.toThrow(RuntimeOwnershipError);
    expect((await readManagedRuntimeSnapshot(fixture.root)).providerLeases).toHaveLength(1);
  });

  it("blocks takeover of a prior lease while the exact prior session is observed non-quiescent", async () => {
    const fixture = await createFixture({ sessionId: "prior-session" });
    const priorEpoch = currentControllerEpoch(fixture.operation);
    const prior = await seedPriorLease(fixture, { ownerEpoch: priorEpoch, lifecycleEpoch: priorEpoch, sessionId: "prior-session" });
    await claimNewEpoch(fixture);
    const inspections: string[] = [];
    const stops: string[] = [];
    const outcome = await settle(runWithOperationProviderLease(leaseInput(fixture, {
      sessionId: "prior-session",
      renewEveryMs: 3_600_000,
      inspect: async (sessionId) => { inspections.push(sessionId); return { status: "running" }; },
      stop: async (sessionId) => { stops.push(sessionId); }
    }), async () => ({ value: "must-not-run", sessionId: "prior-session" })));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(String(outcome.error)).toContain("PASEO_PROVIDER_LEASE_TAKEOVER_BLOCKED");
    expect(inspections).toEqual(["prior-session", "prior-session"]);
    expect(stops).toEqual(["prior-session"]);
    const snapshot = await readManagedRuntimeSnapshot(fixture.root);
    expect(snapshot.providerLeases.map((lease) => lease.leaseId)).toEqual([prior.leaseId]);
    expect(snapshot.providerLeases[0]!.lifecycle).toMatchObject({ providerStatus: "ACTIVE", controllerEpoch: priorEpoch });
  });

  const takeoverPreconditionCases: Array<{
    label: string;
    inputSessionId: string;
    lifecycleEpoch: "prior" | "current";
    lifecycle: Partial<ProviderLeaseLifecycleIdentityV1>;
  }> = [
    { label: "the requested session differs from the prior lease session", inputSessionId: "different-session", lifecycleEpoch: "prior", lifecycle: {} },
    { label: "the prior lease controller epoch is not older", inputSessionId: "prior-session", lifecycleEpoch: "current", lifecycle: {} },
    { label: "the prior lease candidate digest differs", inputSessionId: "prior-session", lifecycleEpoch: "prior", lifecycle: { candidateDigest: "f".repeat(64) } }
  ];

  it.each(takeoverPreconditionCases)("blocks takeover before quiescence inspection when $label", async ({ inputSessionId, lifecycleEpoch, lifecycle }) => {
    const fixture = await createFixture({ sessionId: "prior-session" });
    const { priorEpoch, currentEpoch } = await claimNewEpoch(fixture);
    const prior = await seedPriorLease(fixture, {
      ownerEpoch: priorEpoch,
      lifecycleEpoch: lifecycleEpoch === "prior" ? priorEpoch : currentEpoch,
      sessionId: "prior-session",
      lifecycle
    });
    const inspections: string[] = [];
    const outcome = await settle(runWithOperationProviderLease(leaseInput(fixture, {
      sessionId: inputSessionId,
      renewEveryMs: 3_600_000,
      inspect: async (sessionId) => { inspections.push(sessionId); return { status: "idle" }; },
      stop: async () => undefined
    }), async () => ({ value: "must-not-run", sessionId: inputSessionId })));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(String(outcome.error)).toContain("PASEO_PROVIDER_LEASE_TAKEOVER_BLOCKED");
    expect(inspections).toEqual([]);
    const snapshot = await readManagedRuntimeSnapshot(fixture.root);
    expect(snapshot.providerLeases.map((lease) => lease.leaseId)).toEqual([prior.leaseId]);
  });

  it.each(["idle", "completed", "failed", "stopped"] as const)("completes takeover only after the exact prior session is observed $status", async (status) => {
    const fixture = await createFixture({ sessionId: "prior-session" });
    const { priorEpoch, currentEpoch } = await claimNewEpoch(fixture);
    const prior = await seedPriorLease(fixture, { ownerEpoch: priorEpoch, lifecycleEpoch: priorEpoch, sessionId: "prior-session" });
    const takeoverSpy = vi.spyOn(ManagedRuntimeSupervisorV1.prototype, "completeProviderLeaseTakeover");
    const inspections: string[] = [];
    const stops: string[] = [];
    const outcome = await settle(runWithOperationProviderLease(leaseInput(fixture, {
      sessionId: "prior-session",
      renewEveryMs: 3_600_000,
      inspect: async (sessionId) => { inspections.push(sessionId); return { status }; },
      stop: async (sessionId) => { stops.push(sessionId); }
    }), async () => ({ value: "taken-over", sessionId: "prior-session" })));

    expect(outcome).toEqual({ ok: true, value: "taken-over" });
    expect(stops).toEqual([]);
    expect(inspections).toEqual(["prior-session", "prior-session"]);
    expect(takeoverSpy).toHaveBeenCalledTimes(1);
    const [leaseId, takeoverLifecycle, quiescence] = takeoverSpy.mock.calls[0]!;
    expect(leaseId).toBe(prior.leaseId);
    expect(takeoverLifecycle).toMatchObject({ sessionId: "prior-session", controllerEpoch: currentEpoch });
    expect(quiescence).toMatchObject({ sessionId: "prior-session", status });
    expect((await readManagedRuntimeSnapshot(fixture.root)).providerLeases).toEqual([]);
  });

  it("rejects a stale ExecutionBinding before any lease is written", async () => {
    const fixture = await createFixture({ sessionId: "session-gamma" });
    const staleBinding = compileBinding({
      operation: fixture.operation,
      participantId: fixture.participantId,
      policy: fixture.policy,
      sessionId: "session-gamma",
      operationExecutionRevision: fixture.operation.operationExecutionRevision! + 1
    });
    const inspections: string[] = [];
    const stops: string[] = [];
    const outcome = await settle(runWithOperationProviderLease(leaseInput(fixture, {
      sessionId: staleBinding.runtime.sessionId,
      executionBinding: staleBinding,
      renewEveryMs: 3_600_000,
      inspect: async (sessionId) => { inspections.push(sessionId); return { status: "idle" }; },
      stop: async (sessionId) => { stops.push(sessionId); }
    }), async () => ({ value: "must-not-run", sessionId: staleBinding.runtime.sessionId })));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(String(outcome.error)).toContain("PASEO_PROVIDER_LEASE_EXECUTION_BINDING_STALE");
    expect(inspections).toEqual([]);
    expect(stops).toEqual([]);
    expect((await readManagedRuntimeSnapshot(fixture.root)).providerLeases).toEqual([]);
  });
});
