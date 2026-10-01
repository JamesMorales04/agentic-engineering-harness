import { z } from "zod";
export declare const implementationRouteValues: readonly ["NO_AGENT", "DIRECT", "DELEGATED", "FORMAL_SDD"];
export type ImplementationRoute = (typeof implementationRouteValues)[number];
export declare const implementationRouteSchema: z.ZodEnum<{
    NO_AGENT: "NO_AGENT";
    DIRECT: "DIRECT";
    DELEGATED: "DELEGATED";
    FORMAL_SDD: "FORMAL_SDD";
}>;
export declare const assuranceLevelValues: readonly ["NONE", "STANDARD", "ELEVATED", "CRITICAL"];
export type AssuranceLevel = (typeof assuranceLevelValues)[number];
export declare const assuranceLevelSchema: z.ZodEnum<{
    NONE: "NONE";
    STANDARD: "STANDARD";
    ELEVATED: "ELEVATED";
    CRITICAL: "CRITICAL";
}>;
export declare const workUnitStatusValues: readonly ["PENDING", "IN_PROGRESS", "COMPLETED", "BLOCKED"];
export type WorkUnitStatus = (typeof workUnitStatusValues)[number];
export declare const workUnitStatusSchema: z.ZodEnum<{
    PENDING: "PENDING";
    IN_PROGRESS: "IN_PROGRESS";
    COMPLETED: "COMPLETED";
    BLOCKED: "BLOCKED";
}>;
export interface RouteEvidence {
    route: ImplementationRoute;
    source: string;
    statement: string;
}
export declare const routeEvidenceSchema: z.ZodObject<{
    route: z.ZodEnum<{
        NO_AGENT: "NO_AGENT";
        DIRECT: "DIRECT";
        DELEGATED: "DELEGATED";
        FORMAL_SDD: "FORMAL_SDD";
    }>;
    source: z.ZodString;
    statement: z.ZodString;
}, z.core.$strict>;
export interface IntentDecision {
    version: 1;
    intent: string;
    route: ImplementationRoute;
    assurance: AssuranceLevel;
    routeEvidence: RouteEvidence[];
}
export declare const intentDecisionSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    intent: z.ZodString;
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
    routeEvidence: z.ZodArray<z.ZodObject<{
        route: z.ZodEnum<{
            NO_AGENT: "NO_AGENT";
            DIRECT: "DIRECT";
            DELEGATED: "DELEGATED";
            FORMAL_SDD: "FORMAL_SDD";
        }>;
        source: z.ZodString;
        statement: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export interface Progress {
    total: number;
    completed: number;
    inProgress: number;
    blocked: number;
}
export declare const progressSchema: z.ZodObject<{
    total: z.ZodNumber;
    completed: z.ZodNumber;
    inProgress: z.ZodNumber;
    blocked: z.ZodNumber;
}, z.core.$strict>;
export interface WorkUnit {
    id: string;
    title: string;
    status: WorkUnitStatus;
    dependsOn?: string[];
}
export declare const workUnitSchema: z.ZodObject<{
    id: z.ZodString;
    title: z.ZodString;
    status: z.ZodEnum<{
        PENDING: "PENDING";
        IN_PROGRESS: "IN_PROGRESS";
        COMPLETED: "COMPLETED";
        BLOCKED: "BLOCKED";
    }>;
    dependsOn: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
export interface FeatureCapsuleV1 {
    version: 1;
    /** `taskId`/`objective` are the canonical v2 names. The legacy aliases remain readable for migration. */
    taskId?: string;
    objective?: string;
    featureId?: string;
    intent?: string;
    scope?: {
        allowed: string[];
        forbidden?: string[];
    };
    constraints?: Record<string, unknown>;
    acceptance?: string[];
    contextRefs?: string[];
    candidateRevision?: Record<string, unknown>;
    route: ImplementationRoute;
    assurance: AssuranceLevel;
    routeEvidence: RouteEvidence[];
    progress: Progress;
    workUnits: WorkUnit[];
}
export declare const featureCapsuleV1Schema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    taskId: z.ZodOptional<z.ZodString>;
    objective: z.ZodOptional<z.ZodString>;
    featureId: z.ZodOptional<z.ZodString>;
    intent: z.ZodOptional<z.ZodString>;
    scope: z.ZodOptional<z.ZodObject<{
        allowed: z.ZodArray<z.ZodString>;
        forbidden: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    constraints: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    acceptance: z.ZodOptional<z.ZodArray<z.ZodString>>;
    contextRefs: z.ZodOptional<z.ZodArray<z.ZodString>>;
    candidateRevision: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
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
    routeEvidence: z.ZodArray<z.ZodObject<{
        route: z.ZodEnum<{
            NO_AGENT: "NO_AGENT";
            DIRECT: "DIRECT";
            DELEGATED: "DELEGATED";
            FORMAL_SDD: "FORMAL_SDD";
        }>;
        source: z.ZodString;
        statement: z.ZodString;
    }, z.core.$strict>>;
    progress: z.ZodObject<{
        total: z.ZodNumber;
        completed: z.ZodNumber;
        inProgress: z.ZodNumber;
        blocked: z.ZodNumber;
    }, z.core.$strict>;
    workUnits: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        title: z.ZodString;
        status: z.ZodEnum<{
            PENDING: "PENDING";
            IN_PROGRESS: "IN_PROGRESS";
            COMPLETED: "COMPLETED";
            BLOCKED: "BLOCKED";
        }>;
        dependsOn: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export interface ContractValidationSuccess<T> {
    ok: true;
    value: T;
}
export interface ContractValidationFailure {
    ok: false;
    issues: string[];
}
export type ContractValidation<T> = ContractValidationSuccess<T> | ContractValidationFailure;
export declare class InvalidArchitectureContractError extends Error {
    readonly code = "INVALID_ARCHITECTURE_CONTRACT";
    constructor(message: string);
}
export declare function createRouteEvidence(route: ImplementationRoute, source: string, statement: string): RouteEvidence;
export declare function createRouteEvidence(input: RouteEvidence): RouteEvidence;
export declare function validateRouteEvidence(value: unknown): ContractValidation<RouteEvidence>;
export declare function assertRouteEvidence(value: unknown): RouteEvidence;
export declare function createIntentDecision(intent: string, route: ImplementationRoute, assurance: AssuranceLevel, routeEvidence: RouteEvidence[]): IntentDecision;
export declare function validateIntentDecision(value: unknown): ContractValidation<IntentDecision>;
export declare function assertIntentDecision(value: unknown): IntentDecision;
export declare function assertIntentDecisionForRoute(value: unknown, route: ImplementationRoute): IntentDecision;
export declare function validateProgress(value: unknown): ContractValidation<Progress>;
export declare function assertProgress(value: unknown): Progress;
export declare function validateWorkUnit(value: unknown): ContractValidation<WorkUnit>;
export declare function assertWorkUnit(value: unknown): WorkUnit;
export declare function validateFeatureCapsule(value: unknown): ContractValidation<FeatureCapsuleV1>;
export declare function assertFeatureCapsule(value: unknown): FeatureCapsuleV1;
/** Serialize only schema-validated data in a stable, whitespace-free shape. */
export declare function serializeFeatureCapsule(value: unknown): string;
export declare function parseFeatureCapsule(serialized: string): FeatureCapsuleV1;
export declare const deserializeFeatureCapsule: typeof parseFeatureCapsule;
