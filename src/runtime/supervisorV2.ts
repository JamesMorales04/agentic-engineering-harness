import { randomUUID } from "node:crypto";

export type RuntimeServiceKindV1 = "paseo" | "serena" | "context" | "control-center" | "provider";
export type RuntimeServiceStatusV1 = "STARTING" | "READY" | "DEGRADED" | "STOPPED" | "FAILED";
export type ProviderLeaseModeV1 = "read" | "write";

export interface RuntimeServiceV1 {
  version: 1;
  serviceId: string;
  kind: RuntimeServiceKindV1;
  projectId: string;
  canonicalRoot: string;
  workspaceId?: string;
  status: RuntimeServiceStatusV1;
  ownerId: string;
  healthUrl?: string;
  pid?: number;
  startedAt: string;
  lastHeartbeatAt: string;
  metadata: Record<string, string>;
}

export interface ProviderLeaseV1 {
  version: 1;
  leaseId: string;
  provider: string;
  projectId: string;
  canonicalRoot: string;
  workspaceId: string;
  mode: ProviderLeaseModeV1;
  ownerId: string;
  acquiredAt: string;
  expiresAt: string;
  lifecycle?: ProviderLeaseLifecycleIdentityV1;
}

/** Audit/fencing identity for a production session lease; it grants no capability. */
export interface ProviderLeaseLifecycleIdentityV1 {
  operationId: string;
  candidateDigest: string;
  operationExecutionRevision: number;
  policyDigest: string;
  controllerTokenDigest: string;
  controllerEpoch: number;
  participantId?: string;
  participantGeneration?: string;
  supervisorAgentId?: string;
  leadAgentId?: string;
  leadGeneration?: number;
  sessionId?: string;
  executionBindingDigest?: string;
  providerStatus: "ACTIVE" | "UNCERTAIN";
}

export interface ProviderLeaseQuiescenceV1 {
  sessionId: string;
  status: "idle" | "completed" | "failed" | "stopped";
  observedAt: string;
}

export interface RuntimeSnapshotV1 {
  version: 1;
  capturedAt: string;
  services: RuntimeServiceV1[];
  providerLeases: ProviderLeaseV1[];
}

export interface RuntimeSupervisorOptionsV1 {
  clock?: () => Date;
  leaseTtlMs?: number;
}

export interface ObservedPaseoDaemonV1 {
  projectId: string;
  canonicalRoot: string;
  serviceId: string;
  aehVersion: string;
  paseoVersion: string;
  observedServerId?: string;
  observedPid?: number;
  priorDaemonState: "healthy" | "stopped";
}

export class RuntimeOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeOwnershipError";
  }
}

function requireText(value: string, name: string): void {
  if (!value.trim()) throw new RuntimeOwnershipError(`${name} must not be empty.`);
}

function normalizeRoot(value: string): string {
  requireText(value, "canonicalRoot");
  return value.replaceAll("\\", "/").replace(/\/$/, "");
}

