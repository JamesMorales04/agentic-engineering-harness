import type { HarnessProjectConfig, TaskContract } from "./types.js";
export declare function loadProjectConfig(root: string): Promise<HarnessProjectConfig>;
export declare function loadTaskContract(root: string, taskId: string, config: HarnessProjectConfig): Promise<TaskContract>;
