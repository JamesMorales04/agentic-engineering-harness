import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { minimatch } from "minimatch";
import type { AgentExecutionSelection } from "../agents/types.js";
import type { DelegationTask } from "../agents/outputContracts.js";
import type { ControlPlaneSnapshot } from "../core/controlPlane.js";
import type { HarnessProjectConfig, TaskContract, WorkerSession } from "../core/types.js";
import { executeAgentPrompt } from "../workers/agentPrompt.js";
import { runProcess } from "../utils/process.js";
import { claimDistributedJob, completeDistributedJob, submitDistributedJob, waitForDistributedResult } from "./queue.js";
import type { DistributedDelegationJob, DistributedDelegationResult } from "./types.js";

export async function dispatchDistributedDelegation(input: {
  root: string;
  config: HarnessProjectConfig;
  contract: TaskContract;
  task: DelegationTask;
  selection: AgentExecutionSelection;
  prompt: string;
  controller?: ControlPlaneSnapshot;
}): Promise<DistributedDelegationResult> {
  if (!input.config.distributed?.enabled) throw new Error("Distributed execution is not enabled.");
  const remote = await runProcess("git remote get-url origin", { cwd: input.root, timeoutMs: 10_000 }); if (remote.exitCode !== 0 || !remote.stdout.trim()) throw new Error("Distributed execution requires a Git remote named origin.");
  const base = await runProcess("git rev-parse HEAD", { cwd: input.root, timeoutMs: 10_000 }); if (base.exitCode !== 0) throw new Error("Distributed execution could not resolve the workspace HEAD.");
  const selection = { ...input.selection, transport: input.selection.transport === "podman" ? "podman" as const : "direct" as const };
  const job: DistributedDelegationJob = {
    version: 1,
    id: `${safe(input.contract.task.id)}-${safe(input.task.id)}-${crypto.randomUUID()}`,
    parentTaskId: input.contract.task.id,
    createdAt: new Date().toISOString(),
    repositoryUrl: remote.stdout.trim(),
    baseRef: base.stdout.trim(),
    controllerSha256: input.controller?.compositeSha256,
    task: input.task,
    contract: input.contract,
    selection,
    config: sanitizeRemoteConfig(input.config),
    prompt: input.prompt
  };
  await submitDistributedJob(input.root, input.config, job);
  return waitForDistributedResult(input.root, input.config, job.id);
}

export async function runDistributedWorkerOnce(root: string, config: HarnessProjectConfig, workerId = config.distributed?.workerId ?? `worker-${process.pid}`): Promise<DistributedDelegationResult | undefined> {
  const claimed = await claimDistributedJob(root, config, workerId); if (!claimed) return undefined;
  const result = await executeClaimedJob(claimed.job, workerId);
  await completeDistributedJob(root, config, claimed.leaseId, result);
  return result;
}

export async function runDistributedWorkerLoop(root: string, config: HarnessProjectConfig, options: { workerId?: string; once?: boolean; signal?: AbortSignal } = {}): Promise<void> {
  const workerId = options.workerId ?? config.distributed?.workerId ?? `worker-${process.pid}`; const interval = config.distributed?.pollIntervalMs ?? 1000;
  do {
    if (options.signal?.aborted) return;
    const result = await runDistributedWorkerOnce(root, config, workerId);
    if (options.once) return;
    if (!result) await new Promise((resolve) => setTimeout(resolve, interval));
  } while (!options.signal?.aborted);
}

