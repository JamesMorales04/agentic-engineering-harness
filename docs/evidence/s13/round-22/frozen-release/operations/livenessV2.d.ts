import type { HarnessProjectConfig } from "../core/types.js";
import { dispatchManagedPaseoAgent, inspectManagedPaseoAgent } from "../paseo/runtime.js";
import { recordPaseoTrace } from "../paseo/trace.js";
import { type OperationRecordV2 } from "./state.js";
export type OperationWakeReason = "progress" | "blocked" | "stalled" | "terminal";
export interface OperationLivenessPolicy {
    pollIntervalMs: number;
    progressWakeIntervalMs: number;
    stallThresholdMs: number;
    supervisorStallWakeLimit: number;
    leadWakeLimit: number;
    terminalLeadWakeLimit: number;
    retryDelaysMs: number[];
}
export interface OperationWakeDecision {
    reason?: OperationWakeReason;
    target: "none" | "lead" | "supervisor";
    revision: number;
    message: string;
}
export interface SupervisorWatchdogParticipantSnapshot {
    id: string;
    logicalAgent?: string;
    role?: string;
    phase?: string;
    durableStatus: string;
    runtimeStatus: string;
    resultArtifact?: string;
    error?: string;
}
export interface SupervisorWatchdogSnapshot {
    operationId: string;
    revision: number;
    phase: string;
    stallSeconds: number;
    progress: OperationRecordV2["progress"];
    activeRuntimeParticipants: number;
    participants: SupervisorWatchdogParticipantSnapshot[];
}
export interface OperationLivenessDeps {
    dispatch?: typeof dispatchManagedPaseoAgent;
    inspect?: typeof inspectManagedPaseoAgent;
    trace?: typeof recordPaseoTrace;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    stallSupervisorWakeCount?: number;
}
export declare function operationLivenessPolicy(config: HarnessProjectConfig): OperationLivenessPolicy;
export declare function operationRevisionAcknowledged(operation: OperationRecordV2): boolean;
export declare function evaluateOperationWake(operation: OperationRecordV2, policy: OperationLivenessPolicy, nowMs?: number, stallSupervisorWakeCount?: number, leadWakeCount?: number, terminalLeadWakeCount?: number): OperationWakeDecision;
export declare function buildSupervisorWatchdogSnapshot(root: string, operation: OperationRecordV2, nowMs?: number, inspect?: OperationLivenessDeps["inspect"]): Promise<SupervisorWatchdogSnapshot>;
export declare function runOperationLivenessCheck(root: string, config: HarnessProjectConfig, operationId: string, deps?: OperationLivenessDeps): Promise<OperationWakeDecision>;
export declare function monitorOperationLiveness(root: string, config: HarnessProjectConfig, operationId: string, deps?: OperationLivenessDeps): Promise<void>;
export declare function startOperationWatchdog(root: string, config: HarnessProjectConfig, operationId: string, deps?: OperationLivenessDeps): () => void;
