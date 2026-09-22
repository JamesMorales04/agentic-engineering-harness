import { describe, expect, it } from "vitest";
import { InMemorySemanticAssessmentCacheV1, SemanticAssessmentServiceV1, createSemanticEvidenceReceiptV1, semanticAssessmentTypeValues, semanticCapabilityPolicyRevisionV1, type SemanticAssessmentCacheV1, type SemanticAssessmentRequestV1, type SemanticAssessmentV1 } from "../src/semantic/assessment.js";
import { semanticTestAssessor, semanticTestRequest, semanticTestService, semanticPayload } from "./semanticAssessmentSupport.js";

describe("Paseo-backed semantic assessment contract", () => {
  it("supports the seven canonical assessment types", () => {
    expect(semanticAssessmentTypeValues).toEqual(["INTENT", "ROUTE", "STACK", "ISSUE", "FAILURE", "CANDIDATE_IMPACT", "VALIDATION_NEED"]);
  });

  it("caches by evidence, full binding, policy, and topology profile while preserving Paseo provenance", async () => {
    let calls = 0;
    const cache = new InMemorySemanticAssessmentCacheV1();
    const base = semanticTestService({ runner: { assess: async ({ request, assessor }) => {
      calls += 1;
      expect(assessor.logicalAgent).toBe("assessor");
      expect(assessor.modelId).toBe("openai/small-structured");
      return { payload: semanticPayload(request), paseoSession: { provider: "opencode", agentId: `paseo-session-${calls}`, workspaceId: "workspace-test", transport: "sdk" } };
    } }, cache });
    const request = semanticTestRequest("STACK");
    const first = await base.assess(request);
    const second = await base.assess(request);

    expect(calls).toBe(1);
    expect(first).toMatchObject({
      assessmentType: "STACK",
      mechanism: "MODEL",
      assessor: { logicalAgent: "assessor", modelAlias: "assessorModel", modelId: "openai/small-structured" },
      paseoSession: { provider: "opencode", agentId: "paseo-session-1", workspaceId: "workspace-test", transport: "sdk" },
      evidenceRefs: ["evidence"],
      policyRevision: semanticCapabilityPolicyRevisionV1,
      cacheDisposition: "FRESH",
      cacheIdentity: expect.stringMatching(/^[a-f0-9]{64}$/),
      assessmentDigest: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(second).toMatchObject({ cacheDisposition: "HIT", cacheIdentity: first.cacheIdentity, assessmentDigest: first.assessmentDigest, paseoSession: first.paseoSession });
    expect(second.evidenceReceipts).toEqual(request.evidenceReceipts);
  });

  it("binds typed judgments to exact supplied content and merges typed unknowns into stored unknowns", async () => {
    const request = semanticTestRequest("STACK");
    const assessment = await semanticTestService({}).assess(request);
    expect(assessment.judgment).toMatchObject({ type: "STACK", evidenceRefs: request.evidenceRefs, unknowns: ["unknown build tool"] });
    expect(assessment.unknowns).toEqual(["bounded evidence only", "unknown build tool"]);
    expect(assessment.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(assessment.evidenceReceipts[0]).toMatchObject({ reader: "aeh-controller-v1", ref: "evidence", contentDigest: request.evidenceReceipts[0]!.contentDigest });
  });

  it("rejects invalid types, unsupported capability requests, stale policy, and malformed read receipts", async () => {
    const service = semanticTestService({});
    await expect(service.assess({ ...semanticTestRequest(), assessmentType: "UNKNOWN" } as unknown as SemanticAssessmentRequestV1)).rejects.toMatchObject({ code: "SEMANTIC_ASSESSMENT_INVALID" });
    await expect(service.assess(semanticTestRequest("STACK", { binding: { projectId: "project-test", repositoryDigest: "repo-digest" } }))).resolves.toMatchObject({ assessmentType: "STACK" });
    await expect(service.assess({ ...semanticTestRequest("INTENT"), policyRevision: "old-policy" })).rejects.toMatchObject({ code: "SEMANTIC_ASSESSMENT_INVALID" });
    const request = semanticTestRequest("STACK");
    const badReceipt = { ...request, evidenceReceipts: [{ ...request.evidenceReceipts[0]!, contentDigest: "0".repeat(64) }] };
    await expect(service.assess(badReceipt)).rejects.toMatchObject({ code: "SEMANTIC_ASSESSMENT_INVALID" });
  });

  it("rejects judgments that cite unavailable evidence or attempt to add authority", async () => {
    const request = semanticTestRequest("STACK");
    const invalidRefs = semanticTestService({ payload: (value) => ({ ...semanticPayload(value), judgment: { ...semanticPayload(value).judgment, evidenceRefs: ["outside"] } }) });
    await expect(invalidRefs.assess(request)).rejects.toMatchObject({ code: "SEMANTIC_ASSESSMENT_INVALID" });

    const authority = semanticTestService({ payload: (value) => ({ ...semanticPayload(value), capabilities: ["repository-write"] }) });
    await expect(authority.assess(request)).rejects.toMatchObject({ code: "SEMANTIC_ASSESSMENT_INVALID" });
  });

  it("rejects a Paseo session whose provider does not match resolved topology", async () => {
    const service = semanticTestService({ runner: { assess: async ({ request }) => ({ payload: semanticPayload(request), paseoSession: { provider: "codex", agentId: "wrong-session", transport: "sdk" } }) } });
    await expect(service.assess(semanticTestRequest())).rejects.toMatchObject({ code: "SEMANTIC_ASSESSMENT_INVALID" });
  });

  it("invalidates by candidate identity and content evidence", async () => {
    let calls = 0;
    const cache = new InMemorySemanticAssessmentCacheV1();
    const service = semanticTestService({ runner: { assess: async ({ request }) => { calls += 1; return { payload: semanticPayload(request), paseoSession: { provider: "opencode", agentId: `session-${calls}`, transport: "sdk" } }; } }, cache });
    const first = await service.assess(semanticTestRequest("CANDIDATE_IMPACT", { binding: { operationId: "op-1", candidateId: "candidate-1", candidateRevision: 1, candidateDigest: "candidate-digest-1" } }));
    const second = await service.assess(semanticTestRequest("CANDIDATE_IMPACT", { binding: { operationId: "op-1", candidateId: "candidate-2", candidateRevision: 2, candidateDigest: "candidate-digest-2" } }));
    const third = await service.assess(semanticTestRequest("CANDIDATE_IMPACT", { evidence: [{ ref: "evidence", content: "changed evidence" }], binding: { operationId: "op-1", candidateId: "candidate-2", candidateRevision: 2, candidateDigest: "candidate-digest-2" } }));
    expect(calls).toBe(3);
    expect(new Set([first.cacheIdentity, second.cacheIdentity, third.cacheIdentity]).size).toBe(3);
  });

  it("canonicalizes evidence order for cache identity without dropping receipts", async () => {
    let calls = 0;
    const cache = new InMemorySemanticAssessmentCacheV1();
    const service = semanticTestService({ runner: { assess: async ({ request }) => { calls += 1; return { payload: semanticPayload(request), paseoSession: { provider: "opencode", agentId: "same-session", transport: "sdk" } }; } }, cache });
    const base = semanticTestRequest("STACK", { evidence: [{ ref: "z", content: "second" }, { ref: "a", content: "first" }] });
    const reordered = { ...base, evidenceRefs: [...base.evidenceRefs].reverse(), compactEvidence: [...base.compactEvidence].reverse(), evidenceReceipts: [...base.evidenceReceipts].reverse() };
    const first = await service.assess(base);
    const second = await service.assess(reordered);
    expect(calls).toBe(1);
    expect(second.cacheDisposition).toBe("HIT");
    expect(second.evidenceRefs).toEqual(["a", "z"]);
    expect(second.evidenceReceipts.map((receipt) => receipt.ref)).toEqual(["a", "z"]);
    expect(first.cacheIdentity).toBe(second.cacheIdentity);
  });

  it("rejects tampered and replayed cached session provenance", async () => {
    const values = new Map<string, SemanticAssessmentV1>();
    const cache: SemanticAssessmentCacheV1 = { get: async (key) => values.get(key), set: async (key, value) => { values.set(key, value); } };
    const service = semanticTestService({ cache });
    const request = semanticTestRequest();
    const first = await service.assess(request);
    const stored = values.get(first.cacheIdentity)!;
    values.set(first.cacheIdentity, { ...stored, paseoSession: { ...stored.paseoSession, agentId: "replayed-session" } });
    await expect(service.assess(request)).rejects.toMatchObject({ code: "SEMANTIC_ASSESSMENT_INVALID" });
  });

  it("creates file receipts only for normalized repository-relative paths", () => {
    const binding = semanticTestRequest().binding;
    expect(() => createSemanticEvidenceReceiptV1({ binding, ref: "file:../outside", content: "x", kind: "REPOSITORY_FILE", path: "../outside" })).toThrow(/normalized repository-relative path/);
    expect(createSemanticEvidenceReceiptV1({ binding, ref: "file:src/app.ts", content: "source", kind: "REPOSITORY_FILE", path: "src/app.ts" })).toMatchObject({ kind: "REPOSITORY_FILE", path: "src/app.ts", contentBytes: 6 });
  });

  it("keeps Semantic Assessor outside WorkGraph participant roles", () => {
    expect(semanticTestAssessor().selection.role).toBe("Semantic Assessor");
    expect((semanticTestAssessor().selection.role as string)).not.toBe("Implementer");
  });
});
