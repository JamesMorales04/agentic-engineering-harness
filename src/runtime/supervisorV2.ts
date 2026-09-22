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
    if (existing && existing.ownerId !== input.ownerId && existing.status !== "STOPPED" && existing.status !== "FAILED") {
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
      startedAt: existing?.startedAt ?? now,
      lastHeartbeatAt: now,
      metadata: { ...input.metadata }
    };
    this.services.set(service.serviceId, service);
    return clone(service);
  }

  updateService(serviceId: string, ownerId: string, update: Partial<Pick<RuntimeServiceV1, "status" | "healthUrl" | "pid" | "metadata">>): RuntimeServiceV1 {
    const service = this.requireOwnedService(serviceId, ownerId);
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
      expiresAt: new Date(now.getTime() + ttlMs).toISOString()
    };
    this.leases.set(lease.leaseId, lease);
    return clone(lease);
  }

  renewProviderLease(leaseId: string, ownerId: string, ttlMs = this.leaseTtlMs): ProviderLeaseV1 {
    const lease = this.leases.get(leaseId);
    if (!lease || lease.ownerId !== ownerId) throw new RuntimeOwnershipError(`provider lease ${leaseId} is not owned by ${ownerId}.`);
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new RuntimeOwnershipError("provider lease ttl must be a positive integer.");
    const updated = { ...lease, expiresAt: new Date(this.clock().getTime() + ttlMs).toISOString() };
    this.leases.set(leaseId, updated);
    return clone(updated);
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

  private requireOwnedService(serviceId: string, ownerId: string): RuntimeServiceV1 {
    const service = this.services.get(serviceId);
    if (!service) throw new RuntimeOwnershipError(`service ${serviceId} is not registered.`);
    if (service.ownerId !== ownerId) throw new RuntimeOwnershipError(`service ${serviceId} is owned by ${service.ownerId}.`);
    return service;
  }

  private expireLeases(now: Date): void {
    const timestamp = now.getTime();
    for (const [leaseId, lease] of this.leases) if (new Date(lease.expiresAt).getTime() <= timestamp) this.leases.delete(leaseId);
  }
}
