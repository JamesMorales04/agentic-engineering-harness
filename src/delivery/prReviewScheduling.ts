import type { AgentExecutionSelection } from "../agents/types.js";
import { validateExecutionCapabilities } from "../agents/permissions.js";
import { reviewerOutputSchema, type ReviewerOutput } from "../agents/outputContracts.js";
import { extractMarkedJson } from "../agents/structuredOutput.js";
import type { HarnessProjectConfig, TaskContract, TaskRisk, WorkerSession } from "../core/types.js";
import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { currentOperationContext, loadOperation, resolveOperationStateRoot } from "../operations/state.js";
import { runExecutable } from "../utils/process.js";
import { executeAgentPrompt } from "../workers/agentPrompt.js";
import { executeIsolatedCandidateMutation } from "../candidates/direct.js";
import { inferGithubRepository, loadDeliveryRecord } from "./handoff.js";
import { finalizeAcceptedIssue, type DeliveryFinalizationResult } from "./finalize.js";
import {
  HIGH_ASSURANCE_PROVIDERS_DEFAULT,
  PR_REVIEW_MAX_ROUNDS,
  assertReviewRound,
  bindIndependentPrReview,
  compilePullRequestReviewRequirement,
  type IndependentPullRequestReviewV1,
  type PullRequestIdentityV1,
  type PullRequestReviewDispositionV1,
  type PullRequestReviewFindingV1,
} from "./prReview.js";

/**
 * Delivery-stage independent PR-review scheduler (Track B).
 *
 * Decision mechanism: HYBRID. Semantic PR findings are MODEL output produced
 * by an independent Reviewer participant through the existing
 * participant/assignment infrastructure (frozen Reviewer selection,
 * read-only authority, implementer-distinct identity, isolated candidate
 * snapshot, `reviewer` output contract via the AEH_RESULT_JSON gateway).
 * Everything else is DETERMINISTIC: PR identity derivation (local git +
 * frozen record/config, never a GitHub re-fetch for identity), reviewer
 * independence/authority checks, verdict-to-disposition mapping, review
 * binding, round bounding, eligibility, and the gated merge.
 *
 * Why a controller-owned step instead of reusing runReviewLifecycle: the
 * existing Reviewer-launch path (`runReviewer`, private to
 * reviewLifecycle.ts) is fused to the candidate quality-gate remediation
 * loop (supervisor consolidation, repair budgets, candidate-findings
 * verdicts). Reusing it here would drag remediation authority and a second
 * acceptance oracle into the delivery stage. This module launches exactly
 * one read-only Reviewer turn per round through the same underlying
 * primitives (`executeIsolatedCandidateMutation` + `executeAgentPrompt`
 * with the frozen `reviewer` output contract) and maps the ACTUAL
 * structured verdict to a PR disposition with a closed deterministic rule.
 * No second orchestration engine, no parallel authority, no new oracle.
 *
 * Seam: callers re-invoke `finalizeAcceptedIssue` with the bound review
 * (the artifact-acceptance surface already exists as `FinalizeOptions`;
 * no gate-logic duplication, no new merge path). `mergeAcceptedPullRequest`
 * stays owned by finalize/merge (including Track C's check-run semantics,
 * which this module never re-implements).
 */

export interface PrReviewScheduleRequest {
  root: string;
  config: HarnessProjectConfig;
  contract: TaskContract;
  /** Current CandidateRevision (must match the operation's current candidate). */
  candidate: CandidateRevisionV1;
  /** Merge-pending BLOCKED result from finalize (PR created, review missing). */
  blocked: DeliveryFinalizationResult;
  /**
   * Digest of the REAL evidence bundle the reviewer inspected
   * (the S6 acceptance EvidenceBundle digest). Placeholders fail closed:
   * scheduling is refused and the merge-pending BLOCKED result is preserved.
   */
  evidenceDigest: string;
  /** Implementer identity (must differ from the reviewer identity). */
  implementerIdentity: string;
  /** Frozen Reviewer selections to choose an independent reviewer from. */
  reviewerSelections: Readonly<Record<string, AgentExecutionSelection>>;
  /** 1-indexed starting round (default 1). Past the max, no turn launches. */
  startRound?: number;
  /** Risk class driving the high-assurance requirement (default high = fail-closed). */
  risk?: TaskRisk;
  requireHighAssurance?: boolean;
  mergeMethod?: "merge" | "squash" | "rebase";
}

