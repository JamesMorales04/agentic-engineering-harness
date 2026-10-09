import { sha256Canonical } from "../core/digest.js";
import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";

/**
 * Native IndependentPullRequestReview gate.
 *
 * Decision mechanism:
 * - DETERMINISTIC for independence, binding, eligibility, mode resolution,
 *   and stale-review invalidation. These are mechanically observable facts
 *   (identities, SHAs, digests, dispositions, policy allowlists).
 * - MODEL for the semantic PR findings themselves (produced by an independent
 *   Reviewer participant through the existing review output contract). This
 *   module never generates semantic findings; it only validates their binding
 *   and disposition.
 * - HYBRID overall: semantic review output is accepted only when deterministic
 *   binding, independence, freshness, and eligibility gates pass.
 *
 * Candidate review validates the engineering candidate. PR review validates
 * the exact GitHub change that will be merged (final diff identity, exact
 * head/base, delivery-prep changes, rebase effects). Neither replaces the
 * other.
 */

export const PR_REVIEW_VERSION = 1 as const;
export const PR_REVIEW_MAX_ROUNDS = 3 as const;

export type PullRequestReviewDispositionV1 = "ACCEPTED" | "REPAIR_REQUIRED";

export type DeliveryMergeModeV1 = "PR_ONLY" | "AUTO_MERGE" | "RISK_GATED";

export interface PullRequestIdentityV1 {
  repository: string;
  number: number;
  headSha: string;
  baseSha: string;
  baseRef: string;
}

export interface PullRequestReviewFindingV1 {
  id: string;
  severity: "critical" | "high" | "medium" | "low" | "note";
  statement: string;
  file?: string;
}

export interface IndependentPullRequestReviewV1 {
  version: typeof PR_REVIEW_VERSION;
  pr: PullRequestIdentityV1;
  candidate: { candidateId: string; revision: number; identityDigest: string };
  reviewerIdentity: string;
  reviewerProvider: string;
  reviewerRole: string;
  readOnly: boolean;
  policyDigest: string;
  /**
   * Opaque provenance binding to the PR evidence bundle the reviewer
   * inspected (final diff, check runs, validation/review evidence digests).
   * Format-verified here; content is verified by the reviewer plus the
   * deterministic CI/freshness/authority gates. Callers must supply the
   * digest of the actual evidence bundle, not a placeholder.
   */
  evidenceDigest: string;
  /** Assurance tier of this review. HIGH is required for high-risk changes. */
  assuranceTier: "STANDARD" | "HIGH";
  findings: PullRequestReviewFindingV1[];
  disposition: PullRequestReviewDispositionV1;
  reviewedAt: string;
  digest: string;
}

export interface PullRequestReviewRequirementV1 {
  minReviewers: number;
  requireHighAssurance: boolean;
  maxRounds: number;
}

export interface MergeEligibilityInputV1 {
  review: IndependentPullRequestReviewV1;
  expectedPr: PullRequestIdentityV1;
  expectedCandidate: CandidateRevisionV1;
  expectedPolicyDigest: string;
  implementerIdentity: string;
  ciGreen: boolean;
  baseFresh: boolean;
  authoritySatisfied: boolean;
  mergeAllowedByPolicy: boolean;
  mergeMode: DeliveryMergeModeV1;
  risk: "low" | "medium" | "high";
  /** When true, reviewerProvider must be a qualified high-assurance provider. */
  requireHighAssurance?: boolean;
  /** Case-insensitive qualified providers for HIGH reviews. Defaults to Luna/Codex family. */
  qualifiedProviders?: string[];
}

export interface MergeEligibilityV1 {
  eligible: boolean;
  blockers: string[];
}

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

