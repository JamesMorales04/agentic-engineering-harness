import type { HarnessProjectConfig, TaskRisk } from "../core/types.js";
import { type TriageDecision, type TriageEvidence } from "../core/triage.js";
import { type IntentDecisionV1 } from "./intentDecision.js";
import { SemanticAssessmentServiceV1, type DecisionMechanismV1, type SemanticAssessmentBindingV1 } from "../semantic/assessment.js";
export { assertIntentDecisionForRoute, createIntentDecision, defaultEffects, intentDecisionV1Schema, InvalidIntentDecisionError, parseIntentDecision, semanticIntentValues, validateIntentDecision } from "./intentDecision.js";
export type { IntentDecisionRoute, IntentDecisionResolution, IntentDecisionSource, IntentDecisionV1, SemanticIntent } from "./intentDecision.js";
export type EngineeringIntent = "informational" | "audit" | "change";
export interface EngineeringIntentEvidence extends TriageEvidence {
    explicitIntent?: EngineeringIntent;
}
export interface EngineeringIntentDecision {
    intent: EngineeringIntent;
    mechanism: DecisionMechanismV1;
    reasons: string[];
    unknowns?: string[];
    assessmentDigests?: string[];
    evidence: {
        request: string;
        files: string[];
        domains: string[];
        risk: TaskRisk;
        flags: TriageEvidence["flags"] extends Array<infer T> | undefined ? T[] : never[];
    };
    changeTriage?: TriageDecision;
}
/**
 * Non-authoritative lexical signal for diagnostics, evaluation and explicitly
 * configured compatibility fallback only. Managed conversational routes must
 * use a lead-produced IntentDecisionV1 instead.
 */
export declare function classifyEngineeringIntentHeuristic(config: HarnessProjectConfig, input: EngineeringIntentEvidence): EngineeringIntentDecision;
export declare function classifyEngineeringIntentWithSemanticAssessment(config: HarnessProjectConfig, input: EngineeringIntentEvidence, options: {
    service: SemanticAssessmentServiceV1;
    binding: SemanticAssessmentBindingV1;
    policyRevision: string;
}): Promise<EngineeringIntentDecision>;
/** @deprecated Use classifyEngineeringIntentHeuristic outside the conversational route. */
export declare const classifyEngineeringIntent: typeof classifyEngineeringIntentHeuristic;
export declare function intentDecisionFromHeuristic(config: HarnessProjectConfig, input: EngineeringIntentEvidence, userTurnId?: string): IntentDecisionV1;
export declare function formatEngineeringIntent(decision: EngineeringIntentDecision): string;
