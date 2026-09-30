import { z } from "zod";
import type { AssuranceLevel, ImplementationRoute } from "./contracts.js";
import type { WorkGraphV1 } from "./workGraph.js";
import { type CanonicalRole, type ProjectStackProfileV1, type ToolPackV1 } from "../participants/index.js";
import { type KnowledgeResolutionV1 } from "../knowledge/index.js";
import type { ExecutionCatalogV1 } from "./executionCatalog.js";
import { type CandidateRevisionV1 } from "../operations/v2Contracts.js";
import type { ValidationResolutionV1, ValidationRequirementV1 } from "./validationRequirements.js";
import { type ExecutionBlueprintV2, type ResolvedOperationPolicyV1, type RoleInvocationPolicyV1, type SkillManifestExecutionIdentityV1, type SkillManifestV1 } from "./executionIdentity.js";
export declare const participantRoleValues: readonly ["Lead/Director", "Operation Supervisor", "Explorer", "Librarian", "Planner", "Spec Manager", "Implementer", "Reviewer", "Repairer"];
export type ParticipantRole = CanonicalRole;
export declare const participantRoleSchema: z.ZodEnum<{
    Explorer: "Explorer";
    Planner: "Planner";
    Reviewer: "Reviewer";
    Librarian: "Librarian";
    "Spec Manager": "Spec Manager";
    "Lead/Director": "Lead/Director";
    "Operation Supervisor": "Operation Supervisor";
    Implementer: "Implementer";
    Repairer: "Repairer";
}>;
export interface ParticipantBudgetV1 {
    maxTokens: number;
    reservedTokens: number;
    maxConcurrent: number;
}
export interface ParticipantAssignmentV1 {
    participantId: string;
    role: ParticipantRole;
    specialization: string;
    competencies: string[];
    skills: string[];
    toolPack: ToolPackV1;
    budget: ParticipantBudgetV1;
    workUnitIds: string[];
    skillManifest: SkillManifestV1;
    roleInvocationPolicy?: RoleInvocationPolicyV1;
}
export interface ParticipantPlanV1 {
    version: 1;
    taskId: string;
    route: ImplementationRoute;
    assurance: AssuranceLevel;
    assignments: ParticipantAssignmentV1[];
    reviewDimensions: string[];
    knowledgeRefs: string[];
    executionCatalogDigest?: string;
    compilerDigest: string;
}
export type ExecutionBlueprint = ExecutionBlueprintV2 & {
    taskId: string;
    plan: ParticipantPlanV1;
    waves: string[][];
    deterministicGates: string[];
    executionCatalog: ExecutionCatalogV1;
    validationRequirements: ValidationRequirementV1[];
    candidate: CandidateRevisionV1;
};
export interface ParticipantCompilerInputV1 {
    graph: WorkGraphV1;
    executionIdentity: SkillManifestExecutionIdentityV1;
    availableCompetencies?: string[];
    availableSkills?: string[];
    knowledgeRefs?: string[];
    maxTokens?: number;
    defaultToolPack?: ToolPackV1;
    projectStack?: ProjectStackProfileV1;
    knowledgeResolution?: KnowledgeResolutionV1;
    knowledgeResolutions?: readonly KnowledgeResolutionV1[];
    executionCatalog?: ExecutionCatalogV1;
    validationRequirements?: readonly ValidationRequirementV1[];
    validationResolution?: ValidationResolutionV1;
    maxParticipants?: number;
    maxConcurrent?: number;
}
export declare function compileParticipantPlan(input: ParticipantCompilerInputV1): ParticipantPlanV1;
export declare function compileExecutionBlueprint(input: Omit<ParticipantCompilerInputV1, "executionIdentity"> & {
    candidate: CandidateRevisionV1;
    executionCatalog: ExecutionCatalogV1;
    controllerEpoch: number;
    operationExecutionRevision: number;
    resolvedOperationPolicy: ResolvedOperationPolicyV1;
}): ExecutionBlueprint;
