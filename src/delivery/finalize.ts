import type { HarnessProjectConfig, TaskContract } from "../core/types.js";
import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { computeWorktreeDigest, getCurrentBranch } from "../core/git.js";
import { githubRequest, loadDeliveryRecord, resolveGithubToken } from "./handoff.js";
import { runExecutable } from "../utils/process.js";
import { verifySupplyChainGate } from "../provenance/generate.js";
import { controllerEpochFromEnvironment, currentOperationContext, loadOperation, resolveOperationStateRoot } from "../operations/state.js";
import { reconcileToolAction } from "../security/actionReconciliation.js";
import { executeGatedAction, type GatedActionResultV1 } from "../security/gatedAction.js";
import { controllerActorId, type ToolActionAuthorityEvidenceV1 } from "../security/toolActionGate.js";
import { assertWorkspaceMatchesCandidate } from "../candidates/identity.js";

export type DeliveryFinalizationStatus = "SKIPPED" | "NO_CHANGES" | "FINALIZED" | "BLOCKED_EXTERNAL" | "BLOCKED_SUPPLY_CHAIN" | "SYSTEM_FAILURE";
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

export async function finalizeAcceptedIssue(root: string, config: HarnessProjectConfig, contract: TaskContract, options: { candidate?: CandidateRevisionV1 } = {}): Promise<DeliveryFinalizationResult> {
  const candidate = options.candidate;
  const github = config.delivery?.github;
  if (!contract.issue || contract.issue.provider !== "github") return skipped("Task is not issue-derived.", candidate);
  if (!github?.enabled || github.finalizeOnAcceptance !== true) return skipped("GitHub finalization is not enabled.", candidate);

  const operationContext = currentOperationContext();
  const operationId = operationContext.id;
  const controllerEpoch = controllerEpochFromEnvironment();
  if (!operationId || controllerEpoch === undefined) throw new Error("DELIVERY_AUTHORITY_REQUIRED: accepted delivery must run inside a managed operation with a fenced controller epoch.");
  const operation = await loadOperation(resolveOperationStateRoot(root), operationId);
  const boundCandidate = candidate ?? operation.candidateRevision;
  if (!boundCandidate || !operation.candidateRevision || boundCandidate.identityDigest !== operation.candidateRevision.identityDigest) {
    throw new Error("DELIVERY_AUTHORITY_REQUIRED: delivery requires the operation's current CandidateRevision.");
  }
  await assertWorkspaceMatchesCandidate(root, boundCandidate, operation.candidateRevision);
  const authority: ToolActionAuthorityEvidenceV1 = { kind: "controller-authority", operationId, controllerEpoch };
  const actor = controllerActorId(operationId);

  const supplyChain = await verifySupplyChainGate(root, config);
  if (!supplyChain.ok) throw new Error(`SUPPLY_CHAIN_BLOCKED: ${supplyChain.failures.join("; ")}`);

  const record = await loadDeliveryRecord(root, config, contract.task.id);
  const branch = record?.github?.branch;
  if (!branch) throw new Error(`BLOCKED_EXTERNAL: accepted issue task ${contract.task.id} has no issue-linked delivery branch to finalize.`);
  const repository = record.github?.repository ?? contract.issue.repository;
  const base = contract.git?.originatingBranch ?? contract.git?.baseRef ?? config.validation?.baseRef ?? "main";
  const current = await getCurrentBranch(root);
  if (current && current !== branch) throw new Error(`SYSTEM_FAILURE: refusing to finalize ${contract.task.id}; workspace branch is '${current}' but delivery branch is '${branch}'. Enable the isolated delivery workspace or run from the issue branch.`);

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
      reconcile: (intent) => reconcileToolAction(root, intent, { taskId: contract.task.id, message: commitMessage })
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

  return { status: "FINALIZED", humanRequired: false, committed, commitSha, pushed: true, candidate, pullRequest: { number: pr.number, url: pr.html_url, draft: pr.draft ?? (github.pullRequestDraft ?? true) }, message: `Accepted issue task finalized on ${branch}; pull request #${pr.number}.` };
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