export interface PrReviewTurnRequest {
  root: string;
  config: HarnessProjectConfig;
  contract: TaskContract;
  candidate: CandidateRevisionV1;
  pr: PullRequestIdentityV1;
  reviewerSelection: AgentExecutionSelection;
  implementerIdentity: string;
  round: number;
  evidenceDigest: string;
}

export type PrReviewTurnResult =
  | { ok: true; reviewerIdentity: string; reviewerProvider: string; output: ReviewerOutput; sessionId?: string }
  | { ok: false; kind: "RUNTIME" | "CONTRACT" | "MUTATION"; detail: string; sessionId?: string; exitCode?: number };

export interface FinalizeWithReviewRequest {
  root: string;
  config: HarnessProjectConfig;
  contract: TaskContract;
  candidate: CandidateRevisionV1;
  review: IndependentPullRequestReviewV1;
  round: number;
  risk: TaskRisk;
  requireHighAssurance?: boolean;
  mergeMethod?: "merge" | "squash" | "rebase";
  implementerIdentity: string;
}

export interface PrReviewScheduleOutcome {
  delivery: DeliveryFinalizationResult;
  review?: IndependentPullRequestReviewV1;
  roundsAttempted: number;
}

export interface PrReviewSchedulerDeps {
  deriveIdentity?: (input: {
    root: string;
    config: HarnessProjectConfig;
    contract: TaskContract;
    commitSha: string;
    prNumber: number;
  }) => Promise<PullRequestIdentityV1>;
  executeReviewTurn?: (turn: PrReviewTurnRequest) => Promise<PrReviewTurnResult>;
  finalizeWithReview?: (input: FinalizeWithReviewRequest) => Promise<DeliveryFinalizationResult>;
  resolveAuthority?: (input: { root: string; candidate: CandidateRevisionV1 }) => Promise<{
    operationId: string;
    policyDigest: string;
  }>;
}

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * DETERMINISTIC: recognize the merge-pending BLOCKED result that finalize
 * returns after PR creation when the frozen merge mode (AUTO_MERGE /
 * RISK_GATED) requires an independent ACCEPTED PR review. This is the ONLY
 * finalize result with BLOCKED_EXTERNAL + non-human + pullRequest +
 * commitSha: push/merge failures throw (humanRequired true via
 * deliveryFinalizationFailure), and PR-creation failures never carry a PR.
 */
export function isMergePendingBlockedDelivery(result: DeliveryFinalizationResult): boolean {
  return (
    result.status === "BLOCKED_EXTERNAL" &&
    result.humanRequired === false &&
    typeof result.pullRequest?.number === "number" &&
    typeof result.commitSha === "string" &&
    result.commitSha.length > 0
  );
}

/**
 * DETERMINISTIC: derive the exact final PR identity from locally known
 * facts only — delivered commit SHA (= PR head), base SHA via local
 * rev-parse, base ref + repository from the frozen delivery record /
 * contract / frozen policy. No GitHub re-fetch for identity.
 */
