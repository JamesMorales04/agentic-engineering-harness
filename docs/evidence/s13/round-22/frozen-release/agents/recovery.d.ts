import { z } from "zod";
import type { ValidationReport, WorkerSession } from "../core/types.js";
import type { FailureType, RecoveryMap, RecoveryStep } from "./types.js";
import { SemanticAssessmentServiceV1, type SemanticAssessmentBindingV1 } from "../semantic/assessment.js";
export declare const failureTypeValues: readonly ["PATCH_CONTEXT_MISMATCH", "TOOL_FAILURE", "MISSING_CONTEXT", "WRONG_AGENT", "VALIDATION_FAILURE", "REVIEW_FAILURE", "AMBIGUOUS_OUTPUT", "CONFLICTING_RESULTS"];
export interface FailureAssessmentV1 {
    version: 1;
    mechanism: "MODEL" | "HYBRID";
    classification: FailureType;
    evidenceRefs: string[];
    semanticAssessmentDigest: string;
    assessmentDigest: string;
}
export declare const failureAssessmentSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    mechanism: z.ZodEnum<{
        MODEL: "MODEL";
        HYBRID: "HYBRID";
    }>;
    classification: z.ZodEnum<{
        PATCH_CONTEXT_MISMATCH: "PATCH_CONTEXT_MISMATCH";
        TOOL_FAILURE: "TOOL_FAILURE";
        MISSING_CONTEXT: "MISSING_CONTEXT";
        WRONG_AGENT: "WRONG_AGENT";
        VALIDATION_FAILURE: "VALIDATION_FAILURE";
        REVIEW_FAILURE: "REVIEW_FAILURE";
        AMBIGUOUS_OUTPUT: "AMBIGUOUS_OUTPUT";
        CONFLICTING_RESULTS: "CONFLICTING_RESULTS";
    }>;
    evidenceRefs: z.ZodArray<z.ZodString>;
    semanticAssessmentDigest: z.ZodString;
    assessmentDigest: z.ZodString;
}, z.core.$strict>;
export interface FailureEvidence {
    report?: ValidationReport;
    worker?: WorkerSession;
    conflicting?: boolean;
    wrongAgent?: boolean;
    missingContext?: boolean;
    reviewFailure?: boolean;
}
export interface FailureClassificationDecisionV1 {
    classification: FailureType;
    mechanism: "DETERMINISTIC" | "MODEL" | "HYBRID";
    evidenceRefs: string[];
    assessmentDigest?: string;
    unknowns?: string[];
}
export declare function failureAssessmentDigest(assessment: Omit<FailureAssessmentV1, "assessmentDigest">): string;
export declare function classifyFailure(evidence: FailureEvidence): FailureType;
export declare function classifyFailureDecision(evidence: FailureEvidence): FailureClassificationDecisionV1;
export declare function classifyFailureWithSemanticAssessment(evidence: FailureEvidence, options: {
    service: SemanticAssessmentServiceV1;
    binding: SemanticAssessmentBindingV1;
    policyRevision: string;
}): Promise<FailureClassificationDecisionV1>;
export declare function resolveRecoveryStep(recovery: RecoveryMap, failureType: FailureType, attempt: number): RecoveryStep;
export declare function formatRecoveryAction(step: RecoveryStep, currentAgent: string): string;
