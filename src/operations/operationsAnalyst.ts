import { z } from "zod";
import { sha256Canonical } from "../core/digest.js";
import {
  createSemanticEvidenceReceiptV1,
  semanticCapabilityPolicyRevisionV1,
  type SemanticAssessmentServiceV1,
  type SemanticAssessmentBindingV1,
  type SemanticOperationsAnalysisJudgmentV1
} from "../semantic/assessment.js";

export interface OperationsAnalystEvidenceV1 {
  ref: string;
  content: string;
}

const supervisorActionValues = ["CONTINUE", "RESUME_SAME_SESSION", "ROTATE_SESSION", "RETRY_PARTICIPANT", "RETRIEVE_SKILL", "REPLAN", "SPLIT_WORK", "REASSIGN", "FAIL", "ESCALATE_TO_LEAD", "NONE"] as const;
const findingClassValues = ["PROGRESSING", "POSSIBLE_STALL", "TOOL_MISUSE", "CONTEXT_CHURN", "RESOURCE_WAIT", "BLOCKED", "UNCERTAIN"] as const;
const probableCauseValues = ["PROVIDER_STALL", "TOOL_LOOP", "CONTEXT_CHURN", "BUILD_OR_VALIDATION_WAIT", "TOOL_KNOWLEDGE_GAP", "IMPLEMENTATION_COMPLEXITY", "EXTERNAL_BLOCKER", "UNKNOWN"] as const;

export const operationsAnalystAdvisoryV1Schema = z.object({
  version: z.literal(1),
  kind: z.literal("OPERATIONS_ANALYST_ADVISORY"),
  authority: z.literal("ADVISORY_ONLY"),
  mechanism: z.literal("MODEL"),
  operationId: z.string().trim().min(1).max(200),
  assessmentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  classification: z.enum(findingClassValues),
  probableCause: z.enum(probableCauseValues),
  suggestedSupervisorAction: z.enum(supervisorActionValues),
  rationale: z.string().trim().min(1).max(2_000),
  evidenceRefs: z.array(z.string().trim().min(1).max(200)).min(1).max(32),
  unknowns: z.array(z.string().trim().min(1).max(1_000)).max(16),
  skillOrToolPackSuggestion: z.object({
    topic: z.string().trim().min(1).max(300),
    evidenceRefs: z.array(z.string().trim().min(1).max(200)).min(1).max(16)
  }).strict().optional()
}).strict();

export type OperationsAnalystAdvisoryV1 = Readonly<z.infer<typeof operationsAnalystAdvisoryV1Schema>>;

export interface AnalyzeOperationExecutionInputV1 {
  service: Pick<SemanticAssessmentServiceV1, "assess">;
  binding: SemanticAssessmentBindingV1 & { operationId: string };
  evidence: OperationsAnalystEvidenceV1[];
}

/**
 * Run a bounded semantic diagnosis over controller-selected operation evidence.
 * The returned object is intentionally an advisory projection: it has no fields
 * for policy, budgets, authority, acceptance, or delivery decisions.
 */
export async function analyzeOperationExecutionV1(input: AnalyzeOperationExecutionInputV1): Promise<OperationsAnalystAdvisoryV1> {
  const binding = validateBinding(input.binding);
  const evidence = normalizeEvidence(input.evidence);
  const request = {
    version: 1 as const,
    assessmentType: "OPERATIONS_ANALYSIS" as const,
    evidenceRefs: evidence.map((item) => item.ref),
    compactEvidence: evidence,
    evidenceReceipts: evidence.map((item) => createSemanticEvidenceReceiptV1({ binding, ref: item.ref, content: item.content, kind: "OPERATION_ARTIFACT" })),
    requiredOutputSchema: "semantic-assessment-v1" as const,
    reasoningRequirement: {
      reasoningClass: "STANDARD" as const,
      structuredOutputRequired: true,
      independenceRequired: false,
      externalKnowledgeRequired: false,
      maxContextClass: "STANDARD" as const,
      riskClass: "STANDARD" as const
    },
    binding,
    budget: { maxInputTokens: 4_000, maxOutputTokens: 1_000, deadlineMs: 120_000 },
    policyRevision: semanticCapabilityPolicyRevisionV1
  };
  const assessment = await input.service.assess(request, { attemptBudget: 1 });
  if (assessment.assessmentType !== "OPERATIONS_ANALYSIS" || assessment.binding.operationId !== binding.operationId || assessment.judgment.type !== "OPERATIONS_ANALYSIS") {
    throw new Error("Operations Analyst received an assessment with incompatible operation identity or judgment type.");
  }
  const judgment: SemanticOperationsAnalysisJudgmentV1 = assessment.judgment;
  const evidenceSet = new Set(request.evidenceRefs);
  const refs = [
    ...judgment.evidenceRefs,
    ...(judgment.skillOrToolPackSuggestion?.evidenceRefs ?? [])
  ];
  if (refs.some((ref) => !evidenceSet.has(ref))) throw new Error("Operations Analyst judgment references evidence outside its bound request.");

  return Object.freeze(operationsAnalystAdvisoryV1Schema.parse({
    version: 1,
    kind: "OPERATIONS_ANALYST_ADVISORY",
    authority: "ADVISORY_ONLY",
    mechanism: "MODEL",
    operationId: binding.operationId,
    assessmentDigest: assessment.assessmentDigest,
    evidenceDigest: assessment.evidenceDigest,
    classification: judgment.classification,
    probableCause: judgment.probableCause,
    suggestedSupervisorAction: judgment.suggestedSupervisorAction,
    rationale: judgment.rationale,
    evidenceRefs: judgment.evidenceRefs,
    unknowns: judgment.unknowns,
    ...(judgment.skillOrToolPackSuggestion ? { skillOrToolPackSuggestion: judgment.skillOrToolPackSuggestion } : {})
  }));
}

export function operationsAnalystAdvisoryDigestV1(advisory: OperationsAnalystAdvisoryV1): string {
  return sha256Canonical(advisory);
}

function validateBinding(binding: SemanticAssessmentBindingV1 & { operationId: string }): SemanticAssessmentBindingV1 & { operationId: string } {
  const normalized = {
    ...binding,
    projectId: binding.projectId.trim(),
    repositoryDigest: binding.repositoryDigest.trim(),
    operationId: binding.operationId.trim()
  };
  if (!normalized.projectId || !normalized.repositoryDigest || !normalized.operationId || normalized.operationId.length > 200) throw new Error("Operations Analyst requires project, repository, and operation identity.");
  return normalized;
}

function normalizeEvidence(evidence: OperationsAnalystEvidenceV1[]): OperationsAnalystEvidenceV1[] {
  if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 16) throw new Error("Operations Analyst evidence must contain between 1 and 16 bounded items.");
  const normalized = evidence.map((item) => ({ ref: item.ref.trim(), content: item.content }));
  if (normalized.some((item) => !item.ref || item.ref.length > 200 || !item.content.trim() || Buffer.byteLength(item.content, "utf8") > 4_000)) throw new Error("Operations Analyst evidence items require a reference and at most 4000 UTF-8 bytes of content.");
  if (new Set(normalized.map((item) => item.ref)).size !== normalized.length) throw new Error("Operations Analyst evidence references must be unique.");
  if (normalized.reduce((bytes, item) => bytes + Buffer.byteLength(item.content, "utf8"), 0) > 24_000) throw new Error("Operations Analyst compact evidence exceeds the 24000-byte bound.");
  return normalized;
}
