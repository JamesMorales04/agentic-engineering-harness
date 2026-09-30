import type { HarnessProjectConfig } from "../core/types.js";
import type { WorkUnitOutput } from "./outputContracts.js";
export interface TaskConflict {
    a: string;
    b: string;
    reasons: string[];
}
export interface ParallelismPlan {
    taskId: string;
    waves: string[][];
    conflicts: TaskConflict[];
    graphUsed: boolean;
    taskNodes?: Record<string, string[]>;
}
export declare function planParallelism(root: string, config: HarnessProjectConfig, taskId: string, tasks: WorkUnitOutput[]): Promise<ParallelismPlan>;
