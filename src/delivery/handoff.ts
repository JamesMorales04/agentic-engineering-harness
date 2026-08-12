import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessProjectConfig, TaskContract } from "../core/types.js";
import { getOriginRemote } from "../core/git.js";
import { loadTaskContract } from "../core/config.js";
import { validateSddChange } from "../core/sdd.js";
import { verifyTaskSeal } from "../core/seal.js";
import { runProcess } from "../utils/process.js";

export interface DeliveryRecord {
  version: 1;
  taskId: string;
  status: "initialized" | "issue-created" | "branch-created" | "workspace-created" | "ready";
  createdAt: string;
  updatedAt: string;
  originatingBranch: string;
  github?: { repository: string; issueNumber?: number; issueUrl?: string; branch?: string; branchSha?: string; };
  paseo?: { workspaceId?: string; worktreePath?: string; };
}
interface GithubIssue { number: number; html_url: string; }
interface GithubUser { login: string; }
interface GithubRef { object: { sha: string } }

export async function handoffSdd(root: string, config: HarnessProjectConfig, taskId: string): Promise<DeliveryRecord> {
  const validation = await validateSddChange(root, taskId, config);
  if (!validation.ok) throw new Error(`Cannot hand off ${taskId}: SDD validation failed: ${[...validation.missing, ...validation.issues].join("; ")}`);
  const contract = await loadTaskContract(root, taskId, config);
  await assertHandoffReady(root, contract);
  if (config.validation?.requireSeal !== false) { const seal = await verifyTaskSeal(root, contract, true); if (seal.status !== "PASS") throw new Error(`Cannot hand off ${taskId}: ${seal.message}`); }
  const originatingBranch = contract.git?.originatingBranch ?? contract.git?.baseRef ?? config.validation?.baseRef ?? "main";
  let record = await loadDeliveryRecord(root, config, taskId) ?? { version: 1, taskId, status: "initialized", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), originatingBranch };

  const github = config.delivery?.github;
  if (github?.enabled) {
    const token = resolveGithubToken(github.tokenEnv); const repository = github.repository ?? await inferGithubRepository(root); const apiBase = (github.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
    record.github = { repository, ...(record.github ?? {}) }; await saveDeliveryRecord(root, config, record);
    if (!record.github.issueNumber) {
      const body = await renderIssueBody(root, contract, originatingBranch); const assignees: string[] = [];
      if (github.assignTokenOwner !== false) assignees.push((await githubRequest<GithubUser>(apiBase, token, "/user")).login);
      const issue = await githubRequest<GithubIssue>(apiBase, token, `/repos/${repository}/issues`, { method: "POST", body: JSON.stringify({ title: `${contract.task.id}: ${contract.task.title}`, body, labels: github.labels ?? [], assignees }) });
      record.github.issueNumber = issue.number; record.github.issueUrl = issue.html_url; record.status = "issue-created"; record.updatedAt = new Date().toISOString(); await saveDeliveryRecord(root, config, record);
    }
    if (!record.github.branch) {
      const branch = renderPattern(github.branchPattern ?? "feature/gh-{issue}-{slug}", contract, record.github.issueNumber!); const baseRef = await githubRequest<GithubRef>(apiBase, token, `/repos/${repository}/git/ref/heads/${encodeRef(originatingBranch)}`);
      await githubRequest(apiBase, token, `/repos/${repository}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseRef.object.sha }) });
      record.github.branch = branch; record.github.branchSha = baseRef.object.sha; record.status = "branch-created"; record.updatedAt = new Date().toISOString(); await saveDeliveryRecord(root, config, record);
    }
  }

  const paseo = config.delivery?.paseo;
  if (paseo?.enabled && paseo.createWorkspace !== false) {
    if (record.paseo?.worktreePath && !(await exists(record.paseo.worktreePath))) record.paseo = undefined;
    if (!record.paseo?.workspaceId) {
      const branch = record.github?.branch; const issue = record.github?.issueNumber; const slug = renderPattern(paseo.worktreeSlugPattern ?? "gh-{issue}-{slug}", contract, issue);
      const workspace = branch ? await createCheckoutWorkspace(root, branch, slug, taskId) : await createBranchOffWorkspace(root, originatingBranch, renderPattern("aeh-{task}-{slug}", contract, issue), slug, taskId);
      if (!workspace.worktreePath) throw new Error("Paseo workspace did not expose a worktree path; task context cannot be materialized safely.");
      await materializeTaskContext(root, workspace.worktreePath, config, contract);
      record.paseo = workspace; record.status = "workspace-created"; record.updatedAt = new Date().toISOString(); await saveDeliveryRecord(root, config, record);
    } else if (record.paseo.worktreePath) await materializeTaskContext(root, record.paseo.worktreePath, config, contract);
  }

  record.status = "ready"; record.updatedAt = new Date().toISOString(); await saveDeliveryRecord(root, config, record); return record;
}

export async function assertHandoffReady(root: string, contract: TaskContract): Promise<void> {
  const placeholders: string[] = [];
  for (const [kind, relative] of Object.entries(contract.source ?? {})) { if (!relative) continue; const content = await fs.readFile(path.resolve(root, relative), "utf8"); if (/\bTODO\b|TODO observable|TODO business rule/i.test(content)) placeholders.push(kind); }
  for (const requirement of contract.requirements ?? []) if (/\bTODO\b/i.test(requirement.description ?? "")) placeholders.push(`requirement:${requirement.id}`);
  if (placeholders.length) throw new Error(`Cannot hand off ${contract.task.id}: unresolved template placeholders remain in ${[...new Set(placeholders)].join(", ")}.`);
}

export async function materializeTaskContext(controlRoot: string, workspaceRoot: string, config: HarnessProjectConfig, contract: TaskContract): Promise<void> {
  if (path.resolve(controlRoot) === path.resolve(workspaceRoot)) return;
  const relativeFiles = [...Object.values(contract.source ?? {}).filter((value): value is string => Boolean(value)), path.join(config.sdd?.contractsDir ?? ".harness/contracts", `${contract.task.id}.yaml`), path.join(".harness", "seals", `${contract.task.id}.json`)];
  for (const relative of [...new Set(relativeFiles)]) {
    if (path.isAbsolute(relative) || relative.startsWith("..")) throw new Error(`Task context path must be repository-relative for worktree handoff: ${relative}`);
    const source = path.resolve(controlRoot, relative); const destination = path.resolve(workspaceRoot, relative);
    try { await fs.access(source); } catch { throw new Error(`Task context artifact is missing before worktree handoff: ${relative}`); }
    await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.copyFile(source, destination);
  }
}

export async function loadDeliveryRecord(root: string, config: HarnessProjectConfig, taskId: string): Promise<DeliveryRecord | undefined> {
  for (const candidate of await deliveryControlRoots(root)) { try { return JSON.parse(await fs.readFile(deliveryFile(candidate, config, taskId), "utf8")) as DeliveryRecord; } catch { /* try next root */ } }
  return undefined;
}
export async function deliveryWorkspaceId(root: string, config: HarnessProjectConfig, taskId: string): Promise<string | undefined> { if (config.delivery?.paseo?.enabled !== true || config.delivery.paseo.autoUseWorkspace === false) return undefined; return (await loadDeliveryRecord(root, config, taskId))?.paseo?.workspaceId; }
export async function deliveryWorkspacePath(root: string, config: HarnessProjectConfig, taskId: string): Promise<string | undefined> { if (config.delivery?.paseo?.enabled !== true || config.delivery.paseo.autoUseWorkspace === false) return undefined; const value = (await loadDeliveryRecord(root, config, taskId))?.paseo?.worktreePath; return value && await exists(value) ? value : undefined; }

export function parseGithubRepository(remote: string): string | undefined { const ssh = remote.match(/^[^@]+@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/); if (ssh) return ssh[1]; try { const url = new URL(remote); const value = url.pathname.replace(/^\//, "").replace(/\.git$/, ""); return /^[^/]+\/[^/]+$/.test(value) ? value : undefined; } catch { return undefined; } }
export function renderPattern(pattern: string, contract: TaskContract, issue?: number): string { const slug = slugify(contract.task.title); return pattern.replaceAll("{issue}", issue ? String(issue) : "no-issue").replaceAll("{task}", slugify(contract.task.id)).replaceAll("{slug}", slug); }
export async function renderIssueBody(root: string, contract: TaskContract, originatingBranch: string): Promise<string> { const spec = contract.source?.spec ? await fs.readFile(path.resolve(root, contract.source.spec), "utf8") : ""; const acceptance = contract.source?.acceptance ? await fs.readFile(path.resolve(root, contract.source.acceptance), "utf8") : ""; const requirements = (contract.requirements ?? []).map((item) => `- ${item.id}: ${item.description ?? "see specification"}`).join("\n"); return `**Source: Agentic Engineering Harness SDD**\n\n**Task:** ${contract.task.id}\n\n## Implementation Start Rule\nImplementation is authorized from this issue-linked branch only after the validated SDD handoff completes. The local sealed TaskContract and SDD artifacts remain normative; this issue is a delivery mirror.\n\n## Originating Branch\n${originatingBranch}\n\n## Requirements\n${requirements || "See specification."}\n\n## Specification\n${spec.trim()}\n\n## Acceptance\n\`\`\`gherkin\n${acceptance.trim()}\n\`\`\`\n\n## Harness Sources\n${Object.entries(contract.source ?? {}).map(([name, value]) => `- ${name}: \`${value}\``).join("\n")}\n`; }

async function inferGithubRepository(root: string): Promise<string> { const remote = await getOriginRemote(root); const repository = remote ? parseGithubRepository(remote) : undefined; if (!repository) throw new Error("Cannot infer GitHub repository from origin; set delivery.github.repository as owner/repo."); return repository; }
function resolveGithubToken(preferred?: string): string { for (const name of [preferred, "GH_TOKEN", "GITHUB_TOKEN", "GITHUB_PAT"].filter((value): value is string => Boolean(value))) { const token = process.env[name]; if (token) return token; } throw new Error(`GitHub delivery is enabled but no token is available. Set ${preferred ?? "GH_TOKEN"} (or GITHUB_TOKEN/GITHUB_PAT).`); }
async function githubRequest<T = unknown>(base: string, token: string, endpoint: string, init: RequestInit = {}): Promise<T> { const response = await fetch(`${base}${endpoint}`, { ...init, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json", ...(init.headers ?? {}) } }); const text = await response.text(); if (!response.ok) throw new Error(`GitHub API ${init.method ?? "GET"} ${endpoint} failed (${response.status}): ${text.slice(0, 1000)}`); return text ? JSON.parse(text) as T : undefined as T; }
async function createCheckoutWorkspace(root: string, branch: string, slug: string, title: string): Promise<{ workspaceId?: string; worktreePath?: string }> { const local = await runProcess(`git show-ref --verify --quiet refs/heads/${quoteRef(branch)}`, { cwd: root }); if (local.exitCode !== 0) { const fetchResult = await runProcess(`git fetch origin ${quote(`refs/heads/${branch}:refs/heads/${branch}`)}`, { cwd: root, timeoutMs: 120_000 }); if (fetchResult.exitCode !== 0) throw new Error(`Failed to fetch issue branch ${branch}: ${fetchResult.stderr || fetchResult.stdout}`); } return runPaseoWorkspace(root, `--mode checkout-branch --branch ${quote(branch)}`, slug, title, branch); }
async function createBranchOffWorkspace(root: string, base: string, branch: string, slug: string, title: string): Promise<{ workspaceId?: string; worktreePath?: string }> { return runPaseoWorkspace(root, `--mode branch-off --new-branch ${quote(branch)} --base ${quote(base)}`, slug, title, branch); }
async function runPaseoWorkspace(root: string, mode: string, slug: string, title: string, branch: string): Promise<{ workspaceId?: string; worktreePath?: string }> {
  const create = await runProcess(`paseo workspace create --isolation worktree --path ${quote(root)} ${mode} --worktree-slug ${quote(slug)} --title ${quote(title)} --json`, { cwd: root, timeoutMs: 180_000 }); if (create.exitCode !== 0) throw new Error(`Paseo workspace creation failed: ${create.stderr || create.stdout}`);
  const direct = parseWorkspace(create.stdout, branch); if (direct.workspaceId && direct.worktreePath) return direct;
  const list = await runProcess("paseo workspace ls --json", { cwd: root, timeoutMs: 60_000 }); if (list.exitCode === 0) { const found = parseWorkspace(list.stdout, branch); if (found.workspaceId && found.worktreePath) return found; }
  throw new Error(`Paseo created the workspace but its ID/path could not be resolved. Output: ${create.stdout}`);
}
function parseWorkspace(raw: string, branch: string): { workspaceId?: string; worktreePath?: string } { try { const value = JSON.parse(raw) as unknown; const candidates = flattenObjects(value); const found = candidates.find((item) => [item.branch, item.branchName, item.gitBranch].some((candidate) => candidate === branch)) ?? candidates.find((item) => typeof item.id === "string" || typeof item.workspaceId === "string"); return found ? { workspaceId: stringValue(found.workspaceId) ?? stringValue(found.id), worktreePath: stringValue(found.worktreePath) ?? stringValue(found.path) ?? stringValue(found.root) } : {}; } catch { return {}; } }
function flattenObjects(value: unknown): Array<Record<string, unknown>> { if (Array.isArray(value)) return value.flatMap(flattenObjects); if (!value || typeof value !== "object") return []; const record = value as Record<string, unknown>; return [record, ...Object.values(record).flatMap(flattenObjects)]; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }
async function saveDeliveryRecord(root: string, config: HarnessProjectConfig, record: DeliveryRecord): Promise<void> { const file = deliveryFile(root, config, record.taskId); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`); }
async function deliveryControlRoots(root: string): Promise<string[]> { const roots = [path.resolve(root)]; const common = await runProcess("git rev-parse --path-format=absolute --git-common-dir", { cwd: root, timeoutMs: 10_000 }); if (common.exitCode === 0) { const gitDir = common.stdout.trim(); if (path.basename(gitDir) === ".git") roots.push(path.dirname(gitDir)); } return [...new Set(roots)]; }
function deliveryFile(root: string, config: HarnessProjectConfig, taskId: string): string { return path.join(root, config.delivery?.stateDir ?? ".harness/delivery", `${taskId}.json`); }
function encodeRef(value: string): string { return value.split("/").map(encodeURIComponent).join("/"); }
function slugify(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "change"; }
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function quoteRef(value: string): string { return value.replace(/[^A-Za-z0-9._\/-]/g, ""); }
async function exists(file: string): Promise<boolean> { try { await fs.access(file); return true; } catch { return false; } }
