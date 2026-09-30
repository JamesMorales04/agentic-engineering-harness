import type { AssuranceLevel, ImplementationRoute, RouteEvidence } from "../architecture/contracts.js";
import { createRouteEvidence } from "../architecture/contracts.js";
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
export function requiresDelegatedPlanningV1(input: {
  files: string[];
  crossModule?: boolean;
  scopeConfidence?: "low" | "medium" | "high";
  expectedWorkUnits?: number;
  decompositionNeed?: boolean;
  coordinationNeed?: boolean;
}): boolean {
  const files = [...new Set(input.files ?? [])];
  const nonConcrete = files.filter((file) => /[*?\[\]{}]/.test(file));
  return files.length === 0
    || nonConcrete.length > 0
    || files.length > 5
    || input.crossModule === true
    || (input.expectedWorkUnits !== undefined && input.expectedWorkUnits > 1)
    || input.scopeConfidence === "low"
    || input.decompositionNeed === true
    || input.coordinationNeed === true;
}

export function resolveImplementationRoute(input: ImplementationRoutingEvidence): ImplementationRoutingDecision {
  const files = [...new Set(input.files ?? [])];
  const confidence = input.scopeConfidence ?? "medium";
  let route: ImplementationRoute;
  let statement: string;
  if (input.explicitNoAgent) {
    route = "NO_AGENT";
    statement = "The request explicitly declares that no implementation agent is needed.";
  } else if (input.semanticAssessment?.formalizationNeed === "REQUIRED" || input.semanticAssessment?.productUncertainty || input.semanticAssessment?.architectureUncertainty || input.ambiguity || input.architecture) {
    route = "FORMAL_SDD";
    statement = input.semanticAssessment ? "The bounded semantic route assessment identifies uncertainty that requires formal SDD." : "Explicit ambiguity or architectural uncertainty requires formal SDD.";
  } else if (input.semanticAssessment) {
    route = input.semanticAssessment.recommendedRoute;
    statement = "A bounded semantic route assessment recommended the canonical workflow route; deterministic policy remains authoritative for assurance and action.";
  } else if (requiresDelegatedPlanningV1({ files, crossModule: input.crossModule, scopeConfidence: confidence, expectedWorkUnits: input.expectedWorkUnits })) {
    route = "DELEGATED";
    statement = "The bounded work has multiple coordination units or needs delegated specialist execution.";
  } else {
    route = "DIRECT";
    statement = "The request is bounded, concrete, and suitable for direct implementation.";
  }
  const assurance = input.securityBoundary || input.publicContractImpact || input.dataOrSchemaImpact
    ? "CRITICAL"
    : input.risk === "high" || input.crossModule
      ? "ELEVATED"
      : input.risk === "medium"
        ? "STANDARD"
        : "NONE";
  return {
    intent: input.intent,
    route,
    assurance,
    mechanism: input.semanticAssessment ? "HYBRID" : "DETERMINISTIC",
    routeEvidence: [createRouteEvidence(route, "implementation-routing", statement)]
  };
}
