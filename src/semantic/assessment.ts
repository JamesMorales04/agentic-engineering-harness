import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { executionSelectionForAgent } from "../agents/routing.js";
import type { AgentExecutionSelection, ResolvedAgentTopology } from "../agents/types.js";
import { validateExecutionCapabilities } from "../agents/permissions.js";
import { sha256Canonical, sha256Utf8 } from "../core/digest.js";
import { AehError } from "../core/errors.js";
import { changeKindSchema } from "../architecture/workGraph.js";

export const semanticAssessmentTypeValues = ["INTENT", "ROUTE", "STACK", "ISSUE", "FAILURE", "CANDIDATE_IMPACT", "VALIDATION_NEED"] as const;
export type SemanticAssessmentTypeV1 = (typeof semanticAssessmentTypeValues)[number];
export const semanticAssessmentTypeSchema = z.enum(semanticAssessmentTypeValues);

export const reasoningClassValues = ["LIGHT", "STANDARD", "DEEP"] as const;
export type ReasoningClassV1 = (typeof reasoningClassValues)[number];
export const reasoningClassSchema = z.enum(reasoningClassValues);

export const assessmentContextClassValues = ["SMALL", "STANDARD", "LARGE"] as const;
export type AssessmentContextClassV1 = (typeof assessmentContextClassValues)[number];
export const assessmentContextClassSchema = z.enum(assessmentContextClassValues);

export const assessmentRiskClassValues = ["LOW", "STANDARD", "HIGH", "CRITICAL"] as const;
export type AssessmentRiskClassV1 = (typeof assessmentRiskClassValues)[number];
export const assessmentRiskClassSchema = z.enum(assessmentRiskClassValues);

export const decisionMechanismValues = ["DETERMINISTIC", "MODEL", "HYBRID"] as const;
export type DecisionMechanismV1 = (typeof decisionMechanismValues)[number];
export const decisionMechanismSchema = z.enum(decisionMechanismValues);

export interface AssessmentRequirementV1 {
  reasoningClass: ReasoningClassV1;
  structuredOutputRequired: boolean;
  independenceRequired: boolean;
  externalKnowledgeRequired: boolean;
  maxContextClass: AssessmentContextClassV1;
  riskClass: AssessmentRiskClassV1;
}

export interface SemanticAssessmentBindingV1 {
  projectId: string;
  repositoryDigest: string;
  repositoryRootDigest?: string;
  operationId?: string;
  candidateId?: string;
  candidateRevision?: number;
  candidateDigest?: string;
  intentDigest?: string;
}

export const semanticAssessmentBindingV1Schema = z.object({
  projectId: z.string().trim().min(1).max(200),
  repositoryDigest: z.string().trim().min(1).max(200),
  repositoryRootDigest: z.string().trim().min(1).max(200).optional(),
  operationId: z.string().trim().min(1).max(200).optional(),
  candidateId: z.string().trim().min(1).max(200).optional(),
  candidateRevision: z.number().int().positive().optional(),
  candidateDigest: z.string().trim().min(1).max(200).optional(),
  intentDigest: z.string().trim().min(1).max(200).optional()
}).strict().superRefine((value, context) => {
  const candidateFields = [value.candidateId, value.candidateRevision, value.candidateDigest];
  if (candidateFields.some((field) => field !== undefined) && candidateFields.some((field) => field === undefined)) {
    context.addIssue({ code: "custom", path: ["candidateDigest"], message: "candidateId, candidateRevision, and candidateDigest must be bound together" });
  }
});

export interface SemanticEvidenceItemV1 {
  ref: string;
  content: string;
}

export const semanticEvidenceReceiptKindValues = ["REQUEST", "OBSERVED_FACT", "REPOSITORY_FILE", "CANDIDATE_FILE", "OPERATION_ARTIFACT"] as const;
export type SemanticEvidenceReceiptKindV1 = (typeof semanticEvidenceReceiptKindValues)[number];
export interface SemanticEvidenceReceiptV1 {
  version: 1;
  reader: "aeh-controller-v1";
  kind: SemanticEvidenceReceiptKindV1;
  ref: string;
  path?: string;
  contentDigest: string;
  contentBytes: number;
  boundaryDigest: string;
  receiptDigest: string;
}

