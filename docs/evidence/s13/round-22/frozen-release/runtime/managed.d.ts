import { RuntimeSupervisorV1, type ObservedPaseoDaemonV1, type ProviderLeaseLifecycleIdentityV1, type ProviderLeaseModeV1, type ProviderLeaseQuiescenceV1, type ProviderLeaseV1, type RuntimeServiceV1, type RuntimeServiceKindV1, type RuntimeServiceStatusV1, type RuntimeSnapshotV1 } from "./supervisorV2.js";
export interface ManagedRuntimeOptionsV1 {
    root: string;
    projectId?: string;
    ownerId?: string;
    statePath?: string;
    supervisor?: RuntimeSupervisorV1;
    clock?: () => Date;
    leaseTtlMs?: number;
}
export interface ManagedProviderLeaseInputV1 {
    provider: string;
    workspaceId: string;
    mode: ProviderLeaseModeV1;
    ttlMs?: number;
    lifecycle?: ProviderLeaseLifecycleIdentityV1;
}
/** Stable local identity used when no repository registry record is available yet. */
export declare function runtimeProjectId(root: string): string;
/**
 * Controller-facing runtime supervisor. The shared snapshot is the durable
 * coordination authority for process records and provider leases: every
 * mutation reloads under one root-scoped lock and atomically replaces it.
 * Capability authority and ExecutionBinding identity remain separate.
 */
export declare class ManagedRuntimeSupervisorV1 {
    readonly supervisor: RuntimeSupervisorV1;
    readonly root: string;
    readonly projectId: string;
    readonly ownerId: string;
    readonly statePath: string;
    private readonly clock;
    private readonly leaseTtlMs?;
    constructor(options: ManagedRuntimeOptionsV1);
    registerService(input: Omit<RuntimeServiceV1, "version" | "projectId" | "canonicalRoot" | "ownerId" | "status" | "startedAt" | "lastHeartbeatAt"> & {
        kind: RuntimeServiceKindV1;
        status?: RuntimeServiceStatusV1;
        metadata?: Record<string, string>;
    }): Promise<RuntimeServiceV1>;
    registerObservedPaseoDaemon(input: Omit<ObservedPaseoDaemonV1, "projectId" | "canonicalRoot">): Promise<RuntimeServiceV1>;
    updateService(serviceId: string, update: Partial<Pick<RuntimeServiceV1, "status" | "healthUrl" | "pid" | "metadata">>): Promise<RuntimeServiceV1>;
    heartbeat(serviceId: string): Promise<RuntimeServiceV1>;
    stopService(serviceId: string, status?: "STOPPED" | "FAILED"): Promise<RuntimeServiceV1>;
    acquireProviderLease(input: ManagedProviderLeaseInputV1): Promise<ProviderLeaseV1>;
    renewProviderLease(leaseId: string, ttlMs?: number): Promise<ProviderLeaseV1>;
    updateProviderLeaseLifecycle(leaseId: string, lifecycle: ProviderLeaseLifecycleIdentityV1): Promise<ProviderLeaseV1>;
    completeProviderLeaseTakeover(leaseId: string, lifecycle: ProviderLeaseLifecycleIdentityV1, quiescence: ProviderLeaseQuiescenceV1): Promise<void>;
    releaseProviderLease(leaseId: string): Promise<void>;
    /** Release all leases owned by this exact runtime controller during drain/cleanup. */
    releaseOwnedProviderLeases(): Promise<void>;
    /** Drain every service and provider lease owned by this runtime in one transaction. */
    drainAndRelease(): Promise<void>;
    /** Read a current shared snapshot and expire leases before returning it. */
    snapshot(): Promise<RuntimeSnapshotV1>;
    /** Refresh/expire shared state without introducing a second write path. */
    persist(): Promise<void>;
    private transact;
}
export declare function readManagedRuntimeSnapshot(root: string, statePath?: string): Promise<RuntimeSnapshotV1>;
export declare function createManagedRuntime(options: ManagedRuntimeOptionsV1): Promise<ManagedRuntimeSupervisorV1>;
