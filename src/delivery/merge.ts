import { sha256Canonical } from "../core/digest.js";
import type { HarnessProjectConfig, TaskContract } from "../core/types.js";
import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { controllerEpochFromEnvironment, currentOperationContext, loadOperation, resolveOperationStateRoot } from "../operations/state.js";
import { requireAcceptedCurrentOracleV1 } from "../architecture/acceptanceOracle.js";
import { assertWorkspaceMatchesCandidate } from "../candidates/identity.js";
import { reconcileToolAction } from "../security/actionReconciliation.js";
import { executeGatedAction } from "../security/gatedAction.js";
import { controllerActorId, type ToolActionAuthorityEvidenceV1 } from "../security/toolActionGate.js";
import { githubRequest, inferGithubRepository, resolveGithubToken } from "./handoff.js";
import {
  assertMergeEligible,
  compilePullRequestReviewRequirement,
  evaluateMergeEligibility,
  resolveDeliveryMergeMode,
  type DeliveryMergeModeV1,
  type IndependentPullRequestReviewV1,
  type PullRequestIdentityV1,
} from "./prReview.js";

export interface MergeAcceptedPullRequestInput {
  pr: PullRequestIdentityV1;
  review: IndependentPullRequestReviewV1;
  candidate: CandidateRevisionV1;
  policyDigest: string;
  /**
   * Implementer identity for the independence check. Trust boundary: merge
   * requires fenced controller authority (epoch + controller actor), so only
   * the controller can invoke this path; the controller must supply the true
   * implementer identity from the candidate/operation record. Forgery requires
   * controller compromise, which already grants merge.
   */
  implementerIdentity: string;
  mergeMethod?: "merge" | "squash" | "rebase";
  /**
   * Risk class driving the high-assurance requirement. The controller must
   * derive this from the frozen candidate impact/policy; understating is a
   * controller bug. Absent risk fails closed to high.
   */
  risk?: "low" | "medium" | "high";
  /** When true, a qualified high-assurance reviewer is required. Defaults from risk (high → true). */
  requireHighAssurance?: boolean;
  /** 1-indexed repair-review round persisted by the controller (max 3). */
  reviewRound?: number;
}

export interface RequiredCheckObservationV1 {
  /**
   * Required check name: a branch-protection `checks[].context` entry or a
   * legacy `contexts` entry.
   */
  context: string;
  /**
   * Namespace the requirement lives in. `check` requirements are satisfied by
   * check runs; `status` requirements are satisfied by commit statuses. The
   * namespaces are deliberately strict: a run never satisfies a `status`
   * requirement and a status never satisfies a `check` requirement.
   */
  source: "check" | "status";
  /**
   * Branch-protection `checks[].app_id`. When set, only runs reported by that
   * GitHub App satisfy the requirement; otherwise any app's run qualifies.
   */
  appId?: number | null;
}

export interface ObservedCheckRunV1 {
  /** Check-run `name` as reported by the Checks API. */
  name: string;
  /** Check-run `status`: `queued` | `in_progress` | `completed`. */
  status: string;
  /** Check-run `conclusion` once complete; `null` while incomplete. */
  conclusion?: string | null;
  /** Check-run `head_sha`: the commit the run actually tested. */
  headSha: string;
  /** Check-run `app.id`, when reported. */
  appId?: number | null;
  /** Check-run `app.slug`, when reported (diagnostics only). */
  appSlug?: string;
}

export interface ObservedStatusContextV1 {
  /** Commit-status `context` name. */
  context: string;
  /** Commit-status `state`: `success` | `pending` | `failure` | `error`. */
  state: string;
}

