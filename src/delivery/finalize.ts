import type { HarnessProjectConfig, TaskContract } from "../core/types.js";
import { getCurrentBranch } from "../core/git.js";
import { githubRequest, loadDeliveryRecord, resolveGithubToken } from "./handoff.js";
import { runProcess } from "../utils/process.js";

export type DeliveryFinalizationStatus = "SKIPPED" | "NO_CHANGES" | "FINALIZED" | "BLOCKED_EXTERNAL" | "SYSTEM_FAILURE";
export interface DeliveryFinalizationResult {
  status: DeliveryFinalizationStatus;
  humanRequired: boolean;
  committed: boolean;
  commitSha?: string;
  pushed: boolean;
  pullRequest?: { number: number; url: string; draft: boolean };
  message: string;
}
interface GithubPullRequest { number: number; html_url: string; draft?: boolean; }

export async function finalizeAcceptedIssue(root: string, config: HarnessProjectConfig, contract: TaskContract): Promise<DeliveryFinalizationResult> {
  const github = config.delivery?.github;
  if (!contract.issue || contract.issue.provider !== "github") return skipped("Task is not issue-derived.");
  if (!github?.enabled || github.finalizeOnAcceptance !== true) return skipped("GitHub finalization is not enabled.");

  const record = await loadDeliveryRecord(root, config, contract.task.id);
  const branch = record?.github?.branch;
  if (!branch) throw new Error(`BLOCKED_EXTERNAL: accepted issue task ${contract.task.id} has no issue-linked delivery branch to finalize.`);
  const repository = record.github?.repository ?? contract.issue.repository;
  const base = contract.git?.originatingBranch ?? contract.git?.baseRef ?? config.validation?.baseRef ?? "main";
  const current = await getCurrentBranch(root);
  if (current && current !== branch) throw new Error(`SYSTEM_FAILURE: refusing to finalize ${contract.task.id}; workspace branch is '${current}' but delivery branch is '${branch}'. Enable the isolated delivery workspace or run from the issue branch.`);

  const status = await runProcess("git status --porcelain", { cwd: root, timeoutMs: 30_000 });
  if (status.exitCode !== 0) throw new Error(`SYSTEM_FAILURE: cannot inspect final Git state: ${status.stderr || status.stdout}`);
  let committed = false;
  let commitSha: string | undefined;

  if (status.stdout.trim()) {
    const add = await runProcess("git add -A", { cwd: root, timeoutMs: 60_000 });
    if (add.exitCode !== 0) throw new Error(`SYSTEM_FAILURE: git add failed during deterministic finalization: ${add.stderr || add.stdout}`);
    const commit = await commitWithConfiguredOrHarnessIdentity(root, `${contract.task.id}: ${contract.task.title}`);
    if (commit.exitCode !== 0) throw new Error(`SYSTEM_FAILURE: git commit failed during deterministic finalization: ${commit.stderr || commit.stdout}`);
    committed = true;
    commitSha = await revParse(root, "HEAD");
  } else commitSha = await revParse(root, "HEAD");

  const ahead = await runProcess(`git rev-list --count ${quote(`${base}..HEAD`)}`, { cwd: root, timeoutMs: 30_000 });
  if (ahead.exitCode !== 0) throw new Error(`SYSTEM_FAILURE: cannot determine whether ${branch} contains deliverable commits: ${ahead.stderr || ahead.stdout}`);
  if (Number(ahead.stdout.trim() || "0") === 0) return { status: "NO_CHANGES", humanRequired: false, committed, commitSha, pushed: false, message: `No commits differ from ${base}; no pull request is required.` };

  const push = await runProcess(`git push origin HEAD:${quoteRef(branch)}`, { cwd: root, timeoutMs: 180_000 });
  if (push.exitCode !== 0) throw new Error(`BLOCKED_EXTERNAL: git push failed for ${branch}: ${push.stderr || push.stdout}`);

  const token = resolveGithubToken(github.tokenEnv);
  const apiBase = (github.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
  const owner = repository.split("/")[0];
  const query = `/repos/${repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(base)}`;
  const existing = await githubRequest<GithubPullRequest[]>(apiBase, token, query);
  let pr = existing[0];
  if (!pr) {
    pr = await githubRequest<GithubPullRequest>(apiBase, token, `/repos/${repository}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title: `${contract.task.id}: ${contract.task.title}`, head: branch, base, draft: github.pullRequestDraft ?? true, body: buildPullRequestBody(contract) })
    });
  }

  return { status: "FINALIZED", humanRequired: false, committed, commitSha, pushed: true, pullRequest: { number: pr.number, url: pr.html_url, draft: pr.draft ?? (github.pullRequestDraft ?? true) }, message: `Accepted issue task finalized on ${branch}; pull request #${pr.number}.` };
}

export function deliveryFinalizationFailure(error: unknown): DeliveryFinalizationResult {
  const message = error instanceof Error ? error.message : String(error);
  const external = /^BLOCKED_EXTERNAL:/.test(message);
  return { status: external ? "BLOCKED_EXTERNAL" : "SYSTEM_FAILURE", humanRequired: external, committed: false, pushed: false, message };
}
function buildPullRequestBody(contract: TaskContract): string { const issue = contract.issue!; return `## Harness delivery\n\nTask: \`${contract.task.id}\`\nSource: ${issue.repository}#${issue.number}\nFrozen issue SHA-256: \`${issue.contentSha256}\`\n\nThe implementation passed the configured deterministic validation, quality convergence and lead-acceptance workflow before this PR was created.\n\nCloses #${issue.number}\n`; }
function skipped(message: string): DeliveryFinalizationResult { return { status: "SKIPPED", humanRequired: false, committed: false, pushed: false, message }; }
async function commitWithConfiguredOrHarnessIdentity(root: string, message: string) { const name = await runProcess("git config user.name", { cwd: root, timeoutMs: 10_000 }); const email = await runProcess("git config user.email", { cwd: root, timeoutMs: 10_000 }); const identity = name.exitCode === 0 && name.stdout.trim() && email.exitCode === 0 && email.stdout.trim() ? "" : `-c user.name=${quote("Agentic Engineering Harness")} -c user.email=${quote("aeh@users.noreply.github.com")}`; return runProcess(`git ${identity} commit -m ${quote(message)}`, { cwd: root, timeoutMs: 120_000 }); }
async function revParse(root: string, ref: string): Promise<string> { const result = await runProcess(`git rev-parse ${quote(ref)}`, { cwd: root, timeoutMs: 30_000 }); if (result.exitCode !== 0) throw new Error(`SYSTEM_FAILURE: git rev-parse ${ref} failed: ${result.stderr || result.stdout}`); return result.stdout.trim(); }
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function quoteRef(value: string): string { if (!/^[A-Za-z0-9._\/-]+$/.test(value)) throw new Error(`Unsafe git ref: ${value}`); return value; }
