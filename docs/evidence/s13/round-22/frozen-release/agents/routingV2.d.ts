import type { AssuranceLevel, ImplementationRoute, RouteEvidence } from "../architecture/contracts.js";
import type { DecisionMechanismV1 } from "../semantic/assessment.js";
export interface RouteAssessmentV1 {
    recommendedRoute: ImplementationRoute;
    scopeClarity: "LOW" | "MEDIUM" | "HIGH";
    decompositionNeed: boolean;
    coordinationNeed: boolean;
    architectureUncertainty: boolean;
    productUncertainty: boolean;
    formalizationNeed: "NONE" | "RECOMMENDED" | "REQUIRED";
    semanticRiskSignals: string[];
    evidenceRefs: string[];
    unknowns: string[];
}
export interface ImplementationRoutingEvidence {
    intent: string;
    ambiguity?: boolean;
    architecture?: boolean;
    crossModule?: boolean;
    scopeConfidence?: "low" | "medium" | "high";
    expectedWorkUnits?: number;
    risk?: "low" | "medium" | "high";
    publicContractImpact?: boolean;
    dataOrSchemaImpact?: boolean;
    securityBoundary?: boolean;
    semanticAssessment?: RouteAssessmentV1;
    files?: string[];
    explicitNoAgent?: boolean;
}
export interface ImplementationRoutingDecision {
    intent: string;
    route: ImplementationRoute;
    assurance: AssuranceLevel;
    mechanism: DecisionMechanismV1;
    routeEvidence: RouteEvidence[];
}
/**
 * AEH-V2-0128: the single deterministic delegation floor. Semantic ROUTE triage and the sealed
 * contract route must both consume this predicate, otherwise a bounded concrete scope can take the
 * DIRECT branch while the contract seals DELEGATED and the supervisor fails closed stale. File
 * count alone is not a work-unit count: only an explicit expectedWorkUnits above one (or a
 * concrete delegation signal) raises the floor.
 */
export declare function requiresDelegatedPlanningV1(input: {
    files: string[];
    crossModule?: boolean;
    scopeConfidence?: "low" | "medium" | "high";
    expectedWorkUnits?: number;
    decompositionNeed?: boolean;
    coordinationNeed?: boolean;
}): boolean;
export declare function resolveImplementationRoute(input: ImplementationRoutingEvidence): ImplementationRoutingDecision;