export interface LiveMergeStateV1 {
  state?: string;
  headSha?: string;
  baseSha?: string;
  baseRef?: string;
  mergeable?: boolean | null;
  mergeableState?: string;
  /**
   * Legacy combined commit-status state. Consulted ONLY when `requiredChecks`
   * is absent (backward-compatible fallback). Once the branch-protection
   * required set is observed, the combined state is a lossy derivative and is
   * ignored: the required set evaluated against primary check-run/status
   * observations governs (a `pending` combined state with zero status entries
   * beside green check runs must not block, and a `success` combined state
   * never excuses a missing required check run).
   */
  combinedStatus?: string;
  /**
   * Required-check set observed from branch protection. Presence selects the
   * check-run/status evaluation semantics; absence selects the legacy
   * `combinedStatus` fallback.
   */
  requiredChecks?: RequiredCheckObservationV1[];
  /** Check runs observed for the reviewed head SHA (paginated, complete). */
  checkRuns?: ObservedCheckRunV1[];
  /** When true, check-run pagination was truncated: always blocks. */
  checkRunsIncomplete?: boolean;
  /** Commit statuses observed for the reviewed head SHA. */
  statusContexts?: ObservedStatusContextV1[];
  /** Branch-protection read failure surfaced as data: always blocks. */
  protectionError?: string;
}

/**
 * DETERMINISTIC: verify post-merge identity. After the merge, the observed
 * head SHA must be present and exactly match the reviewed head; a missing or
 * mismatched observation is a new delivery incident (never silent success).
 */
export function assertPostMergeIdentity(prNumber: number, reviewedHeadSha: string, observedHeadSha: unknown): void {
  if (typeof observedHeadSha !== "string" || observedHeadSha.toLowerCase() !== reviewedHeadSha.toLowerCase()) {
    throw new Error(`BLOCKED_EXTERNAL: post-merge reconciliation reports PR #${prNumber} merged an unexpected or unobserved head; treat as a new delivery incident.`);
  }
}

/**
 * Conclusions that count as green for branch protection. GitHub treats
 * `success` as passing and likewise accepts `skipped` and `neutral`
 * (a skipped/neutral required check does not block the merge); every other
 * conclusion — `failure`, `cancelled`, `timed_out`, `action_required`,
 * `stale`, `null`, or any unknown value — blocks. The accepted set is closed:
 * unknown conclusions fail closed rather than passing by default.
 */
const ACCEPTED_CHECK_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

/**
 * DETERMINISTIC: evaluate live merge state observed from GitHub against the
 * reviewed PR identity. Fails closed: observed head SHA, base SHA, and base
 * ref are all required and must exactly match the reviewed identity; only
 * mergeable_state clean passes; unknown/unstable/behind/blocked/dirty all
 * block. Required CI is evaluated with GitHub's actual check-run semantics
 * when `requiredChecks` is present (see `evaluateRequiredChecks`), otherwise
 * the legacy combined commit-status signal applies. A malformed or incomplete
 * GitHub response never passes. Returns blockers so callers record
 * machine-readable denial evidence.
 */
export function evaluateLiveMergeState(reviewed: PullRequestIdentityV1, live: LiveMergeStateV1): string[] {
  const blockers: string[] = [];
  if (live.state !== "open") blockers.push(`MERGE_BLOCKED: pull request #${reviewed.number} is not open (state=${String(live.state)}).`);
  if (typeof live.headSha !== "string" || live.headSha.toLowerCase() !== reviewed.headSha.toLowerCase()) {
    blockers.push("MERGE_BLOCKED: live PR head is unobserved or no longer matches the reviewed head; renewed independent review is required.");
  }
  if (typeof live.baseSha !== "string" || live.baseSha.toLowerCase() !== reviewed.baseSha.toLowerCase()) {
    blockers.push("MERGE_BLOCKED: live PR base is unobserved or no longer matches the reviewed base; renewed independent review is required.");
  }
  if (typeof live.baseRef !== "string" || live.baseRef !== reviewed.baseRef) {
    blockers.push("MERGE_BLOCKED: live PR base ref is unobserved or no longer matches the reviewed base ref; renewed independent review is required.");
  }
  if (live.mergeable === false) blockers.push("MERGE_BLOCKED: pull request reports unmergeable state; repair and renewed review are required.");
  if (live.mergeableState !== "clean") {
    blockers.push(`MERGE_BLOCKED: pull request mergeable_state is '${String(live.mergeableState)}', expected 'clean'; repair or wait and re-review as appropriate.`);
  }
  if (typeof live.protectionError === "string" && live.protectionError.length > 0) {
    blockers.push(`MERGE_BLOCKED: required GitHub checks are unobserved (${live.protectionError}); renewed observation is required.`);
  }
  if (live.requiredChecks !== undefined) {
    blockers.push(...evaluateRequiredChecks(reviewed, live));
  } else if (live.combinedStatus !== "success") {
    blockers.push(`MERGE_BLOCKED: required GitHub checks are not green (combined state=${String(live.combinedStatus)}).`);
  }
  return [...new Set(blockers)].sort();
}

