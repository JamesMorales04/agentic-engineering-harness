import type { AssuranceLevel, ImplementationRoute } from "../architecture/contracts.js";

export type { AssuranceLevel, ImplementationRoute } from "../architecture/contracts.js";

export const canonicalRoleValues = [
  "Lead/Director",
  "Operation Supervisor",
  "Explorer",
  "Librarian",
  "Planner",
  "Spec Manager",
  "Implementer",
  "Reviewer",
  "Repairer"
] as const;

export type CanonicalRole = (typeof canonicalRoleValues)[number];

/** AEH Agent responsibility classes include bounded actors that are not WorkGraph Participants. */
export const canonicalAgentRoleValues = [...canonicalRoleValues, "Semantic Assessor"] as const;
export type CanonicalAgentRole = (typeof canonicalAgentRoleValues)[number];

export const participantCapabilityValues = [
  "read",
  "write",
  "execute",
  "research",
  "plan",
  "specify",
  "implement",
  "review",
  "validate",
  "repair",
  "supervise",
  "delegate"
] as const;

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

export function isCanonicalRole(value: unknown): value is CanonicalRole {
  return typeof value === "string" && (canonicalRoleValues as readonly string[]).includes(value);
}

export function assertCanonicalRole(value: unknown): CanonicalRole {
  if (!isCanonicalRole(value)) throw new Error(`Unknown canonical participant role: ${String(value)}`);
  return value;
}

export interface ParticipantRoleSelectionV1 {
  version: 1;
  role: CanonicalRole;
  profileVersion: 1;
}

/** Selects a role contract without assigning a runtime or concrete agent identity. */
export function selectCanonicalRole(role: CanonicalRole): ParticipantRoleSelectionV1 {
  return { version: 1, role: assertCanonicalRole(role), profileVersion: 1 };
}
