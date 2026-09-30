import type { AssuranceLevel, ImplementationRoute } from "./contracts.js";
import type { ResourceClaimV1, WorkGraphV1 } from "./workGraph.js";
import { type CanonicalRole, type ToolPackV1 } from "../participants/index.js";
import type { GroundedProcedureStepV1 } from "../knowledge/index.js";
import { type ToolActionKindV1 } from "../security/actionKinds.js";
export interface HumanDecisionRequirementV1 {
    kind: "ACTION_AUTHORIZATION";
    action: ToolActionKindV1;
}
export interface ResolvedOperationPolicyV1 {
    version: 1;
    projectId: string;
    operationId: string;
    operationExecutionRevision: number;
    candidateRevision: number;
    candidateDigest: string;
    controllerEpoch: number;
    intent: string;
    route: ImplementationRoute;
    minimumAssurance: AssuranceLevel;
    policyVersions: Record<string, string>;
    policyDigests: Record<string, string>;
    validationPolicy: unknown;
    reviewPolicy: unknown;
    deliveryPolicy: unknown;
    knowledgePolicy: unknown;
    contextPolicy: unknown;
    allowedExternalEffects: string[];
    humanDecisionRequirements: HumanDecisionRequirementV1[];
    digest: string;
}
export interface RoleInvocationPolicyV1 {
    version: 1;
    operationId: string;
    operationPolicyDigest: string;
    participantId: string;
    role: CanonicalRole;
    workUnitIds: string[];
    scope: string[];
    competencies: string[];
    toolPack: ToolPackV1;
    resourceClaims: Array<{
        workUnitId: string;
        claim: ResourceClaimV1;
    }>;
    outputContract: string;
    constraints: Record<string, unknown>;
    digest: string;
}
export interface SkillManifestEntryV1 {
    skillId: string;
    competency: string;
    kind: "role" | "cross-cutting" | "technology" | "project" | "ephemeral";
    procedure: string[];
    procedureDigest: string;
    sourcePackDigest?: string;
    trustDecisionDigest?: string;
    provenance: {
        kind: "skill-catalog";
        digest: string;
    } | {
        kind: "accepted-knowledge";
        groundedProcedure: GroundedProcedureStepV1[];
    };
}
export interface SkillManifestScopeV1 {
    operationId: string;
    operationExecutionRevision: number;
    candidateRevision: number;
    candidateDigest: string;
    controllerEpoch: number;
    participantId: string;
    workUnitIds: string[];
    competencies: string[];
}
export type SkillManifestExecutionIdentityV1 = Pick<SkillManifestScopeV1, "operationId" | "operationExecutionRevision" | "candidateRevision" | "candidateDigest" | "controllerEpoch">;
export interface SkillManifestV1 {
    version: 1;
    lifetime: {
        kind: "operation";
        operationId: string;
    };
    scope: SkillManifestScopeV1;
    entries: SkillManifestEntryV1[];
    digest: string;
}
export interface ExecutionBlueprintV2 {
    version: 2;
    projectId: string;
    operationId: string;
    operationExecutionRevision: number;
    candidateRevision: number;
    candidateDigest: string;
    controllerEpoch: number;
    resolvedOperationPolicy: ResolvedOperationPolicyV1;
    workGraph: WorkGraphV1;
    participantPlan: unknown;
    executionCatalog: unknown;
    participants: Array<{
        participantId: string;
        role: CanonicalRole;
        specialization: string;
        roleInvocationPolicy: RoleInvocationPolicyV1;
        toolPack: ToolPackV1;
        resourceClaims: Array<{
            workUnitId: string;
            claim: ResourceClaimV1;
        }>;
        validationResolution: unknown;
        outputContract: string;
        skillManifestDigest: string;
    }>;
    validationResolution: unknown;
    digest: string;
}
export interface ExecutionBindingV2 {
    version: 2;
    operationId: string;
    operationExecutionRevision: number;
    candidateRevision: number;
    candidateDigest: string;
    controllerEpoch: number;
    executionBlueprintDigest: string;
    operationPolicyDigest: string;
    participantId: string;
    participantGeneration: string;
    roleInvocationPolicyDigest: string;
    skillManifestDigest: string;
    runtime: {
        runtimeId: string;
        provider: string;
        modelId: string;
        model: string;
        sessionId: string;
    };
    contextManifestDigest: string;
    promptManifestDigest: string;
    outputContract: string;
    leaseIdentities: string[];
    digest: string;
}
export declare function compileResolvedOperationPolicy(input: Omit<ResolvedOperationPolicyV1, "version" | "digest">): ResolvedOperationPolicyV1;
export declare function compileRoleInvocationPolicy(input: Omit<RoleInvocationPolicyV1, "version" | "digest">): RoleInvocationPolicyV1;
export declare function compileSkillManifest(input: {
    scope: SkillManifestScopeV1;
    skills: readonly {
        id: string;
        kind: SkillManifestEntryV1["kind"];
        competencies: readonly {
            id: string;
        }[];
        proceduralSteps: readonly string[];
        sourcePackDigest?: string;
        trustDecisionDigest?: string;
        groundedProcedure?: GroundedProcedureStepV1[];
        skillCatalogDigest?: string;
    }[];
}): SkillManifestV1;
export declare function compileExecutionBinding(input: Omit<ExecutionBindingV2, "version" | "digest">): ExecutionBindingV2;
export declare function assertExecutionBlueprintV2(value: unknown): asserts value is ExecutionBlueprintV2;
export declare function assertExecutionBindingV2(value: unknown): asserts value is ExecutionBindingV2;
export declare function createExecutionBlueprintV2(input: Omit<ExecutionBlueprintV2, "version" | "digest">): ExecutionBlueprintV2;
export declare function assertResolvedOperationPolicyV1(value: unknown): asserts value is ResolvedOperationPolicyV1;
export declare function assertRoleInvocationPolicyV1(value: unknown): asserts value is RoleInvocationPolicyV1;
export declare function assertSkillManifestV1(value: unknown): asserts value is SkillManifestV1;
export declare function recompileSkillManifestScope(manifest: SkillManifestV1, scope: SkillManifestScopeV1): SkillManifestV1;
