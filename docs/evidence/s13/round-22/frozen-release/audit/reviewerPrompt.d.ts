import type { TaskRisk, ValidationCheck } from "../core/types.js";
export interface AuditReviewerPromptRequest {
    request: string;
    files?: string[];
    domains?: string[];
    risk?: TaskRisk;
}
export interface AuditReviewerValidationCheck extends ValidationCheck {
    failureClass?: string;
}
export interface AuditReviewerPromptInput {
    input: AuditReviewerPromptRequest;
    reviewer: string;
    checks: AuditReviewerValidationCheck[];
    dirtyPaths: string[];
}
export declare function compileAuditReviewerPrompt({ input, reviewer, checks, dirtyPaths }: AuditReviewerPromptInput): string;
export declare function compactAuditValidationCheck(check: AuditReviewerValidationCheck): Record<string, unknown>;
