import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";
export declare const OBJECTIVE_COMPLETION_VERSION: 1;
export type ObjectiveEvidenceStatusV1 = "PASS" | "FAIL";
export type ObjectiveParticipantStatusV1 = "REGISTERED" | "IDLE" | "RUNNING" | "COMPLETED" | "FAILED" | "BLOCKED" | "CANCELLED";
export interface ObjectiveCompletionIdentityV1 {
    operationId: string;
    candidate: CandidateRevisionV1;
    policyDigest: string;
    operationExecutionRevision: number;
    controllerEpoch: number;
}
export interface ObjectiveAssertionEvidenceV1 {
    assertionId: string;
    status: ObjectiveEvidenceStatusV1;
    identity: ObjectiveCompletionIdentityV1;
}
export interface ObjectiveCompletionInputV1 {
    version: 1;
    identity: ObjectiveCompletionIdentityV1;
    workspaceCandidate: CandidateRevisionV1;
    workGraph: {
        requiredWorkUnitIds: string[];
        accountedWorkUnitIds: string[];
    };
    validation: {
        requiredAssertionIds: string[];
        evidence: ObjectiveAssertionEvidenceV1[];
    };
    review: {
        requiredAssertionIds: string[];
        evidence: ObjectiveAssertionEvidenceV1[];
    };
    acceptance: {
        disposition: "ACCEPTED" | "REJECTED";
        requiredAssertionIds: string[];
        coveredAssertionIds: string[];
        identity: ObjectiveCompletionIdentityV1;
    };
    certification: {
        required: boolean;
        disposition?: "PASS" | "FAIL";
        identity?: ObjectiveCompletionIdentityV1;
    };
    delivery: {
        required: boolean;
        disposition: "RECONCILED" | "NOT_REQUIRED" | "PENDING";
        identity?: ObjectiveCompletionIdentityV1;
    };
    findings: Array<{
        candidate: CandidateRevisionV1;
        blocking: boolean;
    }>;
    participants: Array<{
        id: string;
        required: boolean;
        status: ObjectiveParticipantStatusV1;
    }>;
    terminalIdentity: ObjectiveCompletionIdentityV1;
}
export interface ObjectiveCompletionDecisionV1 {
    version: 1;
    complete: boolean;
    blockers: Array<{
        code: string;
        message: string;
    }>;
}
export declare function evaluateObjectiveCompletionV1(input: ObjectiveCompletionInputV1): ObjectiveCompletionDecisionV1;