async function executeClaimedJob(job: DistributedDelegationJob, workerId: string): Promise<DistributedDelegationResult> {
  const startedAt = new Date().toISOString(); const worktree = await fs.mkdtemp(path.join(os.tmpdir(), `aeh-remote-${safe(job.id)}-`)); let session: WorkerSession = { provider: job.selection.runtimeAdapter, model: job.selection.modelName, logicalAgent: job.selection.logicalAgent, runtime: job.selection.runtimeName, exitCode: 1, stdout: "", stderr: "remote worker did not start" };
  try {
    const clone = await runProcess(`git clone --quiet --no-checkout ${quote(job.repositoryUrl)} ${quote(worktree)}`, { cwd: os.tmpdir(), timeoutMs: 300_000, toolchain: false }); if (clone.exitCode !== 0) return failure(job, workerId, startedAt, session, `clone failed: ${clone.stderr || clone.stdout}`);
    const checkout = await runProcess(`git checkout --quiet --detach ${quote(job.baseRef)}`, { cwd: worktree, timeoutMs: 120_000 }); if (checkout.exitCode !== 0) return failure(job, workerId, startedAt, session, `checkout failed: ${checkout.stderr || checkout.stdout}`);
    const contractDir = job.config.sdd?.contractsDir ?? ".harness/contracts"; const contractFile = path.join(worktree, contractDir, `${job.contract.task.id}.yaml`); await fs.mkdir(path.dirname(contractFile), { recursive: true }); await fs.writeFile(contractFile, YAML.stringify(job.contract));
    session = await executeAgentPrompt(worktree, job.config, job.contract, job.selection, job.prompt);
    if (session.exitCode !== 0) return failure(job, workerId, startedAt, session, `agent exited with ${session.exitCode}`);
    const status = await runProcess("git status --porcelain", { cwd: worktree, timeoutMs: 30_000 }); const untracked = status.stdout.split(/\r?\n/).filter((line) => line.startsWith("?? ")).map((line) => line.slice(3).trim()).filter(Boolean); if (untracked.length) await runProcess(`git add -N -- ${untracked.map(quote).join(" ")}`, { cwd: worktree, timeoutMs: 30_000 });
    const names = await runProcess("git diff --name-only HEAD", { cwd: worktree, timeoutMs: 30_000 }); const changedFiles = names.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean); const escaped = changedFiles.filter((file) => !job.task.scope.some((scope) => matches(file, scope))); if (escaped.length) return failure(job, workerId, startedAt, session, `remote task escaped scope: ${escaped.join(", ")}`, changedFiles);
    const diff = await runProcess("git diff --binary --no-ext-diff HEAD", { cwd: worktree, timeoutMs: 60_000 }); if (diff.exitCode !== 0) return failure(job, workerId, startedAt, session, diff.stderr || "unable to capture patch", changedFiles);
    return { version: 1, jobId: job.id, workerId, startedAt, finishedAt: new Date().toISOString(), status: "PASS", session, changedFiles, patch: diff.stdout };
  } catch (error) { return failure(job, workerId, startedAt, session, String(error)); }
  finally { await fs.rm(worktree, { recursive: true, force: true }).catch(() => undefined); }
}

function failure(job: DistributedDelegationJob, workerId: string, startedAt: string, session: WorkerSession, message: string, changedFiles: string[] = []): DistributedDelegationResult { return { version: 1, jobId: job.id, workerId, startedAt, finishedAt: new Date().toISOString(), status: "FAIL", session: { ...session, exitCode: session.exitCode || 1, stderr: [session.stderr, message].filter(Boolean).join("\n") }, changedFiles, patch: "", message }; }
function sanitizeRemoteConfig(config: HarnessProjectConfig): HarnessProjectConfig { return { ...config, delivery: { ...config.delivery, github: { ...config.delivery?.github, enabled: false }, paseo: { ...config.delivery?.paseo, enabled: false, autoUseWorkspace: false } }, distributed: { ...config.distributed, enabled: false }, telemetry: { ...config.telemetry, exporter: "none" } }; }
function matches(file: string, scope: string): boolean { return scope === "**" || minimatch(file, scope, { dot: true }) || file.startsWith(scope.split(/[?*\[]/, 1)[0].replace(/\/+$/, "")); }
function safe(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, "-"); }
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