const semanticEvidenceReceiptShape = z.object({
  version: z.literal(1),
  reader: z.literal("aeh-controller-v1"),
  kind: z.enum(semanticEvidenceReceiptKindValues),
  ref: z.string().trim().min(1).max(200),
  path: z.string().trim().min(1).max(500).optional(),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  contentBytes: z.number().int().nonnegative().max(24_000),
  boundaryDigest: z.string().regex(/^[a-f0-9]{64}$/),
  receiptDigest: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

export function semanticEvidenceBoundaryDigest(binding: SemanticAssessmentBindingV1): string {
  return sha256Canonical({
    projectId: binding.projectId,
    repositoryDigest: binding.repositoryDigest,
    repositoryRootDigest: binding.repositoryRootDigest ?? null,
    operationId: binding.operationId ?? null,
    candidateId: binding.candidateId ?? null,
    candidateRevision: binding.candidateRevision ?? null,
    candidateDigest: binding.candidateDigest ?? null
  });
}

/** Create a receipt for exact controller-supplied bytes; file callers must first enforce the repository/candidate read boundary. */
export function createSemanticEvidenceReceiptV1(input: {
  binding: SemanticAssessmentBindingV1;
  ref: string;
  content: string;
  kind: SemanticEvidenceReceiptKindV1;
  path?: string;
}): SemanticEvidenceReceiptV1 {
  const normalizedPath = input.path === undefined ? undefined : normalizeEvidencePath(input.path);
  if ((input.kind === "REPOSITORY_FILE" || input.kind === "CANDIDATE_FILE") && !normalizedPath) {
    throw new AehError("SEMANTIC_ASSESSMENT_INVALID", `${input.kind} receipts require a normalized repository-relative path.`);
  }
  if (normalizedPath && input.ref !== `file:${normalizedPath}`) throw new AehError("SEMANTIC_ASSESSMENT_INVALID", "repository file evidence refs must equal file:<normalized path>.");
  const base = {
    version: 1 as const,
    reader: "aeh-controller-v1" as const,
    kind: input.kind,
    ref: input.ref,
    ...(normalizedPath ? { path: normalizedPath } : {}),
    contentDigest: sha256Utf8(input.content),
    contentBytes: Buffer.byteLength(input.content, "utf8"),
    boundaryDigest: semanticEvidenceBoundaryDigest(input.binding)
  };
  if (base.contentBytes > 24_000) throw new AehError("SEMANTIC_ASSESSMENT_INVALID", "semantic evidence exceeds the controller receipt byte bound.");
  return { ...base, receiptDigest: sha256Canonical(base) };
}

export interface SemanticAssessmentRequestV1 {
  version: 1;
  assessmentType: SemanticAssessmentTypeV1;
  evidenceRefs: string[];
  compactEvidence: SemanticEvidenceItemV1[];
  evidenceReceipts: SemanticEvidenceReceiptV1[];
  requiredOutputSchema: string;
  reasoningRequirement: AssessmentRequirementV1;
  binding: SemanticAssessmentBindingV1;
  budget: {
    maxInputTokens?: number;
    maxOutputTokens?: number;
    deadlineMs?: number;
  };
  policyRevision: string;
}

const assessmentRequirementSchema = z.object({
  reasoningClass: reasoningClassSchema,
  structuredOutputRequired: z.boolean(),
  independenceRequired: z.boolean(),
  externalKnowledgeRequired: z.boolean(),
  maxContextClass: assessmentContextClassSchema,
  riskClass: assessmentRiskClassSchema
}).strict();

export const semanticAssessmentRequestV1Schema = z.object({
  version: z.literal(1),
  assessmentType: semanticAssessmentTypeSchema,
  evidenceRefs: z.array(z.string().trim().min(1).max(200)).min(1).max(32),
  compactEvidence: z.array(z.object({ ref: z.string().trim().min(1).max(200), content: z.string().min(1).max(4_000) }).strict()).min(1).max(16),
  evidenceReceipts: z.array(semanticEvidenceReceiptShape).min(1).max(32),
  requiredOutputSchema: z.literal("semantic-assessment-v1"),
  reasoningRequirement: assessmentRequirementSchema,
  binding: semanticAssessmentBindingV1Schema,
  budget: z.object({ maxInputTokens: z.number().int().positive().max(32_000).optional(), maxOutputTokens: z.number().int().positive().max(8_000).optional(), deadlineMs: z.number().int().positive().max(120_000).optional() }).strict(),
  policyRevision: z.string().trim().min(1).max(200)
}).strict().superRefine((value, context) => {
  const refs = new Set(value.compactEvidence.map((item) => item.ref));
  const receiptRefs = new Set(value.evidenceReceipts.map((item) => item.ref));
  if (refs.size !== value.compactEvidence.length) context.addIssue({ code: "custom", path: ["compactEvidence"], message: "evidence refs must be unique" });
  if (receiptRefs.size !== value.evidenceReceipts.length) context.addIssue({ code: "custom", path: ["evidenceReceipts"], message: "evidence receipt refs must be unique" });
  if (value.evidenceRefs.length !== refs.size || value.evidenceRefs.some((ref) => !refs.has(ref) || !receiptRefs.has(ref))) context.addIssue({ code: "custom", path: ["evidenceRefs"], message: "evidenceRefs, compactEvidence, and evidenceReceipts must have the same refs" });
  if (receiptRefs.size !== refs.size || [...receiptRefs].some((ref) => !refs.has(ref))) context.addIssue({ code: "custom", path: ["evidenceReceipts"], message: "every evidence receipt must identify exactly one supplied evidence item" });
  const bytes = value.compactEvidence.reduce((total, item) => total + Buffer.byteLength(item.content, "utf8"), 0);
  if (bytes > 24_000) context.addIssue({ code: "custom", path: ["compactEvidence"], message: "compact evidence exceeds the 24000-byte bound" });
});

const claimStatusValues = ["SUPPORTED", "UNCERTAIN", "CONFLICTING"] as const;
const semanticFailureClassValues = ["PATCH_CONTEXT_MISMATCH", "TOOL_FAILURE", "MISSING_CONTEXT", "WRONG_AGENT", "VALIDATION_FAILURE", "REVIEW_FAILURE", "AMBIGUOUS_OUTPUT", "CONFLICTING_RESULTS"] as const;
const evidenceRefSchema = z.string().trim().min(1).max(200);
const semanticJudgmentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("INTENT"), intent: z.enum(["informational", "audit", "change"]), confidence: z.number().min(0).max(1), evidenceRefs: z.array(evidenceRefSchema).min(1).max(32) }).strict(),
  z.object({
    type: z.literal("ROUTE"),
    recommendedRoute: z.enum(["DIRECT", "DELEGATED", "FORMAL_SDD"]),
    scopeClarity: z.enum(["LOW", "MEDIUM", "HIGH"]),
    decompositionNeed: z.boolean(),
    coordinationNeed: z.boolean(),
    architectureUncertainty: z.boolean(),
    productUncertainty: z.boolean(),
    formalizationNeed: z.enum(["NONE", "RECOMMENDED", "REQUIRED"]),
    semanticRiskSignals: z.array(z.string().trim().min(1).max(500)).max(32),
    evidenceRefs: z.array(evidenceRefSchema).min(1).max(32),
    unknowns: z.array(z.string().trim().min(1).max(1_000)).max(32)
  }).strict(),
  z.object({ type: z.literal("FAILURE"), classification: z.enum(semanticFailureClassValues), evidenceRefs: z.array(evidenceRefSchema).min(1).max(32) }).strict(),
  z.object({
    type: z.literal("STACK"),
    languages: z.array(z.string().trim().min(1).max(100)).max(16),
    frameworks: z.array(z.string().trim().min(1).max(200)).max(64),
    packageManagers: z.array(z.string().trim().min(1).max(200)).max(32),
    databases: z.array(z.string().trim().min(1).max(200)).max(32),
    toolchains: z.array(z.string().trim().min(1).max(200)).max(64),
    signals: z.array(z.object({ id: z.string().trim().min(1).max(200), evidenceRef: evidenceRefSchema }).strict()).max(128),
    testFrameworks: z.array(z.string().trim().min(1).max(200)).max(32),
    migrationMechanisms: z.array(z.string().trim().min(1).max(200)).max(32),
    buildSystems: z.array(z.string().trim().min(1).max(200)).max(32),
    versions: z.record(z.string().trim().min(1).max(200), z.string().trim().min(1).max(200)),
    projectSkillRoots: z.array(z.string().min(1).max(200)).max(64),
    evidenceRefs: z.array(evidenceRefSchema).min(1).max(128),
    unknowns: z.array(z.string().trim().min(1).max(1_000)).max(32)
  }).strict(),
  z.object({
    type: z.literal("ISSUE"),
    classification: z.enum(["ready", "requires_product_decision", "spec_contradiction"]),
    requestedOutcome: z.string().trim().min(1).max(2_000),
    explicitRequirements: z.array(z.object({ statement: z.string().trim().min(1).max(2_000), evidenceRefs: z.array(evidenceRefSchema).min(1).max(16) }).strict()).max(64),
    evidenceRefs: z.array(evidenceRefSchema).min(1).max(128),
    unknowns: z.array(z.string().trim().min(1).max(1_000)).max(32)
  }).strict(),
  z.object({
    type: z.literal("CANDIDATE_IMPACT"),
    changedFiles: z.array(z.string().trim().min(1).max(500)).max(256),
    changeKinds: z.array(changeKindSchema).max(32),
    reviewDimensions: z.array(z.string().trim().min(1).max(200)).max(128),
    requiresIndependentReview: z.boolean(),
    evidenceRefs: z.array(evidenceRefSchema).min(1).max(512),
    unknowns: z.array(z.string().trim().min(1).max(1_000)).max(64)
  }).strict(),
  z.object({
    type: z.literal("VALIDATION_NEED"),
    property: z.string().trim().min(1).max(500),
    rationale: z.string().trim().min(1).max(1_000),
    scope: z.array(z.string().trim().min(1).max(500)).min(1).max(128),
    evidenceRefs: z.array(evidenceRefSchema).min(1).max(64),
    unknowns: z.array(z.string().trim().min(1).max(1_000)).max(32)
  }).strict()
]);
export type SemanticAssessmentJudgmentV1 = z.infer<typeof semanticJudgmentSchema>;
export type SemanticStackJudgmentV1 = Extract<SemanticAssessmentJudgmentV1, { type: "STACK" }>;
export type SemanticIssueJudgmentV1 = Extract<SemanticAssessmentJudgmentV1, { type: "ISSUE" }>;
export type SemanticCandidateImpactJudgmentV1 = Extract<SemanticAssessmentJudgmentV1, { type: "CANDIDATE_IMPACT" }>;
export type SemanticValidationNeedJudgmentV1 = Extract<SemanticAssessmentJudgmentV1, { type: "VALIDATION_NEED" }>;
export const semanticAssessmentPayloadV1Schema = z.object({
  judgment: semanticJudgmentSchema,
  claims: z.array(z.object({ id: z.string().trim().min(1).max(100), statement: z.string().trim().min(1).max(2_000), status: z.enum(claimStatusValues), evidenceRefs: z.array(evidenceRefSchema).max(32) }).strict()).max(64),
  assumptions: z.array(z.string().trim().min(1).max(1_000)).max(32),
  unknowns: z.array(z.string().trim().min(1).max(1_000)).max(32),
  recommendations: z.array(z.object({ id: z.string().trim().min(1).max(100), statement: z.string().trim().min(1).max(2_000), evidenceRefs: z.array(evidenceRefSchema).max(32) }).strict()).max(32),
  knowledgeGaps: z.array(z.object({ competency: z.string().trim().min(1).max(200), reason: z.string().trim().min(1).max(1_000), blocking: z.boolean(), evidenceRefs: z.array(evidenceRefSchema).max(32) }).strict()).max(32)
}).strict().superRefine((value, context) => {
  for (const [index, claim] of value.claims.entries()) {
    if (claim.status !== "UNCERTAIN" && claim.evidenceRefs.length === 0) context.addIssue({ code: "custom", path: ["claims", index, "evidenceRefs"], message: "supported or conflicting claims require evidence references" });
  }
  for (const [index, recommendation] of value.recommendations.entries()) {
    if (recommendation.evidenceRefs.length === 0) context.addIssue({ code: "custom", path: ["recommendations", index, "evidenceRefs"], message: "recommendations require evidence references" });
  }
});
export type SemanticAssessmentPayloadV1 = z.infer<typeof semanticAssessmentPayloadV1Schema>;

