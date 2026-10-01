import { loadProjectConfig, loadTaskContract } from "../core/config.js";
import type { TaskRunResult } from "../core/run.js";
import type { ImplementationRoute } from "../architecture/contracts.js";
import { startDetachedOperation, waitForOperation } from "../operations/controller.js";
import type { OperationRecordV2 } from "../operations/state.js";
import { prepareGithubIssueTask } from "./intake.js";
export interface IssueWorkflowOptions {
    profile?: string;
    refresh?: boolean;
    force?: boolean;
}
export interface ManagedIssueImportResult {
    operationId: string;
    taskId: string;
    route: ImplementationRoute;
    snapshot: {
        repository: string;
        number: number;
        contentSha256: string;
        path: string;
    };
    traceability?: string;
}
export interface IssueWorkflowDependencies {
    loadConfig?: typeof loadProjectConfig;
    importIssue?: typeof importIssueThroughManagedOperation;
    startOperation?: typeof startDetachedOperation;
    waitForOperation?: typeof waitForOperation;
    nodeExecutable?: string;
    entryFile?: string;
}
/**
 * Import an existing GitHub issue through the managed controller authority path. The import runs
 * inside a controller-owned change operation whose deterministic normalization policy, candidate
 * revision and epoch authorize the bounded Planner launch; the sealed TaskContract and the frozen
 * snapshot persist under the control root.
 */
export declare function importIssueThroughManagedOperation(root: string, issueNumber: number, options?: IssueWorkflowOptions, dependencies?: Pick<IssueWorkflowDependencies, "loadConfig" | "startOperation" | "waitForOperation" | "nodeExecutable" | "entryFile">): Promise<ManagedIssueImportResult>;
/** Deterministic projection of the durable intake result; never re-derives product facts. */
export declare function issueImportResult(record: OperationRecordV2): ManagedIssueImportResult;
/**
 * Import an existing issue, then execute its sealed contract as a managed
 * controller run. Public delivery is owned by the accepted run finalizer;
 * this entrypoint never performs a pre-acceptance handoff.
 */
export declare function executeIssueWorkflow(root: string, issueNumber: number, options?: IssueWorkflowOptions, dependencies?: IssueWorkflowDependencies): Promise<{
    result: TaskRunResult;
    contract: Awaited<ReturnType<typeof loadTaskContract>>;
}>;
export { prepareGithubIssueTask };
