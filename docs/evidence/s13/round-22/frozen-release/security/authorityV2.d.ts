import { type CandidateRevisionV1 } from "../operations/v2Contracts.js";
export type CapabilityNameV1 = "read" | "write" | "execute" | "network" | "spawn" | "delegate";
export type ReadCapabilityV1 = {
    capability: "read";
    paths: ReadonlyArray<string>;
};
export type WriteCapabilityV1 = {
    capability: "write";
    paths: ReadonlyArray<string>;
};
export type ExecuteCapabilityV1 = {
    capability: "execute";
    commands: ReadonlyArray<string>;
};
export type NetworkCapabilityV1 = {
    capability: "network";
    hosts: ReadonlyArray<string>;
};
export type SpawnCapabilityV1 = {
    capability: "spawn";
    roles: ReadonlyArray<string>;
    maxChildren: number;
};
export type DelegateCapabilityV1 = {
    capability: "delegate";
    roles: ReadonlyArray<string>;
};
export type CapabilityV1 = ReadCapabilityV1 | WriteCapabilityV1 | ExecuteCapabilityV1 | NetworkCapabilityV1 | SpawnCapabilityV1 | DelegateCapabilityV1;
export type AuthorityEnvelopeV1 = {
    version: 1;
    level: number;
    capabilities: ReadonlyArray<CapabilityNameV1>;
    scope?: ReadonlyArray<string>;
};
export type PermissionRequestV1 = {
    version: 1;
    requestId: string;
    operationId: string;
    participantId: string;
    projectId?: string;
    candidate: CandidateRevisionV1;
    capability: CapabilityNameV1 | CapabilityV1;
    requestedEnvelope: AuthorityEnvelopeV1;
    requestedAt: string;
    expiresAt: string;
    parentLeaseId?: string;
};
export type CapabilityLeaseV1 = {
    version: 1;
    leaseId: string;
    requestId: string;
    operationId: string;
    participantId: string;
    projectId?: string;
    candidate: CandidateRevisionV1;
    capability: CapabilityNameV1;
    envelope: AuthorityEnvelopeV1;
    issuedAt: string;
    expiresAt: string;
    parentLeaseId?: string;
};
export type AuthorityDecisionCodeV1 = "INVALID_REQUEST" | "EXPIRED" | "OPERATION_MISMATCH" | "CANDIDATE_MISMATCH" | "PROJECT_MISMATCH" | "PARENT_LEASE_REQUIRED" | "PARENT_LEASE_MISMATCH" | "AUTHORITY_ESCALATION" | "CAPABILITY_ESCALATION" | "SCOPE_ESCALATION";
export type AuthorityDecisionV1 = {
    allowed: boolean;
    reasons: ReadonlyArray<{
        code: AuthorityDecisionCodeV1;
        message: string;
    }>;
    lease?: CapabilityLeaseV1;
};
export type AuthorityEvaluationContextV1 = {
    operationId: string;
    projectId?: string;
    candidate: CandidateRevisionV1;
    now?: string | Date;
    parentLease?: CapabilityLeaseV1;
};
export declare function assertAuthorityEnvelopeV1(value: unknown): asserts value is AuthorityEnvelopeV1;
export declare function assertPermissionRequestV1(value: unknown): asserts value is PermissionRequestV1;
export declare function isMonotonicEnvelope(child: AuthorityEnvelopeV1, parent: AuthorityEnvelopeV1, requestedCapability: CapabilityNameV1, requestedScope?: ReadonlyArray<string>): boolean;
export declare function evaluatePermissionRequest(request: unknown, context: AuthorityEvaluationContextV1): AuthorityDecisionV1;
export declare const evaluatePermissionRequestV1: typeof evaluatePermissionRequest;
export declare function issueCapabilityLease(request: PermissionRequestV1, context: AuthorityEvaluationContextV1): AuthorityDecisionV1;
export declare const issueCapabilityLeaseV1: typeof issueCapabilityLease;
export declare function createCapabilityLease(request: PermissionRequestV1, context: AuthorityEvaluationContextV1): CapabilityLeaseV1;
