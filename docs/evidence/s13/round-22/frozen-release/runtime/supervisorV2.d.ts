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
export declare class RuntimeOwnershipError extends Error {
    constructor(message: string);
}
export declare class RuntimeSupervisorV1 {
    private readonly services;
    private readonly leases;
    private readonly clock;
    private readonly leaseTtlMs;
    constructor(options?: RuntimeSupervisorOptionsV1);
    registerService(input: Omit<RuntimeServiceV1, "version" | "status" | "startedAt" | "lastHeartbeatAt"> & {
        status?: RuntimeServiceStatusV1;
    }): RuntimeServiceV1;
    /**
     * Record a Paseo daemon only after the caller has observed its current status.
     * This narrowly reconciles legacy aeh-start-owned Paseo records; it does not
     * relax the generic service-owner arbitration used by other services.
     */
    registerObservedPaseoDaemon(input: ObservedPaseoDaemonV1): RuntimeServiceV1;
    updateService(serviceId: string, ownerId: string, update: Partial<Pick<RuntimeServiceV1, "status" | "healthUrl" | "pid" | "metadata">>): RuntimeServiceV1;
    heartbeat(serviceId: string, ownerId: string): RuntimeServiceV1;
    stopService(serviceId: string, ownerId: string, status?: "STOPPED" | "FAILED"): RuntimeServiceV1;
    acquireProviderLease(input: Omit<ProviderLeaseV1, "version" | "leaseId" | "acquiredAt" | "expiresAt"> & {
        ttlMs?: number;
    }): ProviderLeaseV1;
    renewProviderLease(leaseId: string, ownerId: string, ttlMs?: number): ProviderLeaseV1;
    updateProviderLeaseLifecycle(leaseId: string, ownerId: string, lifecycle: ProviderLeaseLifecycleIdentityV1): ProviderLeaseV1;
    /** Revoke a prior epoch's lease only after its exact provider session is observed quiescent. */
    completeProviderLeaseTakeover(leaseId: string, currentOwnerId: string, current: ProviderLeaseLifecycleIdentityV1, quiescence: ProviderLeaseQuiescenceV1): void;
    releaseProviderLease(leaseId: string, ownerId: string): void;
    snapshot(): RuntimeSnapshotV1;
    /** Replace the in-memory view from the atomically persisted runtime snapshot. */
    restoreSnapshot(snapshot: RuntimeSnapshotV1): void;
    private requireOwnedService;
    private expireLeases;
}