function reject(message: string): never {
  throw new Error(message);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function assertPullRequestIdentity(pr: PullRequestIdentityV1): void {
  if (!pr || typeof pr !== "object") reject("PR_REVIEW_REJECTED: pr identity must be an object.");
  if (!nonEmpty(pr.repository) || !REPOSITORY_PATTERN.test(pr.repository!)) {
    reject(`PR_REVIEW_REJECTED: repository '${String(pr?.repository)}' must be owner/repo.`);
  }
  if (!Number.isSafeInteger(pr.number) || pr.number <= 0) {
    reject("PR_REVIEW_REJECTED: pr number must be a positive integer.");
  }
  if (!nonEmpty(pr.headSha) || !SHA_PATTERN.test(pr.headSha!)) {
    reject("PR_REVIEW_REJECTED: pr headSha must be a full Git object name (40 or 64 hex).");
  }
  if (!nonEmpty(pr.baseSha) || !SHA_PATTERN.test(pr.baseSha!)) {
    reject("PR_REVIEW_REJECTED: pr baseSha must be a full Git object name (40 or 64 hex).");
  }
  if (!nonEmpty(pr.baseRef)) reject("PR_REVIEW_REJECTED: pr baseRef must be a non-empty string.");
}

/**
 * DETERMINISTIC: an independent PR reviewer must have a separate execution
 * identity from the implementer, use the Reviewer role, and hold read-only
 * authority. It cannot modify the PR under review and cannot mint merge
 * authority (enforced by ToolActionGate: reviewer identity is never the
 * controller actor and merge requires controller authority + eligibility).
 */
export function assertIndependentPrReviewer(input: {
  reviewerIdentity: string;
  implementerIdentity: string;
  role: string;
  readOnly: boolean;
}): void {
  const reviewer = nonEmpty(input.reviewerIdentity);
  const implementer = nonEmpty(input.implementerIdentity);
  if (!reviewer) reject("PR_REVIEW_REJECTED: reviewerIdentity must be a non-empty string.");
  if (!implementer) reject("PR_REVIEW_REJECTED: implementerIdentity must be a non-empty string.");
  if (reviewer === implementer) {
    reject("PR_REVIEW_SELF_APPROVAL_DENIED: implementer cannot review its own PR.");
  }
  if (input.role !== "Reviewer") {
    reject(`PR_REVIEW_REJECTED: reviewer role must be Reviewer, got '${String(input.role)}'.`);
  }
  if (input.readOnly !== true) {
    reject("PR_REVIEW_REJECTED: independent PR reviewer must hold read-only authority.");
  }
}

/**
 * DETERMINISTIC: risk-based reviewer requirement. High-risk changes (explicit
 * high risk, security-sensitive dimensions are decided by the caller via
 * requireHighAssurance) require a qualified high-assurance reviewer
 * (Luna or another explicitly qualified provider). Ordinary changes may use
 * an independent Muse session.
 */
export function compilePullRequestReviewRequirement(input: {
  risk: "low" | "medium" | "high";
  requiresHighAssurance?: boolean;
}): PullRequestReviewRequirementV1 {
  if (input.risk !== "low" && input.risk !== "medium" && input.risk !== "high") {
    reject(`PR_REVIEW_REJECTED: risk must be low, medium, or high.`);
  }
  const requireHighAssurance = input.risk === "high" || input.requiresHighAssurance === true;
  return { minReviewers: 1, requireHighAssurance, maxRounds: PR_REVIEW_MAX_ROUNDS };
}

export function bindIndependentPrReview(input: {
  pr: PullRequestIdentityV1;
  candidate: CandidateRevisionV1;
  reviewerIdentity: string;
  reviewerProvider: string;
  reviewerRole: string;
  readOnly: boolean;
  implementerIdentity: string;
  policyDigest: string;
  evidenceDigest: string;
  assuranceTier?: "STANDARD" | "HIGH";
  findings: PullRequestReviewFindingV1[];
  disposition: PullRequestReviewDispositionV1;
  reviewedAt?: string;
}): IndependentPullRequestReviewV1 {
  assertPullRequestIdentity(input.pr);
  assertIndependentPrReviewer({
    reviewerIdentity: input.reviewerIdentity,
    implementerIdentity: input.implementerIdentity,
    role: input.reviewerRole,
    readOnly: input.readOnly,
  });
  if (!nonEmpty(input.reviewerProvider)) reject("PR_REVIEW_REJECTED: reviewerProvider must be a non-empty string.");
  if (!nonEmpty(input.policyDigest) || !DIGEST_PATTERN.test(input.policyDigest!)) {
    reject("PR_REVIEW_REJECTED: policyDigest must be a lowercase SHA-256 digest.");
  }
  if (!nonEmpty(input.evidenceDigest) || !DIGEST_PATTERN.test(input.evidenceDigest!)) {
    reject("PR_REVIEW_REJECTED: evidenceDigest must be a lowercase SHA-256 digest.");
  }
  if (!Array.isArray(input.findings)) reject("PR_REVIEW_REJECTED: findings must be an array.");
  for (const finding of input.findings) {
    if (!finding || typeof finding !== "object") reject("PR_REVIEW_REJECTED: each finding must be an object.");
    if (!nonEmpty(finding.id) || !nonEmpty(finding.statement)) {
      reject("PR_REVIEW_REJECTED: each finding must have a non-empty id and statement.");
    }
    if (!["critical", "high", "medium", "low", "note"].includes(finding.severity)) {
      reject(`PR_REVIEW_REJECTED: finding '${String(finding?.id)}' has an unsupported severity.`);
    }
  }
  if (input.disposition !== "ACCEPTED" && input.disposition !== "REPAIR_REQUIRED") {
    reject("PR_REVIEW_REJECTED: disposition must be ACCEPTED or REPAIR_REQUIRED.");
  }
  if (!input.candidate || typeof input.candidate !== "object") reject("PR_REVIEW_REJECTED: candidate must be an object.");
  const candidate = {
    candidateId: String(input.candidate.candidateId ?? ""),
    revision: input.candidate.revision,
    identityDigest: String(input.candidate.identityDigest ?? ""),
  };
  if (!nonEmpty(candidate.candidateId) || !Number.isSafeInteger(candidate.revision) || !DIGEST_PATTERN.test(candidate.identityDigest)) {
    reject("PR_REVIEW_REJECTED: candidate binding must carry candidateId, revision, and identityDigest.");
  }
  const reviewedAt = input.reviewedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(reviewedAt))) reject("PR_REVIEW_REJECTED: reviewedAt must be a valid timestamp.");
  const assuranceTier = input.assuranceTier ?? "STANDARD";
  if (assuranceTier !== "STANDARD" && assuranceTier !== "HIGH") {
    reject("PR_REVIEW_REJECTED: assuranceTier must be STANDARD or HIGH.");
  }
  const body = {
    version: PR_REVIEW_VERSION,
    pr: {
      repository: input.pr.repository,
      number: input.pr.number,
      headSha: input.pr.headSha.toLowerCase(),
      baseSha: input.pr.baseSha.toLowerCase(),
      baseRef: input.pr.baseRef,
    },
    candidate,
    reviewerIdentity: input.reviewerIdentity.trim(),
    reviewerProvider: input.reviewerProvider.trim(),
    reviewerRole: input.reviewerRole,
    readOnly: true,
    policyDigest: input.policyDigest,
    evidenceDigest: input.evidenceDigest,
    assuranceTier,
    findings: [...input.findings].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    disposition: input.disposition,
    reviewedAt,
  };
  return { ...body, digest: sha256Canonical(body) };
}

