import { type ExecutionBindingV2 } from "../architecture/executionIdentity.js";
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
export declare function runWithOperationProviderLease<T>(input: OperationProviderLifecycleInputV1, action: () => Promise<OperationProviderActionResultV1<T>>): Promise<T>;
export declare function operationProviderReservationId(): string;
/**
 * AEH-V2-0129: the provider write-lease workspace key. A launch explicitly bound to the operation
 * workspace keeps that identity; an isolated per-unit wave launch (launch root differs from the
 * operation state/control root) gets its own deterministic key derived from the isolated root, so
 * parallel same-wave units no longer collide on the shared operation workspace key while writers of
 * one workspace still serialize.
 */
export declare function providerLeaseWorkspaceKeyV1(input: {
    explicitWorkspaceId?: string;
    labelWorkspaceId?: string;
    launchRoot: string;
    stateRoot: string;
    operationWorkspaceId?: string;
    operationId: string;
}): string;