/**
 * DETERMINISTIC: fail-closed required-check evaluation with GitHub's actual
 * semantics. Each branch-protection requirement must be satisfied
 * independently — never a naive "some checks passed" assertion:
 *
 * - `check` requirements: at least one check run with the required name must
 *   be observed for the REVIEWED head SHA, and EVERY such fresh run must be
 *   `completed` with an accepted conclusion (`success`, `skipped`,
 *   `neutral`). Runs for any other SHA are stale: they neither satisfy nor
 *   excuse the requirement, so a success at a superseded head blocks as
 *   missing. Duplicate fresh runs (matrix/re-run fans) all must be green.
 *   When protection binds an `app_id`, only runs from that app qualify.
 * - `status` requirements (legacy commit statuses, only when protection
 *   declares them): at least one status entry with the required context must
 *   be observed, and every such entry must be `success` (`pending`,
 *   `failure`, and `error` all block).
 * - Missing requirements, incomplete pagination, malformed requirement
 *   entries, and unknown run statuses/conclusions all block.
 */
function evaluateRequiredChecks(reviewed: PullRequestIdentityV1, live: LiveMergeStateV1): string[] {
  const blockers: string[] = [];
  const required = live.requiredChecks ?? [];
  if (live.checkRunsIncomplete === true) {
    blockers.push("MERGE_BLOCKED: required GitHub check observation is incomplete (check-run pagination truncated); renewed observation is required.");
  }
  const runs = Array.isArray(live.checkRuns) ? live.checkRuns : [];
  const statuses = Array.isArray(live.statusContexts) ? live.statusContexts : [];
  for (const entry of required) {
    if (!entry || typeof entry.context !== "string" || entry.context.length === 0
      || (entry.source !== "check" && entry.source !== "status")) {
      blockers.push("MERGE_BLOCKED: branch-protection required-check set is malformed; renewed observation is required.");
      continue;
    }
    if (entry.source === "status") {
      const observed = statuses.filter((item) => item != null && item.context === entry.context);
      if (observed.length === 0) {
        blockers.push(`MERGE_BLOCKED: required status '${entry.context}' is unobserved for the reviewed head; renewed observation is required.`);
      }
      for (const item of observed) {
        if (item.state !== "success") {
          blockers.push(`MERGE_BLOCKED: required status '${entry.context}' is not green (state=${String(item.state)}).`);
        }
      }
      continue;
    }
    const fresh = runs.filter((run) => run != null
      && run.name === entry.context
      && typeof run.headSha === "string"
      && run.headSha.toLowerCase() === reviewed.headSha.toLowerCase()
      && (entry.appId == null || run.appId === entry.appId));
    if (fresh.length === 0) {
      blockers.push(`MERGE_BLOCKED: required check '${entry.context}' has no observed run for the reviewed head (missing, stale, or wrong app); renewed observation is required.`);
      continue;
    }
    for (const run of fresh) {
      if (run.status !== "completed") {
        blockers.push(`MERGE_BLOCKED: required check '${entry.context}' is not complete (status=${String(run.status)}); wait and re-review as appropriate.`);
      } else if (typeof run.conclusion !== "string" || !ACCEPTED_CHECK_CONCLUSIONS.has(run.conclusion)) {
        blockers.push(`MERGE_BLOCKED: required check '${entry.context}' is not green (conclusion=${String(run.conclusion)}).`);
      }
    }
  }
  return blockers;
}

