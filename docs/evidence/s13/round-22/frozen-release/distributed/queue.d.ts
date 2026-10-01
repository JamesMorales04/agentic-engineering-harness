import http from "node:http";
import type { HarnessProjectConfig } from "../core/types.js";
import type { ClaimedJob, DistributedDelegationJob, DistributedDelegationResult, DistributedExecutionReleaseV1, DistributedSessionReadyV1 } from "./types.js";
export declare function submitDistributedJob(root: string, config: HarnessProjectConfig, job: DistributedDelegationJob): Promise<void>;
export declare function claimDistributedJob(root: string, config: HarnessProjectConfig, workerId: string): Promise<ClaimedJob | undefined>;
export declare function completeDistributedJob(root: string, config: HarnessProjectConfig, leaseId: string, result: DistributedDelegationResult): Promise<void>;
export declare function waitForDistributedResult(root: string, config: HarnessProjectConfig, jobId: string, timeoutMs?: number): Promise<DistributedDelegationResult>;
export declare function publishDistributedSessionReady(root: string, config: HarnessProjectConfig, ready: DistributedSessionReadyV1): Promise<void>;
export declare function waitForDistributedSessionReady(root: string, config: HarnessProjectConfig, jobId: string, timeoutMs?: number): Promise<DistributedSessionReadyV1>;
export declare function releaseDistributedExecutionBinding(root: string, config: HarnessProjectConfig, release: DistributedExecutionReleaseV1): Promise<void>;
export declare function waitForDistributedExecutionRelease(root: string, config: HarnessProjectConfig, jobId: string, workerId: string, leaseId: string, timeoutMs?: number): Promise<DistributedExecutionReleaseV1>;
export declare function serveDistributedQueue(root: string, config: HarnessProjectConfig, options: {
    port: number;
    host?: string;
}): Promise<http.Server>;
