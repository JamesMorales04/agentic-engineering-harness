import type { ResolvedOperationPolicyV1 } from "./executionIdentity.js";
import type { CandidateAssuranceCompilationV1 } from "./candidateAssurance.js";
import { type CandidateRevisionV1 } from "../operations/v2Contracts.js";
import type { OperationRecordV2 } from "../operations/state.js";
import type { ValidationReport } from "../core/types.js";
import type { AssuranceLevel } from "./contracts.js";
import type { ObjectiveCompletionIdentityV1 } from "./objectiveCompletion.js";
export interface VerificationRequirementV1 {
    version: 1;
    id: string;
    assertionId: string;
    statement: string;
    minimumAssurance: AssuranceLevel;
    validationRequirementIds: string[];
    reviewDimensions: string[];
    leadRequired: boolean;
}
export interface AcceptanceEvidenceItemV1 {
    version: 1;
    id: string;
    assertionId: string;
    kind: "VALIDATION" | "REVIEW" | "LEAD" | "CERTIFICATION";
    status: "PASS" | "FAIL";
    identity: ObjectiveCompletionIdentityV1;
    strength: AssuranceLevel;
    provenance: {
        sourceId: string;
        digest: string;
        artifact?: string;
        executionBindingDigest?: string;
        actorId?: string;
        actorGeneration?: number;
        promptDigest?: string;
        assessment?: string;
    };
    dimension?: string;
    reviewerIdentity?: string;
    provider?: string;
}
export interface EvidenceBundleV1 {
    version: 1;
    identity: ObjectiveCompletionIdentityV1;
    candidate: CandidateRevisionV1;
    impactDigest: string;
    compilationDigest: string;
    requirements: VerificationRequirementV1[];
    evidence: AcceptanceEvidenceItemV1[];
    digest: string;
}
export interface AcceptanceOracleDispositionV1 {
    version: 1;
    disposition: "ACCEPTED" | "REJECTED";
    identity: ObjectiveCompletionIdentityV1;
    evidenceBundleDigest: string;
    requiredAssertionIds: string[];
    coveredAssertionIds: string[];
    certificationRequired: boolean;
    certification?: {
        status: "PASS" | "FAIL";
        identity: ObjectiveCompletionIdentityV1;
        provenanceDigest: string;
    };
    blockers: Array<{
        code: string;
        message: string;
    }>;
    digest: string;
}
export interface ManagedLeadAcceptanceEvidenceV1 {
    version: 1;
    status: "PASS" | "FAIL";
    operationId: string;
    candidate: CandidateRevisionV1;
    policyDigest: string;
    operationExecutionRevision: number;
    controllerEpoch: number;
    leadAgentId: string;
    leadGeneration: number;
    assertions: Array<{
        assertionId: string;
        verdict: "PASS" | "FAIL";
        rationale: string;
    }>;
    summary: string;
    unresolved: string[];
    promptDigest: string;
    responseDigest: string;
}
export interface AcceptanceOracleArtifactV1 {
    version: 1;
    operationId: string;
    identity: ObjectiveCompletionIdentityV1;
    evidenceBundle: EvidenceBundleV1;
    disposition: AcceptanceOracleDispositionV1;
    persistedAt: string;
}
export declare function currentObjectiveIdentityV1(operation: OperationRecordV2): ObjectiveCompletionIdentityV1;
export declare function leadAcceptanceRequiredV1(policy: ResolvedOperationPolicyV1): boolean;
export declare function resolveVerificationRequirementsV1(compilation: CandidateAssuranceCompilationV1, policy: ResolvedOperationPolicyV1): VerificationRequirementV1[];
export declare function buildAcceptanceEvidenceBundleV1(input: {
    operation: OperationRecordV2;
    compilation: CandidateAssuranceCompilationV1;
    report: ValidationReport;
    implementationIdentity: string;
    leadEvidence?: ManagedLeadAcceptanceEvidenceV1;
    certification?: {
        status: "PASS" | "FAIL";
        identity: ObjectiveCompletionIdentityV1;
        provenanceDigest: string;
    };
}): EvidenceBundleV1;
export declare function evaluateAcceptanceOracleV1(bundle: EvidenceBundleV1, evidenceStrength: CandidateAssuranceCompilationV1["evidenceStrength"], certification?: AcceptanceOracleDispositionV1["certification"]): AcceptanceOracleDispositionV1;
export declare function candidateForAcceptance(operation: OperationRecordV2): CandidateRevisionV1;
export declare function persistAcceptanceOracleArtifactV1(root: string, bundle: EvidenceBundleV1, disposition: AcceptanceOracleDispositionV1): Promise<string>;
export declare function loadCurrentAcceptanceOracleArtifactV1(root: string, operation: OperationRecordV2): Promise<AcceptanceOracleArtifactV1 | undefined>;
export declare function requireAcceptedCurrentOracleV1(root: string, operation: OperationRecordV2, candidate: CandidateRevisionV1): Promise<AcceptanceOracleArtifactV1>;
