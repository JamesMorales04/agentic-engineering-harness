import { describe, expect, it } from "vitest";
import { sha256Canonical } from "../src/core/digest.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { classifyToolActionImpact } from "../src/security/toolActionGate.js";
import { reconcileToolAction } from "../src/security/actionReconciliation.js";
import {
  assertIndependentPrReviewer,
  assertReviewRound,
  bindIndependentPrReview,
  compilePullRequestReviewRequirement,
  evaluateMergeEligibility,
  resolveDeliveryMergeMode,
  verifyIndependentPrReviewDigest,
} from "../src/delivery/prReview.js";
import { evaluateLiveMergeState } from "../src/delivery/merge.js";
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

  it("fails closed to PR_ONLY on absent mode and throws on unknown mode", () => {
    expect(resolveDeliveryMergeMode({ mode: undefined, mergeAllowedByPolicy: true })).toBe("PR_ONLY");
    expect(resolveDeliveryMergeMode({ mode: undefined, mergeAllowedByPolicy: false })).toBe("PR_ONLY");
    expect(() => resolveDeliveryMergeMode({ mode: "YOLO", mergeAllowedByPolicy: true })).toThrow(
      "DELIVERY_MERGE_MODE_INVALID",
    );
    // Unknown modes are never silently masked, even when merge is not allowed.
    expect(() => resolveDeliveryMergeMode({ mode: "YOLO", mergeAllowedByPolicy: false })).toThrow(
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

  it("forged reviews (wrong role, writable, empty provider) are denied at eligibility", () => {
    const base = {
      expectedPr: pr(),
      expectedCandidate: candidate(),
      expectedPolicyDigest: "c".repeat(64),
      implementerIdentity: "implementer-1",
      ciGreen: true,
      baseFresh: true,
      authoritySatisfied: true,
      mergeAllowedByPolicy: true,
      mergeMode: "AUTO_MERGE" as const,
      risk: "low" as const,
    };
    const good = reviewFor();
    const forgedRole = { ...good, reviewerRole: "Implementer" } as typeof good;
    // Re-mint the digest so the tamper check passes but role enforcement must still deny.
    const { digest: _d1, ...body1 } = forgedRole;
    const mintedRole = { ...body1, digest: sha256Canonical(body1) } as typeof good;
    expect(evaluateMergeEligibility({ ...base, review: mintedRole }).eligible).toBe(false);
    expect(evaluateMergeEligibility({ ...base, review: mintedRole }).blockers.join("\n")).toMatch("Reviewer role");

    const forgedWrite = { ...good, readOnly: false } as unknown as typeof good;
    const { digest: _d2, ...body2 } = forgedWrite;
    const mintedWrite = { ...body2, digest: sha256Canonical(body2) } as typeof good;
    expect(evaluateMergeEligibility({ ...base, review: mintedWrite }).eligible).toBe(false);
    expect(evaluateMergeEligibility({ ...base, review: mintedWrite }).blockers.join("\n")).toMatch("read-only");

    const forgedProvider = { ...good, reviewerProvider: "  " } as unknown as typeof good;
    const { digest: _d3, ...body3 } = forgedProvider;
    const mintedProvider = { ...body3, digest: sha256Canonical(body3) } as typeof good;
    expect(evaluateMergeEligibility({ ...base, review: mintedProvider }).eligible).toBe(false);
  });

  it("high-assurance requirement blocks unqualified providers and allows Luna", () => {
    const base = {
      expectedPr: pr(),
      expectedCandidate: candidate(),
      expectedPolicyDigest: "c".repeat(64),
      implementerIdentity: "implementer-1",
      ciGreen: true,
      baseFresh: true,
      authoritySatisfied: true,
      mergeAllowedByPolicy: true,
      mergeMode: "AUTO_MERGE" as const,
      risk: "high" as const,
      requireHighAssurance: true,
    };
    const standard = reviewFor();
    const blocked = evaluateMergeEligibility({ ...base, review: standard });
    expect(blocked.eligible).toBe(false);
    expect(blocked.blockers.join("\n")).toMatch("high-assurance");
    const luna = reviewFor({ reviewerProvider: "gpt-6-luna", assuranceTier: "HIGH" });
    expect(evaluateMergeEligibility({ ...base, review: luna }).eligible).toBe(true);
    // Substring spoofing never qualifies.
    const spoof = reviewFor({ reviewerProvider: "evil-luna-impersonator", assuranceTier: "HIGH" });
    const spoofed = evaluateMergeEligibility({ ...base, review: spoof });
    expect(spoofed.eligible).toBe(false);
    expect(spoofed.blockers.join("\n")).toMatch("high-assurance");
  });

  it("bounds the repair-review loop to three rounds", () => {
    expect(() => assertReviewRound(1)).not.toThrow();
    expect(() => assertReviewRound(3)).not.toThrow();
    expect(() => assertReviewRound(4)).toThrow("PR_REVIEW_ROUNDS_EXHAUSTED");
    expect(() => assertReviewRound(0)).toThrow("positive integer");
    const review = reviewFor();
    const base = {
      expectedPr: pr(),
      expectedCandidate: candidate(),
      expectedPolicyDigest: "c".repeat(64),
      implementerIdentity: "implementer-1",
      ciGreen: true,
      baseFresh: true,
      authoritySatisfied: true,
      mergeAllowedByPolicy: true,
      mergeMode: "AUTO_MERGE" as const,
      risk: "low" as const,
      review,
    };
    expect(evaluateMergeEligibility({ ...base, reviewRound: 3 }).eligible).toBe(true);
    expect(evaluateMergeEligibility({ ...base, reviewRound: 4 }).eligible).toBe(false);
  });

  it("live merge state fails closed except clean + green", () => {
    const reviewed = pr();
    const clean = { state: "open", headSha: reviewed.headSha, baseSha: reviewed.baseSha, mergeable: true as const, mergeableState: "clean", combinedStatus: "success" };
    expect(evaluateLiveMergeState(reviewed, clean)).toEqual([]);
    expect(evaluateLiveMergeState(reviewed, { ...clean, mergeableState: "unknown" }).length).toBeGreaterThan(0);
    expect(evaluateLiveMergeState(reviewed, { ...clean, mergeableState: "unstable" }).length).toBeGreaterThan(0);
    expect(evaluateLiveMergeState(reviewed, { ...clean, mergeableState: "behind" }).length).toBeGreaterThan(0);
    expect(evaluateLiveMergeState(reviewed, { ...clean, mergeableState: "blocked" }).length).toBeGreaterThan(0);
    expect(evaluateLiveMergeState(reviewed, { ...clean, combinedStatus: "failure" }).length).toBeGreaterThan(0);
    expect(evaluateLiveMergeState(reviewed, { ...clean, headSha: "f".repeat(40) }).join("\n")).toMatch("head");
  });
});

describe("github.pull-request.merge reconciliation", () => {
  const payload = { repository: "owner/repo", number: 155, headSha: "a".repeat(40), baseRef: "main", apiBase: "https://api.github.com" };
  function intent() {
    return {
      version: 2 as const,
      intentId: "action-intent:github-pull-request-merge",
      actionKey: "delivery:merge-pr-155",
      operationId: "RUN-RECONCILE-1",
      participantId: "participant:lead",
      role: "Lead/Director" as const,
      candidate: createCandidateRevisionV1({ operationId: "RUN-RECONCILE-1", candidateId: "candidate:reconcile", projectId: "project-test", taskId: "T-1", revision: 1, sourceDigest: "a".repeat(64), createdAt: "2026-03-04T05:06:07.000Z" }),
      operationExecutionRevision: 1,
      policyDigest: "d".repeat(64),
      action: "github.pull-request.merge" as const,
      impact: classifyToolActionImpact("github.pull-request.merge"),
      controllerEpoch: 1,
      payloadDigest: sha256Canonical(payload),
      authorityBindingDigest: "b".repeat(64),
      requestDigest: "c".repeat(64),
      createdAt: "2026-03-04T05:06:07.000Z",
    };
  }
  it("reports SUCCEEDED when the PR is merged at the expected head/base", async () => {
    const result = await reconcileToolAction("/tmp", intent(), payload, {
      fetchJson: async () => ({ status: 200, body: { merged: true, state: "closed", head: { sha: "a".repeat(40) }, base: { ref: "main" }, merge_commit_sha: "f".repeat(40) } }),
      token: "test-token",
    });
    expect(result.outcome).toBe("SUCCEEDED");
  });
  it("reports FAILED when merged at an unexpected head", async () => {
    const result = await reconcileToolAction("/tmp", intent(), payload, {
      fetchJson: async () => ({ status: 200, body: { merged: true, state: "closed", head: { sha: "b".repeat(40) }, base: { ref: "main" }, merge_commit_sha: "f".repeat(40) } }),
      token: "test-token",
    });
    expect(result.outcome).toBe("FAILED");
    expect(result.detail).toBe("pull-request-merged-unexpected-head");
  });
  it("reports FAILED when closed without merge", async () => {
    const result = await reconcileToolAction("/tmp", intent(), payload, {
      fetchJson: async () => ({ status: 200, body: { merged: false, state: "closed", head: { sha: "a".repeat(40) }, base: { ref: "main" } } }),
      token: "test-token",
    });
    expect(result.outcome).toBe("FAILED");
  });
});
