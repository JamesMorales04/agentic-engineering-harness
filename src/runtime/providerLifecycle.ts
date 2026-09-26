import { randomUUID } from "node:crypto";
import { assertExecutionBindingV2, assertResolvedOperationPolicyV1, type ExecutionBindingV2 } from "../architecture/executionIdentity.js";
import { sha256Utf8 } from "../core/digest.js";
import {
  assertCurrentControllerOwner,
  controllerTokenFromEnvironment,
  currentControllerEpoch,
  currentOperationContext,
  loadOperation,
  type OperationRecordV2
} from "../operations/state.js";
import { createManagedRuntime, runtimeProjectId } from "./managed.js";
import type { ProviderLeaseLifecycleIdentityV1, ProviderLeaseQuiescenceV1 } from "./supervisorV2.js";

export interface ProviderSessionObservationV1 {
  status?: string;
}

export interface OperationProviderLifecycleInputV1 {
  root: string;
  provider: string;
  workspaceId: string;
  operationId: string;
  participantId?: string;
  supervisorAgentId?: string;
  leadAgentId?: string;
  leadGeneration?: number;
  sessionId?: string;
  executionBinding?: ExecutionBindingV2;
  ttlMs?: number;
  renewEveryMs?: number;
  inspect(sessionId: string): Promise<ProviderSessionObservationV1 | undefined>;
  stop(sessionId: string): Promise<void>;
  discoverSession?(): Promise<string | undefined>;
}

export interface OperationProviderActionResultV1<T> {
  value: T;
  sessionId?: string;
}

/**
 * Runs one real Paseo materialize/turn call under the current durable operation
 * owner. The managed lease serializes current-epoch writers and remains fenced
 * until the exact external session is observed idle or terminal.
 */