export interface SemanticAssessorIdentityV1 {
  version: 1;
  role: "Semantic Assessor";
  logicalAgent: string;
  topologyProfile?: string;
  modelAlias: string;
  modelId: string;
  modelName: string;
  modelProvider?: string;
  runtimeName: string;
  runtimeAdapter: string;
  paseoProvider: string;
  variant?: string;
  identityDigest: string;
}

export interface ResolvedSemanticAssessorV1 {
  identity: SemanticAssessorIdentityV1;
  selection: AgentExecutionSelection;
}

export interface SemanticPaseoSessionIdentityV1 {
  provider: string;
  agentId: string;
  workspaceId?: string;
  transport: "sdk" | "cli";
}

export interface SemanticAssessmentV1 extends SemanticAssessmentPayloadV1 {
  version: 1;
  assessmentType: SemanticAssessmentTypeV1;
  mechanism: "MODEL";
  binding: SemanticAssessmentBindingV1;
  policyRevision: string;
  evidenceRefs: string[];
  evidenceReceipts: SemanticEvidenceReceiptV1[];
  evidenceDigest: string;
  assessor: SemanticAssessorIdentityV1;
  paseoSession: SemanticPaseoSessionIdentityV1;
  assessmentDigest: string;
  cacheIdentity: string;
  cacheDisposition: "FRESH" | "HIT";
}

