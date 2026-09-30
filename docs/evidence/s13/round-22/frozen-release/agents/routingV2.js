import { createRouteEvidence } from "../architecture/contracts.js";
/**
 * AEH-V2-0128: the single deterministic delegation floor. Semantic ROUTE triage and the sealed
 * contract route must both consume this predicate, otherwise a bounded concrete scope can take the
 * DIRECT branch while the contract seals DELEGATED and the supervisor fails closed stale. File
 * count alone is not a work-unit count: only an explicit expectedWorkUnits above one (or a
 * concrete delegation signal) raises the floor.
 */
export function requiresDelegatedPlanningV1(input) {
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
export function resolveImplementationRoute(input) {
    const files = [...new Set(input.files ?? [])];
    const confidence = input.scopeConfidence ?? "medium";
    let route;
    let statement;
    if (input.explicitNoAgent) {
        route = "NO_AGENT";
        statement = "The request explicitly declares that no implementation agent is needed.";
    }
    else if (input.semanticAssessment?.formalizationNeed === "REQUIRED" || input.semanticAssessment?.productUncertainty || input.semanticAssessment?.architectureUncertainty || input.ambiguity || input.architecture) {
        route = "FORMAL_SDD";
        statement = input.semanticAssessment ? "The bounded semantic route assessment identifies uncertainty that requires formal SDD." : "Explicit ambiguity or architectural uncertainty requires formal SDD.";
    }
    else if (input.semanticAssessment) {
        route = input.semanticAssessment.recommendedRoute;
        statement = "A bounded semantic route assessment recommended the canonical workflow route; deterministic policy remains authoritative for assurance and action.";
    }
    else if (requiresDelegatedPlanningV1({ files, crossModule: input.crossModule, scopeConfidence: confidence, expectedWorkUnits: input.expectedWorkUnits })) {
        route = "DELEGATED";
        statement = "The bounded work has multiple coordination units or needs delegated specialist execution.";
    }
    else {
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
//# sourceMappingURL=routingV2.js.map