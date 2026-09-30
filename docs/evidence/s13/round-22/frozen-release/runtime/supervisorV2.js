import { randomUUID } from "node:crypto";
export class RuntimeOwnershipError extends Error {
    constructor(message) {
        super(message);
        this.name = "RuntimeOwnershipError";
    }
}
function requireText(value, name) {
    if (!value.trim())
        throw new RuntimeOwnershipError(`${name} must not be empty.`);
}
function normalizeRoot(value) {
    requireText(value, "canonicalRoot");
    return value.replaceAll("\\", "/").replace(/\/$/, "");
}
function key(provider, projectId, root, workspaceId) {
    return `${provider}\u0000${projectId}\u0000${normalizeRoot(root)}\u0000${workspaceId}`;
}
function clone(value) {
    return structuredClone(value);
}
export class RuntimeSupervisorV1 {
    services = new Map();
    leases = new Map();
    clock;
    leaseTtlMs;
    constructor(options = {}) {
        this.clock = options.clock ?? (() => new Date());
        this.leaseTtlMs = options.leaseTtlMs ?? 60_000;
        if (!Number.isSafeInteger(this.leaseTtlMs) || this.leaseTtlMs <= 0)
            throw new RuntimeOwnershipError("leaseTtlMs must be a positive integer.");
    }
    registerService(input) {
        requireText(input.serviceId, "serviceId");
        requireText(input.projectId, "projectId");
        requireText(input.ownerId, "ownerId");
        const now = this.clock().toISOString();
        const existing = this.services.get(input.serviceId);
        if (existing && existing.ownerId !== input.ownerId && existing.status !== "STOPPED" && existing.status !== "FAILED" && serviceOwnerProcessAlive(existing)) {
            throw new RuntimeOwnershipError(`service ${input.serviceId} is owned by ${existing.ownerId}.`);
        }
        const service = {
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
    registerObservedPaseoDaemon(input) {
        const expectedServiceId = `paseo:${input.projectId}`;
        if (!input.projectId.trim() || input.serviceId !== expectedServiceId)
            throw new RuntimeOwnershipError("Observed Paseo daemon service id does not match this project.");
        if (!input.canonicalRoot.trim() || !input.aehVersion.trim())
            throw new RuntimeOwnershipError("Observed Paseo daemon project identity is incomplete.");
        if (!input.paseoVersion.trim())
            throw new RuntimeOwnershipError("Observed Paseo daemon version must not be empty.");
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
            if (!legacyOwner && !stableOwner)
                throw new RuntimeOwnershipError(`Paseo service ${expectedServiceId} has an unsupported owner identity and cannot be reconciled.`);
            const previousServerId = existing.metadata.paseoServerId;
            if (previousServerId && input.observedServerId && previousServerId !== input.observedServerId && input.priorDaemonState !== "stopped") {
                throw new RuntimeOwnershipError(`Paseo service ${expectedServiceId} reports a different daemon identity while the prior daemon was observed healthy.`);
            }
        }
        const sameObservedDaemon = existing && input.observedServerId && existing.metadata.paseoServerId === input.observedServerId;
        const service = {
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
    updateService(serviceId, ownerId, update) {
        const service = this.requireOwnedService(serviceId, ownerId);
        if (service.status === "STOPPED" || service.status === "FAILED") {
            throw new RuntimeOwnershipError(`service ${serviceId} is terminal (${service.status}) and cannot be renewed or updated.`);
        }
        const updated = { ...service, ...update, lastHeartbeatAt: this.clock().toISOString(), metadata: { ...service.metadata, ...(update.metadata ?? {}) } };
        this.services.set(serviceId, updated);
        return clone(updated);
    }
    heartbeat(serviceId, ownerId) {
        return this.updateService(serviceId, ownerId, {});
    }
    stopService(serviceId, ownerId, status = "STOPPED") {
        return this.updateService(serviceId, ownerId, { status });
    }
    acquireProviderLease(input) {
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
        if (conflicting)
            throw new RuntimeOwnershipError(`provider ${input.provider} is already leased in ${input.workspaceId} by ${conflicting.ownerId}.`);
        const ttlMs = input.ttlMs ?? this.leaseTtlMs;
        if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0)
            throw new RuntimeOwnershipError("provider lease ttl must be a positive integer.");
        const lease = {
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
    renewProviderLease(leaseId, ownerId, ttlMs = this.leaseTtlMs) {
        const now = this.clock();
        this.expireLeases(now);
        const lease = this.leases.get(leaseId);
        if (!lease || lease.ownerId !== ownerId)
            throw new RuntimeOwnershipError(`provider lease ${leaseId} is not owned by ${ownerId}.`);
        if (Date.parse(lease.expiresAt) <= now.getTime())
            throw new RuntimeOwnershipError(`provider lease ${leaseId} is expired and requires observed provider quiescence before takeover.`);
        if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0)
            throw new RuntimeOwnershipError("provider lease ttl must be a positive integer.");
        const updated = { ...lease, expiresAt: new Date(now.getTime() + ttlMs).toISOString() };
        this.leases.set(leaseId, updated);
        return clone(updated);
    }
    updateProviderLeaseLifecycle(leaseId, ownerId, lifecycle) {
        const lease = this.leases.get(leaseId);
        if (!lease || lease.ownerId !== ownerId)
            throw new RuntimeOwnershipError(`provider lease ${leaseId} is not owned by ${ownerId}.`);
        if (Date.parse(lease.expiresAt) <= this.clock().getTime())
            throw new RuntimeOwnershipError(`provider lease ${leaseId} is expired and cannot be updated.`);
        const updated = { ...lease, lifecycle: validateProviderLeaseLifecycle(lifecycle) };
        this.leases.set(leaseId, updated);
        return clone(updated);
    }
    /** Revoke a prior epoch's lease only after its exact provider session is observed quiescent. */
    completeProviderLeaseTakeover(leaseId, currentOwnerId, current, quiescence) {
        const prior = this.leases.get(leaseId);
        if (!prior)
            throw new RuntimeOwnershipError(`provider lease ${leaseId} is no longer available for takeover.`);
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
    releaseProviderLease(leaseId, ownerId) {
        const lease = this.leases.get(leaseId);
        if (!lease)
            return;
        if (lease.ownerId !== ownerId)
            throw new RuntimeOwnershipError(`provider lease ${leaseId} is not owned by ${ownerId}.`);
        this.leases.delete(leaseId);
    }
    snapshot() {
        this.expireLeases(this.clock());
        return { version: 1, capturedAt: this.clock().toISOString(), services: [...this.services.values()].map(clone), providerLeases: [...this.leases.values()].map(clone) };
    }
    /** Replace the in-memory view from the atomically persisted runtime snapshot. */
    restoreSnapshot(snapshot) {
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
            if (lease.lifecycle !== undefined)
                validateProviderLeaseLifecycle(lease.lifecycle);
            this.leases.set(lease.leaseId, clone(lease));
        }
        const leasesByScope = new Map();
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
    requireOwnedService(serviceId, ownerId) {
        const service = this.services.get(serviceId);
        if (!service)
            throw new RuntimeOwnershipError(`service ${serviceId} is not registered.`);
        if (service.ownerId !== ownerId)
            throw new RuntimeOwnershipError(`service ${serviceId} is owned by ${service.ownerId}.`);
        return service;
    }
    expireLeases(now) {
        // Expiry fences renewal. It does not prove an external provider session stopped.
        void now;
    }
}
function validateProviderLeaseLifecycle(value) {
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
function sameProviderLeaseActor(left, right) {
    return left.participantId === right.participantId && left.participantGeneration === right.participantGeneration
        && left.supervisorAgentId === right.supervisorAgentId
        && left.leadAgentId === right.leadAgentId && left.leadGeneration === right.leadGeneration;
}
function nonEmptyText(value) { return typeof value === "string" && Boolean(value.trim()); }
function validDate(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function legacyPaseoStartOwner(ownerId, projectId) {
    const prefix = "paseo-start:";
    const suffix = `:${projectId}`;
    if (!ownerId.startsWith(prefix) || !ownerId.endsWith(suffix))
        return false;
    const pid = ownerId.slice(prefix.length, -suffix.length);
    return /^[1-9]\d*$/.test(pid);
}
function serviceOwnerProcessAlive(service) {
    if (!Number.isSafeInteger(service.pid) || (service.pid ?? 0) <= 0)
        return true;
    try {
        process.kill(service.pid, 0);
        return true;
    }
    catch (error) {
        return error.code === "EPERM";
    }
}
//# sourceMappingURL=supervisorV2.js.map