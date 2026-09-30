import type { AgentExecutionSelection } from "../agents/types.js";
import { type NormalizedFinding, type SupervisorOutput } from "../agents/outputContracts.js";
import type { HarnessProjectConfig, TaskContract, WorkerSession } from "../core/types.js";
import { type OperationRecordV2 } from "./state.js";
/**
 * A supervisor generation's structured-result channel is bound to the candidate digest it was
 * materialized under. The generation is only reusable while that binding matches the operation's
 * current candidate; otherwise a consolidation continuation fails closed with
 * `AEH_RESULT_STALE_CANDIDATE` and the generation must be rotated (AEH-V2-0120).
 */
export declare function supervisorGenerationCandidateCurrentV1(provenance: {
    status: string;
    candidate?: {
        identityDigest: string;
    };
} | undefined, operation: Pick<OperationRecordV2, "candidateRevision">): boolean;
export declare function supervisorSourceFindingIdsMatchV1(expected: readonly string[], received: readonly string[]): boolean;
export declare function supervisorConsolidationCorrectionPromptV1(input: SupervisorConsolidationInput, requiredIds: readonly string[], receivedIds: readonly string[]): string;
export declare function supervisorConsolidationContractCorrectionPromptV1(input: SupervisorConsolidationInput, requiredIds: readonly string[], failure: string): string;
export interface SupervisorConsolidationTurnV1 {
    session: WorkerSession;
    output?: SupervisorOutput;
    failure?: string;
}
/**
 * Bounded consolidation correction loop: at most two supervisor turns (initial plus one correction).
 * The single correction covers either a contract-invalid response or a provenance mismatch by
 * re-stating the frozen contract and the exact required id set. The schema and exact-set checks
 * still fail closed; no field is repaired or coerced and a second failure is a hard error.
 */
export declare function withBoundedSupervisorConsolidationCorrectionV1(input: {
    expectedFindingIds: readonly string[];
    initialPrompt: string;
    provenanceCorrectionPrompt: (receivedIds: readonly string[]) => string;
    contractCorrectionPrompt: (failure: string) => string;
    onCorrection?: (detail: {
        receivedIds?: string[];
        failure?: string;
    }) => Promise<void>;
    requestTurn: (prompt: string) => Promise<SupervisorConsolidationTurnV1>;
}): Promise<{
    session: WorkerSession;
    output: SupervisorOutput;
    prompt: string;
}>;
export interface EnsureSupervisorOptions {
    required?: boolean;
    forceMaterialize?: boolean;
}
export interface OperationSupervisorHandle {
    operationId: string;
    generation: number;
    agentId?: string;
    materialized: boolean;
    selection: AgentExecutionSelection;
    session?: WorkerSession;
}
export interface SupervisorConsolidationInput {
    key: string;
    purpose: string;
    findings: NormalizedFinding[];
    sourceArtifacts?: string[];
    deterministicEvidence?: unknown;
}
export interface SupervisorConsolidationResult {
    output: SupervisorOutput;
    artifact: string;
    session: WorkerSession;
}
interface SupervisorContextPolicy {
    handoffThreshold: number;
    hardHandoffThreshold: number;
}
export declare function operationSupervisorContextPolicy(config: HarnessProjectConfig): SupervisorContextPolicy;
export declare function operationSupervisorInitializationTimeoutSeconds(config: HarnessProjectConfig): number;
export declare function operationSupervisorTurnTimeoutSeconds(config: HarnessProjectConfig): number;
export declare function supervisorTurnConfig(config: HarnessProjectConfig): HarnessProjectConfig;
export declare function supervisorTurnTimedOutV1(session: Pick<WorkerSession, "exitCode" | "stdout" | "stderr">): boolean;
export declare function ensureOperationSupervisor(root: string, config: HarnessProjectConfig, contract: TaskContract, selection: AgentExecutionSelection | undefined, options?: EnsureSupervisorOptions): Promise<OperationSupervisorHandle | undefined>;
export declare function consolidateWithOperationSupervisor(root: string, config: HarnessProjectConfig, contract: TaskContract, supervisorSelection: AgentExecutionSelection | undefined, input: SupervisorConsolidationInput): Promise<SupervisorConsolidationResult>;
export declare function maybeRotateOperationSupervisor(root: string, config: HarnessProjectConfig, contract: TaskContract, selection: AgentExecutionSelection | undefined): Promise<OperationSupervisorHandle | undefined>;
export declare function settleDrainingSupervisorGenerations(root: string, operationId: string): Promise<OperationRecordV2>;
export declare function handoffPrompt(operation: OperationRecordV2, generation: number, checkpointArtifact: string): string;
export {};