export async function deriveFinalPrIdentity(input: {
  root: string;
  config: HarnessProjectConfig;
  contract: TaskContract;
  commitSha: string;
  prNumber: number;
}): Promise<PullRequestIdentityV1> {
  const { root, config, contract, commitSha, prNumber } = input;
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new Error("PR_REVIEW_SCHEDULING_REJECTED: merge-pending result carries no usable pull request number.");
  }
  const base = contract.git?.originatingBranch ?? contract.git?.baseRef ?? config.validation?.baseRef ?? "main";
  const baseRev = await runExecutable("git", ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`], {
    cwd: root,
    timeoutMs: 30_000,
  });
  if (baseRev.exitCode !== 0) {
    throw new Error(`SYSTEM_FAILURE: cannot resolve the PR base SHA for independent review: ${baseRev.stderr || baseRev.stdout}`);
  }
  let repository: string | undefined;
  if (contract.issue) {
    const record = await loadDeliveryRecord(root, config, contract.task.id);
    repository = record?.github?.repository ?? contract.issue.repository;
  } else {
    const operationId = currentOperationContext().id;
    const frozenRepository = operationId
      ? ((await loadOperation(resolveOperationStateRoot(root), operationId)).resolvedOperationPolicy?.deliveryPolicy as
          | Record<string, unknown>
          | undefined)?.repository
      : undefined;
    repository =
      (typeof frozenRepository === "string" ? frozenRepository : undefined) ??
      config.delivery?.github?.repository ??
      (await inferGithubRepository(root));
  }
  if (!repository || !REPOSITORY_PATTERN.test(repository)) {
    throw new Error("DELIVERY_REPOSITORY_INVALID: delivery repository must be owner/repo.");
  }
  return {
    repository,
    number: prNumber,
    headSha: commitSha,
    baseSha: baseRev.stdout.trim(),
    baseRef: base,
  };
}

/**
 * DETERMINISTIC: pick the independent Reviewer selection. Closed rule —
 * frozen Reviewer role, denied source-write authority, frozen `reviewer`
 * output contract, implementer-distinct identity, deterministic order.
 * High-assurance changes additionally require a frozen qualified provider
 * (exact allowlist match on model, falling back to runtime name).
 */
export function selectIndependentPrReviewer(
  selections: Readonly<Record<string, AgentExecutionSelection>>,
  implementerIdentity: string,
  options: { requireHighAssurance: boolean },
): AgentExecutionSelection | undefined {
  const implementer = implementerIdentity.trim();
  const eligible = Object.values(selections).filter(
    (selection) =>
      selection.role === "Reviewer" &&
      selection.permissions.write === "deny" &&
      selection.logicalAgent.trim().length > 0 &&
      selection.logicalAgent !== implementer &&
      (selection.outputContract ?? "reviewer") === "reviewer",
  );
  const ordered = [...eligible].sort((left, right) => left.logicalAgent.localeCompare(right.logicalAgent));
  if (!options.requireHighAssurance) return ordered[0];
  return ordered.find(
    (selection) =>
      isQualifiedHighAssuranceProvider(selection.modelId) || isQualifiedHighAssuranceProvider(selection.runtimeName),
  );
}

/**
 * DETERMINISTIC: the frozen high-assurance allowlist (mirrors the closed
 * exact-match rule in prReview.ts, which Track B must not edit: the
 * allowlist constant is imported, the membership predicate is local).
 */
function isQualifiedHighAssuranceProvider(provider: unknown): boolean {
  if (typeof provider !== "string") return false;
  const normalized = provider.trim().toLowerCase();
  return HIGH_ASSURANCE_PROVIDERS_DEFAULT.some((qualified) => qualified.toLowerCase() === normalized);
}

/**
 * DETERMINISTIC verdict mapping (closed, fail-closed — not an oracle): the
 * reviewer judges semantics; this maps its ACTUAL structured verdict to a
 * PR disposition. ACCEPTED requires an explicit pass with SAFE
 * finalization and no critical/high findings. Anything else —
 * FAIL verdict, BLOCKED or RISK_KNOWN safety, blocking findings —
 * is REPAIR_REQUIRED, which deterministically denies autonomous merge.
 */
export function mapPrReviewerVerdict(output: ReviewerOutput): {
  disposition: PullRequestReviewDispositionV1;
  reason: string;
} {
  const blocking = output.findings.some((finding) => finding.severity === "critical" || finding.severity === "high");
  if (output.verdict === "FAIL") return { disposition: "REPAIR_REQUIRED", reason: "reviewer verdict FAIL" };
  if (output.finalizationSafety === "BLOCKED") {
    return { disposition: "REPAIR_REQUIRED", reason: "reviewer finalizationSafety BLOCKED" };
  }
  if (blocking) return { disposition: "REPAIR_REQUIRED", reason: "blocking (critical/high) review finding remains" };
  if ((output.verdict === "PASS" || output.verdict === "PASS_WITH_WARNINGS") && output.finalizationSafety === "SAFE") {
    return { disposition: "ACCEPTED", reason: "reviewer passed with SAFE finalization and no blocking findings" };
  }
  return { disposition: "REPAIR_REQUIRED", reason: `reviewer finalizationSafety ${output.finalizationSafety} requires a human merge decision` };
}

/** DETERMINISTIC: carry the reviewer's structured findings onto the PR review artifact. */
export function mapPrReviewFindings(
  reviewerIdentity: string,
  output: ReviewerOutput,
): PullRequestReviewFindingV1[] {
  return output.findings.map((finding) => {
    const statement = finding.recommendedFix
      ? `${finding.evidence}\nRecommended fix: ${finding.recommendedFix}`
      : finding.evidence;
    return {
      id: `${reviewerIdentity}:${finding.id}`,
      severity: finding.severity,
      statement: statement.slice(0, 4000),
      file: finding.location.file,
    };
  });
}

function buildPrReviewerPrompt(contract: TaskContract, pr: PullRequestIdentityV1, round: number): string {
  const requirements = (contract.requirements ?? []).slice(0, 20).map((requirement) => `${requirement.id}: ${requirement.description}`).join(" | ");
  return [
    `You are the independent PR reviewer for ${contract.task.id} (review round ${round}).`,
    `Review the exact final pull request ${pr.repository}#${pr.number}: head ${pr.headSha} against base ${pr.baseRef} (${pr.baseSha}).`,
    `Inspect the final diff in this workspace. This turn is read-only: do not modify files and do not attempt to access paths outside this candidate workspace.`,
    requirements ? `Sealed requirements: ${requirements}.` : `No explicit requirement rows; review against the sealed TaskContract.`,
    `Return the reviewer output contract with verdict PASS only when the exact final diff is safe to merge, FAIL when repair is required, findings for every concern, and finalizationSafety SAFE only when autonomous merge is safe.`,
    `Your final output MUST contain exactly one line beginning AEH_RESULT_JSON= followed by the JSON object.`,
  ].join(" ");
}