export async function runWithOperationProviderLease<T>(
  input: OperationProviderLifecycleInputV1,
  action: () => Promise<OperationProviderActionResultV1<T>>
): Promise<T> {
  const operationRoot = input.root;
  const initial = await requireCurrentOperation(input, operationRoot);
  const epoch = currentControllerEpoch(initial);
  const ownerId = `provider-controller:${initial.id}:${epoch}:${operationProviderReservationId()}`;
  const runtime = await createManagedRuntime({ root: operationRoot, projectId: runtimeProjectId(operationRoot), ownerId, leaseTtlMs: input.ttlMs });
  const identity = lifecycleIdentity(initial, input, input.sessionId);
  await takeOverPriorLeaseIfQuiescent(runtime, input, identity, ownerId);
  const lease = await runtime.acquireProviderLease({ provider: input.provider, workspaceId: input.workspaceId, mode: "write", ttlMs: input.ttlMs, lifecycle: identity });

  let renewalError: unknown;
  let renewalInFlight: Promise<void> | undefined;
  const renew = async () => {
    if (renewalInFlight || renewalError !== undefined) return;
    renewalInFlight = (async () => {
      const current = await requireCurrentOperation(input, operationRoot);
      assertSameIdentity(initial, current, input);
      await runtime.renewProviderLease(lease.leaseId, input.ttlMs);
    })().catch((error) => { renewalError = error; }).finally(() => { renewalInFlight = undefined; });
    await renewalInFlight;
  };
  const renewTimer = setInterval(() => { void renew(); }, input.renewEveryMs ?? Math.max(10, Math.floor((input.ttlMs ?? 60_000) / 3)));
  renewTimer.unref?.();

  let knownSessionId = input.sessionId;
  let returned = false;
  try {
    const actionResult = await action();
    returned = true;
    if (actionResult.sessionId) {
      if (knownSessionId && actionResult.sessionId !== knownSessionId) throw new Error("PASEO_PROVIDER_SESSION_IDENTITY_MISMATCH: provider lifecycle returned a different session than the current ExecutionBinding.");
      knownSessionId = actionResult.sessionId;
    }
    if (renewalInFlight) await renewalInFlight;
    if (renewalError !== undefined) throw new Error(`PASEO_PROVIDER_LEASE_RENEWAL_FAILED: ${String(renewalError)}`);
    const current = await requireCurrentOperation(input, operationRoot);
    assertSameIdentity(initial, current, input);
    await runtime.updateProviderLeaseLifecycle(lease.leaseId, { ...identity, ...(knownSessionId ? { sessionId: knownSessionId } : {}), providerStatus: "ACTIVE" });
    const quiescence = knownSessionId ? await stopAndObserveQuiescence(input, knownSessionId) : undefined;
    if (!quiescence) throw await fenceUncertainLease(runtime, input, lease.leaseId, identity, knownSessionId, "provider call returned without an observable quiescent session");
    const afterObservation = await requireCurrentOperation(input, operationRoot);
    assertSameIdentity(initial, afterObservation, input);
    await runtime.releaseProviderLease(lease.leaseId);
    return actionResult.value;
  } catch (error) {
    if (renewalInFlight) await renewalInFlight;
    if (renewalError === undefined) {
      const current = await requireCurrentOperation(input, operationRoot).catch(() => undefined);
      let stillOwner = false;
      if (current) {
        try {
          assertSameIdentity(initial, current, input);
          stillOwner = true;
        } catch { /* A stale owner must leave provider cleanup to the current controller. */ }
      }
      if (stillOwner) {
        if (!knownSessionId && input.discoverSession) knownSessionId = await input.discoverSession().catch(() => undefined);
        const quiescence = knownSessionId ? await stopAndObserveQuiescence(input, knownSessionId).catch(() => undefined) : undefined;
        if (quiescence) {
          const latest = await requireCurrentOperation(input, operationRoot).catch(() => undefined);
          if (latest) {
            try {
              assertSameIdentity(initial, latest, input);
              await runtime.releaseProviderLease(lease.leaseId);
            } catch { /* A stale owner leaves the lease for the current controller to reconcile. */ }
          }
        } else {
          await markLeaseUncertain(runtime, input, lease.leaseId, identity, knownSessionId);
        }
      }
    }
    if (returned && renewalError !== undefined) throw new Error(`PASEO_PROVIDER_LEASE_RENEWAL_FAILED: provider result was fenced because lease renewal failed: ${String(renewalError)}`, { cause: error });
    throw error;
  } finally {
    clearInterval(renewTimer);
  }
}

async function takeOverPriorLeaseIfQuiescent(
  runtime: Awaited<ReturnType<typeof createManagedRuntime>>,
  input: OperationProviderLifecycleInputV1,
  currentIdentity: ProviderLeaseLifecycleIdentityV1,
  currentOwnerId: string
): Promise<void> {
  const snapshot = await runtime.snapshot();
  const conflicts = snapshot.providerLeases.filter((lease) => lease.provider === input.provider
    && lease.projectId === runtime.projectId && lease.canonicalRoot === runtime.root && lease.workspaceId === input.workspaceId
    && lease.mode === "write" && lease.ownerId !== currentOwnerId);
  for (const previous of conflicts) {
    const priorIdentity = previous.lifecycle;
    if (!priorIdentity?.sessionId || priorIdentity.operationId !== currentIdentity.operationId
      || priorIdentity.candidateDigest !== currentIdentity.candidateDigest
      || priorIdentity.operationExecutionRevision !== currentIdentity.operationExecutionRevision
      || !sameProviderActor(priorIdentity, currentIdentity)
      || currentIdentity.controllerEpoch <= priorIdentity.controllerEpoch
      || (input.sessionId && priorIdentity.sessionId !== input.sessionId)) {
      throw new Error(`PASEO_PROVIDER_LEASE_TAKEOVER_BLOCKED: provider lease ${previous.leaseId} belongs to another or stale lifecycle without a current-session takeover binding.`);
    }
    await requireCurrentOperation(input, input.root);
    const quiescence = await stopAndObserveQuiescence(input, priorIdentity.sessionId);
    if (!quiescence) throw new Error(`PASEO_PROVIDER_LEASE_TAKEOVER_BLOCKED: prior session ${priorIdentity.sessionId} remains active or uncertain.`);
    const currentOperation = await requireCurrentOperation(input, input.root);
    assertLifecycleCurrent(currentOperation, currentIdentity);
    await runtime.completeProviderLeaseTakeover(previous.leaseId, { ...currentIdentity, sessionId: priorIdentity.sessionId }, quiescence);
  }
}

