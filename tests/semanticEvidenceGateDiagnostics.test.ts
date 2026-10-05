import { describe, expect, it } from "vitest";
import { AehError } from "../src/core/errors.js";
import {
  createSemanticAssessmentServiceV1,
  offendingEvidenceRefsV1,
  semanticCapabilityPolicyRevisionV1,
  type SemanticAssessmentRejectedReplyV1
} from "../src/semantic/assessment.js";
import { semanticTestAssessor, semanticTestRequest, semanticTestService, semanticPayload } from "./semanticAssessmentSupport.js";

describe("evidence-membership gate diagnostics", () => {
  it("records the offending evidenceRef when the gate rejects a schema-valid payload", async () => {
    const request = semanticTestRequest("STACK");
    const service = semanticTestService({
      runner: {
        assess: async () => ({
          payload: {
            ...semanticPayload(request),
            judgment: {
              ...semanticPayload(request).judgment,
              evidenceRefs: ["outside-evidence-ref"],
              signals: [{ id: "language", evidenceRef: "outside-evidence-ref" }]
            }
          } as unknown as ReturnType<typeof semanticPayload>,
          paseoSession: { provider: "codex", agentId: "paseo-session-offending", transport: "sdk" },
          // head200-style prefix truncated before any evidenceRefs array (mirrors
          // the real STACK truncation): the offending string is NOT in the head.
          rawReply: { version: 1, lengthBytes: 2048, sha256: "b".repeat(64), head: '{"judgment":{"type":"STACK","languages":["Rust"],"frameworks":[]' }
        })
      }
    });
    let failure: AehError | undefined;
    try {
      await service.assess(request, { attemptBudget: 1 });
    } catch (error) {
      failure = error as AehError;
    }
    expect(failure?.code).toBe("SEMANTIC_ASSESSMENT_INVALID");
    // Fail-closed is preserved: still throws.
    expect(failure).toBeDefined();
    expect(failure?.message).toContain("typed judgment or assessment payload referenced evidence outside the request evidence.");
    expect(failure?.message).toContain("outside-evidence-ref");
    expect(failure?.details).toMatchObject({ offendingEvidenceRefCount: 1 });
    expect(failure?.details?.offendingEvidenceRefs).toEqual(expect.arrayContaining(["outside-evidence-ref"]));
    // Existing fingerprint diagnostics are preserved alongside.
    expect(failure?.details?.fingerprint).toMatchObject({ lengthBytes: 2048, sha256: "b".repeat(64) });
    expect(failure?.message).toContain("assessorSession=paseo-session-offending");
    expect(failure?.message).toContain(`replySha256=${"b".repeat(64)}`);
  });

  it("caps the offending list deterministically with total count", () => {
    const allowed = ["evidence"];
    const replyRefs = Array.from({ length: 12 }, (_, index) => `outside-${String(index).padStart(2, "0")}`);
    const { offending, total } = offendingEvidenceRefsV1([...replyRefs].reverse().concat(["outside-00", "evidence"]), allowed);
    expect(total).toBe(12);
    expect(offending).toHaveLength(10);
    expect(offending).toEqual([...offending].sort((a, b) => a.localeCompare(b)));
    expect(offending[0]).toBe("outside-00");
  });

  it("emits the rejected-reply record (fingerprint shape plus offending refs) through onRejectedReply", async () => {
    const request = semanticTestRequest("STACK");
    const seen: SemanticAssessmentRejectedReplyV1[] = [];
    const service = createSemanticAssessmentServiceV1({
      assessor: semanticTestAssessor(),
      runner: {
        assess: async () => ({
          payload: {
            ...semanticPayload(request),
            judgment: {
              ...semanticPayload(request).judgment,
              evidenceRefs: ["outside-evidence-ref"],
              signals: [{ id: "language", evidenceRef: "outside-evidence-ref" }]
            }
          } as unknown as ReturnType<typeof semanticPayload>,
          paseoSession: { provider: "codex", agentId: "paseo-session-hook", transport: "sdk" },
          rawReply: { version: 1, lengthBytes: 2048, sha256: "c".repeat(64), head: '{"judgment":{"type":"STACK"' }
        })
      },
      policyRevision: semanticCapabilityPolicyRevisionV1,
      onRejectedReply: (record) => { seen.push(record); }
    });
    await expect(service.assess(request, { attemptBudget: 1 })).rejects.toMatchObject({ code: "SEMANTIC_ASSESSMENT_INVALID" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      assessmentType: "STACK",
      sessionId: "paseo-session-hook",
      transport: "sdk",
      fingerprint: { version: 1, lengthBytes: 2048, sha256: "c".repeat(64) },
      offendingEvidenceRefs: ["outside-evidence-ref"],
      offendingEvidenceRefCount: 1
    });
  });

  it("leaves valid assessments unchanged (no offending diagnostics)", async () => {
    const request = semanticTestRequest("STACK");
    const assessment = await semanticTestService({}).assess(request, { attemptBudget: 1 });
    expect(assessment.assessmentType).toBe("STACK");
    expect(assessment.judgment).toMatchObject({ type: "STACK" });
  });
});
