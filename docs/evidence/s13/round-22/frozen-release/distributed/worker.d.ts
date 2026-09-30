import type { AgentExecutionSelection } from "../agents/types.js";
import type { WorkUnitOutput } from "../agents/outputContracts.js";
import type { ControlPlaneSnapshot } from "../core/controlPlane.js";
import type { HarnessProjectConfig, TaskContract } from "../core/types.js";
import { type PreparedAgentExecutionIdentity } from "../workers/agentPrompt.js";
import type { DistributedDelegationJob, DistributedDelegationResult, DistributedTransportResolutionV1 } from "./types.js";
import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";
export declare function dispatchDistributedDelegation(input: {
    root: string;
    config: HarnessProjectConfig;
    contract: TaskContract;
    task: WorkUnitOutput;
    participantId: string;
    selection: AgentExecutionSelection;
    controller?: ControlPlaneSnapshot;
    waveBase: CandidateRevisionV1;
    identity: PreparedAgentExecutionIdentity;
}): Promise<DistributedDelegationResult>;
/**
 * A distributed job must freeze a concrete worker session-materialization transport before it is
 * submitted: `inherit` is a local orchestration instruction (it resolves to the orchestration
 * provider in-process), and the detached worker has no operation context to resolve it against.
 * Deterministically resolve it once at job creation and fail closed for anything the worker has no
 * approved pre-prompt session-materialization boundary for (AEH-V2-0131).
 */
export declare function resolveDistributedWorkerTransport(config: HarnessProjectConfig, selection: AgentExecutionSelection): DistributedTransportResolutionV1;
export declare function createDistributedCandidatePatch(root: string): Promise<string>;
export declare function runDistributedWorkerOnce(root: string, config: HarnessProjectConfig, workerId?: string): Promise<DistributedDelegationResult | undefined>;
export declare function runDistributedWorkerLoop(root: string, config: HarnessProjectConfig, options?: {
    workerId?: string;
    once?: boolean;
    signal?: AbortSignal;
}): Promise<void>;
export interface DistributedSandboxValidation {
    selection: AgentExecutionSelection;
    config: HarnessProjectConfig;
}
export declare function validateDistributedSandboxPolicy(job: DistributedDelegationJob, workerConfig: HarnessProjectConfig): DistributedSandboxValidation;
