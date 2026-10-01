import type { HarnessProjectConfig, TaskContract } from "../core/types.js";
export interface DeliveryRecord {
    version: 1;
    taskId: string;
    status: "initialized" | "issue-created" | "branch-created" | "workspace-created" | "ready";
    createdAt: string;
    updatedAt: string;
    originatingBranch: string;
    github?: {
        repository: string;
        issueNumber?: number;
        issueUrl?: string;
        branch?: string;
        branchSha?: string;
    };
    paseo?: {
        workspaceId?: string;
        worktreePath?: string;
    };
}
export declare function handoffTask(root: string, config: HarnessProjectConfig, taskId: string, options?: {
    createWorkspace?: boolean;
}): Promise<DeliveryRecord>;
export declare function handoffSdd(root: string, config: HarnessProjectConfig, taskId: string): Promise<DeliveryRecord>;
export declare function seedDeliveryRecordFromIssue(root: string, config: HarnessProjectConfig, contract: TaskContract, issue: {
    repository: string;
    issueNumber: number;
    issueUrl: string;
}): Promise<DeliveryRecord>;
export declare function assertHandoffReady(root: string, contract: TaskContract): Promise<void>;
export declare function materializeTaskContext(controlRoot: string, workspaceRoot: string, config: HarnessProjectConfig, contract: TaskContract): Promise<void>;
export declare function loadDeliveryRecord(root: string, config: HarnessProjectConfig, taskId: string): Promise<DeliveryRecord | undefined>;
export declare function deliveryWorkspaceId(root: string, config: HarnessProjectConfig, taskId: string): Promise<string | undefined>;
export declare function deliveryWorkspacePath(root: string, config: HarnessProjectConfig, taskId: string): Promise<string | undefined>;
export declare function parseGithubRepository(remote: string): string | undefined;
export declare function renderPattern(pattern: string, contract: TaskContract, issue?: number): string;
export declare function renderIssueBody(root: string, contract: TaskContract, originatingBranch: string): Promise<string>;
export declare function inferGithubRepository(root: string): Promise<string>;
export declare function resolveGithubTokenOptional(preferred?: string): string | undefined;
export declare function resolveGithubToken(preferred?: string): string;
export declare function githubRequest<T = unknown>(base: string, token: string | undefined, endpoint: string, init?: RequestInit): Promise<T>;
