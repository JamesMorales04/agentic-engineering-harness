import { z } from "zod";
import { validationRequirementKindValues } from "../architecture/validationRequirements.js";
import { semanticAssessmentPayloadV1Schema } from "../semantic/assessment.js";

const riskSchema = z.enum(["low", "medium", "high"]);
const exceptionTypeSchema = z.enum(["IMPLEMENTATION_DEFECT", "SPEC_CONTRADICTION", "REQUIRES_PRODUCT_DECISION", "BLOCKED_EXTERNAL", "SYSTEM_FAILURE"]);

const workUnitOutputSchema = z.object({
  id: z.string().min(1),
  objective: z.string().min(1),
  scope: z.array(z.string()).min(1),
  dependencies: z.array(z.string()),
  requirementRefs: z.array(z.string()),
  acceptanceRefs: z.array(z.string()),
  competencies: z.array(z.string()),
  riskTags: z.array(z.string()),
  changeKinds: z.array(z.enum(["source", "test", "schema", "config", "docs", "dependency", "infrastructure", "security"])).min(1),
  risk: z.enum(["low", "medium", "high", "critical"]),
  resourceClaims: z.array(z.object({
    version: z.literal(1),
    resource: z.string().trim().min(1).max(200),
    mode: z.enum(["SHARED_READ", "EXCLUSIVE_WRITE", "ORDERED_SEQUENCE"]),
    order: z.number().int().min(0).max(100000).optional()
  }).strict()).max(64).default([])
}).strict();
export const plannerOutputSchema = z.object({
  workUnits: z.array(workUnitOutputSchema),
  affectedAreas: z.array(z.string()).default([]),
  reviewDimensions: z.array(z.string()).default([]),
  validationRequirements: z.array(z.object({
    version: z.literal(1),
    id: z.string().trim().min(1).max(120),
    property: z.string().trim().min(1).max(500),
    kind: z.enum(validationRequirementKindValues),
    scope: z.array(z.string().trim().min(1).max(500)).min(1).max(128),
    evidenceNeeded: z.array(z.string().trim().min(1).max(300)).min(1).max(64),
    requirementRefs: z.array(z.string().trim().min(1).max(120)).max(128),
    acceptanceRefs: z.array(z.string().trim().min(1).max(120)).max(128)
  }).strict()).default([]),
  outOfScopeImprovements: z.array(z.string()).default([]),
  formalizationNeed: z.enum(["NONE", "RECOMMENDED", "REQUIRED"]).optional(),
  formalizationReason: z.enum(["PRODUCT_UNCERTAINTY", "ARCHITECTURE_UNCERTAINTY", "REQUIREMENT_CONTRADICTION", "CROSS_COMPONENT_DESIGN", "OTHER"]).optional(),
  formalizationEvidenceRefs: z.array(z.string()).max(64).optional()
}).strict();