async function stopAndObserveQuiescence(input: OperationProviderLifecycleInputV1, sessionId: string): Promise<ProviderLeaseQuiescenceV1 | undefined> {
  let observed = await input.inspect(sessionId).catch(() => undefined);
  let status = observed?.status?.toLowerCase();
  if (!isQuiescent(status)) {
    await input.stop(sessionId);
    observed = await input.inspect(sessionId).catch(() => undefined);
    status = observed?.status?.toLowerCase();
  }
  if (!isQuiescent(status)) return undefined;
  return { sessionId, status, observedAt: new Date().toISOString() };
}

function isQuiescent(status?: string): status is ProviderLeaseQuiescenceV1["status"] {
  return status === "idle" || status === "completed" || status === "failed" || status === "stopped";
}

async function fenceUncertainLease(
  runtime: Awaited<ReturnType<typeof createManagedRuntime>>,
  input: OperationProviderLifecycleInputV1,
  leaseId: string,
  identity: ProviderLeaseLifecycleIdentityV1,
  sessionId: string | undefined,
  reason: string
): Promise<Error> {
  await markLeaseUncertain(runtime, input, leaseId, identity, sessionId);
  return new Error(`PASEO_PROVIDER_LIFECYCLE_UNCERTAIN: ${reason}; lease ${leaseId} remains durable and fenced.`);
}

async function markLeaseUncertain(
  runtime: Awaited<ReturnType<typeof createManagedRuntime>>,
  input: OperationProviderLifecycleInputV1,
  leaseId: string,
  identity: ProviderLeaseLifecycleIdentityV1,
  sessionId?: string
): Promise<void> {
  const current = await requireCurrentOperation(input, input.root).catch(() => undefined);
  if (!current) return;
  try {
    assertSameIdentity(await loadOperation(input.root, identity.operationId), current, input);
    await runtime.updateProviderLeaseLifecycle(leaseId, { ...identity, ...(sessionId ? { sessionId } : {}), providerStatus: "UNCERTAIN" });
  } catch { /* A stale owner may not rewrite or release the current owner's lease record. */ }
}

