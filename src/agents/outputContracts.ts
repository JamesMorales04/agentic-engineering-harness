import { z } from "zod";

const riskSchema = z.enum(["low", "medium", "high"]);
export const delegationTaskSchema = z.object({
  id: z.string().min(1), summary: z.string().min(1), agent: z.string().min(1), scope: z.array(z.string()), dependencies: z.array(z.string()), acceptance: z.array(z.string()).min(1), risk: riskSchema
});
export const plannerOutputSchema = z.object({ tasks: z.array(delegationTaskSchema), affectedAreas: z.array(z.string()).default([]), requiredReviewers: z.array(z.string()).default([]), validationGates: z.array(z.string()).default([]), fallbackRouting: z.array(z.string()).default([]), outOfScopeImprovements: z.array(z.string()).default([]) });
export const implementerOutputSchema = z.object({ filesChanged: z.array(z.string()), behaviorImplemented: z.array(z.string()), decisions: z.array(z.string()).default([]), assumptions: z.array(z.string()).default([]), risks: z.array(z.string()).default([]), validationCommands: z.array(z.string()).default([]), reviewers: z.array(z.string()).default([]), followUp: z.array(z.string()).default([]), contractSync: z.array(z.string()).optional() });
export const findingSchema = z.object({ id: z.string().min(1), severity: z.enum(["critical", "high", "medium", "low", "note"]), category: z.string().min(1), location: z.object({ file: z.string().min(1), startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional() }), evidence: z.string().min(1), impact: z.string().min(1), recommendedFix: z.string().min(1), suggestedAgent: z.string().min(1) });
export const reviewerOutputSchema = z.object({ verdict: z.enum(["PASS", "FAIL", "PASS_WITH_WARNINGS"]), findings: z.array(findingSchema), finalizationSafety: z.enum(["SAFE", "BLOCKED", "RISK_KNOWN"]), confidence: z.string().optional(), followUp: z.array(z.string()).default([]) });
export const validatorOutputSchema = z.object({ verdict: z.enum(["PASS", "FAIL", "WARN"]), checks: z.array(z.object({ id: z.string(), status: z.enum(["PASS", "FAIL", "WARN", "SKIP"]), evidence: z.string().optional() })) });
export const recoveryOutputSchema = z.object({ failureType: z.enum(["PATCH_CONTEXT_MISMATCH", "TOOL_FAILURE", "MISSING_CONTEXT", "WRONG_AGENT", "VALIDATION_FAILURE", "REVIEW_FAILURE", "AMBIGUOUS_OUTPUT", "CONFLICTING_RESULTS"]), rationale: z.string(), nextAction: z.string() });
export const orchestratorOutputSchema = z.object({ summary: z.string(), delegatedAgents: z.array(z.string()).default([]), validationStatus: z.string().optional(), unresolved: z.array(z.string()).default([]), finalizationSafe: z.boolean().optional() });

const schemas: Record<string, z.ZodType> = { planner: plannerOutputSchema, implementer: implementerOutputSchema, reviewer: reviewerOutputSchema, validator: validatorOutputSchema, recovery: recoveryOutputSchema, orchestrator: orchestratorOutputSchema };
export function validateAgentOutput(contractName: string, value: unknown): { ok: boolean; value?: unknown; issues: string[] } {
  const schema = schemas[contractName];
  if (!schema) return { ok: false, issues: [`Unknown agent output contract: ${contractName}`] };
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data, issues: [] };
  return { ok: false, issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`) };
}
export function knownOutputContracts(): string[] { return Object.keys(schemas).sort(); }