export interface MergeAcceptedPullRequestResult {
  merged: boolean;
  mergeCommitSha?: string;
  pullRequestNumber: number;
  pullRequestUrl?: string;
  mode: DeliveryMergeModeV1;
}

/**
 * DETERMINISTIC: raw GitHub GET that surfaces the HTTP status instead of
 * throwing a status-blind error, so the caller can fail closed with an exact
 * reason (a 401/403 — and GitHub's unauthorized-masking 404 — on branch
 * protection must block, never silently skip the required-check gate).
 */
async function githubGetJson(apiBase: string, token: string | undefined, endpoint: string): Promise<{ status: number; body: unknown }> {
  const headers = new Headers();
  headers.set("Accept", "application/vnd.github+json");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${apiBase}${endpoint}`, { method: "GET", headers });
  const text = await response.text();
  let body: unknown;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }
  return { status: response.status, body };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function encodeRepository(repository: string): string {
  const parts = repository.split("/");
  return parts.map(encodeURIComponent).join("/");
}

/**
 * DETERMINISTIC: observe the required-check set from branch protection
 * (`GET /repos/{o}/{r}/branches/{base}/protection/required_status_checks`).
 * Fails closed: any non-200 — including 404, which covers both "no
 * protection" and GitHub's unauthorized-masking 404 — throws instead of
 * degrading to an empty requirement set, and a malformed body throws instead
 * of being coerced. Autonomous merge therefore requires observable branch
 * protection; unprotected or unreadable branches never auto-merge.
 */
async function observeRequiredChecks(
  apiBase: string,
  token: string | undefined,
  repository: string,
  baseRef: string,
): Promise<RequiredCheckObservationV1[]> {
  const { status, body } = await githubGetJson(
    apiBase, token, `/repos/${encodeRepository(repository)}/branches/${encodeURIComponent(baseRef)}/protection/required_status_checks`,
  );
  if (status !== 200) {
    throw new Error(`BLOCKED_EXTERNAL: branch protection required-checks for '${baseRef}' are unobserved (HTTP ${status}); autonomous merge requires observable branch protection — unauthenticated/unauthorized reads fail closed, never silently skipped.`);
  }
  const record = asRecord(body);
  const contextsRaw = record?.contexts;
  const checksRaw = record?.checks;
  if (!Array.isArray(contextsRaw) || !Array.isArray(checksRaw)) {
    throw new Error(`BLOCKED_EXTERNAL: branch protection required-checks for '${baseRef}' are uninterpretable; failing closed.`);
  }
  const required: RequiredCheckObservationV1[] = [];
  for (const item of contextsRaw) {
    if (typeof item !== "string" || item.length === 0) {
      throw new Error(`BLOCKED_EXTERNAL: branch protection required-checks for '${baseRef}' contain a malformed legacy context; failing closed.`);
    }
    required.push({ context: item, source: "status" });
  }
  for (const item of checksRaw) {
    const entry = asRecord(item);
    const context = entry?.context;
    const appId = entry?.app_id;
    if (typeof context !== "string" || context.length === 0
      || (appId !== undefined && appId !== null && (typeof appId !== "number" || !Number.isSafeInteger(appId)))) {
      throw new Error(`BLOCKED_EXTERNAL: branch protection required-checks for '${baseRef}' contain a malformed check entry; failing closed.`);
    }
    required.push(typeof appId === "number" ? { context, source: "check", appId } : { context, source: "check" });
  }
  return required;
}

const CHECK_RUNS_PER_PAGE = 100;
const CHECK_RUNS_MAX_PAGES = 10;

function normalizeCheckRun(entry: unknown): ObservedCheckRunV1 {
  const record = asRecord(entry);
  const name = record?.name;
  const runStatus = record?.status;
  const headSha = record?.head_sha;
  const conclusion = record?.conclusion;
  if (typeof name !== "string" || name.length === 0
    || typeof runStatus !== "string" || runStatus.length === 0
    || typeof headSha !== "string" || headSha.length === 0
    || (conclusion !== undefined && conclusion !== null && typeof conclusion !== "string")) {
    throw new Error("BLOCKED_EXTERNAL: check-run listing contains a malformed entry; failing closed rather than evaluating a partially understood set.");
  }
  const app = asRecord(record?.app);
  const appId = app?.id;
  const appSlug = app?.slug;
  return {
    name,
    status: runStatus,
    conclusion: typeof conclusion === "string" ? conclusion : null,
    headSha,
    ...(typeof appId === "number" ? { appId } : {}),
    ...(typeof appSlug === "string" ? { appSlug } : {}),
  };
}

/**
 * DETERMINISTIC: observe every check run for the reviewed head SHA
 * (`GET /repos/{o}/{r}/commits/{sha}/check-runs`, paginated). Pagination runs
 * to a short page; a page failure, an uninterpretable body, an observed-vs-
 * total count shortfall, or more pages than the bound all throw instead of
 * evaluating a truncated set.
 */
async function observeCheckRunsForHead(
  apiBase: string,
  token: string | undefined,
  repository: string,
  headSha: string,
): Promise<ObservedCheckRunV1[]> {
  if (!/^[0-9a-f]{40,64}$/i.test(headSha)) {
    throw new Error("MERGE_BLOCKED: reviewed head SHA is not a full commit object name; renewed independent review is required.");
  }
  const sha = headSha.toLowerCase();
  const runs: ObservedCheckRunV1[] = [];
  let total: number | undefined;
  for (let page = 1; page <= CHECK_RUNS_MAX_PAGES; page += 1) {
    const { status, body } = await githubGetJson(
      apiBase, token, `/repos/${encodeRepository(repository)}/commits/${sha}/check-runs?per_page=${CHECK_RUNS_PER_PAGE}&page=${page}`,
    );
    if (status !== 200) {
      throw new Error(`BLOCKED_EXTERNAL: check runs for head ${sha} are unobserved (HTTP ${status}); renewed observation is required.`);
    }
    const record = asRecord(body);
    const list = record?.check_runs;
    if (!Array.isArray(list)) {
      throw new Error(`BLOCKED_EXTERNAL: check-run listing for head ${sha} is uninterpretable; failing closed.`);
    }
    if (typeof record?.total_count === "number") total = record.total_count;
    for (const item of list) runs.push(normalizeCheckRun(item));
    if (list.length < CHECK_RUNS_PER_PAGE) {
      if (total !== undefined && runs.length < total) {
        throw new Error(`BLOCKED_EXTERNAL: check-run listing for head ${sha} is incomplete (observed ${runs.length} of ${total}); failing closed.`);
      }
      return runs;
    }
  }
  throw new Error(`BLOCKED_EXTERNAL: check-run listing for head ${sha} exceeds ${CHECK_RUNS_MAX_PAGES * CHECK_RUNS_PER_PAGE} runs; failing closed rather than evaluating a truncated set.`);
}

/**
 * DETERMINISTIC: project the combined-status `statuses` array to
 * context/state pairs. Malformed entries cannot satisfy anything, so they are
 * skipped (the requirement then reports missing and blocks); a non-array
 * body throws.
 */
function normalizeStatusContexts(statuses: unknown): ObservedStatusContextV1[] {
  if (!Array.isArray(statuses)) {
    throw new Error("BLOCKED_EXTERNAL: commit status listing is uninterpretable; failing closed.");
  }
  const out: ObservedStatusContextV1[] = [];
  for (const item of statuses) {
    const record = asRecord(item);
    const context = record?.context;
    const state = record?.state;
    if (typeof context !== "string" || context.length === 0 || typeof state !== "string" || state.length === 0) continue;
    out.push({ context, state });
  }
  return out;
}

/**
 * Deterministic autonomous merge for an accepted PR.
 *
 * Mechanism: HYBRID. Semantic review output (MODEL) is accepted only when
 * deterministic gates pass (DETERMINISTIC): independent ACCEPTED review bound
 * to the exact final head/base/candidate/policy, green CI, fresh base, frozen
 * policy authorizing merge, and controller authority within Owner-delegated
 * scope. Uses GitHub's supported merge mechanism; never force-pushes, never
 * forges review, never suppresses required CI or overrides branch protection
 * (the API itself enforces protection; a protection failure surfaces as a
 * merge failure, not a silent override).
 */
export async function mergeAcceptedPullRequest(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  input: MergeAcceptedPullRequestInput,
): Promise<MergeAcceptedPullRequestResult> {
  const context = currentOperationContext();
  const operationId = context.id;
  const controllerEpoch = controllerEpochFromEnvironment();
  if (!operationId || controllerEpoch === undefined) {
    throw new Error("DELIVERY_AUTHORITY_REQUIRED: autonomous merge must run inside a managed operation with a fenced controller epoch.");
  }
  const stateRoot = resolveOperationStateRoot(root);
  const operation = await loadOperation(stateRoot, operationId);
  const boundCandidate = operation.candidateRevision;
  if (!boundCandidate || boundCandidate.identityDigest !== input.candidate.identityDigest
    || boundCandidate.revision !== input.candidate.revision
    || boundCandidate.candidateId !== input.candidate.candidateId) {
    throw new Error("DELIVERY_AUTHORITY_REQUIRED: autonomous merge requires the operation's current CandidateRevision.");
  }
  await requireAcceptedCurrentOracleV1(stateRoot, operation, boundCandidate);
  await assertWorkspaceMatchesCandidate(root, boundCandidate, operation.candidateRevision);

  const policyDelivery = operation.resolvedOperationPolicy?.deliveryPolicy as Record<string, unknown> | undefined;
  if (!policyDelivery || typeof policyDelivery !== "object") {
    throw new Error("DELIVERY_POLICY_REQUIRED: current frozen operation policy has no delivery policy.");
  }
  const allowedActions = Array.isArray(policyDelivery.allowedActions)
    ? policyDelivery.allowedActions.filter((a): a is string => typeof a === "string")
    : [];
  const mergeAllowedByPolicy = allowedActions.includes("github.pull-request.merge");
  // Frozen policy only: live project config must never widen merge authority
  // beyond the frozen operation policy. Absent frozen mode fails closed to PR_ONLY.
  const rawMode = typeof policyDelivery.mergeMode === "string" ? policyDelivery.mergeMode : undefined;
  const mode = resolveDeliveryMergeMode({ mode: rawMode, mergeAllowedByPolicy });
  if (!mergeAllowedByPolicy) {
    throw new Error("MERGE_BLOCKED: frozen delivery policy does not authorize merge.");
  }
  const externalEffects = operation.resolvedOperationPolicy?.allowedExternalEffects ?? [];
  if (!externalEffects.includes("github.pull-request.merge")) {
    throw new Error("DELIVERY_POLICY_STALE: frozen allowed delivery actions and external effects disagree on merge.");
  }

  const github = config.delivery?.github;
  const repository = (typeof policyDelivery.repository === "string" ? policyDelivery.repository : undefined)
    ?? github?.repository
    ?? contract.issue?.repository
    ?? await inferGithubRepository(root);
  if (!/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error("DELIVERY_REPOSITORY_INVALID: delivery repository must be owner/repository.");
  }
  if (input.pr.repository !== repository) {
    throw new Error("MERGE_BLOCKED: PR repository does not match the frozen delivery repository.");
  }
  const apiBase = (github?.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
  const token = resolveGithubToken(github?.tokenEnv);
  const mergeMethod = input.mergeMethod ?? "squash";

  // Revalidate immediately before the merge from live evidence (never from
  // caller-asserted booleans): fetch the live PR, the branch-protection
  // required-check set, and every check run for the REVIEWED head SHA
  // (paginated), plus commit statuses only when protection declares legacy
  // status requirements. Only mergeable_state clean passes;
  // unknown/unstable/behind/blocked/dirty all fail closed. The combined
  // commit-status endpoint is deliberately NOT consulted here: it is a lossy
  // derivative that reports `pending` with zero entries for repos whose
  // protection uses check runs, which would reject genuinely green PRs.
  // Branch protection itself is enforced by GitHub; we never attempt to
  // override it.
  const live = await githubRequest<{ head?: { sha?: string }; base?: { ref?: string; sha?: string }; state?: string; mergeable?: boolean | null; mergeable_state?: string; html_url?: string }>(
    apiBase, token, `/repos/${repository}/pulls/${input.pr.number}`,
  );
  const liveBaseRef = live.base?.ref;
  if (typeof liveBaseRef !== "string" || liveBaseRef.length === 0) {
    throw new Error("MERGE_BLOCKED: live PR base ref is unobserved; renewed independent review is required.");
  }
  // Protection/observation failures throw (fail closed); they never degrade
  // to an empty requirement set.
  const requiredChecks = await observeRequiredChecks(apiBase, token, repository, liveBaseRef);
  const checkRuns = await observeCheckRunsForHead(apiBase, token, repository, input.pr.headSha);
  let statusContexts: ObservedStatusContextV1[] = [];
  if (requiredChecks.some((entry) => entry.source === "status")) {
    const status = await githubRequest<{ state?: string; statuses?: unknown[] }>(
      apiBase, token, `/repos/${repository}/commits/${input.pr.headSha}/status`,
    );
    statusContexts = normalizeStatusContexts(status.statuses);
  }
  const liveBlockers = evaluateLiveMergeState(input.pr, {
    state: live.state,
    headSha: live.head?.sha,
    baseSha: live.base?.sha,
    baseRef: live.base?.ref,
    mergeable: live.mergeable,
    mergeableState: live.mergeable_state,
    requiredChecks,
    checkRuns,
    statusContexts,
  });
  if (liveBlockers.length) {
    throw new Error(liveBlockers[0]!);
  }

  // Fail closed on risk: absent risk is treated as high so the Luna
  // high-assurance requirement applies unless the controller explicitly
  // classifies the change from frozen candidate impact.
  const risk = input.risk ?? "high";
  const requirement = compilePullRequestReviewRequirement({ risk, requiresHighAssurance: input.requireHighAssurance });
  const authoritySatisfied = operation.status === "RUNNING";
  // Anchor the review policy binding to the frozen operation policy (S6: never
  // accept a caller digest as proof of current policy/epoch).
  const frozenDigest = operation.resolvedOperationPolicy?.digest;
  if (typeof frozenDigest !== "string" || frozenDigest !== input.policyDigest) {
    throw new Error("MERGE_BLOCKED: review policy binding does not match the current frozen operation policy.");
  }
  const eligibilityInput = {
    review: input.review,
    expectedPr: input.pr,
    expectedCandidate: boundCandidate,
    expectedPolicyDigest: input.policyDigest,
    implementerIdentity: input.implementerIdentity,
    ciGreen: true,
    baseFresh: true,
    authoritySatisfied,
    mergeAllowedByPolicy,
    mergeMode: mode,
    risk,
    requireHighAssurance: requirement.requireHighAssurance,
    ...(input.reviewRound !== undefined ? { reviewRound: input.reviewRound } : {}),
  };
  const eligibility = evaluateMergeEligibility(eligibilityInput);
  if (!eligibility.eligible) {
    throw new Error(eligibility.blockers[0] ?? "MERGE_BLOCKED: merge eligibility failed.");
  }
  assertMergeEligible(eligibilityInput);

  const authority: ToolActionAuthorityEvidenceV1 = { kind: "controller-authority", operationId, controllerEpoch };
  const actor = controllerActorId(operationId);
  const payload = {
    repository,
    number: input.pr.number,
    headSha: input.pr.headSha.toLowerCase(),
    baseRef: input.pr.baseRef,
    apiBase,
    mergeMethod,
  };
  let observedUrl = live.html_url;
  const gate = await executeGatedAction({
    root,
    request: {
      root, operationId, participantId: actor, candidate: boundCandidate,
      actionKey: `delivery:${boundCandidate.taskId ?? contract.task.id}:merge-pr-${input.pr.number}`,
      action: "github.pull-request.merge", payload, authority,
    },
    execute: async () => {
      await assertWorkspaceMatchesCandidate(root, boundCandidate, operation.candidateRevision);
      const merged = await githubRequest<{ merged?: boolean; message?: string }>(
        apiBase, token, `/repos/${repository}/pulls/${input.pr.number}/merge`,
        {
          method: "PUT",
          body: JSON.stringify({
            commit_title: `${contract.task.id}: ${contract.task.title} (#${input.pr.number})`,
            sha: input.pr.headSha,
            merge_method: mergeMethod,
          }),
        },
      );
      if (merged.merged !== true) {
        return { outcome: "FAILED" as const, evidence: { number: input.pr.number, message: String(merged.message ?? "merge not completed") } };
      }
      return { outcome: "SUCCEEDED" as const, evidence: { number: input.pr.number, headSha: input.pr.headSha.toLowerCase() } };
    },
    reconcile: (intent) => reconcileToolAction(root, intent, payload, { token }),
  });
  if (gate.status === "HUMAN_REQUIRED" || gate.status === "RECONCILIATION_REQUIRED") {
    throw new Error(`BLOCKED_EXTERNAL: merge has an unresolved durable intent and requires human reconciliation: ${gate.detail}`);
  }
  if (gate.receipt?.outcome !== "SUCCEEDED") {
    throw new Error(`BLOCKED_EXTERNAL: autonomous merge failed for PR #${input.pr.number}: ${gate.detail}`);
  }

  // Post-merge reconciliation: confirm the merged state, the merged head
  // identity, and capture the resulting merge commit for the operation
  // ledger. A post-merge failure is a new incident; it does not retroactively
  // validate the pre-merge review.
  const after = await githubRequest<{ merged?: boolean; merge_commit_sha?: string; html_url?: string; head?: { sha?: string } }>(
    apiBase, token, `/repos/${repository}/pulls/${input.pr.number}`,
  );
  if (after.merged !== true) {
    throw new Error(`BLOCKED_EXTERNAL: post-merge reconciliation reports PR #${input.pr.number} is not merged; treat as a new delivery incident.`);
  }
  assertPostMergeIdentity(input.pr.number, input.pr.headSha, after.head?.sha);
  return {
    merged: true,
    mergeCommitSha: typeof after.merge_commit_sha === "string" ? after.merge_commit_sha : undefined,
    pullRequestNumber: input.pr.number,
    pullRequestUrl: observedUrl ?? after.html_url,
    mode,
  };
}

export function mergePayloadDigest(payload: { repository: string; number: number; headSha: string; baseRef: string; apiBase: string; mergeMethod: string }): string {
  return sha256Canonical(payload);
}
