import { describe, expect, it } from "vitest";
import { analyzeOperationExecutionV1, operationsAnalystAdvisoryDigestV1 } from "../src/operations/operationsAnalyst.js";
import { semanticTestService, semanticPayload } from "./semanticAssessmentSupport.js";

const binding = {
  projectId: "project-a",
  repositoryDigest: "repo-digest-a",
  operationId: "CHANGE-test-1"
};
const evidence = [
  { ref: "activity:participant-1", content: "Two scratch files were written. No candidate mutation followed. The last provider activity was 17 minutes ago." },
  { ref: "tools:participant-1", content: "Three equivalent repository reads returned the same content." }
];

describe("Operations Analyst advisory", () => {
  it("returns a bounded evidence-bound suggestion with advisory-only authority", async () => {
    let requestBinding: unknown;
    const service = semanticTestService({ payload: (request) => {
      requestBinding = request.binding;
      return {
        ...semanticPayload(request),
        judgment: {
          type: "OPERATIONS_ANALYSIS",
          classification: "POSSIBLE_STALL",
          probableCause: "CONTEXT_CHURN",
          suggestedSupervisorAction: "RETRIEVE_SKILL",
          rationale: "The supplied activity shows repeated equivalent reads and no subsequent mutation.",
          skillOrToolPackSuggestion: { topic: "repository context retrieval", evidenceRefs: ["tools:participant-1"] },
          evidenceRefs: ["activity:participant-1", "tools:participant-1"],
          unknowns: ["Provider token usage is unavailable."]
        }
      };
    } });

    const result = await analyzeOperationExecutionV1({ service, binding, evidence });

    expect(requestBinding).toMatchObject({ operationId: binding.operationId });
    expect(result).toMatchObject({
      kind: "OPERATIONS_ANALYST_ADVISORY",
      authority: "ADVISORY_ONLY",
      mechanism: "MODEL",
      operationId: binding.operationId,
      classification: "POSSIBLE_STALL",
      probableCause: "CONTEXT_CHURN",
      suggestedSupervisorAction: "RETRIEVE_SKILL",
      evidenceRefs: ["activity:participant-1", "tools:participant-1"],
      skillOrToolPackSuggestion: { topic: "repository context retrieval", evidenceRefs: ["tools:participant-1"] }
    });
    expect(result).not.toHaveProperty("authorityGrant");
    expect(result).not.toHaveProperty("budget");
    expect(result).not.toHaveProperty("acceptance");
    expect(result).not.toHaveProperty("delivery");
    expect(operationsAnalystAdvisoryDigestV1(result)).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("rejects model output that tries to attach authority or policy changes", async () => {
    const service = semanticTestService({ payload: (request) => ({
      ...semanticPayload(request),
      judgment: {
        type: "OPERATIONS_ANALYSIS",
        classification: "BLOCKED",
        probableCause: "EXTERNAL_BLOCKER",
        suggestedSupervisorAction: "ESCALATE_TO_LEAD",
        rationale: "The evidence mentions an external blocker.",
        evidenceRefs: ["activity:participant-1"],
        unknowns: [],
        authority: "HUMAN_REQUIRED",
        policyMutation: { allowExternalEffect: true }
      }
    }) });

    await expect(analyzeOperationExecutionV1({ service, binding, evidence: [evidence[0]!] })).rejects.toMatchObject({ code: "SEMANTIC_ASSESSMENT_INVALID" });
  });

  it("rejects recommendations that cite evidence outside the operation snapshot", async () => {
    const service = semanticTestService({ payload: (request) => ({
      ...semanticPayload(request),
      judgment: {
        type: "OPERATIONS_ANALYSIS",
        classification: "POSSIBLE_STALL",
        probableCause: "TOOL_KNOWLEDGE_GAP",
        suggestedSupervisorAction: "RETRIEVE_SKILL",
        rationale: "A tool recovery skill may help.",
        skillOrToolPackSuggestion: { topic: "browser startup", evidenceRefs: ["unprovided:browser-log"] },
        evidenceRefs: ["activity:participant-1"],
        unknowns: []
      }
    }) });

    await expect(analyzeOperationExecutionV1({ service, binding, evidence: [evidence[0]!] })).rejects.toMatchObject({ code: "SEMANTIC_ASSESSMENT_INVALID" });
  });

  it("requires durable operation identity and bounded, unique evidence", async () => {
    const service = semanticTestService({});
    await expect(analyzeOperationExecutionV1({ service, binding: { ...binding, operationId: " " }, evidence })).rejects.toThrow(/operation identity/);
    await expect(analyzeOperationExecutionV1({ service, binding, evidence: [evidence[0]!, evidence[0]!] })).rejects.toThrow(/unique/);
    await expect(analyzeOperationExecutionV1({ service, binding, evidence: [] })).rejects.toThrow(/between 1 and 16/);
  });
});