async function requireCurrentOperation(input: OperationProviderLifecycleInputV1, operationRoot: string): Promise<OperationRecordV2> {
  const context = currentOperationContext();
  if (context.id !== input.operationId) throw new Error("PASEO_PROVIDER_LEASE_OPERATION_CONTEXT_REQUIRED: provider session lifecycle requires the current controller operation context.");
  const operation = await loadOperation(operationRoot, input.operationId);
  assertCurrentControllerOwner(operation, "provider session lifecycle");
  const token = controllerTokenFromEnvironment();
  if (!token || !operation.controller?.tokenDigest || sha256Utf8(token) !== operation.controller.tokenDigest) {
    throw new Error("PASEO_PROVIDER_LEASE_CONTROLLER_TOKEN_STALE: provider lifecycle token does not match the current durable controller owner.");
  }
  if (!operation.candidateRevision || !operation.resolvedOperationPolicy || !Number.isSafeInteger(operation.operationExecutionRevision)) {
    throw new Error("PASEO_PROVIDER_LEASE_IDENTITY_INCOMPLETE: current candidate, operation execution revision, and frozen policy are required.");
  }
  assertResolvedOperationPolicyV1(operation.resolvedOperationPolicy);
  const policy = operation.resolvedOperationPolicy;
  if (policy.operationId !== operation.id || policy.operationExecutionRevision !== operation.operationExecutionRevision
    || policy.candidateRevision !== operation.candidateRevision.revision || policy.candidateDigest !== operation.candidateRevision.identityDigest
    || policy.controllerEpoch !== currentControllerEpoch(operation)) {
    throw new Error("PASEO_PROVIDER_LEASE_POLICY_STALE: frozen policy does not match the current operation, candidate, revision, and controller epoch.");
  }
  const participantId = input.participantId;
  const supervisorAgentId = input.supervisorAgentId;
  const leadAgentId = input.leadAgentId;
  const actorCount = [participantId, supervisorAgentId, leadAgentId].filter(Boolean).length;
  if (actorCount !== 1) throw new Error("PASEO_PROVIDER_LEASE_ACTOR_REQUIRED: provider lifecycle requires exactly one current participant, supervisor generation, or bound Lead generation.");
  if (participantId && !operation.participants[participantId]) throw new Error("PASEO_PROVIDER_LEASE_PARTICIPANT_UNKNOWN: provider session participant is not in the current durable operation.");
  if (supervisorAgentId && !operation.agents?.some((agent) => agent.id === supervisorAgentId && agent.role === "Operation Supervisor")) {
    throw new Error("PASEO_PROVIDER_LEASE_SUPERVISOR_UNKNOWN: provider session supervisor is not in the current durable operation.");
  }
  if (leadAgentId && (operation.lead?.agentId !== leadAgentId || operation.lead.generation !== input.leadGeneration)) {
    throw new Error("PASEO_PROVIDER_LEASE_LEAD_BINDING_STALE: provider session does not match the current bound Lead generation.");
  }
  if (input.executionBinding) {
    const bindingActor = participantId ?? supervisorAgentId;
    if (!bindingActor) throw new Error("PASEO_PROVIDER_LEASE_EXECUTION_BINDING_ACTOR_INVALID: ExecutionBinding is bound to a participant or supervisor identity, not a Lead identity.");
    assertBindingCurrent(input.executionBinding, operation, bindingActor, input.sessionId);
  }
  return operation;
}

function assertBindingCurrent(binding: ExecutionBindingV2, operation: OperationRecordV2, participantId: string, sessionId?: string): void {
  assertExecutionBindingV2(binding);
  if (!operation.candidateRevision || !operation.resolvedOperationPolicy
    || binding.operationId !== operation.id || binding.operationExecutionRevision !== operation.operationExecutionRevision
    || binding.candidateRevision !== operation.candidateRevision.revision || binding.candidateDigest !== operation.candidateRevision.identityDigest
    || binding.operationPolicyDigest !== operation.resolvedOperationPolicy.digest || binding.controllerEpoch !== currentControllerEpoch(operation)
    || binding.participantId !== participantId || (sessionId && binding.runtime.sessionId !== sessionId)) {
    throw new Error("PASEO_PROVIDER_LEASE_EXECUTION_BINDING_STALE: current Paseo session binding does not match the durable operation, participant, policy, and controller epoch.");
  }
}

