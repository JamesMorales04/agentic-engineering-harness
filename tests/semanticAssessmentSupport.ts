import {
  createSemanticEvidenceReceiptV1,
  createSemanticAssessmentServiceV1,
  resolveSemanticAssessor,
  semanticCapabilityPolicyRevisionV1,
  type SemanticAssessmentPayloadV1,
  type SemanticAssessmentRequestV1,
  type SemanticAssessmentRunnerV1,
  type SemanticAssessmentTypeV1,
  type SemanticEvidenceItemV1
} from "../src/semantic/assessment.js";
import { resolveAgentTopology } from "../src/agents/config.js";
import type { AgentTopologySource } from "../src/agents/types.js";

export const semanticAssessorTopologySource: AgentTopologySource = {
  version: 1,
  runtimes: {
    opencode: {
      adapter: "opencode",
      paseoProvider: "opencode",
      capabilities: { modelSelection: true, structuredOutput: true, runtimeConfigInjection: true }
    }
  },
  models: { assessorModel: { runtime: "opencode", provider: "openai", model: "small-structured" } },
  agents: {
    assessor: {
      role: "Semantic Assessor",
      execution: { model: "@assessorModel", transport: "paseo" },
      permissions: { read: "deny", write: "deny", shell: "deny", network: "deny", delegate: "deny", review: "deny", validate: "deny", gitWrite: "deny" },
      contextRequirements: { repositoryMap: "FORBIDDEN", semanticRetrieval: "FORBIDDEN", rawRetrieval: "FORBIDDEN", compression: "FORBIDDEN" },
      outputContract: "semantic-assessment",
      skills: [],
      mcps: []
    }
  }
};

export function semanticTestAssessor() {
  return resolveSemanticAssessor(resolveAgentTopology(semanticAssessorTopologySource));
}

export function semanticTestRequest(
  assessmentType: SemanticAssessmentTypeV1 = "STACK",
  options: { evidence?: SemanticEvidenceItemV1[]; binding?: Partial<SemanticAssessmentRequestV1["binding"]> } = {}
): SemanticAssessmentRequestV1 {
  const binding: SemanticAssessmentRequestV1["binding"] = {
    projectId: "project-test",
    repositoryDigest: "repo-digest",
    ...options.binding
  };
  const compactEvidence = options.evidence ?? [{ ref: "evidence", content: "Controller supplied bounded evidence." }];
  return {
    version: 1,
    assessmentType,
    evidenceRefs: compactEvidence.map((item) => item.ref),
    compactEvidence,
    evidenceReceipts: compactEvidence.map((item) => createSemanticEvidenceReceiptV1({ binding, ref: item.ref, content: item.content, kind: "REQUEST" })),
    requiredOutputSchema: "semantic-assessment-v1",
    reasoningRequirement: {
      reasoningClass: assessmentType === "ROUTE" || assessmentType === "CANDIDATE_IMPACT" ? "DEEP" : "LIGHT",
      structuredOutputRequired: true,
      independenceRequired: false,
      externalKnowledgeRequired: false,
      maxContextClass: assessmentType === "STACK" || assessmentType === "CANDIDATE_IMPACT" ? "LARGE" : "SMALL",
      riskClass: assessmentType === "CANDIDATE_IMPACT" ? "CRITICAL" : "STANDARD"
    },
    binding,
    budget: { maxInputTokens: 1_000, maxOutputTokens: 500, deadlineMs: 10_000 },
    policyRevision: semanticCapabilityPolicyRevisionV1
  };
}

export function semanticPayload(request: SemanticAssessmentRequestV1, override?: Partial<SemanticAssessmentPayloadV1>): SemanticAssessmentPayloadV1 {
  const refs = request.evidenceRefs;
  const judgment: SemanticAssessmentPayloadV1["judgment"] = (() => {
    switch (request.assessmentType) {
      case "INTENT": return { type: "INTENT", intent: "change", confidence: 0.8, evidenceRefs: [refs[0]!] };
      case "ROUTE": return { type: "ROUTE", recommendedRoute: "DIRECT", scopeClarity: "HIGH", decompositionNeed: false, coordinationNeed: false, architectureUncertainty: false, productUncertainty: false, formalizationNeed: "NONE", semanticRiskSignals: [], evidenceRefs: [refs[0]!], unknowns: ["unknown route context"] };
      case "STACK": return { type: "STACK", languages: ["Rust"], frameworks: [], packageManagers: [], databases: [], toolchains: [], signals: [{ id: "language", evidenceRef: refs[0]! }], testFrameworks: [], migrationMechanisms: [], buildSystems: [], versions: {}, projectSkillRoots: [], evidenceRefs: [refs[0]!], unknowns: ["unknown build tool"] };
      case "ISSUE": return { type: "ISSUE", classification: "ready", requestedOutcome: "Implement the reported behavior", explicitRequirements: [], evidenceRefs: [refs[0]!], unknowns: ["unknown acceptance detail"] };
      case "FAILURE": return { type: "FAILURE", classification: "AMBIGUOUS_OUTPUT", evidenceRefs: [refs[0]!] };
      case "CANDIDATE_IMPACT": return { type: "CANDIDATE_IMPACT", changedFiles: ["src/example.ts"], changeKinds: ["source"], reviewDimensions: [], requiresIndependentReview: true, evidenceRefs: [refs[0]!], unknowns: ["unknown downstream effect"] };
      case "VALIDATION_NEED": return { type: "VALIDATION_NEED", property: "Expected behavior is preserved", rationale: "The request changes behavior.", scope: ["src/**"], evidenceRefs: [refs[0]!], unknowns: ["unknown validator mapping"] };
    }
  })();
  return {
    judgment,
    claims: [],
    assumptions: [],
    unknowns: ["bounded evidence only"],
    recommendations: [],
    knowledgeGaps: [],
    ...override
  } as SemanticAssessmentPayloadV1;
}

export function semanticTestService(options: {
  payload?: (request: SemanticAssessmentRequestV1) => unknown;
  runner?: SemanticAssessmentRunnerV1;
  cache?: Parameters<typeof createSemanticAssessmentServiceV1>[0]["cache"];
}) {
  const assessor = semanticTestAssessor();
  const runner = options.runner ?? {
    assess: async ({ request: assessmentRequest }: { request: SemanticAssessmentRequestV1 }) => ({
      payload: options.payload?.(assessmentRequest) ?? semanticPayload(assessmentRequest),
      paseoSession: { provider: "opencode", agentId: "paseo-semantic-session-1", workspaceId: "workspace-test", transport: "sdk" as const }
    })
  };
  return createSemanticAssessmentServiceV1({ assessor, runner, policyRevision: semanticCapabilityPolicyRevisionV1, ...(options.cache ? { cache: options.cache } : {}) });
}
