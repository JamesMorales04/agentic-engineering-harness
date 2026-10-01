import type { AgentExecutionSelection } from "./types.js";
import { type ParallelismPlan } from "./parallelism.js";
import { type PlannerOutput, type WorkUnitOutput } from "./outputContracts.js";
import type { ControlPlaneSnapshot } from "../core/controlPlane.js";
import type { HarnessProjectConfig, TaskContract, ValidationReport, WorkerSession } from "../core/types.js";
import { type ExecutionBlueprint, type ParticipantAssignmentV1 } from "../architecture/participantPlan.js";
import type { ExecutionCatalogV1 } from "../architecture/executionCatalog.js";
import type { CandidateImpactAssessmentRuntimeV1, CandidateImpactV1, ChangeSetV1 } from "../candidates/assembler.js";
import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { resolveKnowledgeGate, type KnowledgeCacheV1, type KnowledgeLookupResultV1, type KnowledgeModeV1, type KnowledgePackV1, type KnowledgeResolutionV1 } from "../knowledge/index.js";
import type { ProjectStackProfileV1 } from "../participants/stack.js";
export interface DelegationExecutionResult {
    task: WorkUnitOutput;
    session: WorkerSession;
    changedFiles: string[];
    patch: string;
    status: "PASS" | "FAIL";
    message?: string;
    distributed?: boolean;
    candidate?: CandidateRevisionV1;
    impact?: CandidateImpactV1;
    changeSet?: ChangeSetV1;
}
export interface WaveExecutionSummary {
    wave: number;
    taskIds: string[];
    status: "PASS" | "FAIL";
    results: DelegationExecutionResult[];
    barrier?: ValidationReport;
}
export interface PlannerWaveResult {
    used: boolean;
    plan?: PlannerOutput;
    blueprint?: ExecutionBlueprint;
    schedule?: ParallelismPlan;
    waves: WaveExecutionSummary[];
    sessions: WorkerSession[];
    aggregateSession?: WorkerSession;
    report?: ValidationReport;
}
export declare function executePlannerWaves(input: {
    root: string;
    stateRoot: string;
    config: HarnessProjectConfig;
    contract: TaskContract;
    plannerSelection?: AgentExecutionSelection;
    librarianSelection?: AgentExecutionSelection;
    implementationSelection: AgentExecutionSelection;
    executionCatalog: ExecutionCatalogV1;
    controller?: ControlPlaneSnapshot;
    precomputedPlan?: PlannerOutput;
    semanticAssessment?: CandidateImpactAssessmentRuntimeV1;
    projectStack?: ProjectStackProfileV1;
    knowledgeMode?: KnowledgeModeV1;
    knowledgeCache?: KnowledgeCacheV1;
    knowledgeResolutions?: readonly KnowledgeResolutionV1[];
    knowledgeLookup?: (gap: Parameters<NonNullable<Parameters<typeof resolveKnowledgeGate>[0]["lookup"]>>[0]) => Promise<KnowledgePackV1 | KnowledgeLookupResultV1>;
    revalidate: () => Promise<ValidationReport>;
}): Promise<PlannerWaveResult>;
export declare function resolvePlannerKnowledge(plan: PlannerOutput, input: Pick<Parameters<typeof executePlannerWaves>[0], "contract" | "root" | "config" | "librarianSelection" | "knowledgeMode" | "knowledgeCache" | "knowledgeResolutions" | "knowledgeLookup"> & Partial<Pick<Parameters<typeof executePlannerWaves>[0], "stateRoot">>): Promise<KnowledgeResolutionV1[]>;
export declare function validatePlannerWavePlan(contract: TaskContract, plan: PlannerOutput): string[];
export declare function selectionForParticipant(base: AgentExecutionSelection, assignment: ParticipantAssignmentV1, catalog: ExecutionCatalogV1): AgentExecutionSelection;
/**
 * AEH-V2-0129: `workflow.planning.worktreeIsolation` defaults to true and is honored by per-unit
 * candidate worktrees. When it is explicitly disabled, same-workspace writers are serialized
 * deterministically (one work unit at a time) instead of running parallel writers, because
 * DELEGATED candidate assembly always captures one ChangeSet per unit.
 */
export declare function waveConcurrencyV1(planning: {
    worktreeIsolation?: boolean;
    maxWaveConcurrency?: number;
} | undefined, taskCount: number): number;