function lifecycleIdentity(operation: OperationRecordV2, input: OperationProviderLifecycleInputV1, sessionId?: string): ProviderLeaseLifecycleIdentityV1 {
  const policy = operation.resolvedOperationPolicy!;
  const token = controllerTokenFromEnvironment();
  if (!token || !operation.candidateRevision) throw new Error("PASEO_PROVIDER_LEASE_IDENTITY_INCOMPLETE: controller token and current candidate are required.");
  return {
    operationId: operation.id,
    candidateDigest: operation.candidateRevision.identityDigest,
    operationExecutionRevision: operation.operationExecutionRevision!,
    policyDigest: policy.digest,
    controllerTokenDigest: sha256Utf8(token),
    controllerEpoch: currentControllerEpoch(operation),
    ...(input.participantId ? { participantId: input.participantId, ...(operation.participants[input.participantId]?.executionBinding?.participantGeneration ? { participantGeneration: operation.participants[input.participantId]!.executionBinding!.participantGeneration } : {}) } : {}),
    ...(input.supervisorAgentId ? { supervisorAgentId: input.supervisorAgentId } : {}),
    ...(input.leadAgentId ? { leadAgentId: input.leadAgentId, leadGeneration: input.leadGeneration } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(input.executionBinding ? { executionBindingDigest: input.executionBinding.digest } : {}),
    providerStatus: "ACTIVE"
  };
}

function assertSameIdentity(expected: OperationRecordV2, current: OperationRecordV2, input: OperationProviderLifecycleInputV1): void {
  if (!expected.candidateRevision || !current.candidateRevision || !expected.resolvedOperationPolicy || !current.resolvedOperationPolicy
    || expected.id !== current.id || expected.candidateRevision.identityDigest !== current.candidateRevision.identityDigest
    || expected.operationExecutionRevision !== current.operationExecutionRevision
    || expected.resolvedOperationPolicy.digest !== current.resolvedOperationPolicy.digest
    || currentControllerEpoch(expected) !== currentControllerEpoch(current)
    || expected.controller?.tokenDigest !== current.controller?.tokenDigest
    || (input.participantId && (!current.participants[input.participantId] || current.participants[input.participantId]?.executionBinding?.participantGeneration !== expected.participants[input.participantId]?.executionBinding?.participantGeneration))
    || (input.supervisorAgentId && !current.agents?.some((agent) => agent.id === input.supervisorAgentId))
    || (input.leadAgentId && (current.lead?.agentId !== input.leadAgentId || current.lead.generation !== input.leadGeneration))) {
    throw new Error("PASEO_PROVIDER_LEASE_OWNER_STALE: current operation, candidate, policy, execution revision, controller epoch, token, or participant changed during provider work.");
  }
}

function sameProviderActor(left: ProviderLeaseLifecycleIdentityV1, right: ProviderLeaseLifecycleIdentityV1): boolean {
  return left.participantId === right.participantId && left.participantGeneration === right.participantGeneration
    && left.supervisorAgentId === right.supervisorAgentId
    && left.leadAgentId === right.leadAgentId && left.leadGeneration === right.leadGeneration;
}

function assertLifecycleCurrent(operation: OperationRecordV2, identity: ProviderLeaseLifecycleIdentityV1): void {
  const participant = identity.participantId ? operation.participants[identity.participantId] : undefined;
  const mismatches = [
    !operation.candidateRevision || operation.id !== identity.operationId || operation.candidateRevision.identityDigest !== identity.candidateDigest ? "operation/candidate" : undefined,
    !operation.resolvedOperationPolicy || operation.operationExecutionRevision !== identity.operationExecutionRevision || operation.resolvedOperationPolicy.digest !== identity.policyDigest ? "policy/revision" : undefined,
    currentControllerEpoch(operation) !== identity.controllerEpoch || operation.controller?.tokenDigest !== identity.controllerTokenDigest ? "controller" : undefined,
    identity.participantId && (!participant || (identity.participantGeneration !== undefined && participant.executionBinding?.participantGeneration !== identity.participantGeneration)
      || (identity.executionBindingDigest !== undefined && participant?.executionBinding?.digest !== identity.executionBindingDigest)
      || (identity.sessionId !== undefined && participant?.executionBinding !== undefined && participant.executionBinding.runtime.sessionId !== identity.sessionId)) ? "participant/session" : undefined,
    identity.supervisorAgentId && !operation.agents?.some((agent) => agent.id === identity.supervisorAgentId) ? "supervisor" : undefined,
    identity.leadAgentId && (operation.lead?.agentId !== identity.leadAgentId || operation.lead.generation !== identity.leadGeneration) ? "Lead generation" : undefined
  ].filter(Boolean);
  if (mismatches.length) throw new Error(`PASEO_PROVIDER_LEASE_OWNER_STALE: operation identity changed while reconciling prior provider ownership (${mismatches.join(", ")}).`);
}

export function operationProviderReservationId(): string {
  return `provider-session:${randomUUID()}`;
}
