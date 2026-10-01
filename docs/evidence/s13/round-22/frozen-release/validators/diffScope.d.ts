import type { TaskContract, ValidationCheck } from "../core/types.js";
export declare function validateDiffScope(changedFiles: string[], contract: TaskContract, globalFrozen?: string[]): ValidationCheck[];
