import type { HarnessProjectConfig, ValidationCheck } from "../core/types.js";
import type { ValidationContext } from "./types.js";
export declare function snapshotGraph(root: string, config: HarnessProjectConfig, taskId: string, phase: "before" | "after"): Promise<string | undefined>;
export declare function runGraphifyValidator(context: ValidationContext): Promise<ValidationCheck>;
