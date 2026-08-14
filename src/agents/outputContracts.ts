import { z } from "zod";

const riskSchema = z.enum(["low", "medium", "high"]);
const exceptionTypeSchema = z.enum(["IMPLEMENTATION_DEFECT", "SPEC_CONTRADICTION", "REQUIRES_PRODUCT_DECISION", "BLOCKED_EXTERNAL", "SYSTEM_FAILURE"]);

export const delegationTaskSchema = z.object({ id: z.string().min(1), summary: z.string().min(1), agent: z.string().min(1), scope: z.array(z.string()), dependencies: z.array(z.string()), acceptance: z.array(z.string()).min(1), risk: riskSchema });
export const plannerOutputSchema = z.object({ tasks: z.array(delegationTaskSchema), affectedAreas: z.array(z.string()).default([]), requiredReviewers: z.array(z.string()).default([]), validationGates: z.array(z.string()).default([]), fallbackRouting: z.array(z.string()).default([]), outOfScopeImprovements: z.array(z.string()).default([]) });

const explorerFileSchema = z.object({ path: z.string().min(1), symbols: z.array(z.string()).default([]), reason: z.string().min(1) });
const explorerFindingSchema = z.object({ id: z.string().min(1), status: z.enum(["CONFIRMED", "PARTIAL", "NOT_REPRODUCED", "BLOCKED"]), evidence: z.array(z.string()).default([]), notes: z.string().optional() });
export const explorerOutputSchema = z.object({
  summary: z.string().min(1),
  relevantFiles: z.array(explorerFileSchema).default([]),
  findings: z.array(explorerFindingSchema).default([]),
  moduleBoundaries: z.array(z.string()).default([]),
  tests: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([])
});

export const specAuthoringOutputSchema = z.object({
  change: z.string().min(1),
  status: z.enum(["READY", "BLOCKED"]),
  artifacts: z.object({
    proposal: z.string().optional(),
    design: z.string().optional(),
    tasks: z.string().optional(),
    specs: z.array(z.string()).default([])
  }),
  requirements: z.array(z.string()).default([]),
  unresolvedDecisions: z.array(z.string()).default([]),
  validationReady: z.boolean()
});

export const implementerOutputSchema = z.object({ filesChanged: z.array(z.string()), behaviorImplemented: z.array(z.string()), decisions: z.array(z.string()).default([]), assumptions: z.array(z.string()).default([]), risks: z.array(z.string()).default([]), validationCommands: z.array(z.string()).default([]), reviewers: z.array(z.string()).default([]), followUp: z.array(z.string()).default([]), contractSync: z.array(z.string()).optional() });
export const findingSchema = z.object({ id: z.string().min(1), severity: z.enum(["critical", "high", "medium", "low", "note"]), category: z.string().min(1), location: z.object({ file: z.string().min(1), startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional() }), evidence: z.string().min(1), impact: z.string().min(1), recommendedFix: z.string().min(1), suggestedAgent: z.string().min(1), exceptionType: exceptionTypeSchema.optional() });
export const reviewerOutputSchema = z.object({ verdict: z.enum(["PASS", "FAIL", "PASS_WITH_WARNINGS"]), findings: z.array(findingSchema), finalizationSafety: z.enum(["SAFE", "BLOCKED", "RISK_KNOWN"]), confidence: z.string().optional(), followUp: z.array(z.string()).default([]) });
export const validatorOutputSchema = z.object({ verdict: z.enum(["PASS", "FAIL", "WARN"]), checks: z.array(z.object({ id: z.string(), status: z.enum(["PASS", "FAIL", "WARN", "SKIP"]), evidence: z.string().optional() })) });
export const recoveryOutputSchema = z.object({ failureType: z.enum(["PATCH_CONTEXT_MISMATCH", "TOOL_FAILURE", "MISSING_CONTEXT", "WRONG_AGENT", "VALIDATION_FAILURE", "REVIEW_FAILURE", "AMBIGUOUS_OUTPUT", "CONFLICTING_RESULTS"]), rationale: z.string(), nextAction: z.string() });
export const orchestratorOutputSchema = z.object({ summary: z.string(), delegatedAgents: z.array(z.string()).default([]), validationStatus: z.string().optional(), unresolved: z.array(z.string()).default([]), finalizationSafe: z.boolean().optional() });
const supervisorRoadmapItemSchema = z.object({ phase: z.string().min(1), priority: z.enum(["P0", "P1", "P2", "P3"]), actions: z.array(z.string().min(1)).min(1), findingIds: z.array(z.string()).default([]) });
export const supervisorOutputSchema = z.object({
  summary: z.string().min(1),
  consolidatedFindings: z.array(findingSchema).default([]),
  sourceFindingIds: z.array(z.string()).default([]),
  conflicts: z.array(z.object({ summary: z.string().min(1), sources: z.array(z.string()).min(1) })).default([]),
  missingEvidence: z.array(z.string()).default([]),
  unresolved: z.array(z.string()).default([]),
  roadmap: z.array(supervisorRoadmapItemSchema).default([]),
  finalizationSafety: z.enum(["SAFE", "BLOCKED", "RISK_KNOWN"])
});

