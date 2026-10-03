import { z } from "zod";

export const semanticIntentValues = ["informational", "audit", "change", "run", "status", "cancel"] as const;
export type SemanticIntent = (typeof semanticIntentValues)[number];
export const intentDecisionSourceValues = ["lead-semantic", "explicit-cli", "heuristic-fallback"] as const;
export type IntentDecisionSource = (typeof intentDecisionSourceValues)[number];
export const intentDecisionResolutionValues = ["resolved", "ambiguous", "unresolved-reference"] as const;
export type IntentDecisionResolution = (typeof intentDecisionResolutionValues)[number];

/** The managed Lead supplies meaning and constraints; the tool name supplies the route,
 * while trusted runtime metadata supplies the user-turn identity. */
export const leadOperationIntentV1Schema = z.object({
  version: z.literal(1),
  requestedOutcome: z.string().trim().min(1).max(2_000),
  continuation: z.object({
    operationId: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._-]+$/),
    findingIds: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
    taskId: z.string().trim().min(1).max(200).optional()
  }).strict().optional(),
  constraints: z.array(z.string().trim().min(1).max(500)).max(32).optional()
}).strict();

export type LeadOperationIntentV1 = z.infer<typeof leadOperationIntentV1Schema>;

/** Provider-facing JSON Schema kept beside the deterministic Zod contract. */
export const leadOperationIntentV1JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "requestedOutcome"],
  properties: {
    version: { const: 1 },
    requestedOutcome: { type: "string", minLength: 1, maxLength: 2_000, pattern: "\\S" },
    continuation: {
      type: "object",
      additionalProperties: false,
      required: ["operationId"],
      properties: {
        operationId: { type: "string", minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9._-]+$" },
        findingIds: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" } },
        taskId: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" }
      }
    },
    constraints: { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 500, pattern: "\\S" } }
  }
} as const;

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
  requestedOutcome: z.string().trim().min(1).max(2_000),
  effects: effectsSchema,
  continuation: continuationSchema.optional(),
  constraints: z.array(z.string().trim().min(1).max(500)).max(32).optional(),
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

/** Build an internal semantic decision from the route-specific MCP tool and bounded Lead intent. */
export function intentDecisionFromLeadOperationIntent(
  route: Extract<IntentDecisionRoute, "audit" | "change" | "run">,
  value: unknown,
  trustedUserTurnId?: string
): IntentDecisionV1 {
  const parsed = leadOperationIntentV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidIntentDecisionError(parsed.error.issues.map((issue) => `${issue.path.join(".") || "operationIntent"}: ${issue.message}`).join("; "));
  }
  return createIntentDecision(route, parsed.data.requestedOutcome, "lead-semantic", {
    ...(trustedUserTurnId ? { userTurnId: trustedUserTurnId } : {}),
    ...(parsed.data.continuation ? { continuation: parsed.data.continuation } : {}),
    ...(parsed.data.constraints ? { constraints: parsed.data.constraints } : {})
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
  if (JSON.stringify(decision.effects) !== JSON.stringify(defaultEffects(decision.intent))) {
    if (decision.effects.deliver) issues.push("effects.deliver must remain false; delivery is controller-owned");
    issues.push(`${decision.intent} effects must exactly match the deterministic route contract`);
  }
  return issues;
}