export function verifyIndependentPrReviewDigest(review: IndependentPullRequestReviewV1): void {
  if (!review || typeof review !== "object" || review.version !== PR_REVIEW_VERSION) {
    reject("PR_REVIEW_REJECTED: review must be a version 1 IndependentPullRequestReview.");
  }
  const { digest, ...body } = review;
  if (typeof digest !== "string" || !DIGEST_PATTERN.test(digest)) {
    reject("PR_REVIEW_REJECTED: review digest must be a lowercase SHA-256 digest.");
  }
  if (sha256Canonical(body) !== digest) {
    reject("PR_REVIEW_STALE: review digest does not match its content; rebase, repair, or merge-conflict resolution invalidates prior reviews.");
  }
}

/**
 * DETERMINISTIC: resolve the frozen delivery merge mode. The selected
 * delivery authority is frozen and bound to the operation; an agent cannot
 * change its own merge policy. Absent mode fails closed to PR_ONLY (create an
 * accepted PR and stop before merge). Unknown modes always throw, even when
 * merge is not allowed, so misconfiguration is never silently masked.
 */
export function resolveDeliveryMergeMode(input: {
  mode?: unknown;
  mergeAllowedByPolicy: boolean;
}): DeliveryMergeModeV1 {
  if (input.mode !== undefined && input.mode !== "PR_ONLY" && input.mode !== "AUTO_MERGE" && input.mode !== "RISK_GATED") {
    reject(`DELIVERY_MERGE_MODE_INVALID: merge mode '${String(input.mode)}' is not PR_ONLY, AUTO_MERGE, or RISK_GATED.`);
  }
  if (input.mergeAllowedByPolicy !== true) return "PR_ONLY";
  if (input.mode === undefined) return "PR_ONLY";
  return input.mode;
}

