import type { HarnessProjectConfig, TaskContract } from "../core/types.js";
import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { sha256Canonical } from "../core/digest.js";
import { computeWorktreeDigest } from "../core/git.js";
import { handoffTask, githubRequest, inferGithubRepository, loadDeliveryRecord, renderPattern, resolveGithubToken, saveDeliveryRecord, type DeliveryRecord } from "./handoff.js";
import { runExecutable } from "../utils/process.js";
import { verifySupplyChainGate } from "../provenance/generate.js";
import { controllerEpochFromEnvironment, currentOperationContext, loadOperation, resolveOperationStateRoot } from "../operations/state.js";
import { reconcileToolAction } from "../security/actionReconciliation.js";
import { executeGatedAction, type GatedActionResultV1 } from "../security/gatedAction.js";
import { controllerActorId, type ToolActionAuthorityEvidenceV1 } from "../security/toolActionGate.js";
import { assertWorkspaceMatchesCandidate } from "../candidates/identity.js";
import { requireAcceptedCurrentOracleV1 } from "../architecture/acceptanceOracle.js";
import { mergeAcceptedPullRequest } from "./merge.js";
import { resolveDeliveryMergeMode, type IndependentPullRequestReviewV1 } from "./prReview.js";

export type DeliveryFinalizationStatus = "SKIPPED" | "HANDOFF_ONLY" | "NO_CHANGES" | "FINALIZED" | "BLOCKED_EXTERNAL" | "BLOCKED_SUPPLY_CHAIN" | "SYSTEM_FAILURE";
export interface DeliveryFinalizationResult {
  status: DeliveryFinalizationStatus;
  humanRequired: boolean;
  committed: boolean;
  commitSha?: string;
  pushed: boolean;
  pullRequest?: { number: number; url: string; draft: boolean };
  candidate?: CandidateRevisionV1;
  message: string;
}
interface GithubPullRequest { number: number; html_url: string; draft?: boolean; }

/**
 * Optional governed-merge inputs. When the frozen delivery policy requests
 * autonomous merge (AUTO_MERGE/RISK_GATED), finalization completes the merge
 * inline only when a valid independent ACCEPTED PR review for the exact
 * created PR is supplied; otherwise it reports merge-pending BLOCKED rather
 * than silently completing delivery without the merge.
 */
export interface DeliveryMergeAfterReviewOptions {
  prReview?: IndependentPullRequestReviewV1;
  implementerIdentity?: string;
  reviewRisk?: "low" | "medium" | "high";
  requireHighAssuranceReview?: boolean;
  reviewRound?: number;
  mergeMethod?: "merge" | "squash" | "rebase";
}

export type FinalizeOptions = { candidate?: CandidateRevisionV1 } & DeliveryMergeAfterReviewOptions;

interface FrozenMergeDirective {
  mode: "AUTO_MERGE" | "RISK_GATED";
  policyDigest: string;
}

/**
 * DETERMINISTIC: read the frozen merge directive from the operation's frozen
 * policy only. Live project config must never widen merge authority beyond
 * the frozen policy. Returns null for PR_ONLY (create the PR and stop).
 * Unknown modes throw fail-closed, even when merge is not allowed.
 */
function frozenMergeDirective(operation: { resolvedOperationPolicy?: unknown }): FrozenMergeDirective | null {
  const policy = operation.resolvedOperationPolicy as { digest?: unknown; deliveryPolicy?: unknown } | undefined;
  const delivery = policy?.deliveryPolicy as Record<string, unknown> | undefined;
  const allowedActions = Array.isArray(delivery?.allowedActions)
    ? (delivery.allowedActions as unknown[]).filter((a): a is string => typeof a === "string")
    : [];
  const mode = resolveDeliveryMergeMode({
    mode: typeof delivery?.mergeMode === "string" ? delivery.mergeMode : undefined,
    mergeAllowedByPolicy: allowedActions.includes("github.pull-request.merge"),
  });
  if (mode === "PR_ONLY") return null;
  if (typeof policy?.digest !== "string" || !/^[a-f0-9]{64}$/.test(policy.digest)) {
    throw new Error("DELIVERY_POLICY_REQUIRED: frozen operation policy has no anchor digest for autonomous merge.");
  }
  return { mode, policyDigest: policy.digest };
}

/**
 * Governed autonomous merge after PR creation. When the frozen policy keeps
 * PR_ONLY, this is a no-op and delivery completes at PR creation. When the
 * frozen policy requests AUTO_MERGE/RISK_GATED, the merge runs inline through
 * independent PR review, deterministic eligibility, the gated merge, and
 * reconciliation — or reports merge-pending BLOCKED (never silent completion)
 * when no valid independent review was supplied.
 */