export interface SemanticAssessmentTelemetryV1 {
  assessmentType: SemanticAssessmentTypeV1;
  assessorId: string;
  paseoAgentId: string;
  evidenceDigest: string;
  assessmentDigest: string;
  cacheHit: boolean;
}

export interface SemanticAssessmentCacheV1 {
  get(key: string): Promise<SemanticAssessmentV1 | undefined>;
  set(key: string, value: SemanticAssessmentV1): Promise<void>;
}

export class InMemorySemanticAssessmentCacheV1 implements SemanticAssessmentCacheV1 {
  private readonly values = new Map<string, SemanticAssessmentV1>();
  async get(key: string): Promise<SemanticAssessmentV1 | undefined> { return this.values.get(key); }
  async set(key: string, value: SemanticAssessmentV1): Promise<void> { this.values.set(key, value); }
}

/** Durable controller-owned storage for complete, provenance-bearing assessments. */
export class FileSemanticAssessmentCacheV1 implements SemanticAssessmentCacheV1 {
  private readonly directory: string;

  constructor(root: string) {
    this.directory = path.resolve(root, ".harness", "cache", "semantic-assessments-v1");
  }

  async get(key: string): Promise<SemanticAssessmentV1 | undefined> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new AehError("SEMANTIC_ASSESSMENT_INVALID", "semantic cache key must be a SHA-256 digest.");
    const file = path.join(this.directory, `${key}.json`);
    let stat: import("node:fs").Stats;
    try { stat = await fs.lstat(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new AehError("SEMANTIC_ASSESSMENT_INVALID", `unable to inspect semantic cache entry ${key}.`, { cause: error });
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new AehError("SEMANTIC_ASSESSMENT_INVALID", `semantic cache entry ${key} is not a regular file.`);
    try { return JSON.parse(await fs.readFile(file, "utf8")) as SemanticAssessmentV1; }
    catch (error) { throw new AehError("SEMANTIC_ASSESSMENT_INVALID", `semantic cache entry ${key} is malformed.`, { cause: error }); }
  }

  async set(key: string, value: SemanticAssessmentV1): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(key) || value.cacheIdentity !== key) throw new AehError("SEMANTIC_ASSESSMENT_INVALID", "semantic cache entry key does not match its canonical identity.");
    await fs.mkdir(this.directory, { recursive: true });
    const file = path.join(this.directory, `${key}.json`);
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    try { await fs.rename(temporary, file); }
    catch (error) { await fs.rm(temporary, { force: true }).catch(() => undefined); throw error; }
  }
}

export interface SemanticAssessmentRunnerResultV1 {
  payload: unknown;
  paseoSession: SemanticPaseoSessionIdentityV1;
}