/** Default qualified high-assurance reviewer providers (Luna/Codex family), matched case-insensitively. */
export const HIGH_ASSURANCE_PROVIDERS_DEFAULT = ["luna", "codex", "codex/luna", "gpt-6-luna", "gpt-6-luna-codex"] as const;

function isQualifiedHighAssuranceProvider(provider: unknown, qualified: readonly string[]): boolean {
  if (typeof provider !== "string") return false;
  const normalized = provider.trim().toLowerCase();
  return qualified.some((q) => q.toLowerCase() === normalized || normalized.includes(q.toLowerCase()));
}

/**
 * DETERMINISTIC: bound the repair-review loop. The PR review repair loop
 * (REPAIR_REQUIRED → implementer fix → regression tests → renewed review)
 * must be bounded by the caller (operation controller). Rounds are 1-indexed;
 * anything past PR_REVIEW_MAX_ROUNDS is rejected so retries cannot loop
 * unbounded. Callers persist the round with the review chain.
 */
export function assertReviewRound(round: number): void {
  if (!Number.isSafeInteger(round) || round < 1) {
    reject("PR_REVIEW_REJECTED: review round must be a positive integer.");
  }
  if (round > PR_REVIEW_MAX_ROUNDS) {
    reject(`PR_REVIEW_ROUNDS_EXHAUSTED: independent PR review rounds are bounded to ${PR_REVIEW_MAX_ROUNDS}; escalate instead of retrying.`);
  }
}

/**
 * DETERMINISTIC merge-eligibility gate. All conditions are mechanically
 * observable; no semantic judgment is made here. Returns blockers instead of
 * throwing so callers can record machine-readable denial evidence.
 */