export type DelegationTask = z.infer<typeof delegationTaskSchema>;
export type PlannerOutput = z.infer<typeof plannerOutputSchema>;
export type ExplorerOutput = z.infer<typeof explorerOutputSchema>;
export type SpecAuthoringOutput = z.infer<typeof specAuthoringOutputSchema>;
export type NormalizedFinding = z.infer<typeof findingSchema>;
export type ReviewerOutput = z.infer<typeof reviewerOutputSchema>;
export type SupervisorOutput = z.infer<typeof supervisorOutputSchema>;

const schemas: Record<string, z.ZodType> = {
  explorer: explorerOutputSchema,
  planner: plannerOutputSchema,
  "spec-authoring": specAuthoringOutputSchema,
  implementer: implementerOutputSchema,
  reviewer: reviewerOutputSchema,
  validator: validatorOutputSchema,
  recovery: recoveryOutputSchema,
  orchestrator: orchestratorOutputSchema,
  supervisor: supervisorOutputSchema
};

const stringArray = { type: "array", items: { type: "string" } } as const;
const delegationTaskJson = { type: "object", additionalProperties: false, required: ["id", "summary", "agent", "scope", "dependencies", "acceptance", "risk"], properties: { id: { type: "string" }, summary: { type: "string" }, agent: { type: "string" }, scope: stringArray, dependencies: stringArray, acceptance: stringArray, risk: { enum: ["low", "medium", "high"] } } } as const;
const explorerFileJson = { type: "object", additionalProperties: false, required: ["path", "symbols", "reason"], properties: { path: { type: "string" }, symbols: stringArray, reason: { type: "string" } } } as const;
const explorerFindingJson = { type: "object", additionalProperties: false, required: ["id", "status", "evidence"], properties: { id: { type: "string" }, status: { enum: ["CONFIRMED", "PARTIAL", "NOT_REPRODUCED", "BLOCKED"] }, evidence: stringArray, notes: { type: "string" } } } as const;
const findingJson = { type: "object", additionalProperties: false, required: ["id", "severity", "category", "location", "evidence", "impact", "recommendedFix", "suggestedAgent"], properties: { id: { type: "string" }, severity: { enum: ["critical", "high", "medium", "low", "note"] }, category: { type: "string" }, location: { type: "object", additionalProperties: false, required: ["file"], properties: { file: { type: "string" }, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } } }, evidence: { type: "string" }, impact: { type: "string" }, recommendedFix: { type: "string" }, suggestedAgent: { type: "string" }, exceptionType: { enum: ["IMPLEMENTATION_DEFECT", "SPEC_CONTRADICTION", "REQUIRES_PRODUCT_DECISION", "BLOCKED_EXTERNAL", "SYSTEM_FAILURE"] } } } as const;
const supervisorRoadmapItemJson = { type: "object", additionalProperties: false, required: ["phase", "priority", "actions", "findingIds"], properties: { phase: { type: "string" }, priority: { enum: ["P0", "P1", "P2", "P3"] }, actions: stringArray, findingIds: stringArray } } as const;