async function maybeAutonomousMerge(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  operation: { resolvedOperationPolicy?: unknown },
  boundCandidate: CandidateRevisionV1,
  options: FinalizeOptions,
  identities: { repository: string; base: string; baseSha: string; headSha: string; prNumber: number },
): Promise<{ blocked?: string; mergeCommitSha?: string }> {
  const directive = frozenMergeDirective(operation);
  if (!directive) return {};
  const review = options.prReview;
  const implementer = typeof options.implementerIdentity === "string" ? options.implementerIdentity.trim() : "";
  if (!review || !implementer) {
    return {
      blocked: `Pull request #${identities.prNumber} created; autonomous merge (${directive.mode}) requires an independent ACCEPTED PR review for the exact PR head. Supply options.prReview and options.implementerIdentity, then re-run delivery.`,
    };
  }
  const merged = await mergeAcceptedPullRequest(root, config, contract, {
    pr: {
      repository: identities.repository,
      number: identities.prNumber,
      headSha: identities.headSha.toLowerCase(),
      baseSha: identities.baseSha.toLowerCase(),
      baseRef: identities.base,
    },
    review,
    candidate: boundCandidate,
    policyDigest: directive.policyDigest,
    implementerIdentity: implementer,
    mergeMethod: options.mergeMethod,
    risk: options.reviewRisk,
    requireHighAssurance: options.requireHighAssuranceReview,
    reviewRound: options.reviewRound,
  });
  return { mergeCommitSha: merged.mergeCommitSha };
}