/** Production runners must execute the selected AEH agent through Paseo; provider inference calls are not this interface. */
export interface SemanticAssessmentRunnerV1 {
  assess(input: { request: SemanticAssessmentRequestV1; assessor: SemanticAssessorIdentityV1 }): Promise<SemanticAssessmentRunnerResultV1>;
}

export interface SemanticAssessmentServiceOptionsV1 {
  assessor: ResolvedSemanticAssessorV1;
  runner: SemanticAssessmentRunnerV1;
  policyRevision: string;
  cache?: SemanticAssessmentCacheV1;
  onTelemetry?: (event: SemanticAssessmentTelemetryV1) => Promise<void> | void;
}

export const semanticCapabilityPolicyRevisionV1 = "core-semantic-capability-policy-v1";
export const semanticCapabilityPolicyV1: Readonly<Record<SemanticAssessmentTypeV1, { maxInputTokens: number; maxOutputTokens: number; maxDeadlineMs: number; maxReasoningClass: ReasoningClassV1; maxContextClass: AssessmentContextClassV1; maxRiskClass: AssessmentRiskClassV1 }>> = {
  INTENT: { maxInputTokens: 4_000, maxOutputTokens: 1_000, maxDeadlineMs: 30_000, maxReasoningClass: "STANDARD", maxContextClass: "SMALL", maxRiskClass: "HIGH" },
  ROUTE: { maxInputTokens: 8_000, maxOutputTokens: 1_500, maxDeadlineMs: 45_000, maxReasoningClass: "DEEP", maxContextClass: "STANDARD", maxRiskClass: "HIGH" },
  STACK: { maxInputTokens: 8_000, maxOutputTokens: 2_000, maxDeadlineMs: 45_000, maxReasoningClass: "STANDARD", maxContextClass: "LARGE", maxRiskClass: "HIGH" },
  ISSUE: { maxInputTokens: 8_000, maxOutputTokens: 2_000, maxDeadlineMs: 45_000, maxReasoningClass: "STANDARD", maxContextClass: "STANDARD", maxRiskClass: "HIGH" },
  FAILURE: { maxInputTokens: 8_000, maxOutputTokens: 1_500, maxDeadlineMs: 45_000, maxReasoningClass: "STANDARD", maxContextClass: "STANDARD", maxRiskClass: "HIGH" },
  CANDIDATE_IMPACT: { maxInputTokens: 12_000, maxOutputTokens: 2_000, maxDeadlineMs: 60_000, maxReasoningClass: "DEEP", maxContextClass: "LARGE", maxRiskClass: "CRITICAL" },
  VALIDATION_NEED: { maxInputTokens: 8_000, maxOutputTokens: 1_500, maxDeadlineMs: 45_000, maxReasoningClass: "STANDARD", maxContextClass: "STANDARD", maxRiskClass: "HIGH" }
};

export function resolveSemanticAssessor(topology: ResolvedAgentTopology): ResolvedSemanticAssessorV1 {
  const configured = Object.values(topology.agents).filter((agent) => agent.role === "Semantic Assessor" && !agent.disabled).sort((left, right) => left.name.localeCompare(right.name));
  if (configured.length !== 1) throw new AehError("SEMANTIC_ASSESSMENT_UNAVAILABLE", `AgentTopology must resolve exactly one enabled Semantic Assessor; found ${configured.length}.`);
  const agent = configured[0]!;
  const selection = executionSelectionForAgent(topology, agent.name);
  const capabilityIssues = validateExecutionCapabilities(selection, "paseo");
  if (capabilityIssues.length) throw new AehError("SEMANTIC_ASSESSMENT_UNAVAILABLE", capabilityIssues.join("; "));
  const permissions = selection.permissions;
  const requiredDenied = ["read", "write", "shell", "network", "delegate", "review", "validate", "gitWrite"] as const;
  const permissionIssues = requiredDenied.filter((key) => permissions[key] !== "deny");
  if (permissionIssues.length) throw new AehError("SEMANTIC_ASSESSMENT_UNAVAILABLE", `Semantic Assessor permissions must explicitly deny ${permissionIssues.join(", ")}.`);
  if (selection.transport !== "paseo" || selection.runtimeAdapter !== "opencode" || selection.paseoProvider !== "opencode") throw new AehError("SEMANTIC_ASSESSMENT_UNAVAILABLE", "Semantic Assessor requires the AEH-managed OpenCode runtime through Paseo.");
  if (selection.runtimeCapabilities.runtimeConfigInjection !== true || selection.runtimeCapabilities.structuredOutput !== true || selection.runtimeCapabilities.modelSelection !== true) throw new AehError("SEMANTIC_ASSESSMENT_UNAVAILABLE", "Semantic Assessor runtime must support AEH permission projection, topology model selection, and structured output.");
  if (selection.nativeAgent || selection.skills.length || selection.mcps.length || selection.args.length || agent.capabilities?.length || agent.orchestratorPromptPath) throw new AehError("SEMANTIC_ASSESSMENT_UNAVAILABLE", "Semantic Assessor topology cannot select external agents, tools, skills, capabilities, runtime arguments, or orchestrator prompts.");
  if (selection.outputContract !== "semantic-assessment") throw new AehError("SEMANTIC_ASSESSMENT_UNAVAILABLE", "Semantic Assessor topology must use the semantic-assessment output contract.");
  const contextRequirements = agent.contextRequirements;
  if (!contextRequirements || [contextRequirements.repositoryMap, contextRequirements.semanticRetrieval, contextRequirements.rawRetrieval, contextRequirements.compression].some((value) => value !== "FORBIDDEN")) throw new AehError("SEMANTIC_ASSESSMENT_UNAVAILABLE", "Semantic Assessor topology must forbid repository maps, retrieval, raw reads, and compression tools.");
  const identityBase = {
    version: 1 as const,
    role: "Semantic Assessor" as const,
    logicalAgent: agent.name,
    ...(topology.profile ? { topologyProfile: topology.profile } : {}),
    modelAlias: selection.modelAlias,
    modelId: selection.modelId,
    modelName: selection.modelName,
    ...(selection.modelProvider ? { modelProvider: selection.modelProvider } : {}),
    runtimeName: selection.runtimeName,
    runtimeAdapter: selection.runtimeAdapter,
    paseoProvider: selection.paseoProvider,
    ...(selection.variant ? { variant: selection.variant } : {})
  };
  return { identity: { ...identityBase, identityDigest: sha256Canonical(identityBase) }, selection };
}

