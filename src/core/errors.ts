export const aehErrorCodeValues = [
  "PARTICIPANT_PLAN_INVALID",
  "PARTICIPANT_PLAN_BUDGET_EXCEEDED",
  "EXECUTION_BLUEPRINT_INVALID",
  "SKILL_COMPILATION_REJECTED",
  "KNOWLEDGE_CACHE_REJECTED",
  "KNOWLEDGE_PACK_REJECTED",
  "KNOWLEDGE_GAP_BLOCKED",
  "TOOL_AUTHORIZATION_REJECTED",
  "CAPABILITY_DENIED",
  "CANDIDATE_STALE",
  "CANDIDATE_WORKSPACE_MISMATCH",
  "BUDGET_EXCEEDED",
  "SEMANTIC_ASSESSMENT_INVALID",
  "SEMANTIC_ASSESSMENT_UNAVAILABLE",
  "ISSUE_NORMALIZATION_BLOCKED",
  "ISSUE_NORMALIZATION_INVALID",
  "STACK_ASSESSMENT_INVALID",
  "CANDIDATE_IMPACT_INVALID",
  "FAILURE_ASSESSMENT_INVALID",
  "VALIDATION_REQUIREMENT_BLOCKED"
] as const;

export type AehErrorCode = (typeof aehErrorCodeValues)[number];

export class AehError extends Error {
  readonly code: AehErrorCode;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;

  constructor(code: AehErrorCode, detail?: string, options?: { details?: Record<string, unknown>; cause?: unknown }) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "AehError";
    this.code = code;
    this.details = options?.details;
    this.cause = options?.cause;
  }
}

export function isAehError(error: unknown): error is AehError {
  return error instanceof AehError;
}
