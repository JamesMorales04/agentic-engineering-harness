import type { AssuranceLevel, ImplementationRoute } from "../architecture/contracts.js";
export type { AssuranceLevel, ImplementationRoute } from "../architecture/contracts.js";
export declare const canonicalRoleValues: readonly ["Lead/Director", "Operation Supervisor", "Explorer", "Librarian", "Planner", "Spec Manager", "Implementer", "Reviewer", "Repairer"];
export type CanonicalRole = (typeof canonicalRoleValues)[number];
/** AEH Agent responsibility classes include bounded actors that are not WorkGraph Participants. */
export declare const canonicalAgentRoleValues: readonly ["Lead/Director", "Operation Supervisor", "Explorer", "Librarian", "Planner", "Spec Manager", "Implementer", "Reviewer", "Repairer", "Semantic Assessor"];
export type CanonicalAgentRole = (typeof canonicalAgentRoleValues)[number];
export declare const participantCapabilityValues: readonly ["read", "write", "execute", "research", "plan", "specify", "implement", "review", "validate", "repair", "supervise", "delegate"];
export type ParticipantCapability = (typeof participantCapabilityValues)[number];
export interface ToolPackV1 {
    version: 1;
    required: readonly string[];
    optional: readonly string[];
    forbidden: readonly string[];
}
export interface ContextMetadataV1 {
    requiredKinds: readonly string[];
    retrieval: "none" | "authorized";
    preservation: "verbatim" | "projectable" | "compressible" | "retrievable";
    budgetClass: "small" | "standard" | "large";
}
export interface DelegationMetadataV1 {
    allowed: boolean;
    allowedRoles: readonly CanonicalRole[];
    maxChildren: number;
    requiresSupervisorApproval: boolean;
}
export interface AuthorityMetadataV1 {
    canRead: boolean;
    canWrite: boolean;
    canExecute: boolean;
    canApprove: boolean;
    canSelfAccept: boolean;
    leaseRequired: boolean;
}
export interface RoleProfileV1 {
    version: 1;
    role: CanonicalRole;
    purpose: string;
    validRoutes: readonly ImplementationRoute[];
    validAssurance: readonly AssuranceLevel[];
    baseCapabilities: readonly ParticipantCapability[];
    maxCapabilities: readonly ParticipantCapability[];
    specializations: readonly string[];
    toolPack: ToolPackV1;
    context: ContextMetadataV1;
    delegation: DelegationMetadataV1;
    authority: AuthorityMetadataV1;
    defaultSkills: readonly string[];
    inputContract: string;
    outputContract: string;
    invocationConditions: readonly string[];
}
export declare function isCanonicalRole(value: unknown): value is CanonicalRole;
export declare function assertCanonicalRole(value: unknown): CanonicalRole;
export interface ParticipantRoleSelectionV1 {
    version: 1;
    role: CanonicalRole;
    profileVersion: 1;
}
/** Selects a role contract without assigning a runtime or concrete agent identity. */
export declare function selectCanonicalRole(role: CanonicalRole): ParticipantRoleSelectionV1;