const rank = { LIGHT: 0, STANDARD: 1, DEEP: 2 } as const;
const contextRank = { SMALL: 0, STANDARD: 1, LARGE: 2 } as const;
const riskRank = { LOW: 0, STANDARD: 1, HIGH: 2, CRITICAL: 3 } as const;

function validateRequestPolicy(request: SemanticAssessmentRequestV1, policyRevision: string): void {
  const limit = semanticCapabilityPolicyV1[request.assessmentType];
  const requirement = request.reasoningRequirement;
  if (request.policyRevision !== policyRevision || request.policyRevision !== semanticCapabilityPolicyRevisionV1) throw new AehError("SEMANTIC_ASSESSMENT_INVALID", "request policy revision is stale or does not match the deterministic semantic capability policy.");
  if (!requirement.structuredOutputRequired || requirement.independenceRequired || requirement.externalKnowledgeRequired) throw new AehError("SEMANTIC_ASSESSMENT_INVALID", "semantic assessments require structured output and cannot request independence or external knowledge.");
  if (rank[requirement.reasoningClass] > rank[limit.maxReasoningClass] || contextRank[requirement.maxContextClass] > contextRank[limit.maxContextClass] || riskRank[requirement.riskClass] > riskRank[limit.maxRiskClass]) throw new AehError("SEMANTIC_ASSESSMENT_INVALID", `${request.assessmentType} exceeds the deterministic semantic capability policy.`);
  if ((request.budget.maxInputTokens ?? limit.maxInputTokens) > limit.maxInputTokens || (request.budget.maxOutputTokens ?? limit.maxOutputTokens) > limit.maxOutputTokens || (request.budget.deadlineMs ?? limit.maxDeadlineMs) > limit.maxDeadlineMs) throw new AehError("SEMANTIC_ASSESSMENT_INVALID", `${request.assessmentType} exceeds the deterministic semantic assessment budget.`);
}

function validateEvidenceReceipts(request: SemanticAssessmentRequestV1): void {
  const evidence = new Map(request.compactEvidence.map((item) => [item.ref, item.content]));
  for (const receipt of request.evidenceReceipts) {
    const content = evidence.get(receipt.ref);
    if (content === undefined) throw new AehError("SEMANTIC_ASSESSMENT_INVALID", `evidence receipt ${receipt.ref} has no supplied content.`);
    if (receipt.contentDigest !== sha256Utf8(content) || receipt.contentBytes !== Buffer.byteLength(content, "utf8")) throw new AehError("SEMANTIC_ASSESSMENT_INVALID", `evidence receipt ${receipt.ref} does not bind the exact supplied bytes.`);
    if (receipt.boundaryDigest !== semanticEvidenceBoundaryDigest(request.binding)) throw new AehError("SEMANTIC_ASSESSMENT_INVALID", `evidence receipt ${receipt.ref} is outside the bound repository/candidate boundary.`);
    if (receipt.receiptDigest !== semanticEvidenceReceiptDigest(receipt)) throw new AehError("SEMANTIC_ASSESSMENT_INVALID", `evidence receipt ${receipt.ref} digest is invalid.`);
    if ((receipt.kind === "REPOSITORY_FILE" || receipt.kind === "CANDIDATE_FILE") && (!receipt.path || normalizeEvidencePath(receipt.path) !== receipt.path || receipt.ref !== `file:${receipt.path}`)) throw new AehError("SEMANTIC_ASSESSMENT_INVALID", `file evidence receipt ${receipt.ref} has no matching normalized path.`);
  }
}

export function semanticEvidenceReceiptDigest(receipt: SemanticEvidenceReceiptV1): string {
  const { receiptDigest: _ignored, ...body } = receipt;
  return sha256Canonical(body);
}

export function semanticAssessmentEvidenceDigest(request: Pick<SemanticAssessmentRequestV1, "evidenceRefs" | "compactEvidence" | "evidenceReceipts">): string {
  return sha256Canonical({
    refs: [...request.evidenceRefs].sort(),
    evidence: [...request.compactEvidence].sort((left, right) => left.ref.localeCompare(right.ref)),
    receipts: [...request.evidenceReceipts].sort((left, right) => left.ref.localeCompare(right.ref))
  });
}

