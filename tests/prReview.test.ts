import { describe, expect, it } from "vitest";
import { sha256Canonical } from "../src/core/digest.js";
import {
  assertIndependentPrReviewer,
  bindIndependentPrReview,
  compilePullRequestReviewRequirement,
  evaluateMergeEligibility,
  resolveDeliveryMergeMode,
  verifyIndependentPrReviewDigest,
} from "../src/delivery/prReview.js";
import type { CandidateRevisionV1 } from "../src/operations/v2Contracts.js";

function candidate(): CandidateRevisionV1 {
  return {
    operationId: "CHANGE-TEST",
    candidateId: "candidate-test",
    projectId: "test",
    taskId: "T-1",
    revision: 4,
    sourceDigest: "a".repeat(64),
    canonicalIdentity: "identity",
    identityDigest: "b".repeat(64),
  } as unknown as CandidateRevisionV1;
}

function pr() {
  return {
    repository: "owner/repo",
    number: 155,
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    baseRef: "main",
  };
}

function reviewFor(overrides: Record<string, unknown> = {}) {
  return bindIndependentPrReview({
    pr: pr(),
    candidate: candidate(),
    reviewerIdentity: "reviewer-2",
    reviewerProvider: "muse-spark",
    reviewerRole: "Reviewer",
    readOnly: true,
    implementerIdentity: "implementer-1",
    policyDigest: "c".repeat(64),
    evidenceDigest: "d".repeat(64),
    findings: [],
    disposition: "ACCEPTED",
    reviewedAt: "2026-10-09T00:00:00.000Z",
    ...overrides,
  } as never);
}

