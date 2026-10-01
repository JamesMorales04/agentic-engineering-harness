import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";
import type { HarnessProjectConfig, TaskContract, WorkerSession } from "../core/types.js";
import type { ChangeSetV1 } from "./assembler.js";
export interface IsolatedCandidateExecutionV1 {
    session: WorkerSession;
    changeSet?: ChangeSetV1;
}
/**
 * Materialize the exact source state of a frozen CandidateRevision into a
 * fresh worktree: HEAD plus the candidate's tracked diff plus untracked
 * non-ignored files. The caller owns worktree creation/removal.
 */
export declare function materializeCandidateState(sourceRoot: string, targetRoot: string, candidate: CandidateRevisionV1): Promise<void>;
/**
 * Run a single DIRECT participant against an isolated snapshot of the current
 * candidate and return its source diff. The caller owns assembly and binding.
 */
export declare function executeIsolatedCandidateMutation(input: {
    root: string;
    operationId: string;
    taskId: string;
    workUnitId: string;
    candidate: CandidateRevisionV1;
    config: HarnessProjectConfig;
    contract: TaskContract;
    execute: (isolatedRoot: string) => Promise<WorkerSession>;
    prepareWorkspace?: (isolatedRoot: string) => Promise<void>;
}): Promise<IsolatedCandidateExecutionV1>;
/**
 * Capture the exact inverse of a previously assembled ChangeSet from a fresh
 * snapshot of the now-current candidate. The inverse is still returned as a
 * ChangeSet so callers can advance candidate lineage when rejecting a repair.
 */
export declare function captureInverseCandidateChangeSet(input: {
    root: string;
    operationId: string;
    taskId: string;
    workUnitId: string;
    candidate: CandidateRevisionV1;
    config: HarnessProjectConfig;
    contract: TaskContract;
    rejectedChangeSet: ChangeSetV1;
    prepareWorkspace?: (isolatedRoot: string) => Promise<void>;
}): Promise<ChangeSetV1 | undefined>;
