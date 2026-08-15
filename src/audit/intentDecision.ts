import { z } from "zod";

export const semanticIntentValues = ["informational", "audit", "change", "run", "status", "cancel"] as const;
export type SemanticIntent = (typeof semanticIntentValues)[number];
export const intentDecisionSourceValues = ["lead-semantic", "explicit-cli", "heuristic-fallback"] as const;
export type IntentDecisionSource = (typeof intentDecisionSourceValues)[number];
export const intentDecisionResolutionValues = ["resolved", "ambiguous", "unresolved-reference"] as const;
export type IntentDecisionResolution = (typeof intentDecisionResolutionValues)[number];

const effectsSchema = z.object({
  evaluate: z.boolean(),
  mutateRepository: z.boolean(),
  executePreparedTask: z.boolean(),
  deliver: z.boolean()
}).strict();

const continuationSchema = z.object({
  operationId: z.string().min(1).max(200).optional(),
  findingIds: z.array(z.string().min(1).max(200)).max(100).optional(),
  taskId: z.string().min(1).max(200).optional()
}).strict();

export const intentDecisionV1Schema = z.object({
  version: z.literal(1),
  source: z.enum(intentDecisionSourceValues),
  userTurnId: z.string().min(1).max(200).optional(),
  intent: z.enum(semanticIntentValues),
  requestedOutcome: z.string().min(1).max(2_000),
  effects: effectsSchema,
  continuation: continuationSchema.optional(),
  constraints: z.array(z.string().min(1).max(500)).max(32).optional(),
  confidence: z.number().min(0).max(1).optional(),
  resolution: z.enum(intentDecisionResolutionValues).default("resolved")
}).strict();

export type IntentDecisionV1 = z.infer<typeof intentDecisionV1Schema>;
export type IntentDecisionRoute = SemanticIntent;

export interface IntentDecisionValidationSuccess { ok: true; value: IntentDecisionV1; }
export interface IntentDecisionValidationFailure { ok: false; issues: string[]; }
export type IntentDecisionValidation = IntentDecisionValidationSuccess | IntentDecisionValidationFailure;

export class InvalidIntentDecisionError extends Error {
  readonly code = "INVALID_INTENT_DECISION";

  constructor(message: string) {
    super(`${"INVALID_INTENT_DECISION"}: ${message}`);
    this.name = "InvalidIntentDecisionError";
  }
}

/**
 * Validate only the lead's typed semantic decision. This function deliberately
 * does not accept a human request and never performs natural-language parsing.
 */
export function validateIntentDecision(value: unknown): IntentDecisionValidation {
  const parsed = intentDecisionV1Schema.safeParse(value);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "decision"}: ${issue.message}`) };
  const issues = decisionInvariantIssues(parsed.data);
  return issues.length ? { ok: false, issues } : { ok: true, value: parsed.data };
}

export function parseIntentDecision(value: unknown): IntentDecisionV1 {
  const result = validateIntentDecision(value);
  if (!result.ok) throw new InvalidIntentDecisionError(result.issues.join("; "));
  return result.value;
}

export function assertIntentDecisionForRoute(value: unknown, route: IntentDecisionRoute): IntentDecisionV1 {
  const decision = parseIntentDecision(value);
  if (decision.intent !== route) throw new InvalidIntentDecisionError(`route ${route} does not match intent ${decision.intent}`);
  if (decision.resolution !== "resolved" && (route === "change" || route === "run")) throw new InvalidIntentDecisionError(`${route} requires a resolved referent`);
  return decision;
}

export function createIntentDecision(
  intent: IntentDecisionRoute,
  requestedOutcome: string,
  source: IntentDecisionSource,
  options: Partial<Pick<IntentDecisionV1, "userTurnId" | "continuation" | "constraints" | "confidence" | "resolution" | "effects">> = {}
): IntentDecisionV1 {
  return parseIntentDecision({
    version: 1,
    source,
    intent,
    requestedOutcome,
    effects: options.effects ?? defaultEffects(intent),
    userTurnId: options.userTurnId,
    continuation: options.continuation,
    constraints: options.constraints,
    confidence: options.confidence,
    resolution: options.resolution ?? "resolved"
  });
}

export function defaultEffects(intent: IntentDecisionRoute): IntentDecisionV1["effects"] {
  switch (intent) {
    case "informational": return { evaluate: false, mutateRepository: false, executePreparedTask: false, deliver: false };
    case "audit": return { evaluate: true, mutateRepository: false, executePreparedTask: false, deliver: false };
    case "change": return { evaluate: false, mutateRepository: true, executePreparedTask: false, deliver: false };
    case "run": return { evaluate: false, mutateRepository: false, executePreparedTask: true, deliver: false };
    case "status":
    case "cancel": return { evaluate: false, mutateRepository: false, executePreparedTask: false, deliver: false };
  }
}

function decisionInvariantIssues(decision: IntentDecisionV1): string[] {
  const issues: string[] = [];
  if (decision.effects.deliver) issues.push("deliver must remain false; delivery is controller-owned");
  if (decision.intent === "informational" && (decision.effects.evaluate || decision.effects.mutateRepository || decision.effects.executePreparedTask)) issues.push("informational decisions cannot evaluate, mutate, or execute prepared tasks");
  if (decision.intent === "audit" && (!decision.effects.evaluate || decision.effects.mutateRepository || decision.effects.executePreparedTask)) issues.push("audit decisions require evaluate=true and mutation/execution=false");
  if (decision.intent === "change" && !decision.effects.mutateRepository) issues.push("change decisions require mutateRepository=true");
  if (decision.intent === "run" && !decision.effects.executePreparedTask) issues.push("run decisions require executePreparedTask=true");
  if ((decision.intent === "status" || decision.intent === "cancel") && (decision.effects.evaluate || decision.effects.mutateRepository || decision.effects.executePreparedTask)) issues.push(`${decision.intent} decisions cannot request engineering effects`);
  return issues;
}