export async function finalizeAcceptedIssue(root: string, config: HarnessProjectConfig, contract: TaskContract, options: FinalizeOptions = {}): Promise<DeliveryFinalizationResult> {
  const candidate = options.candidate;
  const github = config.delivery?.github;
  if (!contract.issue) return finalizeAcceptedChange(root, config, contract, options);
  if (contract.issue.provider !== "github") return skipped("Task is not GitHub issue-derived.", candidate);
  const handoffRequested = config.workflow?.issueIntake?.autoHandoff !== false;
  const finalizationRequested = github?.finalizeOnAcceptance === true;
  if (!github?.enabled || (!handoffRequested && !finalizationRequested)) return skipped("GitHub delivery and issue handoff are not enabled.", candidate);

  const operationContext = currentOperationContext();
  const operationId = operationContext.id;
  const controllerEpoch = controllerEpochFromEnvironment();
  if (!operationId || controllerEpoch === undefined) throw new Error("DELIVERY_AUTHORITY_REQUIRED: accepted delivery must run inside a managed operation with a fenced controller epoch.");
  const operation = await loadOperation(resolveOperationStateRoot(root), operationId);
  const boundCandidate = candidate ?? operation.candidateRevision;
  if (!boundCandidate || !operation.candidateRevision || boundCandidate.identityDigest !== operation.candidateRevision.identityDigest) {
    throw new Error("DELIVERY_AUTHORITY_REQUIRED: delivery requires the operation's current CandidateRevision.");
  }
  await requireAcceptedCurrentOracleV1(resolveOperationStateRoot(root), operation, boundCandidate);
  await assertWorkspaceMatchesCandidate(root, boundCandidate, operation.candidateRevision);
  const initialRecord = await loadDeliveryRecord(root, config, contract.task.id);
  if ((handoffRequested || finalizationRequested) && (!initialRecord?.github?.issueNumber || !initialRecord.github.branch)) {
    // The controller already provisioned the candidate's internal execution
    // workspace. Handoff here may create public GitHub resources only after
    // current acceptance and never provisions a second execution workspace.
    await handoffTask(root, config, contract.task.id, { createWorkspace: false });
  }
  if (!finalizationRequested) {
    return handoffRequested
      ? { status: "HANDOFF_ONLY", humanRequired: false, committed: false, pushed: false, candidate: boundCandidate, message: `Accepted issue task ${contract.task.id} has completed its requested handoff.` }
      : skipped("GitHub finalization and issue handoff are not enabled.", candidate);
  }
  const authority: ToolActionAuthorityEvidenceV1 = { kind: "controller-authority", operationId, controllerEpoch };
  const actor = controllerActorId(operationId);

  const supplyChain = await verifySupplyChainGate(root, config, { candidate: boundCandidate, artifactPath: config.provenance?.artifact ?? "" });
  if (!supplyChain.ok) throw new Error(`SUPPLY_CHAIN_BLOCKED: ${supplyChain.failures.join("; ")}`);

  const record = await loadDeliveryRecord(root, config, contract.task.id);
  const branch = record?.github?.branch;
  if (!branch) throw new Error(`BLOCKED_EXTERNAL: accepted issue task ${contract.task.id} has no issue-linked delivery branch to finalize.`);
  const repository = record.github?.repository ?? contract.issue.repository;
  const base = contract.git?.originatingBranch ?? contract.git?.baseRef ?? config.validation?.baseRef ?? "main";

  const status = await runExecutable("git", ["status", "--porcelain"], { cwd: root, timeoutMs: 30_000 });
  if (status.exitCode !== 0) throw new Error(`SYSTEM_FAILURE: cannot inspect final Git state: ${status.stderr || status.stdout}`);
  let committed = false;
  let commitSha: string | undefined;

  if (status.stdout.trim()) {
    const commitMessage = `${contract.task.id}: ${contract.task.title}`;
    const contentDigest = await computeWorktreeDigest(root);
    await assertWorkspaceMatchesCandidate(root, boundCandidate, operation.candidateRevision);
    const commitGate = await executeGatedAction({
      root,
      request: { root, operationId, participantId: actor, candidate: boundCandidate, actionKey: `delivery:${contract.task.id}:commit`, action: "git.commit", payload: { taskId: contract.task.id, message: commitMessage, contentDigest }, authority },
      execute: async () => {
        const add = await runExecutable("git", ["add", "-A"], { cwd: root, timeoutMs: 60_000 });
        if (add.exitCode !== 0) return { outcome: "FAILED" as const, evidence: { step: "add", exitCode: add.exitCode, stderr: add.stderr.slice(-2000) } };
        try { await assertWorkspaceMatchesCandidate(root, boundCandidate, operation.candidateRevision); }
        catch (error) { return { outcome: "FAILED" as const, evidence: { step: "candidate-identity", message: String(error) } }; }
        const commit = await commitWithConfiguredOrHarnessIdentity(root, commitMessage);
        return { outcome: commit.exitCode === 0 ? "SUCCEEDED" as const : "FAILED" as const, evidence: { step: "commit", exitCode: commit.exitCode, stderr: commit.stderr.slice(-2000) } };
      },
      reconcile: (intent) => reconcileToolAction(root, intent, { taskId: contract.task.id, message: commitMessage, contentDigest })
    });
    assertDeliveryGateProgress(commitGate, "git.commit");
    if (commitGate.receipt?.outcome === "FAILED") throw new Error(`SYSTEM_FAILURE: git commit failed during deterministic finalization: ${commitGate.detail}`);
    committed = true;
    commitSha = await revParse(root, "HEAD");
  } else commitSha = await revParse(root, "HEAD");

  await assertWorkspaceMatchesCandidate(root, boundCandidate, operation.candidateRevision);

  const baseCommit = await revParse(root, `${base}^{commit}`);
  const ahead = await runExecutable("git", ["rev-list", "--count", `${baseCommit}..HEAD`], { cwd: root, timeoutMs: 30_000 });
  if (ahead.exitCode !== 0) throw new Error(`SYSTEM_FAILURE: cannot determine whether ${branch} contains deliverable commits: ${ahead.stderr || ahead.stdout}`);
  if (Number(ahead.stdout.trim() || "0") === 0) return { status: "NO_CHANGES", humanRequired: false, committed, commitSha, pushed: false, candidate, message: `No commits differ from ${base}; no pull request is required.` };

  const pushGate = await executeGatedAction({
    root,
    request: { root, operationId, participantId: actor, candidate: boundCandidate, actionKey: `delivery:${contract.task.id}:push`, action: "git.push", payload: { remote: "origin", ref: branch, expectedCommit: commitSha }, authority },
    execute: async () => {
      await assertWorkspaceMatchesCandidate(root, boundCandidate, operation.candidateRevision);
      const result = await runExecutable("git", ["push", "origin", `HEAD:${quoteRef(branch)}`], { cwd: root, timeoutMs: 180_000 });
      return { outcome: result.exitCode === 0 ? "SUCCEEDED" as const : "FAILED" as const, evidence: { ref: branch, exitCode: result.exitCode, stderr: result.stderr.slice(-2000) } };
    },
    reconcile: (intent) => reconcileToolAction(root, intent, { remote: "origin", ref: branch, expectedCommit: commitSha })
  });
  assertDeliveryGateProgress(pushGate, "git.push");
  if (pushGate.receipt?.outcome === "FAILED") throw new Error(`BLOCKED_EXTERNAL: git push failed for ${branch}: ${pushGate.detail}`);

  if (github.pullRequests === false) {
    return { status: "FINALIZED", humanRequired: false, committed, commitSha, pushed: true, candidate, message: `Accepted issue task finalized on ${branch} with a push-only delivery policy; pull request creation was not requested by frozen policy.` };
  }

  const token = resolveGithubToken(github.tokenEnv);
  const apiBase = (github.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
  const owner = repository.split("/")[0];
  const query = `/repos/${repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(base)}`;
  const prPayload = { repository, head: branch, base, apiBase };
  let pr: GithubPullRequest | undefined;
  const prGate = await executeGatedAction({
    root,
    request: { root, operationId, participantId: actor, candidate: boundCandidate, actionKey: `delivery:${contract.task.id}:pull-request`, action: "github.pull-request.create", payload: prPayload, authority },
    execute: async () => {
      await assertWorkspaceMatchesCandidate(root, boundCandidate, operation.candidateRevision);
      const existing = await githubRequest<GithubPullRequest[]>(apiBase, token, query);
      if (existing[0]) {
        pr = existing[0];
        return { outcome: "SUCCEEDED" as const, evidence: { number: existing[0].number, url: existing[0].html_url, reused: true } };
      }
      const created = await githubRequest<GithubPullRequest>(apiBase, token, `/repos/${repository}/pulls`, {
        method: "POST",
        body: JSON.stringify({ title: `${contract.task.id}: ${contract.task.title}`, head: branch, base, draft: github.pullRequestDraft ?? true, body: buildPullRequestBody(contract) })
      });
      pr = created;
      return { outcome: "SUCCEEDED" as const, evidence: { number: created.number, url: created.html_url } };
    },
    reconcile: (intent) => reconcileToolAction(root, intent, prPayload, { token })
  });
  assertDeliveryGateProgress(prGate, "github.pull-request.create");
  if (prGate.receipt?.outcome === "FAILED") throw new Error(`BLOCKED_EXTERNAL: pull request creation failed: ${prGate.detail}`);
  if (!pr) {
    const existing = await githubRequest<GithubPullRequest[]>(apiBase, token, query);
    pr = existing[0];
  }
  if (!pr) throw new Error("BLOCKED_EXTERNAL: a pull request receipt exists but no open pull request could be observed.");

  const pullRequest = { number: pr.number, url: pr.html_url, draft: pr.draft ?? (github.pullRequestDraft ?? true) };
  if (!commitSha) throw new Error("SYSTEM_FAILURE: cannot establish the delivered head SHA for merge review binding.");
  const merged = await maybeAutonomousMerge(root, config, contract, operation, boundCandidate, options, {
    repository, base, baseSha: baseCommit, headSha: commitSha, prNumber: pr.number,
  });
  if (merged.blocked) {
    return { status: "BLOCKED_EXTERNAL", humanRequired: false, committed, commitSha, pushed: true, candidate, pullRequest, message: merged.blocked };
  }
  return { status: "FINALIZED", humanRequired: false, committed, commitSha, pushed: true, candidate, pullRequest, message: `Accepted issue task finalized on ${branch}; pull request #${pr.number}${merged.mergeCommitSha ? ` merged (${merged.mergeCommitSha})` : ""}.` };
}

/** Generic no-Issue CHANGE delivery. Every delivery action runs after current acceptance through ToolActionGate. */
export async function finalizeAcceptedChange(root: string, config: HarnessProjectConfig, contract: TaskContract, options: FinalizeOptions = {}): Promise<DeliveryFinalizationResult> {
  const candidate = options.candidate;
  const github = config.delivery?.github;
  if (currentOperationContext().kind !== "change") return skipped("Generic GitHub delivery is limited to managed CHANGE operations.", candidate);
  if (github?.enabled !== true || github.finalizeOnAcceptance !== true) return skipped("Generic GitHub CHANGE finalization is not enabled by project policy.", candidate);

  const context = currentOperationContext();
  const operationId = context.id;
  const controllerEpoch = controllerEpochFromEnvironment();
  if (!operationId || controllerEpoch === undefined) throw new Error("DELIVERY_AUTHORITY_REQUIRED: accepted CHANGE delivery requires a managed operation with a fenced controller epoch.");
  const stateRoot = resolveOperationStateRoot(root);
  const operation = await loadOperation(stateRoot, operationId);
  const boundCandidate = candidate ?? operation.candidateRevision;
  if (!boundCandidate || !operation.candidateRevision || boundCandidate.identityDigest !== operation.candidateRevision.identityDigest) {
    throw new Error("DELIVERY_AUTHORITY_REQUIRED: CHANGE delivery requires the operation's current CandidateRevision.");
  }
  await requireAcceptedCurrentOracleV1(stateRoot, operation, boundCandidate);
  await assertWorkspaceMatchesCandidate(root, boundCandidate, operation.candidateRevision);

  const policyDelivery = operation.resolvedOperationPolicy?.deliveryPolicy;
  if (!policyDelivery || typeof policyDelivery !== "object" || Array.isArray(policyDelivery)) throw new Error("DELIVERY_POLICY_REQUIRED: current frozen operation policy has no delivery policy.");
  const policy = policyDelivery as Record<string, unknown>;
  const allowedActions = Array.isArray(policy.allowedActions) ? policy.allowedActions.filter((item): item is string => typeof item === "string") : [];
  const requiredActions = ["git.branch.create", "git.commit", "git.push"];
  if (requiredActions.some((action) => !allowedActions.includes(action))) {
    return skipped("Frozen project policy does not configure complete branch/commit/push delivery for non-Issue changes.", boundCandidate);
  }
  const allowPullRequest = allowedActions.includes("github.pull-request.create") && policy.pullRequests !== false;
  const externalEffects = operation.resolvedOperationPolicy?.allowedExternalEffects ?? [];
  if (!externalEffects.includes("git.push") || (allowPullRequest && !externalEffects.includes("github.pull-request.create"))) {
    throw new Error("DELIVERY_POLICY_STALE: frozen allowed delivery actions and external effects disagree.");
  }
  const supplyChain = await verifySupplyChainGate(root, config, { candidate: boundCandidate, artifactPath: config.provenance?.artifact ?? "" });
  if (!supplyChain.ok) throw new Error(`SUPPLY_CHAIN_BLOCKED: ${supplyChain.failures.join("; ")}`);

  const repository = (typeof policy.repository === "string" ? policy.repository : undefined) ?? github.repository ?? await inferGithubRepository(root);
  if (!/^[^/]+\/[^/]+$/.test(repository)) throw new Error("DELIVERY_REPOSITORY_INVALID: delivery repository must be owner/repository.");
  const base = contract.git?.originatingBranch ?? contract.git?.baseRef ?? config.validation?.baseRef ?? "main";
  const branchPattern = typeof policy.branchPattern === "string" ? policy.branchPattern : github.branchPattern ?? "feature/{task}-{slug}";
  const branch = renderPattern(branchPattern, contract);
  const initialRecord = await loadDeliveryRecord(root, config, contract.task.id);
  const baseCommit = initialRecord?.github?.branchSha ?? await revParse(root, "HEAD");
  const branchValidation = await runExecutable("git", ["check-ref-format", "--branch", branch], { cwd: root, timeoutMs: 10_000 });
  if (branchValidation.exitCode !== 0) throw new Error(`DELIVERY_BRANCH_INVALID: configured branch pattern produced an invalid ref '${branch}'.`);
  const token = allowPullRequest ? resolveGithubToken(github.tokenEnv) : undefined;

  const status = await runExecutable("git", ["status", "--porcelain"], { cwd: root, timeoutMs: 30_000 });
  if (status.exitCode !== 0) throw new Error(`SYSTEM_FAILURE: cannot inspect final Git state: ${status.stderr || status.stdout}`);
  if (!status.stdout.trim() && (await revParse(root, "HEAD")) === baseCommit) {
    return { status: "NO_CHANGES", humanRequired: false, committed: false, pushed: false, candidate: boundCandidate, message: "Accepted CHANGE candidate has no Git changes; no branch or pull request was published." };
  }

  const actor = controllerActorId(operationId);
  const authority: ToolActionAuthorityEvidenceV1 = { kind: "controller-authority", operationId, controllerEpoch };
  if (initialRecord?.github?.issueNumber) throw new Error("DELIVERY_RECORD_CONFLICT: a no-Issue CHANGE cannot reuse an Issue-derived delivery record.");
  const now = new Date().toISOString();
  const record: DeliveryRecord = initialRecord ?? {
    version: 1,
    taskId: contract.task.id,
    status: "initialized",
    createdAt: now,
    updatedAt: now,
    originatingBranch: base
  };
  if (record.github?.branch && record.github.branch !== branch) throw new Error("DELIVERY_RECORD_CONFLICT: existing delivery branch does not match the frozen branch pattern.");
  const branchBase = record.github?.branchSha ?? baseCommit;
  record.github = { ...(record.github ?? {}), repository, branch, branchSha: branchBase };
  record.updatedAt = now;
  await saveDeliveryRecord(stateRoot, config, record);

  const branchPayload = { taskId: contract.task.id, branch, expectedCommit: branchBase };
  let localBranchFailure: string | undefined;
  const branchGate = await executeGatedAction({
    root,
    request: { root, operationId, participantId: actor, candidate: boundCandidate, actionKey: `delivery:${contract.task.id}:local-branch`, action: "git.branch.create", payload: branchPayload, authority },
    execute: async () => {
      const existing = await runExecutable("git", ["for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`], { cwd: root, timeoutMs: 15_000 });
      if (existing.exitCode === 0 && existing.stdout.trim()) {
        const current = existing.stdout.trim();
        if (current !== branchBase) {
          localBranchFailure = `branch ${branch} already exists at ${current}, expected ${branchBase}`;
          return { outcome: "FAILED" as const, evidence: { branch, expectedCommit: branchBase, observedCommit: current, reason: "branch already exists at a different commit" } };
        }
      } else if (existing.exitCode === 0) {
        const created = await runExecutable("git", ["switch", "--create", branch, branchBase], { cwd: root, timeoutMs: 30_000 });
        if (created.exitCode !== 0) {
          localBranchFailure = `git switch --create exited ${created.exitCode}: ${created.stderr || created.stdout}`;
          return { outcome: "FAILED" as const, evidence: { branch, expectedCommit: branchBase, exitCode: created.exitCode, stderr: created.stderr.slice(-2000) } };
        }
      } else {
        localBranchFailure = `git show-ref for ${branch} exited ${existing.exitCode}: ${existing.stderr || existing.stdout}`;
        return { outcome: "FAILED" as const, evidence: { branch, expectedCommit: branchBase, exitCode: existing.exitCode, stderr: existing.stderr.slice(-2000) } };
      }
      const switched = await runExecutable("git", ["switch", branch], { cwd: root, timeoutMs: 30_000 });
      if (switched.exitCode !== 0) localBranchFailure = `git switch ${branch} exited ${switched.exitCode}: ${switched.stderr || switched.stdout}`;
      return { outcome: switched.exitCode === 0 ? "SUCCEEDED" as const : "FAILED" as const, evidence: { branch, expectedCommit: branchBase, exitCode: switched.exitCode, stderr: switched.stderr.slice(-2000) } };
    },
    reconcile: (intent) => reconcileToolAction(root, intent, branchPayload)
  });
  assertDeliveryGateProgress(branchGate, "git.branch.create");
  if (branchGate.receipt?.outcome === "FAILED") throw new Error(`SYSTEM_FAILURE: gated local branch creation failed: ${localBranchFailure ?? branchGate.detail}`);
  record.status = "branch-created";
  record.updatedAt = new Date().toISOString();
  await saveDeliveryRecord(stateRoot, config, record);

  const commitMessage = `${contract.task.id}: ${contract.task.title}`;
  const contentDigest = await computeWorktreeDigest(root);
  const commitPayload = { taskId: contract.task.id, message: commitMessage, contentDigest };
  await assertWorkspaceMatchesCandidate(root, boundCandidate, operation.candidateRevision);
  const commitGate = await executeGatedAction({
    root,
    request: { root, operationId, participantId: actor, candidate: boundCandidate, actionKey: `delivery:${contract.task.id}:commit`, action: "git.commit", payload: commitPayload, authority },
    execute: async () => {
      const add = await runExecutable("git", ["add", "-A"], { cwd: root, timeoutMs: 60_000 });
      if (add.exitCode !== 0) return { outcome: "FAILED" as const, evidence: { step: "add", exitCode: add.exitCode, stderr: add.stderr.slice(-2000) } };
      try { await assertWorkspaceMatchesCandidate(root, boundCandidate, operation.candidateRevision); }
      catch (error) { return { outcome: "FAILED" as const, evidence: { step: "candidate-identity", message: String(error) } }; }
      const commit = await commitWithConfiguredOrHarnessIdentity(root, commitMessage);
      return { outcome: commit.exitCode === 0 ? "SUCCEEDED" as const : "FAILED" as const, evidence: { step: "commit", exitCode: commit.exitCode, stderr: commit.stderr.slice(-2000) } };
    },
    reconcile: (intent) => reconcileToolAction(root, intent, commitPayload)
  });
  assertDeliveryGateProgress(commitGate, "git.commit");
  if (commitGate.receipt?.outcome === "FAILED") throw new Error(`SYSTEM_FAILURE: gated git commit failed: ${commitGate.detail}`);
  const commitSha = await revParse(root, "HEAD");
  await assertWorkspaceMatchesCandidate(root, boundCandidate, operation.candidateRevision);

  const pushPayload = { remote: "origin", ref: branch, expectedCommit: commitSha };
  const pushGate = await executeGatedAction({
    root,
    request: { root, operationId, participantId: actor, candidate: boundCandidate, actionKey: `delivery:${contract.task.id}:push`, action: "git.push", payload: pushPayload, authority },
    execute: async () => {
      await assertWorkspaceMatchesCandidate(root, boundCandidate, operation.candidateRevision);
      const pushed = await runExecutable("git", ["push", "origin", `HEAD:${quoteRef(branch)}`], { cwd: root, timeoutMs: 180_000 });
      return { outcome: pushed.exitCode === 0 ? "SUCCEEDED" as const : "FAILED" as const, evidence: { ref: branch, exitCode: pushed.exitCode, stderr: pushed.stderr.slice(-2000) } };
    },
    reconcile: (intent) => reconcileToolAction(root, intent, pushPayload)
  });
  assertDeliveryGateProgress(pushGate, "git.push");
  if (pushGate.receipt?.outcome === "FAILED") throw new Error(`BLOCKED_EXTERNAL: git push failed for ${branch}: ${pushGate.detail}`);

  let pullRequest: DeliveryFinalizationResult["pullRequest"];
  if (allowPullRequest) {
    const apiBase = (github.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
    const owner = repository.split("/")[0]!;
    const query = `/repos/${repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(base)}`;
    const title = `${contract.task.id}: ${contract.task.title}`;
    const body = buildChangePullRequestBody(contract);
    const draft = typeof policy.pullRequestDraft === "boolean" ? policy.pullRequestDraft : github.pullRequestDraft ?? true;
    const prPayload = { repository, head: branch, base, apiBase, title, bodyDigest: sha256Canonical(body), draft };
    let observed: GithubPullRequest | undefined;
    const prGate = await executeGatedAction({
      root,
      request: { root, operationId, participantId: actor, candidate: boundCandidate, actionKey: `delivery:${contract.task.id}:pull-request`, action: "github.pull-request.create", payload: prPayload, authority },
      execute: async () => {
        const existing = await githubRequest<GithubPullRequest[]>(apiBase, token, query);
        if (existing[0]) {
          observed = await githubRequest<GithubPullRequest>(apiBase, token, `/repos/${repository}/pulls/${existing[0].number}`, { method: "PATCH", body: JSON.stringify({ title, body, draft, base }) });
          return { outcome: "SUCCEEDED" as const, evidence: { number: observed.number, url: observed.html_url, updated: true } };
        }
        observed = await githubRequest<GithubPullRequest>(apiBase, token, `/repos/${repository}/pulls`, { method: "POST", body: JSON.stringify({ title, head: branch, base, draft, body }) });
        return { outcome: "SUCCEEDED" as const, evidence: { number: observed.number, url: observed.html_url, created: true } };
      },
      reconcile: (intent) => reconcileToolAction(root, intent, prPayload, { token })
    });
    assertDeliveryGateProgress(prGate, "github.pull-request.create");
    if (prGate.receipt?.outcome === "FAILED") throw new Error(`BLOCKED_EXTERNAL: pull request create/update failed: ${prGate.detail}`);
    if (!observed) observed = (await githubRequest<GithubPullRequest[]>(apiBase, token, query))[0];
    if (!observed) throw new Error("BLOCKED_EXTERNAL: a pull request receipt exists but no open pull request could be observed.");
    pullRequest = { number: observed.number, url: observed.html_url, draft: observed.draft ?? draft };
  }

  let mergeCommitSha: string | undefined;
  if (pullRequest && frozenMergeDirective(operation)) {
    const baseSha = await revParse(root, `${base}^{commit}`);
    const merged = await maybeAutonomousMerge(root, config, contract, operation, boundCandidate, options, {
      repository, base, baseSha, headSha: commitSha, prNumber: pullRequest.number,
    });
    if (merged.blocked) {
      record.status = "ready";
      record.updatedAt = new Date().toISOString();
      await saveDeliveryRecord(stateRoot, config, record);
      return {
        status: "BLOCKED_EXTERNAL",
        humanRequired: false,
        committed: commitGate.receipt?.outcome === "SUCCEEDED",
        commitSha,
        pushed: pushGate.receipt?.outcome === "SUCCEEDED",
        pullRequest,
        candidate: boundCandidate,
        message: merged.blocked,
      };
    }
    mergeCommitSha = merged.mergeCommitSha;
  }

  record.status = "ready";
  record.updatedAt = new Date().toISOString();
  await saveDeliveryRecord(stateRoot, config, record);
  return {
    status: "FINALIZED",
    humanRequired: false,
    committed: commitGate.receipt?.outcome === "SUCCEEDED",
    commitSha,
    pushed: pushGate.receipt?.outcome === "SUCCEEDED",
    ...(pullRequest ? { pullRequest } : {}),
    candidate: boundCandidate,
    message: pullRequest ? `Accepted CHANGE finalized on ${branch}; pull request #${pullRequest.number}${mergeCommitSha ? ` merged (${mergeCommitSha})` : ""}.` : `Accepted CHANGE finalized on ${branch} with push-only policy.`
  };
}

export function buildChangePullRequestBody(contract: TaskContract): string {
  const requirements = (contract.requirements ?? []).map((item) => `- ${item.id}: ${item.description ?? "see sealed TaskContract"}`).join("\n");
  return [
    "## Harness delivery",
    "",
    `Task: \`${contract.task.id}\``,
    `Route: \`${contract.routing?.route ?? "unknown"}\` / assurance \`${contract.routing?.assurance ?? "unknown"}\``,
    "",
    "Accepted by the current candidate-bound AEH validation, review, and AcceptanceOracle gates before this pull request was created or updated.",
    "",
    "## Frozen requirements",
    requirements || "No explicit TaskContract requirement rows.",
    ""
  ].join("\n");
}

function assertDeliveryGateProgress(gate: GatedActionResultV1, action: string): void {
  if (gate.status === "HUMAN_REQUIRED" || gate.status === "RECONCILIATION_REQUIRED") {
    throw new Error(`BLOCKED_EXTERNAL: ${action} has an unresolved durable intent and requires human reconciliation: ${gate.detail}`);
  }
}

export function deliveryFinalizationFailure(error: unknown): DeliveryFinalizationResult {
  const message = error instanceof Error ? error.message : String(error);
  const external = /^BLOCKED_EXTERNAL:/.test(message);
  const supplyChain = /^SUPPLY_CHAIN_BLOCKED:/.test(message);
  return { status: external ? "BLOCKED_EXTERNAL" : supplyChain ? "BLOCKED_SUPPLY_CHAIN" : "SYSTEM_FAILURE", humanRequired: external, committed: false, pushed: false, message };
}function buildPullRequestBody(contract: TaskContract): string { const issue = contract.issue!; return `## Harness delivery\n\nTask: \`${contract.task.id}\`\nSource: ${issue.repository}#${issue.number}\nFrozen issue SHA-256: \`${issue.contentSha256}\`\n\nThe implementation passed the configured deterministic validation, quality convergence and lead-acceptance workflow before this PR was created.\n\nCloses #${issue.number}\n`; }
function skipped(message: string, candidate?: CandidateRevisionV1): DeliveryFinalizationResult { return { status: "SKIPPED", humanRequired: false, committed: false, pushed: false, candidate, message }; }
async function commitWithConfiguredOrHarnessIdentity(root: string, message: string) {
  const name = await runExecutable("git", ["config", "user.name"], { cwd: root, timeoutMs: 10_000 });
  const email = await runExecutable("git", ["config", "user.email"], { cwd: root, timeoutMs: 10_000 });
  const args = [
    ...(name.exitCode === 0 && name.stdout.trim() && email.exitCode === 0 && email.stdout.trim()
      ? []
      : ["-c", "user.name=Agentic Engineering Harness", "-c", "user.email=aeh@users.noreply.github.com"]),
    "commit", "-m", message
  ];
  return runExecutable("git", args, { cwd: root, timeoutMs: 120_000 });
}
async function revParse(root: string, ref: string): Promise<string> {
  const result = await runExecutable("git", ["rev-parse", "--verify", "--end-of-options", ref], { cwd: root, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(`SYSTEM_FAILURE: git rev-parse ${ref} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
function quoteRef(value: string): string { if (!/^[A-Za-z0-9._\/-]+$/.test(value) || value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".") || value.includes("..") || value.includes("@{")) throw new Error(`Unsafe git ref: ${value}`); return value; }
