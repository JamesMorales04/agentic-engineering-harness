import type { HarnessProjectConfig, TaskContract, ValidationCheck } from "./types.js";
export declare function sealTask(root: string, config: HarnessProjectConfig, contract: TaskContract): Promise<string>;
export declare function verifyTaskSeal(root: string, contract: TaskContract, required?: boolean): Promise<ValidationCheck>;