/**
 * Production Reviewer turn: one independent Reviewer participant through
 * the existing participant/assignment infrastructure (frozen selection,
 * execution authority, isolated candidate snapshot, `reviewer` output
 * contract parsed through the AEH_RESULT_JSON gateway). Never fabricates:
 * provider stops, mutations, and contract violations return typed failures.
 */
async function defaultExecutePrReviewTurn(turn: PrReviewTurnRequest): Promise<PrReviewTurnResult> {
  const selection = turn.reviewerSelection;
  if (selection.role !== "Reviewer") {
    return { ok: false, kind: "CONTRACT", detail: `Reviewer selection '${selection.logicalAgent}' does not hold the frozen Reviewer role.` };
  }
  if (!selection.logicalAgent.trim() || selection.logicalAgent === turn.implementerIdentity) {
    return {
      ok: false,
      kind: "CONTRACT",
      detail: "PR_REVIEW_SELF_APPROVAL_DENIED: implementer cannot review its own PR.",
    };
  }
  if (selection.permissions.write !== "deny") {
    return {
      ok: false,
      kind: "CONTRACT",
      detail: `Reviewer '${selection.logicalAgent}' must hold read-only authority.`,
    };
  }
  const transport = selection.transport === "inherit" ? (turn.config.orchestration?.provider ?? "none") : selection.transport;
  const capabilityIssues = validateExecutionCapabilities(selection, transport);
  if (capabilityIssues.length) {
    return {
      ok: false,
      kind: "RUNTIME",
      detail: `Reviewer '${selection.logicalAgent}' is not executable: ${capabilityIssues.join("; ")}`,
    };
  }
  const isolated = await executeIsolatedCandidateMutation({
    root: turn.root,
    operationId: turn.candidate.operationId,
    taskId: turn.contract.task.id,
    workUnitId: `pr-review:${turn.contract.task.id}:${turn.pr.number}:${turn.round}`,
    candidate: turn.candidate,
    config: turn.config,
    contract: turn.contract,
    execute: (isolatedRoot: string) =>
      executeAgentPrompt(isolatedRoot, turn.config, turn.contract, selection, buildPrReviewerPrompt(turn.contract, turn.pr, turn.round), {
        outputContract: "reviewer",
        phase: "review",
        operationKind: currentOperationContext().kind,
        requireExecutionAuthority: true,
      }),
  });
  const session: WorkerSession = isolated.session;
  if (isolated.changeSet) {
    return {
      ok: false,
      kind: "MUTATION",
      detail: "Reviewer attempted to modify its isolated candidate snapshot; the output was rejected.",
      sessionId: session.id,
      exitCode: session.exitCode,
    };
  }
  if (session.exitCode !== 0) {
    const stop = (session.stderr || session.stdout || "no provider output").replace(/\s+/g, " ").trim().slice(0, 600);
    return {
      ok: false,
      kind: "RUNTIME",
      detail: `Reviewer provider session stopped or exited with code ${session.exitCode}: ${stop}`,
      sessionId: session.id,
      exitCode: session.exitCode,
    };
  }
  try {
    const output = reviewerOutputSchema.parse(extractMarkedJson(session.stdout, session.stderr));
    return {
      ok: true,
      reviewerIdentity: selection.logicalAgent,
      reviewerProvider: selection.modelId,
      output,
      sessionId: session.id,
    };
  } catch (error) {
    return {
      ok: false,
      kind: "CONTRACT",
      detail: `Invalid reviewer output contract: ${String(error)}`,
      sessionId: session.id,
      exitCode: session.exitCode,
    };
  }
}

