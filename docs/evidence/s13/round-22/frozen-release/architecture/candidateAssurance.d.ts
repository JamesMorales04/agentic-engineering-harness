import type { CandidateImpactV1 } from "../candidates/assembler.js";
import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";
import type { AssuranceLevel } from "./contracts.js";
import { type ValidationRequirementKindV1, type ValidationRequirementV1, type ValidationResolutionV1 } from "./validationRequirements.js";
export declare const CANDIDATE_ASSURANCE_VERSION: 1;
export type CandidateAssuranceStatusV1 = "READY" | "BLOCKED";
export type CandidateAssuranceRiskV1 = "low" | "medium" | "high";
export type CandidateAssuranceProviderAdapterV1 = "playwright" | "visual" | "opengrep" | "trivy";
export declare function candidateAssuranceProviderAdapterV1(kind: ValidationRequirementKindV1, provider: string): CandidateAssuranceProviderAdapterV1 | undefined;
export interface CandidateIdentityBindingV1 {
    candidateId: string;
    revision: number;
    identityDigest: string;
}
export type BoundCandidateImpactV1 = CandidateImpactV1 & {
    candidate?: CandidateIdentityBindingV1;
};
export interface CandidateAssuranceReviewerCandidateV1 {
    identity: string;
    role: string;
    provider: string;
    readOnly: boolean;
}
export interface CandidateAssurancePolicyV1 {
    version: 1;
    digest: string;
    minimumAssurance: AssuranceLevel;
    independentReviewRequired: boolean;
    minimumIndependentReviewers: number;
    providerDiversity: boolean;
    allowedValidationKinds: ValidationRequirementKindV1[];
    evidenceStrength: AssuranceLevel;
}
export interface CandidateAssuranceBaseAssertionV1 {
    id: string;
    statement: string;
    requirementRefs: string[];
}
export interface CandidateAssuranceInputV1 {
    candidate: CandidateRevisionV1;
    impact: BoundCandidateImpactV1;
    policy: CandidateAssurancePolicyV1;
    implementationIdentity: string;
    risk: CandidateAssuranceRiskV1;
    reviewerCandidates: CandidateAssuranceReviewerCandidateV1[];
    baseValidationRequirements: ValidationRequirementV1[];
    validationResolution: ValidationResolutionV1;
    acceptanceAssertions: CandidateAssuranceBaseAssertionV1[];
}
export interface CandidateAssuranceReviewAssignmentV1 {
    reviewerIdentity: string;
    provider: string;
    dimensions: string[];
    candidate: CandidateIdentityBindingV1;
    impactDigest: string;
    policyDigest: string;
}
export interface CandidateAssuranceEvidenceStrengthV1 {
    minimumAssurance: AssuranceLevel;
    minimumIndependentReviewers: number;
    providerDiversity: boolean;
    requiredDimensions: string[];
}
export interface AcceptanceAssertionV1 {
    version: 1;
    id: string;
    statement: string;
    requirementRefs: string[];
    candidate: CandidateIdentityBindingV1;
    impactDigest: string;
    policyDigest: string;
    dimensions: string[];
    evidenceStrength: AssuranceLevel;
}
export interface CandidateAssuranceCompilationV1 {
    version: 1;
    candidate: CandidateIdentityBindingV1;
    impactDigest: string;
    policyDigest: string;
    minimumAssurance: AssuranceLevel;
    reviewAssignments: CandidateAssuranceReviewAssignmentV1[];
    validationRequirements: ValidationRequirementV1[];
    acceptanceAssertions: AcceptanceAssertionV1[];
    evidenceStrength: CandidateAssuranceEvidenceStrengthV1;
    blockers: string[];
    status: CandidateAssuranceStatusV1;
    digest: string;
}
/**
 * The canonical typed CandidateImpact review-dimension vocabulary. The semantic assessment contract
 * is constrained to exactly these typed dimensions so model output cannot fabricate a validation
 * obligation for a free-form dimension: every accepted dimension has one deterministic
 * validation-kind mapping (and a bounded assurance floor), and the model cannot widen it.
 */
export declare const candidateReviewDimensionValues: readonly ["security", "authentication/authorization", "public API", "migration/schema", "dependency/supply chain", "UI/browser", "UI/visual", "architecture", "concurrency", "operations", "behavior.correctness"];
export type CandidateReviewDimensionV1 = (typeof candidateReviewDimensionValues)[number];
export declare function candidateImpactValidationRequirementsV1(impact: BoundCandidateImpactV1): ValidationRequirementV1[];
export declare function compileCandidateAssuranceV1(input: CandidateAssuranceInputV1): CandidateAssuranceCompilationV1;
