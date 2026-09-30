import type { HarnessProjectConfig, RequirementTrace } from "./types.js";
export interface SddValidationResult {
    ok: boolean;
    missing: string[];
    issues: string[];
    requirements: RequirementTrace[];
}
export declare function createSddChange(root: string, taskId: string, title: string, config?: HarnessProjectConfig): Promise<string>;
export declare function validateSddChange(root: string, taskId: string, config?: HarnessProjectConfig): Promise<SddValidationResult>;
export declare function formatTraceabilityMatrix(requirements: RequirementTrace[]): string;
