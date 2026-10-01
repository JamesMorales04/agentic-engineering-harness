import { type SemanticAssessmentBindingV1, type SemanticAssessmentRequestV1, type SemanticAssessmentV1, type SemanticEvidenceReceiptV1 } from "../semantic/assessment.js";
export type ProjectLanguageV1 = string;
export interface StackSignalV1 {
    id: string;
    source: string;
}
export type StackInterpretationV1 = "MODEL";
export interface ProjectStackProfileV1 {
    version: 1;
    interpretation: StackInterpretationV1;
    languages: readonly ProjectLanguageV1[];
    frameworks: readonly string[];
    packageManagers: readonly string[];
    databases: readonly string[];
    toolchains: readonly string[];
    signals: readonly StackSignalV1[];
    testFrameworks?: readonly string[];
    migrationMechanisms?: readonly string[];
    buildSystems?: readonly string[];
    versions?: Readonly<Record<string, string>>;
    projectSkillRoots?: readonly string[];
    unknowns?: readonly string[];
    inputDigest?: string;
    assessmentDigest?: string;
    bindingDigest?: string;
    policyRevision?: string;
    assessorDigest?: string;
}
export interface ProjectStackFileEvidenceV1 {
    path: string;
    content: string;
}
export interface ProjectStackEvidencePacketV1 {
    version: 1;
    items: readonly ProjectStackFileEvidenceV1[];
    receipts: readonly SemanticEvidenceReceiptV1[];
    digest: string;
    scannedFiles: number;
    truncated: boolean;
}
export interface ProjectStackEvidenceBoundsV1 {
    maxFiles: number;
    maxFileBytes: number;
    maxTotalBytes: number;
    maxScannedEntries: number;
    maxDepth: number;
    deadlineMs: number;
}
export declare const defaultProjectStackEvidenceBoundsV1: Readonly<ProjectStackEvidenceBoundsV1>;
export interface ProjectStackSemanticAssessorV1 {
    assess(request: SemanticAssessmentRequestV1, options?: {
        attemptBudget?: number;
    }): Promise<SemanticAssessmentV1>;
}
export interface ProjectStackSemanticAssessmentInjectionV1 {
    service: ProjectStackSemanticAssessorV1;
    binding: SemanticAssessmentBindingV1;
}
export interface ProjectStackDiscoveryOptionsV1 {
    semanticAssessment?: ProjectStackSemanticAssessmentInjectionV1;
    bounds?: Partial<ProjectStackEvidenceBoundsV1>;
}
export declare function collectProjectStackEvidence(root: string, input: {
    binding: SemanticAssessmentBindingV1;
    bounds?: Partial<ProjectStackEvidenceBoundsV1>;
}): Promise<ProjectStackEvidencePacketV1>;
export declare function projectStackAssessmentRequest(packet: ProjectStackEvidencePacketV1, binding: SemanticAssessmentBindingV1, correction?: string): {
    request: SemanticAssessmentRequestV1;
    packet: ProjectStackEvidencePacketV1;
};
export declare function discoverProjectStackProfile(root: string, options?: ProjectStackDiscoveryOptionsV1): Promise<ProjectStackProfileV1>;