describe("IndependentPullRequestReview native gate", () => {
  it("rejects self-approval: implementer cannot review its own PR", () => {
    expect(() =>
      assertIndependentPrReviewer({
        reviewerIdentity: "implementer-1",
        implementerIdentity: "implementer-1",
        role: "Reviewer",
        readOnly: true,
      }),
    ).toThrow("PR_REVIEW_SELF_APPROVAL_DENIED");
  });

  it("rejects non-Reviewer roles and writable reviewers", () => {
    expect(() =>
      assertIndependentPrReviewer({ reviewerIdentity: "r", implementerIdentity: "i", role: "Implementer", readOnly: true }),
    ).toThrow("reviewer role must be Reviewer");
    expect(() =>
      assertIndependentPrReviewer({ reviewerIdentity: "r", implementerIdentity: "i", role: "Reviewer", readOnly: false }),
    ).toThrow("read-only");
  });

  it("requires high-assurance review for high-risk changes", () => {
    expect(compilePullRequestReviewRequirement({ risk: "high" }).requireHighAssurance).toBe(true);
    expect(compilePullRequestReviewRequirement({ risk: "low" }).requireHighAssurance).toBe(false);
    expect(compilePullRequestReviewRequirement({ risk: "low", requiresHighAssurance: true }).requireHighAssurance).toBe(true);
  });

  it("independent ACCEPTED review permits eligible delivery in AUTO_MERGE", () => {
    const review = reviewFor();
    const result = evaluateMergeEligibility({
      review,
      expectedPr: pr(),
      expectedCandidate: candidate(),
      expectedPolicyDigest: "c".repeat(64),
      implementerIdentity: "implementer-1",
      ciGreen: true,
      baseFresh: true,
      authoritySatisfied: true,
      mergeAllowedByPolicy: true,
      mergeMode: "AUTO_MERGE",
      risk: "low",
    });
    expect(result.eligible).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it("REPAIR_REQUIRED blocks merge", () => {
    const review = reviewFor({ disposition: "REPAIR_REQUIRED" });
    const result = evaluateMergeEligibility({
      review,
      expectedPr: pr(),
      expectedCandidate: candidate(),
      expectedPolicyDigest: "c".repeat(64),
      implementerIdentity: "implementer-1",
      ciGreen: true,
      baseFresh: true,
      authoritySatisfied: true,
      mergeAllowedByPolicy: true,
      mergeMode: "AUTO_MERGE",
      risk: "low",
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join("\n")).toMatch("not ACCEPTED");
  });

  it("head SHA mismatch invalidates the review (stale review reuse denied)", () => {
    const review = reviewFor();
    const stale = evaluateMergeEligibility({
      review,
      expectedPr: { ...pr(), headSha: "f".repeat(40) },
      expectedCandidate: candidate(),
      expectedPolicyDigest: "c".repeat(64),
      implementerIdentity: "implementer-1",
      ciGreen: true,
      baseFresh: true,
      authoritySatisfied: true,
      mergeAllowedByPolicy: true,
      mergeMode: "AUTO_MERGE",
      risk: "low",
    });
    expect(stale.eligible).toBe(false);
    expect(stale.blockers.join("\n")).toMatch("exact final PR head");
  });

  it("unrelated candidate is rejected", () => {
    const review = reviewFor();
    const other = candidate();
    (other as unknown as Record<string, unknown>).revision = 5;
    const result = evaluateMergeEligibility({
      review,
      expectedPr: pr(),
      expectedCandidate: other,
      expectedPolicyDigest: "c".repeat(64),
      implementerIdentity: "implementer-1",
      ciGreen: true,
      baseFresh: true,
      authoritySatisfied: true,
      mergeAllowedByPolicy: true,
      mergeMode: "AUTO_MERGE",
      risk: "low",
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join("\n")).toMatch("CandidateRevision");
  });

  it("tampered review digest fails closed", () => {
    const review = reviewFor();
    const tampered = { ...review, disposition: "ACCEPTED", findings: [{ id: "f", severity: "note", statement: "x" }] } as typeof review;
    expect(() => verifyIndependentPrReviewDigest(tampered)).toThrow("PR_REVIEW_STALE");
  });

  it("PR_ONLY mode blocks merge even with ACCEPTED review", () => {
    const review = reviewFor();
    const result = evaluateMergeEligibility({
      review,
      expectedPr: pr(),
      expectedCandidate: candidate(),
      expectedPolicyDigest: "c".repeat(64),
      implementerIdentity: "implementer-1",
      ciGreen: true,
      baseFresh: true,
      authoritySatisfied: true,
      mergeAllowedByPolicy: false,
      mergeMode: "PR_ONLY",
      risk: "low",
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join("\n")).toMatch(/PR_ONLY|does not authorize merge/);
  });

  it("RISK_GATED never auto-merges high-risk changes", () => {
    const review = reviewFor();
    const result = evaluateMergeEligibility({
      review,
      expectedPr: pr(),
      expectedCandidate: candidate(),
      expectedPolicyDigest: "c".repeat(64),
      implementerIdentity: "implementer-1",
      ciGreen: true,
      baseFresh: true,
      authoritySatisfied: true,
      mergeAllowedByPolicy: true,
      mergeMode: "RISK_GATED",
      risk: "high",
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join("\n")).toMatch("RISK_GATED");
  });

  it("fails closed to PR_ONLY on unknown mode", () => {
    expect(resolveDeliveryMergeMode({ mode: undefined, mergeAllowedByPolicy: true })).toBe("PR_ONLY");
    expect(() => resolveDeliveryMergeMode({ mode: "YOLO", mergeAllowedByPolicy: true })).toThrow(
      "DELIVERY_MERGE_MODE_INVALID",
    );
  });

  it("blocking findings deny merge", () => {
    const review = reviewFor({
      findings: [{ id: "sec-1", severity: "high", statement: "auth bypass" }],
    });
    const result = evaluateMergeEligibility({
      review,
      expectedPr: pr(),
      expectedCandidate: candidate(),
      expectedPolicyDigest: "c".repeat(64),
      implementerIdentity: "implementer-1",
      ciGreen: true,
      baseFresh: true,
      authoritySatisfied: true,
      mergeAllowedByPolicy: true,
      mergeMode: "AUTO_MERGE",
      risk: "low",
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join("\n")).toMatch("blocking review finding");
  });

  it("review digest is stable and provenance-bound", () => {
    const a = reviewFor();
    const b = reviewFor();
    expect(a.digest).toBe(b.digest);
    expect(a.digest).toMatch(/^[a-f0-9]{64}$/);
    const { digest, ...body } = a;
    expect(sha256Canonical(body)).toBe(digest);
  });
});
