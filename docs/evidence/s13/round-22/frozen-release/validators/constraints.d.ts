import type { TaskContract, ValidationCheck } from "../core/types.js";
export declare function validateDiffBudget(contract: TaskContract, stats: {
    files: number;
    added: number;
    deleted: number;
}): ValidationCheck[];
