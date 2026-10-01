import type { ValidationCheck } from "../../core/types.js";
import type { BddExecutionResult, ContractVerificationResult, IntegrationEnvironmentResult, TestExecutionResult } from "./types.js";
export type NormalizedValidationResult = TestExecutionResult | BddExecutionResult | IntegrationEnvironmentResult | ContractVerificationResult;
export declare function persistRawArtifact(root: string, directory: string, id: string, stdout: string, stderr: string): Promise<string>;
export declare function resultCheck(id: string, category: string, result: NormalizedValidationResult, required: boolean): ValidationCheck;
export declare function parseJson(value: string): unknown;
export declare function stableFingerprint(value: unknown): string;
