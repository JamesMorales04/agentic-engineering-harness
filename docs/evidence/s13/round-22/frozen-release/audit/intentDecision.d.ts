import { z } from "zod";
export declare const semanticIntentValues: readonly ["informational", "audit", "change", "run", "status", "cancel"];
export type SemanticIntent = (typeof semanticIntentValues)[number];
export declare const intentDecisionSourceValues: readonly ["lead-semantic", "explicit-cli", "heuristic-fallback"];
export type IntentDecisionSource = (typeof intentDecisionSourceValues)[number];
export declare const intentDecisionResolutionValues: readonly ["resolved", "ambiguous", "unresolved-reference"];
export type IntentDecisionResolution = (typeof intentDecisionResolutionValues)[number];
export declare const intentDecisionV1Schema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    source: z.ZodEnum<{
        "lead-semantic": "lead-semantic";
        "explicit-cli": "explicit-cli";
        "heuristic-fallback": "heuristic-fallback";
    }>;
    userTurnId: z.ZodOptional<z.ZodString>;
    intent: z.ZodEnum<{
        status: "status";
        audit: "audit";
        informational: "informational";
        change: "change";
        run: "run";
        cancel: "cancel";
    }>;
    requestedOutcome: z.ZodString;
    effects: z.ZodObject<{
        evaluate: z.ZodBoolean;
        mutateRepository: z.ZodBoolean;
        executePreparedTask: z.ZodBoolean;
        deliver: z.ZodBoolean;
    }, z.core.$strict>;
    continuation: z.ZodOptional<z.ZodObject<{
        operationId: z.ZodOptional<z.ZodString>;
        findingIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
        taskId: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    constraints: z.ZodOptional<z.ZodArray<z.ZodString>>;
    confidence: z.ZodOptional<z.ZodNumber>;
    resolution: z.ZodDefault<z.ZodEnum<{
        resolved: "resolved";
        ambiguous: "ambiguous";
        "unresolved-reference": "unresolved-reference";
    }>>;
}, z.core.$strict>;
export type IntentDecisionV1 = z.infer<typeof intentDecisionV1Schema>;
export type IntentDecisionRoute = SemanticIntent;
export interface IntentDecisionValidationSuccess {
    ok: true;
    value: IntentDecisionV1;
}
export interface IntentDecisionValidationFailure {
    ok: false;
    issues: string[];
}
export type IntentDecisionValidation = IntentDecisionValidationSuccess | IntentDecisionValidationFailure;
export declare class InvalidIntentDecisionError extends Error {
    readonly code = "INVALID_INTENT_DECISION";
    constructor(message: string);
}
/**
 * Validate only the lead's typed semantic decision. This function deliberately
 * does not accept a human request and never performs natural-language parsing.
 */
export declare function validateIntentDecision(value: unknown): IntentDecisionValidation;
export declare function parseIntentDecision(value: unknown): IntentDecisionV1;
export declare function assertIntentDecisionForRoute(value: unknown, route: IntentDecisionRoute): IntentDecisionV1;
export declare function createIntentDecision(intent: IntentDecisionRoute, requestedOutcome: string, source: IntentDecisionSource, options?: Partial<Pick<IntentDecisionV1, "userTurnId" | "continuation" | "constraints" | "confidence" | "resolution" | "effects">>): IntentDecisionV1;
export declare function defaultEffects(intent: IntentDecisionRoute): IntentDecisionV1["effects"];