export function evaluateMergeEligibility(input: MergeEligibilityInputV1): MergeEligibilityV1 {
  const blockers: string[] = [];
  try {
    verifyIndependentPrReviewDigest(input.review);
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : String(error));
  }
  try {
    assertPullRequestIdentity(input.expectedPr);
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : String(error));
  }

  if (input.review?.disposition !== "ACCEPTED") {
    blockers.push("MERGE_BLOCKED: independent PR review disposition is not ACCEPTED.");
  }
  const blockingFinding = input.review?.findings?.some((f) => f.severity === "critical" || f.severity === "high");
  if (blockingFinding) {
    blockers.push("MERGE_BLOCKED: unresolved blocking review finding remains.");
  }
  // Re-validate independence on the bound artifact itself: a forged review
  // object with a valid digest but Implementer role, writable authority, or
  // empty provider must not pass eligibility even if it was minted outside
  // bindIndependentPrReview.
  const reviewerIdentity = typeof input.review?.reviewerIdentity === "string" ? input.review.reviewerIdentity.trim() : "";
  const implementerIdentity = typeof input.implementerIdentity === "string" ? input.implementerIdentity.trim() : "";
  if (!reviewerIdentity || !implementerIdentity) {
    blockers.push("MERGE_BLOCKED: reviewer and implementer identities must be non-empty.");
  } else if (reviewerIdentity === implementerIdentity) {
    blockers.push("MERGE_BLOCKED: reviewer is not independent of the implementer.");
  }
  if (input.review?.reviewerRole !== "Reviewer") {
    blockers.push("MERGE_BLOCKED: independent PR reviewer must hold the Reviewer role.");
  }
  if (input.review?.readOnly !== true) {
    blockers.push("MERGE_BLOCKED: independent PR reviewer must hold read-only authority.");
  }
  if (typeof input.review?.reviewerProvider !== "string" || !input.review.reviewerProvider.trim()) {
    blockers.push("MERGE_BLOCKED: independent PR reviewer provider must be a non-empty string.");
  }
  if (input.requireHighAssurance === true) {
    const qualified = input.qualifiedProviders ?? [...HIGH_ASSURANCE_PROVIDERS_DEFAULT];
    if (!isQualifiedHighAssuranceProvider(input.review?.reviewerProvider, qualified)) {
      blockers.push("MERGE_BLOCKED: high-risk changes require a qualified high-assurance reviewer (Luna/Codex family).");
    } else if (input.review?.assuranceTier !== "HIGH") {
      blockers.push("MERGE_BLOCKED: high-assurance review tier is required for this change.");
    }
  }
  if (input.review?.pr?.number !== input.expectedPr?.number
    || input.review?.pr?.repository !== input.expectedPr?.repository
    || input.review?.pr?.headSha?.toLowerCase() !== input.expectedPr?.headSha?.toLowerCase()
    || input.review?.pr?.baseSha?.toLowerCase() !== input.expectedPr?.baseSha?.toLowerCase()
    || input.review?.pr?.baseRef !== input.expectedPr?.baseRef) {
    blockers.push("MERGE_BLOCKED: review does not cover the exact final PR head/base identity; rebase or repair invalidates prior reviews.");
  }
  const reviewCandidate = input.review?.candidate;
  if (!reviewCandidate
    || reviewCandidate.candidateId !== input.expectedCandidate?.candidateId
    || reviewCandidate.revision !== input.expectedCandidate?.revision
    || reviewCandidate.identityDigest !== input.expectedCandidate?.identityDigest) {
    blockers.push("MERGE_BLOCKED: review is not bound to the current CandidateRevision.");
  }
  if (input.review?.policyDigest !== input.expectedPolicyDigest) {
    blockers.push("MERGE_BLOCKED: review policy binding is stale.");
  }
  if (input.ciGreen !== true) blockers.push("MERGE_BLOCKED: required GitHub checks are not green.");
  if (input.baseFresh !== true) blockers.push("MERGE_BLOCKED: target branch freshness/integration requirement is not satisfied.");
  if (input.authoritySatisfied !== true) blockers.push("MERGE_BLOCKED: required authority and policy are not satisfied.");
  if (input.mergeAllowedByPolicy !== true) blockers.push("MERGE_BLOCKED: frozen delivery policy does not authorize merge.");
  if (input.mergeMode === "PR_ONLY") {
    blockers.push("MERGE_BLOCKED: frozen delivery mode is PR_ONLY; create an accepted PR and stop before merge.");
  }
  if (input.mergeMode === "RISK_GATED" && input.risk === "high") {
    blockers.push("MERGE_BLOCKED: RISK_GATED mode does not auto-merge high-risk changes.");
  }
  const ordered = [...new Set(blockers)].sort();
  return { eligible: ordered.length === 0, blockers: ordered };
}

export function assertMergeEligible(input: MergeEligibilityInputV1): void {
  const result = evaluateMergeEligibility(input);
  if (!result.eligible) {
    throw new Error(result.blockers[0] ?? "MERGE_BLOCKED: merge eligibility failed.");
  }
}