const jsonSchemas: Record<string, Record<string, unknown>> = {
  explorer: { type: "object", additionalProperties: false, required: ["summary", "relevantFiles", "findings", "moduleBoundaries", "tests", "dependencies", "risks", "openQuestions"], properties: { summary: { type: "string" }, relevantFiles: { type: "array", items: explorerFileJson }, findings: { type: "array", items: explorerFindingJson }, moduleBoundaries: stringArray, tests: stringArray, dependencies: stringArray, risks: stringArray, openQuestions: stringArray } },
  planner: { type: "object", additionalProperties: false, required: ["tasks", "affectedAreas", "requiredReviewers", "validationGates", "fallbackRouting", "outOfScopeImprovements"], properties: { tasks: { type: "array", items: delegationTaskJson }, affectedAreas: stringArray, requiredReviewers: stringArray, validationGates: stringArray, fallbackRouting: stringArray, outOfScopeImprovements: stringArray } },
  "spec-authoring": { type: "object", additionalProperties: false, required: ["change", "status", "artifacts", "requirements", "unresolvedDecisions", "validationReady"], properties: { change: { type: "string" }, status: { enum: ["READY", "BLOCKED"] }, artifacts: { type: "object", additionalProperties: false, required: ["specs"], properties: { proposal: { type: "string" }, design: { type: "string" }, tasks: { type: "string" }, specs: stringArray } }, requirements: stringArray, unresolvedDecisions: stringArray, validationReady: { type: "boolean" } } },
  implementer: { type: "object", additionalProperties: false, required: ["filesChanged", "behaviorImplemented", "decisions", "assumptions", "risks", "validationCommands", "reviewers", "followUp"], properties: { filesChanged: stringArray, behaviorImplemented: stringArray, decisions: stringArray, assumptions: stringArray, risks: stringArray, validationCommands: stringArray, reviewers: stringArray, followUp: stringArray, contractSync: stringArray } },
  reviewer: { type: "object", additionalProperties: false, required: ["verdict", "findings", "finalizationSafety", "followUp"], properties: { verdict: { enum: ["PASS", "FAIL", "PASS_WITH_WARNINGS"] }, findings: { type: "array", items: findingJson }, finalizationSafety: { enum: ["SAFE", "BLOCKED", "RISK_KNOWN"] }, confidence: { type: "string" }, followUp: stringArray } },
  validator: { type: "object", additionalProperties: false, required: ["verdict", "checks"], properties: { verdict: { enum: ["PASS", "FAIL", "WARN"] }, checks: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "status"], properties: { id: { type: "string" }, status: { enum: ["PASS", "FAIL", "WARN", "SKIP"] }, evidence: { type: "string" } } } } } },
  recovery: { type: "object", additionalProperties: false, required: ["failureType", "rationale", "nextAction"], properties: { failureType: { enum: ["PATCH_CONTEXT_MISMATCH", "TOOL_FAILURE", "MISSING_CONTEXT", "WRONG_AGENT", "VALIDATION_FAILURE", "REVIEW_FAILURE", "AMBIGUOUS_OUTPUT", "CONFLICTING_RESULTS"] }, rationale: { type: "string" }, nextAction: { type: "string" } } },
  orchestrator: { type: "object", additionalProperties: false, required: ["summary", "delegatedAgents", "unresolved"], properties: { summary: { type: "string" }, delegatedAgents: stringArray, validationStatus: { type: "string" }, unresolved: stringArray, finalizationSafe: { type: "boolean" } } },
  supervisor: { type: "object", additionalProperties: false, required: ["summary", "consolidatedFindings", "sourceFindingIds", "conflicts", "missingEvidence", "unresolved", "finalizationSafety"], properties: { summary: { type: "string" }, consolidatedFindings: { type: "array", items: findingJson }, sourceFindingIds: stringArray, conflicts: { type: "array", items: { type: "object", additionalProperties: false, required: ["summary", "sources"], properties: { summary: { type: "string" }, sources: stringArray } } }, missingEvidence: stringArray, unresolved: stringArray, roadmap: { type: "array", items: supervisorRoadmapItemJson }, finalizationSafety: { enum: ["SAFE", "BLOCKED", "RISK_KNOWN"] } } }
};

export function validateAgentOutput(contractName: string, value: unknown): { ok: boolean; value?: unknown; issues: string[] } { const schema = schemas[contractName]; if (!schema) return { ok: false, issues: [`Unknown agent output contract: ${contractName}`] }; const parsed = schema.safeParse(value); return parsed.success ? { ok: true, value: parsed.data, issues: [] } : { ok: false, issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`) }; }
export function knownOutputContracts(): string[] { return Object.keys(schemas).sort(); }
export function outputJsonSchema(contractName: string): Record<string, unknown> | undefined { const schema = jsonSchemas[contractName]; return schema ? structuredClone(schema) : undefined; }