export class SemanticAssessmentServiceV1 {
  private readonly cache: SemanticAssessmentCacheV1;

  constructor(private readonly options: SemanticAssessmentServiceOptionsV1) {
    if (!options.policyRevision.trim()) throw new AehError("SEMANTIC_ASSESSMENT_INVALID", "semantic assessment policyRevision must be non-empty.");
    this.cache = options.cache ?? new InMemorySemanticAssessmentCacheV1();
  }

  async assess(request: SemanticAssessmentRequestV1): Promise<SemanticAssessmentV1> {
    const parsed = semanticAssessmentRequestV1Schema.safeParse(request);
    if (!parsed.success) throw new AehError("SEMANTIC_ASSESSMENT_INVALID", parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; "));
    const normalizedRequest: SemanticAssessmentRequestV1 = {
      ...parsed.data,
      evidenceRefs: [...parsed.data.evidenceRefs].sort((left, right) => left.localeCompare(right)),
      compactEvidence: [...parsed.data.compactEvidence].sort((left, right) => left.ref.localeCompare(right.ref)),
      evidenceReceipts: [...parsed.data.evidenceReceipts].sort((left, right) => left.ref.localeCompare(right.ref))
    };
    validateRequestPolicy(normalizedRequest, this.options.policyRevision);
    validateEvidenceReceipts(normalizedRequest);
    const evidenceDigest = semanticAssessmentEvidenceDigest(normalizedRequest);
    const cacheIdentity = sha256Canonical({ version: 1, assessmentType: normalizedRequest.assessmentType, evidenceDigest, binding: normalizedRequest.binding, policyRevision: normalizedRequest.policyRevision, assessorDigest: this.options.assessor.identity.identityDigest, requirement: normalizedRequest.reasoningRequirement, budget: normalizedRequest.budget });
    const cached = await this.cache.get(cacheIdentity);
    if (cached) {
      const validated = validateCachedAssessment(cached, normalizedRequest, this.options.assessor.identity, evidenceDigest, cacheIdentity);
      const result = { ...validated, cacheDisposition: "HIT" as const };
      await this.emitTelemetry(result, true);
      return result;
    }

    let run: SemanticAssessmentRunnerResultV1;
    try {
      run = await this.options.runner.assess({ request: normalizedRequest, assessor: this.options.assessor.identity });
    } catch (error) {
      if (error instanceof AehError) throw error;
      throw new AehError("SEMANTIC_ASSESSMENT_UNAVAILABLE", `Paseo Semantic Assessor execution failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const payloadResult = semanticAssessmentPayloadV1Schema.safeParse(run.payload);
    if (!payloadResult.success) throw new AehError("SEMANTIC_ASSESSMENT_INVALID", "Paseo Semantic Assessor returned an invalid non-authoritative structured assessment payload.", { cause: payloadResult.error });
    const payload = normalizePayloadUnknowns(payloadResult.data);
    validateAssessmentPayload(payload, normalizedRequest);
    validateSessionIdentity(run.paseoSession, this.options.assessor.identity);
    const assessmentDigest = semanticAssessmentDigest(normalizedRequest, evidenceDigest, this.options.assessor.identity, run.paseoSession, cacheIdentity, payload);
    const result: SemanticAssessmentV1 = {
      version: 1,
      assessmentType: normalizedRequest.assessmentType,
      mechanism: "MODEL",
      binding: normalizedRequest.binding,
      policyRevision: normalizedRequest.policyRevision,
      ...payload,
      evidenceRefs: [...normalizedRequest.evidenceRefs],
      evidenceReceipts: structuredClone(normalizedRequest.evidenceReceipts),
      evidenceDigest,
      assessor: this.options.assessor.identity,
      paseoSession: run.paseoSession,
      assessmentDigest,
      cacheIdentity,
      cacheDisposition: "FRESH"
    };
    await this.cache.set(cacheIdentity, result);
    await this.emitTelemetry(result, false);
    return result;
  }

  private async emitTelemetry(result: SemanticAssessmentV1, cacheHit: boolean): Promise<void> {
    await this.options.onTelemetry?.({ assessmentType: result.assessmentType, assessorId: result.assessor.logicalAgent, paseoAgentId: result.paseoSession.agentId, evidenceDigest: result.evidenceDigest, assessmentDigest: result.assessmentDigest, cacheHit });
  }
}

function validateSessionIdentity(session: SemanticPaseoSessionIdentityV1, assessor: SemanticAssessorIdentityV1): void {
  if (!session || session.provider !== assessor.paseoProvider || !session.agentId?.trim() || !["sdk", "cli"].includes(session.transport)) throw new AehError("SEMANTIC_ASSESSMENT_INVALID", "Paseo execution did not return a valid actual session identity for the selected AEH Semantic Assessor.");
}

function normalizePayloadUnknowns(payload: SemanticAssessmentPayloadV1): SemanticAssessmentPayloadV1 {
  const judgmentUnknowns = "unknowns" in payload.judgment ? payload.judgment.unknowns : [];
  return { ...payload, unknowns: [...new Set([...payload.unknowns, ...judgmentUnknowns])].sort() };
}

function validateAssessmentPayload(payload: SemanticAssessmentPayloadV1, request: SemanticAssessmentRequestV1): void {
  if (payload.judgment.type !== request.assessmentType) throw new AehError("SEMANTIC_ASSESSMENT_INVALID", `${request.assessmentType} assessments require a typed ${request.assessmentType} judgment.`);
  const refs = [
    ...payload.judgment.evidenceRefs,
    ...(payload.judgment.type === "STACK" ? payload.judgment.signals.map((signal) => signal.evidenceRef) : []),
    ...(payload.judgment.type === "ISSUE" ? payload.judgment.explicitRequirements.flatMap((requirement) => requirement.evidenceRefs) : []),
    ...payload.claims.flatMap((claim) => claim.evidenceRefs),
    ...payload.recommendations.flatMap((recommendation) => recommendation.evidenceRefs),
    ...payload.knowledgeGaps.flatMap((gap) => gap.evidenceRefs)
  ];
  if (!refs.length || refs.some((ref) => !request.evidenceRefs.includes(ref))) throw new AehError("SEMANTIC_ASSESSMENT_INVALID", "typed judgment or assessment payload referenced evidence outside the request evidence.");
  const judgmentRefs = new Set(payload.judgment.evidenceRefs);
  const nestedRefs = [
    ...(payload.judgment.type === "STACK" ? payload.judgment.signals.map((signal) => signal.evidenceRef) : []),
    ...(payload.judgment.type === "ISSUE" ? payload.judgment.explicitRequirements.flatMap((requirement) => requirement.evidenceRefs) : [])
  ];
  if (nestedRefs.some((ref) => !judgmentRefs.has(ref))) throw new AehError("SEMANTIC_ASSESSMENT_INVALID", "nested typed judgments must list every evidence reference in their top-level evidenceRefs.");
}

function semanticAssessmentDigest(request: SemanticAssessmentRequestV1, evidenceDigest: string, assessor: SemanticAssessorIdentityV1, paseoSession: SemanticPaseoSessionIdentityV1, cacheIdentity: string, payload: SemanticAssessmentPayloadV1): string {
  return sha256Canonical({ version: 1, mechanism: "MODEL", assessmentType: request.assessmentType, evidenceRefs: request.evidenceRefs, evidenceDigest, binding: request.binding, policyRevision: request.policyRevision, assessor, paseoSession, cacheIdentity, payload });
}

function validateCachedAssessment(cached: SemanticAssessmentV1, request: SemanticAssessmentRequestV1, assessor: SemanticAssessorIdentityV1, evidenceDigest: string, cacheIdentity: string): SemanticAssessmentV1 {
  try {
    const { version: _version, assessmentType: _type, mechanism: _mechanism, binding: _binding, policyRevision: _policy, evidenceRefs: _refs, evidenceReceipts: _receipts, evidenceDigest: _evidenceDigest, assessor: _assessor, paseoSession, assessmentDigest: _digest, cacheIdentity: _cacheIdentity, cacheDisposition: _disposition, ...rawPayload } = cached;
    const payload = normalizePayloadUnknowns(semanticAssessmentPayloadV1Schema.parse(rawPayload));
    validateAssessmentPayload(payload, request);
    validateEvidenceReceipts(request);
    const expectedDigest = semanticAssessmentDigest(request, evidenceDigest, assessor, paseoSession, cacheIdentity, payload);
    if (cached.version !== 1 || cached.mechanism !== "MODEL" || cached.assessmentType !== request.assessmentType || sha256Canonical(cached.binding) !== sha256Canonical(request.binding) || cached.policyRevision !== request.policyRevision || sha256Canonical(cached.evidenceRefs) !== sha256Canonical(request.evidenceRefs) || cached.evidenceDigest !== evidenceDigest || sha256Canonical(cached.evidenceReceipts) !== sha256Canonical(request.evidenceReceipts) || cached.assessmentDigest !== expectedDigest || cached.cacheIdentity !== cacheIdentity || sha256Canonical(cached.assessor) !== sha256Canonical(assessor) || cached.cacheDisposition !== "FRESH" && cached.cacheDisposition !== "HIT") throw new Error("cached assessment provenance or digest is invalid");
    validateSessionIdentity(paseoSession, assessor);
    return { ...cached, ...payload, cacheDisposition: "HIT" };
  } catch (error) {
    if (error instanceof AehError) throw error;
    throw new AehError("SEMANTIC_ASSESSMENT_INVALID", "cached assessment is malformed, stale, replayed, or its provenance digest is invalid.", { cause: error });
  }
}

export function createSemanticAssessmentServiceV1(options: SemanticAssessmentServiceOptionsV1): SemanticAssessmentServiceV1 {
  return new SemanticAssessmentServiceV1(options);
}

export interface DecisionMechanismAssessmentV1 {
  version: 1;
  mechanism: DecisionMechanismV1;
  rationale: string;
  deterministicFacts: string[];
  semanticJudgment?: string;
  controlledAction?: string;
}

function normalizeEvidencePath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized) || normalized.split("/").some((part) => part === ".." || part === "." || part === "")) throw new AehError("SEMANTIC_ASSESSMENT_INVALID", `evidence path '${value}' is not a normalized repository-relative path.`);
  return normalized;
}