/** Default merge seam: re-invoke finalize with the bound review (idempotent gated path, no duplication). */
async function defaultFinalizeWithReview(input: FinalizeWithReviewRequest): Promise<DeliveryFinalizationResult> {
  return finalizeAcceptedIssue(input.root, input.config, input.contract, {
    candidate: input.candidate,
    prReview: input.review,
    implementerIdentity: input.implementerIdentity,
    reviewRisk: input.risk,
    requireHighAssuranceReview: input.requireHighAssurance,
    reviewRound: input.round,
    mergeMethod: input.mergeMethod,
  });
}

/**
 * DETERMINISTIC authority resolution: the scheduler runs under fenced
 * controller authority and anchors review binding to the frozen operation
 * policy digest (never a caller-supplied digest).
 */
async function defaultResolveAuthority(input: {
  root: string;
  candidate: CandidateRevisionV1;
}): Promise<{ operationId: string; policyDigest: string }> {
  const operationId = currentOperationContext().id;
  if (!operationId) {
    throw new Error("DELIVERY_AUTHORITY_REQUIRED: PR review scheduling must run inside a managed operation.");
  }
  const operation = await loadOperation(resolveOperationStateRoot(input.root), operationId);
  const current = operation.candidateRevision;
  if (
    !current ||
    current.identityDigest !== input.candidate.identityDigest ||
    current.revision !== input.candidate.revision ||
    current.candidateId !== input.candidate.candidateId
  ) {
    throw new Error("DELIVERY_AUTHORITY_REQUIRED: PR review scheduling requires the operation's current CandidateRevision.");
  }
  const policyDigest = operation.resolvedOperationPolicy?.digest;
  if (typeof policyDigest !== "string" || !DIGEST_PATTERN.test(policyDigest)) {
    throw new Error("DELIVERY_POLICY_REQUIRED: frozen operation policy has no anchor digest for autonomous merge.");
  }
  return { operationId, policyDigest };
}

/**
 * Schedule independent PR review and merge after finalize reported
 * merge-pending BLOCKED. Flow per round (bounded by assertReviewRound):
 * exact final PR identity → independent Reviewer turn → ACTUAL structured
 * output → bind → ACCEPTED ? re-invoke finalize (merge attempt) :
 * bounded re-review. Reviewer failure and persistent REPAIR_REQUIRED
 * return BLOCKED (never success); only a merged finalize returns FINALIZED.
 */
