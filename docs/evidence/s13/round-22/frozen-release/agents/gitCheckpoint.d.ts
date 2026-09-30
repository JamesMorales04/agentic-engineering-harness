export interface WorktreeCheckpoint {
    createdAt: string;
    files: Map<string, Buffer | undefined>;
}
export declare function createWorktreeCheckpoint(root: string): Promise<WorktreeCheckpoint>;
export declare function rollbackWorktreeCheckpoint(root: string, checkpoint: WorktreeCheckpoint): Promise<string[]>;
