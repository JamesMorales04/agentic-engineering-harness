import { z } from "zod";
import type { AssuranceLevel, ImplementationRoute } from "./contracts.js";
export declare const workRiskValues: readonly ["low", "medium", "high", "critical"];
export type WorkRisk = (typeof workRiskValues)[number];
export declare const workRiskSchema: z.ZodEnum<{
    high: "high";
    medium: "medium";
    low: "low";
    critical: "critical";
}>;
export declare const changeKindValues: readonly ["source", "test", "schema", "config", "docs", "dependency", "infrastructure", "security"];
export type ChangeKind = (typeof changeKindValues)[number];
export declare const changeKindSchema: z.ZodEnum<{
    source: "source";
    test: "test";
    schema: "schema";
    config: "config";
    docs: "docs";
    dependency: "dependency";
    infrastructure: "infrastructure";
    security: "security";
}>;
export declare const graphWorkUnitStatusValues: readonly ["PENDING", "IN_PROGRESS", "COMPLETED", "BLOCKED"];
export type GraphWorkUnitStatus = (typeof graphWorkUnitStatusValues)[number];
export declare const graphWorkUnitStatusSchema: z.ZodEnum<{
    PENDING: "PENDING";
    IN_PROGRESS: "IN_PROGRESS";
    COMPLETED: "COMPLETED";
    BLOCKED: "BLOCKED";
}>;
export declare const resourceClaimModeValues: readonly ["SHARED_READ", "EXCLUSIVE_WRITE", "ORDERED_SEQUENCE"];
export type ResourceClaimMode = (typeof resourceClaimModeValues)[number];
export declare const resourceClaimModeSchema: z.ZodEnum<{
    SHARED_READ: "SHARED_READ";
    EXCLUSIVE_WRITE: "EXCLUSIVE_WRITE";
    ORDERED_SEQUENCE: "ORDERED_SEQUENCE";
}>;
export interface ResourceClaimV1 {
    version: 1;
    resource: string;
    mode: ResourceClaimMode;
    order?: number;
}
export declare const resourceClaimSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    resource: z.ZodString;
    mode: z.ZodEnum<{
        SHARED_READ: "SHARED_READ";
        EXCLUSIVE_WRITE: "EXCLUSIVE_WRITE";
        ORDERED_SEQUENCE: "ORDERED_SEQUENCE";
    }>;
    order: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export interface WorkUnitV1 {
    version: 1;
    id: string;
    objective: string;
    scope: string[];
    dependencies: string[];
    requirementRefs: string[];
    acceptanceRefs: string[];
    competencies: string[];
    riskTags: string[];
    changeKinds: ChangeKind[];
    risk: WorkRisk;
    status: GraphWorkUnitStatus;
    resourceClaims: ResourceClaimV1[];
}
export declare const workUnitV1Schema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    id: z.ZodString;
    objective: z.ZodString;
    scope: z.ZodArray<z.ZodString>;
    dependencies: z.ZodArray<z.ZodString>;
    requirementRefs: z.ZodArray<z.ZodString>;
    acceptanceRefs: z.ZodArray<z.ZodString>;
    competencies: z.ZodArray<z.ZodString>;
    riskTags: z.ZodArray<z.ZodString>;
    changeKinds: z.ZodArray<z.ZodEnum<{
        source: "source";
        test: "test";
        schema: "schema";
        config: "config";
        docs: "docs";
        dependency: "dependency";
        infrastructure: "infrastructure";
        security: "security";
    }>>;
    risk: z.ZodEnum<{
        high: "high";
        medium: "medium";
        low: "low";
        critical: "critical";
    }>;
    status: z.ZodEnum<{
        PENDING: "PENDING";
        IN_PROGRESS: "IN_PROGRESS";
        COMPLETED: "COMPLETED";
        BLOCKED: "BLOCKED";
    }>;
    resourceClaims: z.ZodDefault<z.ZodArray<z.ZodObject<{
        version: z.ZodLiteral<1>;
        resource: z.ZodString;
        mode: z.ZodEnum<{
            SHARED_READ: "SHARED_READ";
            EXCLUSIVE_WRITE: "EXCLUSIVE_WRITE";
            ORDERED_SEQUENCE: "ORDERED_SEQUENCE";
        }>;
        order: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>;
}, z.core.$strict>;
export interface WorkGraphV1 {
    version: 1;
    taskId: string;
    objective: string;
    route: ImplementationRoute;
    assurance: AssuranceLevel;
    requirementRefs: string[];
    acceptanceRefs: string[];
    units: WorkUnitV1[];
}
export declare const workGraphV1Schema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    taskId: z.ZodString;
    objective: z.ZodString;
    route: z.ZodEnum<{
        NO_AGENT: "NO_AGENT";
        DIRECT: "DIRECT";
        DELEGATED: "DELEGATED";
        FORMAL_SDD: "FORMAL_SDD";
    }>;
    assurance: z.ZodEnum<{
        NONE: "NONE";
        STANDARD: "STANDARD";
        ELEVATED: "ELEVATED";
        CRITICAL: "CRITICAL";
    }>;
    requirementRefs: z.ZodArray<z.ZodString>;
    acceptanceRefs: z.ZodArray<z.ZodString>;
    units: z.ZodArray<z.ZodObject<{
        version: z.ZodLiteral<1>;
        id: z.ZodString;
        objective: z.ZodString;
        scope: z.ZodArray<z.ZodString>;
        dependencies: z.ZodArray<z.ZodString>;
        requirementRefs: z.ZodArray<z.ZodString>;
        acceptanceRefs: z.ZodArray<z.ZodString>;
        competencies: z.ZodArray<z.ZodString>;
        riskTags: z.ZodArray<z.ZodString>;
        changeKinds: z.ZodArray<z.ZodEnum<{
            source: "source";
            test: "test";
            schema: "schema";
            config: "config";
            docs: "docs";
            dependency: "dependency";
            infrastructure: "infrastructure";
            security: "security";
        }>>;
        risk: z.ZodEnum<{
            high: "high";
            medium: "medium";
            low: "low";
            critical: "critical";
        }>;
        status: z.ZodEnum<{
            PENDING: "PENDING";
            IN_PROGRESS: "IN_PROGRESS";
            COMPLETED: "COMPLETED";
            BLOCKED: "BLOCKED";
        }>;
        resourceClaims: z.ZodDefault<z.ZodArray<z.ZodObject<{
            version: z.ZodLiteral<1>;
            resource: z.ZodString;
            mode: z.ZodEnum<{
                SHARED_READ: "SHARED_READ";
                EXCLUSIVE_WRITE: "EXCLUSIVE_WRITE";
                ORDERED_SEQUENCE: "ORDERED_SEQUENCE";
            }>;
            order: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export interface WorkExpansionRequestV1 {
    version: 1;
    taskId: string;
    sourceUnitId: string;
    reason: string;
    requestedCompetencies: string[];
    requestedScope: string[];
    requestedAcceptanceRefs: string[];
}
export declare const workExpansionRequestV1Schema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    taskId: z.ZodString;
    sourceUnitId: z.ZodString;
    reason: z.ZodString;
    requestedCompetencies: z.ZodArray<z.ZodString>;
    requestedScope: z.ZodArray<z.ZodString>;
    requestedAcceptanceRefs: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
export declare function validateWorkGraph(value: unknown): WorkGraphV1;
export declare function resourceClaimConflicts(left: readonly ResourceClaimV1[], right: readonly ResourceClaimV1[]): string[];
export declare function resourceClaimOrderingViolations(units: ReadonlyArray<{
    id: string;
    resourceClaims: readonly ResourceClaimV1[];
}>): string[];
export declare function assertAcyclicWorkGraph(graph: WorkGraphV1): void;
export declare function createWorkGraph(input: Omit<WorkGraphV1, "version">): WorkGraphV1;
