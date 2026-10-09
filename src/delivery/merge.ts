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
  implementerIdentity: string;
  mergeMethod?: "merge" | "squash" | "rebase";
  risk?: "low" | "medium" | "high";
  /** When true, a qualified high-assurance reviewer is required. Defaults from risk (high → true). */
  requireHighAssurance?: boolean;
  qualifiedProviders?: string[];
}

export interface MergeAcceptedPullRequestResult {
  merged: boolean;
  mergeCommitSha?: string;
  pullRequestNumber: number;
  pullRequestUrl?: string;
  mode: DeliveryMergeModeV1;
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
  // caller-asserted booleans): fetch the live PR and the combined commit
  // status. Confirm the exact reviewed head is still current, the live base
  // SHA still matches the reviewed base, the PR is open and mergeable, and
  // required checks are green. Branch protection itself is enforced by GitHub;
  // we never attempt to override it. A protection failure surfaces as a merge
  // failure, not a silent override.
  const live = await githubRequest<{ head?: { sha?: string }; base?: { ref?: string; sha?: string }; state?: string; mergeable?: boolean | null; mergeable_state?: string; html_url?: string }>(
    apiBase, token, `/repos/${repository}/pulls/${input.pr.number}`,
  );
  if (live.state !== "open") throw new Error(`MERGE_BLOCKED: pull request #${input.pr.number} is not open (state=${String(live.state)}).`);
  if (typeof live.head?.sha === "string" && live.head.sha.toLowerCase() !== input.pr.headSha.toLowerCase()) {
    throw new Error("MERGE_BLOCKED: live PR head no longer matches the reviewed head; renewed independent review is required.");
  }
  if (typeof live.base?.sha === "string" && live.base.sha.toLowerCase() !== input.pr.baseSha.toLowerCase()) {
    throw new Error("MERGE_BLOCKED: live PR base no longer matches the reviewed base; renewed independent review is required.");
  }
  if (live.mergeable === false || live.mergeable_state === "dirty") {
    throw new Error("MERGE_BLOCKED: pull request reports a merge conflict; repair and renewed review are required.");
  }
  if (live.mergeable_state === "blocked") {
    throw new Error("MERGE_BLOCKED: pull request is blocked by branch protection (failing checks or missing reviews).");
  }
  const baseFresh = live.mergeable_state !== "behind" && live.mergeable_state !== "dirty";
  if (!baseFresh) {
    throw new Error(`MERGE_BLOCKED: target branch freshness/integration requirement is not satisfied (mergeable_state=${String(live.mergeable_state)}).`);
  }
  const status = await githubRequest<{ state?: string; statuses?: unknown[] }>(
    apiBase, token, `/repos/${repository}/commits/${input.pr.headSha}/status`,
  );
  const ciGreen = status.state === "success";
  if (!ciGreen) {
    throw new Error(`MERGE_BLOCKED: required GitHub checks are not green (combined state=${String(status.state)}).`);
  }

  const risk = input.risk ?? "medium";
  const requirement = compilePullRequestReviewRequirement({ risk, requiresHighAssurance: input.requireHighAssurance });
  const authoritySatisfied = operation.status === "RUNNING";
  const eligibilityInput = {
    review: input.review,
    expectedPr: input.pr,
    expectedCandidate: boundCandidate,
    expectedPolicyDigest: input.policyDigest,
    implementerIdentity: input.implementerIdentity,
    ciGreen,
    baseFresh,
    authoritySatisfied,
    mergeAllowedByPolicy,
    mergeMode: mode,
    risk,
    requireHighAssurance: requirement.requireHighAssurance,
    ...(input.qualifiedProviders ? { qualifiedProviders: input.qualifiedProviders } : {}),
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

  // Post-merge reconciliation: confirm the merged state and capture the
  // resulting merge commit for the operation ledger. A post-merge failure is
  // a new incident; it does not retroactively validate the pre-merge review.
  const after = await githubRequest<{ merged?: boolean; merge_commit_sha?: string; html_url?: string }>(
    apiBase, token, `/repos/${repository}/pulls/${input.pr.number}`,
  );
  if (after.merged !== true) {
    throw new Error(`BLOCKED_EXTERNAL: post-merge reconciliation reports PR #${input.pr.number} is not merged; treat as a new delivery incident.`);
  }
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