function key(provider: string, projectId: string, root: string, workspaceId: string): string {
  return `${provider}\u0000${projectId}\u0000${normalizeRoot(root)}\u0000${workspaceId}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class RuntimeSupervisorV1 {
  private readonly services = new Map<string, RuntimeServiceV1>();
  private readonly leases = new Map<string, ProviderLeaseV1>();
  private readonly clock: () => Date;
  private readonly leaseTtlMs: number;

  constructor(options: RuntimeSupervisorOptionsV1 = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.leaseTtlMs = options.leaseTtlMs ?? 60_000;
    if (!Number.isSafeInteger(this.leaseTtlMs) || this.leaseTtlMs <= 0) throw new RuntimeOwnershipError("leaseTtlMs must be a positive integer.");
  }

  registerService(input: Omit<RuntimeServiceV1, "version" | "status" | "startedAt" | "lastHeartbeatAt"> & { status?: RuntimeServiceStatusV1 }): RuntimeServiceV1 {
    requireText(input.serviceId, "serviceId");
    requireText(input.projectId, "projectId");
    requireText(input.ownerId, "ownerId");
    const now = this.clock().toISOString();
    const existing = this.services.get(input.serviceId);
    if (existing && existing.ownerId !== input.ownerId && existing.status !== "STOPPED" && existing.status !== "FAILED" && serviceOwnerProcessAlive(existing)) {
      throw new RuntimeOwnershipError(`service ${input.serviceId} is owned by ${existing.ownerId}.`);
    }
    const service: RuntimeServiceV1 = {
      version: 1,
      serviceId: input.serviceId,
      kind: input.kind,
      projectId: input.projectId,
      canonicalRoot: normalizeRoot(input.canonicalRoot),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      status: input.status ?? "STARTING",
      ownerId: input.ownerId,
      ...(input.healthUrl ? { healthUrl: input.healthUrl } : {}),
      ...(input.pid === undefined ? {} : { pid: input.pid }),
      startedAt: existing?.ownerId === input.ownerId && existing.status !== "STOPPED" && existing.status !== "FAILED" ? existing.startedAt : now,
      lastHeartbeatAt: now,
      metadata: { ...input.metadata }
    };
    this.services.set(service.serviceId, service);
    return clone(service);
  }

  /**
   * Record a Paseo daemon only after the caller has observed its current status.
   * This narrowly reconciles legacy aeh-start-owned Paseo records; it does not
   * relax the generic service-owner arbitration used by other services.
   */
  registerObservedPaseoDaemon(input: ObservedPaseoDaemonV1): RuntimeServiceV1 {
    const expectedServiceId = `paseo:${input.projectId}`;
    if (!input.projectId.trim() || input.serviceId !== expectedServiceId) throw new RuntimeOwnershipError("Observed Paseo daemon service id does not match this project.");
    if (!input.canonicalRoot.trim() || !input.aehVersion.trim()) throw new RuntimeOwnershipError("Observed Paseo daemon project identity is incomplete.");
    if (!input.paseoVersion.trim()) throw new RuntimeOwnershipError("Observed Paseo daemon version must not be empty.");
    if (input.observedPid !== undefined && (!Number.isSafeInteger(input.observedPid) || input.observedPid <= 0)) {
      throw new RuntimeOwnershipError("Observed Paseo daemon PID must be a positive integer.");
    }
    const now = this.clock().toISOString();
    const existing = this.services.get(expectedServiceId);
    const root = normalizeRoot(input.canonicalRoot);
    const daemonOwnerBase = `paseo-daemon:${input.projectId}`;
    const ownerId = daemonOwnerBase;
    if (existing) {
      if (existing.kind !== "paseo" || existing.projectId !== input.projectId || normalizeRoot(existing.canonicalRoot) !== root) {
        throw new RuntimeOwnershipError(`Paseo service ${expectedServiceId} has a mismatched project identity and cannot be reconciled.`);
      }
      const legacyOwner = legacyPaseoStartOwner(existing.ownerId, input.projectId);
      const stableOwner = existing.ownerId === daemonOwnerBase;
      if (!legacyOwner && !stableOwner) throw new RuntimeOwnershipError(`Paseo service ${expectedServiceId} has an unsupported owner identity and cannot be reconciled.`);
      const previousServerId = existing.metadata.paseoServerId;
      if (previousServerId && input.observedServerId && previousServerId !== input.observedServerId && input.priorDaemonState !== "stopped") {
        throw new RuntimeOwnershipError(`Paseo service ${expectedServiceId} reports a different daemon identity while the prior daemon was observed healthy.`);
      }
    }
    const sameObservedDaemon = existing && input.observedServerId && existing.metadata.paseoServerId === input.observedServerId;
    const service: RuntimeServiceV1 = {
      version: 1,
      serviceId: expectedServiceId,
      kind: "paseo",
      projectId: input.projectId,
      canonicalRoot: root,
      status: "READY",
      ownerId,
      ...(input.observedPid === undefined ? {} : { pid: input.observedPid }),
      startedAt: sameObservedDaemon && existing ? existing.startedAt : now,
      lastHeartbeatAt: now,
      metadata: {
        projectId: input.projectId,
        aehVersion: input.aehVersion,
        paseoVersion: input.paseoVersion,
        ...(input.observedServerId ? { paseoServerId: input.observedServerId } : {})
      }
    };
    this.services.set(expectedServiceId, service);
    return clone(service);
  }

  updateService(serviceId: string, ownerId: string, update: Partial<Pick<RuntimeServiceV1, "status" | "healthUrl" | "pid" | "metadata">>): RuntimeServiceV1 {
    const service = this.requireOwnedService(serviceId, ownerId);
    if (service.status === "STOPPED" || service.status === "FAILED") {
      throw new RuntimeOwnershipError(`service ${serviceId} is terminal (${service.status}) and cannot be renewed or updated.`);
    }
    const updated = { ...service, ...update, lastHeartbeatAt: this.clock().toISOString(), metadata: { ...service.metadata, ...(update.metadata ?? {}) } };
    this.services.set(serviceId, updated);
    return clone(updated);
  }

  heartbeat(serviceId: string, ownerId: string): RuntimeServiceV1 {
    return this.updateService(serviceId, ownerId, {});
  }

  stopService(serviceId: string, ownerId: string, status: "STOPPED" | "FAILED" = "STOPPED"): RuntimeServiceV1 {
    return this.updateService(serviceId, ownerId, { status });
  }

  acquireProviderLease(input: Omit<ProviderLeaseV1, "version" | "leaseId" | "acquiredAt" | "expiresAt"> & { ttlMs?: number }): ProviderLeaseV1 {
    requireText(input.provider, "provider");
    requireText(input.projectId, "projectId");
    requireText(input.ownerId, "ownerId");
    requireText(input.workspaceId, "workspaceId");
    const now = this.clock();
    this.expireLeases(now);
    const root = normalizeRoot(input.canonicalRoot);
    const leaseKey = key(input.provider, input.projectId, root, input.workspaceId);
    const active = [...this.leases.values()].filter((lease) => key(lease.provider, lease.projectId, lease.canonicalRoot, lease.workspaceId) === leaseKey);
    const conflicting = active.find((lease) => lease.ownerId !== input.ownerId && (lease.mode === "write" || input.mode === "write"));
    if (conflicting) throw new RuntimeOwnershipError(`provider ${input.provider} is already leased in ${input.workspaceId} by ${conflicting.ownerId}.`);
    const ttlMs = input.ttlMs ?? this.leaseTtlMs;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new RuntimeOwnershipError("provider lease ttl must be a positive integer.");
    const lease: ProviderLeaseV1 = {
      version: 1,
      leaseId: `lease:${randomUUID()}`,
      provider: input.provider,
      projectId: input.projectId,
      canonicalRoot: root,
      workspaceId: input.workspaceId,
      mode: input.mode,
      ownerId: input.ownerId,
      acquiredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      ...(input.lifecycle ? { lifecycle: validateProviderLeaseLifecycle(input.lifecycle) } : {})
    };
    this.leases.set(lease.leaseId, lease);
    return clone(lease);
  }

  renewProviderLease(leaseId: string, ownerId: string, ttlMs = this.leaseTtlMs): ProviderLeaseV1 {
    const now = this.clock();
    this.expireLeases(now);
    const lease = this.leases.get(leaseId);
    if (!lease || lease.ownerId !== ownerId) throw new RuntimeOwnershipError(`provider lease ${leaseId} is not owned by ${ownerId}.`);
    if (Date.parse(lease.expiresAt) <= now.getTime()) throw new RuntimeOwnershipError(`provider lease ${leaseId} is expired and requires observed provider quiescence before takeover.`);
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new RuntimeOwnershipError("provider lease ttl must be a positive integer.");
    const updated = { ...lease, expiresAt: new Date(now.getTime() + ttlMs).toISOString() };
    this.leases.set(leaseId, updated);
    return clone(updated);
  }

  updateProviderLeaseLifecycle(leaseId: string, ownerId: string, lifecycle: ProviderLeaseLifecycleIdentityV1): ProviderLeaseV1 {
    const lease = this.leases.get(leaseId);
    if (!lease || lease.ownerId !== ownerId) throw new RuntimeOwnershipError(`provider lease ${leaseId} is not owned by ${ownerId}.`);
    if (Date.parse(lease.expiresAt) <= this.clock().getTime()) throw new RuntimeOwnershipError(`provider lease ${leaseId} is expired and cannot be updated.`);
    const updated = { ...lease, lifecycle: validateProviderLeaseLifecycle(lifecycle) };
    this.leases.set(leaseId, updated);
    return clone(updated);
  }

  /** Revoke a prior epoch's lease only after its exact provider session is observed quiescent. */
  completeProviderLeaseTakeover(
    leaseId: string,
    currentOwnerId: string,
    current: ProviderLeaseLifecycleIdentityV1,
    quiescence: ProviderLeaseQuiescenceV1
  ): void {
    const prior = this.leases.get(leaseId);
    if (!prior) throw new RuntimeOwnershipError(`provider lease ${leaseId} is no longer available for takeover.`);
    const previous = prior.lifecycle;
    const next = validateProviderLeaseLifecycle(current);
    if (!previous?.sessionId || prior.ownerId === currentOwnerId || previous.operationId !== next.operationId || previous.candidateDigest !== next.candidateDigest
      || previous.operationExecutionRevision !== next.operationExecutionRevision || !sameProviderLeaseActor(previous, next)
      || next.controllerEpoch <= previous.controllerEpoch || quiescence.sessionId !== previous.sessionId
      || !["idle", "completed", "failed", "stopped"].includes(quiescence.status) || !validDate(quiescence.observedAt)) {
      throw new RuntimeOwnershipError("provider lease takeover requires the same current operation/candidate/revision/participant, a newer controller epoch, and observed quiescence of the prior session.");
    }
    this.leases.delete(leaseId);
  }

  releaseProviderLease(leaseId: string, ownerId: string): void {
    const lease = this.leases.get(leaseId);
    if (!lease) return;
    if (lease.ownerId !== ownerId) throw new RuntimeOwnershipError(`provider lease ${leaseId} is not owned by ${ownerId}.`);
    this.leases.delete(leaseId);
  }

  snapshot(): RuntimeSnapshotV1 {
    this.expireLeases(this.clock());
    return { version: 1, capturedAt: this.clock().toISOString(), services: [...this.services.values()].map(clone), providerLeases: [...this.leases.values()].map(clone) };
  }

  /** Replace the in-memory view from the atomically persisted runtime snapshot. */
  restoreSnapshot(snapshot: RuntimeSnapshotV1): void {
    if (!snapshot || snapshot.version !== 1 || !validDate(snapshot.capturedAt) || !Array.isArray(snapshot.services) || !Array.isArray(snapshot.providerLeases)) {
      throw new RuntimeOwnershipError("UNSUPPORTED_RUNTIME_SNAPSHOT: expected version 1 with service and provider lease arrays.");
    }
    this.services.clear();
    this.leases.clear();
    for (const service of snapshot.services) {
      if (!service || typeof service !== "object" || service.version !== 1 || !nonEmptyText(service.serviceId) || !nonEmptyText(service.ownerId)
        || !nonEmptyText(service.projectId) || !nonEmptyText(service.canonicalRoot) || !validDate(service.startedAt) || !validDate(service.lastHeartbeatAt)
        || !["paseo", "serena", "context", "control-center", "provider"].includes(service.kind)
        || !["STARTING", "READY", "DEGRADED", "STOPPED", "FAILED"].includes(service.status)
        || !service.metadata || typeof service.metadata !== "object" || Array.isArray(service.metadata)
        || (service.pid !== undefined && (!Number.isSafeInteger(service.pid) || service.pid <= 0))
        || this.services.has(service.serviceId)) {
        throw new RuntimeOwnershipError("INVALID_RUNTIME_SNAPSHOT: service records must have unique ids and current version 1.");
      }
      this.services.set(service.serviceId, clone(service));
    }
    for (const lease of snapshot.providerLeases) {
      if (!lease || typeof lease !== "object" || lease.version !== 1 || !nonEmptyText(lease.leaseId) || !nonEmptyText(lease.ownerId) || !nonEmptyText(lease.provider)
        || !nonEmptyText(lease.projectId) || !nonEmptyText(lease.canonicalRoot) || !nonEmptyText(lease.workspaceId)
        || !["read", "write"].includes(lease.mode) || !validDate(lease.acquiredAt) || !validDate(lease.expiresAt)
        || this.leases.has(lease.leaseId)) {
        throw new RuntimeOwnershipError("INVALID_RUNTIME_SNAPSHOT: provider leases must have unique ids and current version 1.");
      }
      if (lease.lifecycle !== undefined) validateProviderLeaseLifecycle(lease.lifecycle);
      this.leases.set(lease.leaseId, clone(lease));
    }
    const leasesByScope = new Map<string, ProviderLeaseV1[]>();
    for (const lease of this.leases.values()) {
      const scope = key(lease.provider, lease.projectId, lease.canonicalRoot, lease.workspaceId);
      const scoped = leasesByScope.get(scope) ?? [];
      if (scoped.some((existing) => existing.ownerId !== lease.ownerId && (existing.mode === "write" || lease.mode === "write"))) {
        throw new RuntimeOwnershipError("INVALID_RUNTIME_SNAPSHOT: provider lease records contain conflicting active owners.");
      }
      scoped.push(lease);
      leasesByScope.set(scope, scoped);
    }
  }

  private requireOwnedService(serviceId: string, ownerId: string): RuntimeServiceV1 {
    const service = this.services.get(serviceId);
    if (!service) throw new RuntimeOwnershipError(`service ${serviceId} is not registered.`);
    if (service.ownerId !== ownerId) throw new RuntimeOwnershipError(`service ${serviceId} is owned by ${service.ownerId}.`);
    return service;
  }

  private expireLeases(now: Date): void {
    // Expiry fences renewal. It does not prove an external provider session stopped.
    void now;
  }
}

function validateProviderLeaseLifecycle(value: ProviderLeaseLifecycleIdentityV1): ProviderLeaseLifecycleIdentityV1 {
  const participantIdentity = nonEmptyText(value?.participantId);
  const supervisorIdentity = nonEmptyText(value?.supervisorAgentId);
  const leadIdentity = nonEmptyText(value?.leadAgentId) && Number.isSafeInteger(value?.leadGeneration) && (value?.leadGeneration ?? 0) > 0;
  const actorCount = [participantIdentity, supervisorIdentity, leadIdentity].filter(Boolean).length;
  if (!value || !nonEmptyText(value.operationId) || !/^[a-f0-9]{64}$/.test(value.candidateDigest)
    || !Number.isSafeInteger(value.operationExecutionRevision) || value.operationExecutionRevision < 1
    || !/^[a-f0-9]{64}$/.test(value.policyDigest) || !/^[a-f0-9]{64}$/.test(value.controllerTokenDigest)
    || !Number.isSafeInteger(value.controllerEpoch) || value.controllerEpoch < 0 || actorCount > 1
    || (value.participantGeneration !== undefined && (!participantIdentity || !nonEmptyText(value.participantGeneration)))
    || (value.leadGeneration !== undefined && !leadIdentity)
    || (value.sessionId !== undefined && !nonEmptyText(value.sessionId))
    || (value.executionBindingDigest !== undefined && !/^[a-f0-9]{64}$/.test(value.executionBindingDigest))
    || !["ACTIVE", "UNCERTAIN"].includes(value.providerStatus)) {
    throw new RuntimeOwnershipError("INVALID_PROVIDER_LEASE_LIFECYCLE: current operation, candidate, policy, controller, participant, and provider state identity are required.");
  }
  return clone(value);
}

function sameProviderLeaseActor(left: ProviderLeaseLifecycleIdentityV1, right: ProviderLeaseLifecycleIdentityV1): boolean {
  return left.participantId === right.participantId && left.participantGeneration === right.participantGeneration
    && left.supervisorAgentId === right.supervisorAgentId
    && left.leadAgentId === right.leadAgentId && left.leadGeneration === right.leadGeneration;
}

function nonEmptyText(value: unknown): value is string { return typeof value === "string" && Boolean(value.trim()); }
function validDate(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }

function legacyPaseoStartOwner(ownerId: string, projectId: string): boolean {
  const prefix = "paseo-start:";
  const suffix = `:${projectId}`;
  if (!ownerId.startsWith(prefix) || !ownerId.endsWith(suffix)) return false;
  const pid = ownerId.slice(prefix.length, -suffix.length);
  return /^[1-9]\d*$/.test(pid);
}

function serviceOwnerProcessAlive(service: RuntimeServiceV1): boolean {
  if (!Number.isSafeInteger(service.pid) || (service.pid ?? 0) <= 0) return true;
  try { process.kill(service.pid!, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
