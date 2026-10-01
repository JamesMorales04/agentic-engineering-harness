import type { AgentExecutionSelection } from "../agents/types.js";
import { type CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { type CapabilityLeaseV1, type CapabilityNameV1 } from "./authorityV2.js";
export interface ExecutionAuthorityV1 {
    version: 1;
    operationId: string;
    participantId: string;
    projectId?: string;
    candidateRevision: CandidateRevisionV1;
    candidateDigest: string;
    /** Durable monotonic controller epoch this authority was compiled under. */
    controllerEpoch: number;
    leases: CapabilityLeaseV1[];
}
export interface ExecutionAuthorityOptions {
    participantId?: string;
    phase?: string;
    now?: Date;
    leaseSeconds?: number;
    required?: boolean;
}
/** Compile short-lived launch authority from the current operation state. */
export declare function prepareExecutionAuthority(root: string, selection: AgentExecutionSelection, options?: ExecutionAuthorityOptions): Promise<ExecutionAuthorityV1 | undefined>;
export declare function requestedCapabilities(selection: AgentExecutionSelection): CapabilityNameV1[];
export declare function assertExecutionAuthority(value: unknown, now?: Date): asserts value is ExecutionAuthorityV1;
export declare function deterministicParticipantId(operationId: string, logicalAgent: string, phase?: string): string;
