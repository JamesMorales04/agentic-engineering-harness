import type { HarnessProjectConfig, TaskContract, WorkerSession } from "../core/types.js";
import type { AgentExecutionSelection } from "../agents/types.js";
import type { ExecutionCatalogV1 } from "../architecture/executionCatalog.js";
import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { type CandidateImpactAssessmentRuntimeV1, type ChangeSetV1 } from "./assembler.js";
export interface RepairCandidateMutationResultV1 {
    session: WorkerSession;
    changeSet?: ChangeSetV1;
    candidate?: CandidateRevisionV1;
    impact?: import("./assembler.js").CandidateImpactV1;
}
export declare function assertCompiledRepairer(selection: AgentExecutionSelection | undefined, catalog: ExecutionCatalogV1 | undefined): asserts selection is AgentExecutionSelection;
export declare function executeRepairerCandidateMutation(input: {
    root: string;
    stateRoot: string;
    operationId: string;
    taskId: string;
    workUnitId: string;
    phase: string;
    config: HarnessProjectConfig;
    contract: TaskContract;
    selection: AgentExecutionSelection | undefined;
    executionCatalog: ExecutionCatalogV1 | undefined;
    allowedScope: readonly string[];
    forbiddenScope: readonly string[];
    prompt: string;
    execute: (isolatedRoot: string, participantId: string) => Promise<WorkerSession>;
    prepareWorkspace?: (isolatedRoot: string) => Promise<void>;
    semanticAssessment?: CandidateImpactAssessmentRuntimeV1;
}): Promise<RepairCandidateMutationResultV1>;
export declare function rejectRepairCandidateChangeSet(input: {
    root: string;
    stateRoot: string;
    operationId: string;
    taskId: string;
    workUnitId: string;
    config: HarnessProjectConfig;
    contract: TaskContract;
    rejectedChangeSet: ChangeSetV1;
    allowedScope: readonly string[];
    forbiddenScope: readonly string[];
    prepareWorkspace?: (isolatedRoot: string) => Promise<void>;
    semanticAssessment?: CandidateImpactAssessmentRuntimeV1;
}): Promise<{
    candidate: CandidateRevisionV1;
    impact: import("./assembler.js").CandidateImpactV1;
}>;
/** Files that define the frozen task, validation policy, or runtime policy cannot be changed by repair. */
export declare function repairProtectedPaths(config: HarnessProjectConfig, contract: TaskContract): string[];