export async function scheduleIndependentPrReviewAndMerge(
  request: PrReviewScheduleRequest,
  deps: PrReviewSchedulerDeps = {},
): Promise<PrReviewScheduleOutcome> {
  const { root, config, contract, candidate, blocked } = request;
  const risk = request.risk ?? "high";
  const startRound = request.startRound ?? 1;
  const preserveBlocked = (
    message: string,
    review?: IndependentPullRequestReviewV1,
    roundsAttempted = 0,
  ): PrReviewScheduleOutcome => ({
    delivery: {
      status: "BLOCKED_EXTERNAL",
      humanRequired: false,
      committed: blocked.committed,
      ...(blocked.commitSha ? { commitSha: blocked.commitSha } : {}),
      pushed: blocked.pushed,
      ...(blocked.pullRequest ? { pullRequest: blocked.pullRequest } : {}),
      candidate,
      message,
    },
    ...(review ? { review } : {}),
    roundsAttempted,
  });

  if (!isMergePendingBlockedDelivery(blocked)) {
    throw new Error("PR_REVIEW_SCHEDULING_REJECTED: scheduling requires a merge-pending BLOCKED delivery result with pullRequest and commitSha.");
  }
  const prNumber = blocked.pullRequest?.number;
  const commitSha = blocked.commitSha;
  if (prNumber === undefined || !commitSha) {
    throw new Error("PR_REVIEW_SCHEDULING_REJECTED: merge-pending result lost its pullRequest identity.");
  }
  if (!request.implementerIdentity.trim()) {
    return preserveBlocked("Independent PR review was not scheduled: the implementer identity is missing, so reviewer independence cannot be proven.");
  }
  if (!DIGEST_PATTERN.test(request.evidenceDigest)) {
    return preserveBlocked("Independent PR review was not scheduled: no genuine evidence-bundle digest was supplied (placeholders are refused).");
  }
  if (!Number.isSafeInteger(startRound) || startRound < 1) {
    throw new Error("PR_REVIEW_SCHEDULING_REJECTED: review round must be a positive integer.");
  }
  if (startRound > PR_REVIEW_MAX_ROUNDS) {
    return preserveBlocked(
      `PR_REVIEW_ROUNDS_EXHAUSTED: independent PR review rounds are bounded to ${PR_REVIEW_MAX_ROUNDS}; escalate instead of retrying.`,
    );
  }

  const { policyDigest } = await (deps.resolveAuthority ?? defaultResolveAuthority)({ root, candidate });
  const pr = await (deps.deriveIdentity ?? deriveFinalPrIdentity)({ root, config, contract, commitSha, prNumber });
  const requirement = compilePullRequestReviewRequirement({ risk, requiresHighAssurance: request.requireHighAssurance });
  const executeTurn = deps.executeReviewTurn ?? defaultExecutePrReviewTurn;
  const finalizeWithReview = deps.finalizeWithReview ?? defaultFinalizeWithReview;

  let roundsAttempted = 0;
  let round = startRound;
  for (;;) {
    assertReviewRound(round);
    const reviewerSelection = selectIndependentPrReviewer(request.reviewerSelections, request.implementerIdentity, {
      requireHighAssurance: requirement.requireHighAssurance,
    });
    if (!reviewerSelection) {
      return preserveBlocked(
        requirement.requireHighAssurance
          ? "Independent PR review was not scheduled: no independent read-only Reviewer with a qualified high-assurance provider is available."
          : "Independent PR review was not scheduled: no independent read-only Reviewer selection is available.",
        undefined,
        roundsAttempted,
      );
    }
    const turn = await executeTurn({
      root,
      config,
      contract,
      candidate,
      pr,
      reviewerSelection,
      implementerIdentity: request.implementerIdentity,
      round,
      evidenceDigest: request.evidenceDigest,
    });
    roundsAttempted += 1;
    if (!turn.ok) {
      return preserveBlocked(
        `Independent PR review failed (${turn.kind}): ${turn.detail} Merge stays pending; escalate instead of merging unreviewed.`,
        undefined,
        roundsAttempted,
      );
    }
    const mapped = mapPrReviewerVerdict(turn.output);
    const review = bindIndependentPrReview({
      pr,
      candidate,
      reviewerIdentity: turn.reviewerIdentity,
      reviewerProvider: turn.reviewerProvider,
      reviewerRole: "Reviewer",
      readOnly: true,
      implementerIdentity: request.implementerIdentity,
      policyDigest,
      evidenceDigest: request.evidenceDigest,
      assuranceTier: requirement.requireHighAssurance ? "HIGH" : "STANDARD",
      findings: mapPrReviewFindings(turn.reviewerIdentity, turn.output),
      disposition: mapped.disposition,
    });
    if (mapped.disposition !== "ACCEPTED") {
      if (round >= PR_REVIEW_MAX_ROUNDS) {
        return preserveBlocked(
          `Independent PR review requires repair (${mapped.reason}) after ${PR_REVIEW_MAX_ROUNDS} bounded round(s); merge stays pending.`,
          review,
          roundsAttempted,
        );
      }
      round += 1;
      continue;
    }
    try {
      const delivery = await finalizeWithReview({
        root,
        config,
        contract,
        candidate,
        review,
        round,
        risk,
        requireHighAssurance: request.requireHighAssurance,
        mergeMethod: request.mergeMethod,
        implementerIdentity: request.implementerIdentity,
      });
      return { delivery, review, roundsAttempted };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/^(BLOCKED_EXTERNAL|MERGE_BLOCKED|PR_REVIEW_|DELIVERY_POLICY_STALE|TOOL_ACTION_)/.test(message)) {
        return preserveBlocked(message, review, roundsAttempted);
      }
      throw error;
    }
  }
}
