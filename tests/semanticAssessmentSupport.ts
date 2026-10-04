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
import { executionSelectionForAgent } from "../src/agents/routing.js";
import { sha256Canonical } from "../src/core/digest.js";
import type { AgentTopologySource } from "../src/agents/types.js";

export const semanticAssessorTopologySource: AgentTopologySource = {
  version: 1,
  runtimes: {
    codex: {
      adapter: "codex",
      paseoProvider: "codex",
      capabilities: { modelSelection: true, variantSelection: true, structuredOutput: true, runtimeConfigInjection: true, sessions: true }
    }
  },
  models: { assessorModel: { runtime: "codex", provider: "openai", model: "gpt-6-luna", variant: "xhigh" } },
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

/**
 * Test-only assessor identity while the Codex-channel Luna certification is PENDING
 * (see semanticStructuredOutputCapabilitiesV1 pendingRequalification and
 * docs/evidence/model-routing/codex-structured-output-probe-2026-10-04.json).
 *
 * It mirrors resolveSemanticAssessor's identity construction EXACTLY (same fields, same
 * canonical digest) but bypasses the structured-output capability gate, which currently
 * fails closed for openai/gpt-6-luna. Service-logic tests (assessment validation, caching,
 * retry, telemetry) use this stub so their coverage survives the honest uncertification;
 * production NEVER uses this path. The gate itself is pinned by the capability/topology/
 * migration tests, which assert the real resolver refuses with SEMANTIC_ASSESSMENT_UNAVAILABLE.
 * Delete this stub and restore the gated resolver once bounded Codex-channel probe evidence
 * certifies the model.
 */
export function semanticPendingRequalificationStubAssessor() {
  const topology = resolveAgentTopology(semanticAssessorTopologySource);
  const configured = Object.values(topology.agents)
    .filter((agent) => agent.role === "Semantic Assessor" && !agent.disabled)
    .sort((left, right) => left.name.localeCompare(right.name));
  if (configured.length !== 1) throw new Error(`AgentTopology must resolve exactly one enabled Semantic Assessor; found ${configured.length}.`);
  const agent = configured[0]!;
  const selection = executionSelectionForAgent(topology, agent.name);
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
      case "OPERATIONS_ANALYSIS": return { type: "OPERATIONS_ANALYSIS", classification: "UNCERTAIN", probableCause: "UNKNOWN", suggestedSupervisorAction: "NONE", rationale: "The bounded evidence does not establish a specific operational cause.", evidenceRefs: [refs[0]!], unknowns: ["additional activity evidence is unavailable"] };
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
  // Service-logic coverage uses the pending-requalification stub (see above): the gated
  // resolver currently fails closed for the uncertified Codex-channel Luna model.
  const assessor = semanticPendingRequalificationStubAssessor();
  const runner = options.runner ?? {
    assess: async ({ request: assessmentRequest }: { request: SemanticAssessmentRequestV1 }) => ({
      payload: options.payload?.(assessmentRequest) ?? semanticPayload(assessmentRequest),
      paseoSession: { provider: "codex", agentId: "paseo-semantic-session-1", workspaceId: "workspace-test", transport: "sdk" as const }
    })
  };
  return createSemanticAssessmentServiceV1({ assessor, runner, policyRevision: semanticCapabilityPolicyRevisionV1, ...(options.cache ? { cache: options.cache } : {}) });
}
