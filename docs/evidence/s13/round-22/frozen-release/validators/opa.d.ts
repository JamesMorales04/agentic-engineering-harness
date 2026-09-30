import type { HarnessProjectConfig, TaskContract, ValidationCheck } from "../core/types.js";
import type { PolicyEvidence } from "./evidence.js";
export interface OpaExecutionIdentity {
    operationId?: string;
    operationKind?: string;
    logicalAgent?: string;
    role?: string;
    profile?: string;
    domains?: string[];
    risk?: string;
    runtime?: string;
    modelAlias?: string;
    permissions?: object;
}
export declare function buildOpaInput(contract: TaskContract, changedFiles: string[], frozenChangedFiles: string[], evidence: PolicyEvidence, executionIdentity?: OpaExecutionIdentity): Record<string, unknown>;
export declare function runOpaPolicies(root: string, config: HarnessProjectConfig, contract: TaskContract, changedFiles: string[], frozenChangedFiles: string[], evidence: PolicyEvidence, policyRoot?: string, executionIdentity?: OpaExecutionIdentity): Promise<ValidationCheck>;
