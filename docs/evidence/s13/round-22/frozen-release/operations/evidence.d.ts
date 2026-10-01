import type { OperationRecordV2 } from "./state.js";
export type UserFacingClaimSource = "operation-result" | "audit-report" | "validation-report" | "task-contract" | "control-plane-context" | "repository-context" | "inference";
export interface UserFacingClaim {
    text: string;
    source: UserFacingClaimSource;
    verified: boolean;
    artifact?: string;
    evidenceRefs?: string[];
    priority?: number;
}
export interface OperationEvidenceSummary {
    operationId: string;
    status: OperationRecordV2["status"];
    resultAvailable: boolean;
    auditReportAvailable: boolean;
    findingsAvailable: boolean;
    repositoryInspection: "not-started" | "started" | "completed";
    authoritativeSources: UserFacingClaimSource[];
}
export declare function summarizeOperationEvidence(operation: OperationRecordV2): OperationEvidenceSummary;
export declare function evidenceDisciplineInstruction(operation: OperationRecordV2): string;
export declare function claimFromOperation(text: string, operation: OperationRecordV2, artifact?: string): UserFacingClaim;