const knowledgePackSchema = z.object({
  version: z.literal(1),
  cacheKey: z.string().trim().min(1).max(500),
  topic: z.string().trim().min(1).max(500),
  claims: z.array(z.object({ id: z.string().trim().min(1).max(100), statement: z.string().trim().min(1).max(2_000), competency: z.string().trim().min(1).max(200), confidence: z.enum(["high", "medium", "low"]) }).strict()).min(1).max(64),
  sources: z.array(z.object({ uri: z.string().trim().min(1).max(2_000), kind: z.enum(["official", "repository", "public-code", "unknown"]), version: z.string().trim().min(1).max(200).optional() }).strict()).min(1).max(64),
  retrievedAt: z.string().datetime(),
  packDigest: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
const skillProcedureEvidenceSchema = z.object({ stepIndex: z.number().int().nonnegative(), claimIds: z.array(z.string().trim().min(1).max(100)).min(1).max(64), sourceUris: z.array(z.string().trim().min(1).max(2_000)).min(1).max(64) }).strict();
const skillCandidateSchema = z.object({ version: z.literal(1), id: z.string().regex(/^ephemeral:.+/), competency: z.string().trim().min(1).max(200), procedure: z.array(z.string().trim().min(1).max(1_000)).min(1).max(32), sourcePackDigest: z.string().regex(/^[a-f0-9]{64}$/), procedureEvidence: z.array(skillProcedureEvidenceSchema).min(1).max(32) }).strict();
export const knowledgePackOutputSchema = z.object({ pack: knowledgePackSchema, skillCandidate: skillCandidateSchema.optional() }).strict();
export type KnowledgePackOutput = z.infer<typeof knowledgePackOutputSchema>;

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

export const implementerOutputSchema = z.object({ filesChanged: z.array(z.string()), behaviorImplemented: z.array(z.string()), decisions: z.array(z.string()).default([]), assumptions: z.array(z.string()).default([]), risks: z.array(z.string()).default([]), validationCommands: z.array(z.string()).default([]), followUp: z.array(z.string()).default([]), contractSync: z.array(z.string()).optional() });
export const findingSchema = z.object({ id: z.string().min(1), severity: z.enum(["critical", "high", "medium", "low", "note"]), category: z.string().min(1), location: z.object({ file: z.string().min(1), startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional() }), evidence: z.string().min(1), impact: z.string().min(1), recommendedFix: z.string().min(1), requiredCompetencies: z.array(z.string()).min(1), reviewDimensions: z.array(z.string()).default([]), exceptionType: exceptionTypeSchema.optional() });
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

export type WorkUnitOutput = z.infer<typeof workUnitOutputSchema>;
export type PlannerOutput = z.infer<typeof plannerOutputSchema>;
export type ExplorerOutput = z.infer<typeof explorerOutputSchema>;
export type SpecAuthoringOutput = z.infer<typeof specAuthoringOutputSchema>;
export type NormalizedFinding = z.infer<typeof findingSchema>;
export type ReviewerOutput = z.infer<typeof reviewerOutputSchema>;
export type SupervisorOutput = z.infer<typeof supervisorOutputSchema>;

const schemas: Record<string, z.ZodType> = {
  explorer: explorerOutputSchema,
  planner: plannerOutputSchema,
  "knowledge-pack": knowledgePackOutputSchema,
  "spec-authoring": specAuthoringOutputSchema,
  implementer: implementerOutputSchema,
  reviewer: reviewerOutputSchema,
  validator: validatorOutputSchema,
  recovery: recoveryOutputSchema,
  orchestrator: orchestratorOutputSchema,
  supervisor: supervisorOutputSchema,
  "semantic-assessment": semanticAssessmentPayloadV1Schema
};

const stringArray = { type: "array", items: { type: "string" } } as const;
const workUnitJson = { type: "object", additionalProperties: false, required: ["id", "objective", "scope", "dependencies", "requirementRefs", "acceptanceRefs", "competencies", "riskTags", "changeKinds", "risk"], properties: { id: { type: "string" }, objective: { type: "string" }, scope: stringArray, dependencies: stringArray, requirementRefs: stringArray, acceptanceRefs: stringArray, competencies: stringArray, riskTags: stringArray, changeKinds: { type: "array", items: { enum: ["source", "test", "schema", "config", "docs", "dependency", "infrastructure", "security"] } }, resourceClaims: { type: "array", items: { type: "object", additionalProperties: false, required: ["version", "resource", "mode"], properties: { version: { const: 1 }, resource: { type: "string" }, mode: { enum: ["SHARED_READ", "EXCLUSIVE_WRITE", "ORDERED_SEQUENCE"] }, order: { type: "integer", minimum: 0, maximum: 100000 } } } }, risk: { enum: ["low", "medium", "high", "critical"] } } } as const;
const explorerFileJson = { type: "object", additionalProperties: false, required: ["path", "symbols", "reason"], properties: { path: { type: "string" }, symbols: stringArray, reason: { type: "string" } } } as const;
const explorerFindingJson = { type: "object", additionalProperties: false, required: ["id", "status", "evidence"], properties: { id: { type: "string" }, status: { enum: ["CONFIRMED", "PARTIAL", "NOT_REPRODUCED", "BLOCKED"] }, evidence: stringArray, notes: { type: "string" } } } as const;
const findingJson = { type: "object", additionalProperties: false, required: ["id", "severity", "category", "location", "evidence", "impact", "recommendedFix", "requiredCompetencies", "reviewDimensions"], properties: { id: { type: "string" }, severity: { enum: ["critical", "high", "medium", "low", "note"] }, category: { type: "string" }, location: { type: "object", additionalProperties: false, required: ["file"], properties: { file: { type: "string" }, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } } }, evidence: { type: "string" }, impact: { type: "string" }, recommendedFix: { type: "string" }, requiredCompetencies: stringArray, reviewDimensions: stringArray, exceptionType: { enum: ["IMPLEMENTATION_DEFECT", "SPEC_CONTRADICTION", "REQUIRES_PRODUCT_DECISION", "BLOCKED_EXTERNAL", "SYSTEM_FAILURE"] } } } as const;
const supervisorRoadmapItemJson = { type: "object", additionalProperties: false, required: ["phase", "priority", "actions", "findingIds"], properties: { phase: { type: "string" }, priority: { enum: ["P0", "P1", "P2", "P3"] }, actions: stringArray, findingIds: stringArray } } as const;
const skillCandidateJson = { type: "object", additionalProperties: false, required: ["version", "id", "competency", "procedure", "sourcePackDigest", "procedureEvidence"], properties: { version: { const: 1 }, id: { type: "string" }, competency: { type: "string" }, procedure: stringArray, sourcePackDigest: { type: "string" }, procedureEvidence: { type: "array", minItems: 1, maxItems: 32, items: { type: "object", additionalProperties: false, required: ["stepIndex", "claimIds", "sourceUris"], properties: { stepIndex: { type: "integer", minimum: 0 }, claimIds: { type: "array", minItems: 1, items: { type: "string" } }, sourceUris: { type: "array", minItems: 1, items: { type: "string" } } } } } } } as const;

const jsonSchemas: Record<string, Record<string, unknown>> = {
  explorer: { type: "object", additionalProperties: false, required: ["summary", "relevantFiles", "findings", "moduleBoundaries", "tests", "dependencies", "risks", "openQuestions"], properties: { summary: { type: "string" }, relevantFiles: { type: "array", items: explorerFileJson }, findings: { type: "array", items: explorerFindingJson }, moduleBoundaries: stringArray, tests: stringArray, dependencies: stringArray, risks: stringArray, openQuestions: stringArray } },
  planner: { type: "object", additionalProperties: false, required: ["workUnits", "affectedAreas", "reviewDimensions", "validationRequirements", "outOfScopeImprovements"], properties: { workUnits: { type: "array", items: workUnitJson }, affectedAreas: stringArray, reviewDimensions: stringArray, validationRequirements: { type: "array", items: { type: "object", additionalProperties: false, required: ["version", "id", "property", "kind", "scope", "evidenceNeeded", "requirementRefs", "acceptanceRefs"], properties: { version: { const: 1 }, id: { type: "string" }, property: { type: "string" }, kind: { enum: [...validationRequirementKindValues] }, scope: stringArray, evidenceNeeded: stringArray, requirementRefs: stringArray, acceptanceRefs: stringArray } } }, outOfScopeImprovements: stringArray, formalizationNeed: { enum: ["NONE", "RECOMMENDED", "REQUIRED"] }, formalizationReason: { enum: ["PRODUCT_UNCERTAINTY", "ARCHITECTURE_UNCERTAINTY", "REQUIREMENT_CONTRADICTION", "CROSS_COMPONENT_DESIGN", "OTHER"] }, formalizationEvidenceRefs: stringArray } },
  "knowledge-pack": { type: "object", additionalProperties: false, required: ["pack"], properties: { pack: { type: "object", additionalProperties: false, required: ["version", "cacheKey", "topic", "claims", "sources", "retrievedAt", "packDigest"], properties: { version: { const: 1 }, cacheKey: { type: "string" }, topic: { type: "string" }, claims: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "statement", "competency", "confidence"], properties: { id: { type: "string" }, statement: { type: "string" }, competency: { type: "string" }, confidence: { enum: ["high", "medium", "low"] } } } }, sources: { type: "array", items: { type: "object", additionalProperties: false, required: ["uri", "kind"], properties: { uri: { type: "string" }, kind: { enum: ["official", "repository", "public-code", "unknown"] }, version: { type: "string" } } } }, retrievedAt: { type: "string" }, packDigest: { type: "string" } } }, skillCandidate: skillCandidateJson } },
  "spec-authoring": { type: "object", additionalProperties: false, required: ["change", "status", "artifacts", "requirements", "unresolvedDecisions", "validationReady"], properties: { change: { type: "string" }, status: { enum: ["READY", "BLOCKED"] }, artifacts: { type: "object", additionalProperties: false, required: ["specs"], properties: { proposal: { type: "string" }, design: { type: "string" }, tasks: { type: "string" }, specs: stringArray } }, requirements: stringArray, unresolvedDecisions: stringArray, validationReady: { type: "boolean" } } },
  implementer: { type: "object", additionalProperties: false, required: ["filesChanged", "behaviorImplemented", "decisions", "assumptions", "risks", "validationCommands", "followUp"], properties: { filesChanged: stringArray, behaviorImplemented: stringArray, decisions: stringArray, assumptions: stringArray, risks: stringArray, validationCommands: stringArray, followUp: stringArray, contractSync: stringArray } },
  reviewer: { type: "object", additionalProperties: false, required: ["verdict", "findings", "finalizationSafety", "followUp"], properties: { verdict: { enum: ["PASS", "FAIL", "PASS_WITH_WARNINGS"] }, findings: { type: "array", items: findingJson }, finalizationSafety: { enum: ["SAFE", "BLOCKED", "RISK_KNOWN"] }, confidence: { type: "string" }, followUp: stringArray } },
  validator: { type: "object", additionalProperties: false, required: ["verdict", "checks"], properties: { verdict: { enum: ["PASS", "FAIL", "WARN"] }, checks: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "status"], properties: { id: { type: "string" }, status: { enum: ["PASS", "FAIL", "WARN", "SKIP"] }, evidence: { type: "string" } } } } } },
  recovery: { type: "object", additionalProperties: false, required: ["failureType", "rationale", "nextAction"], properties: { failureType: { enum: ["PATCH_CONTEXT_MISMATCH", "TOOL_FAILURE", "MISSING_CONTEXT", "WRONG_AGENT", "VALIDATION_FAILURE", "REVIEW_FAILURE", "AMBIGUOUS_OUTPUT", "CONFLICTING_RESULTS"] }, rationale: { type: "string" }, nextAction: { type: "string" } } },
  orchestrator: { type: "object", additionalProperties: false, required: ["summary", "delegatedAgents", "unresolved"], properties: { summary: { type: "string" }, delegatedAgents: stringArray, validationStatus: { type: "string" }, unresolved: stringArray, finalizationSafe: { type: "boolean" } } },
  supervisor: { type: "object", additionalProperties: false, required: ["summary", "consolidatedFindings", "sourceFindingIds", "conflicts", "missingEvidence", "unresolved", "finalizationSafety"], properties: { summary: { type: "string" }, consolidatedFindings: { type: "array", items: findingJson }, sourceFindingIds: stringArray, conflicts: { type: "array", items: { type: "object", additionalProperties: false, required: ["summary", "sources"], properties: { summary: { type: "string" }, sources: stringArray } } }, missingEvidence: stringArray, unresolved: stringArray, roadmap: { type: "array", items: supervisorRoadmapItemJson }, finalizationSafety: { enum: ["SAFE", "BLOCKED", "RISK_KNOWN"] } } },
  "semantic-assessment": z.toJSONSchema(semanticAssessmentPayloadV1Schema) as Record<string, unknown>
};

export function validateAgentOutput(contractName: string, value: unknown): { ok: boolean; value?: unknown; issues: string[] } { const schema = schemas[contractName]; if (!schema) return { ok: false, issues: [`Unknown agent output contract: ${contractName}`] }; const parsed = schema.safeParse(value); return parsed.success ? { ok: true, value: parsed.data, issues: [] } : { ok: false, issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`) }; }
export function knownOutputContracts(): string[] { return Object.keys(schemas).sort(); }
export function outputJsonSchema(contractName: string): Record<string, unknown> | undefined { const schema = jsonSchemas[contractName]; return schema ? structuredClone(schema) : undefined; }
