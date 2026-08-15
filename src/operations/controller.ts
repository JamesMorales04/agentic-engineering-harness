import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { runAudit } from "../audit/run.js";
import { loadProjectConfig, loadTaskContract } from "../core/config.js";
import { runTask } from "../core/run.js";
import type { HarnessProjectConfig } from "../core/types.js";
import {
  deliveryWorkspaceId,
  deliveryWorkspacePath,
  materializeTaskContext
} from "../delivery/handoff.js";
import { listManagedPaseoAgents } from "../paseo/runtime.js";
import { recordPaseoTrace } from "../paseo/trace.js";
import { runProcess, type ProcessResult } from "../utils/process.js";
import { runChangeOperation } from "./change.js";
import {
  disableOperationCompletionTarget,
  notifyOperationCompletion,
  registerOperationCompletionTarget
} from "./completion.js";
import { startOperationWatchdog } from "./liveness.js";
import { assertOperationCapacity, syncOperationPortfolio } from "./portfolio.js";
import {
  bindOperationLead,
  isTerminalOperation,
  loadOperation,
  patchOperation,
  saveOperation,
  transitionOperationToTerminal,
  type AuditOperationPayload,
  type ChangeOperationPayload,
  type OperationKind,
  type OperationPayload,
  type OperationRecord,
  type OperationRecordV2,
  type RunOperationPayload
} from "./state.js";

export interface StartOperationOptions {
  nodeExecutable: string;
  entryFile: string;
  spawnProcess?: typeof spawn;
  completionAgentId?: string;
  completionSource?: string;
}

export interface OperationControllerDeps {
  run?: typeof runProcess;
  trace?: typeof recordPaseoTrace;
  notifyCompletion?: (root: string, operation: OperationRecord) => Promise<unknown>;
  startWatchdog?: typeof startOperationWatchdog;
  runAudit?: typeof runAudit;
  runTask?: typeof runTask;
  runChange?: typeof runChangeOperation;
}

interface OperationWorkspace {
  workspaceId?: string;
  workspaceRoot?: string;
  warning?: string;
  reusedDelivery?: boolean;
}

export async function startDetachedOperation(
  root: string,
  kind: OperationKind,
  payload: OperationPayload,
  options: StartOperationOptions
): Promise<OperationRecordV2> {
  const absoluteRoot = path.resolve(root);
  const config = await loadProjectConfigIfPresent(absoluteRoot);
  if (config) await assertOperationCapacity(absoluteRoot, config, operationPriority(payload));

  const now = new Date().toISOString();
  const id = createOperationId(kind, JSON.stringify(payload));
  let record: OperationRecordV2 = {
    version: 2,
    id,
    kind,
    status: "QUEUED",
    phase: "queued",
    root: absoluteRoot,
    payload,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    lastProgressAt: now,
    intent: initialIntent(kind, payload),
    supervision: {
      required: kind === "audit" || kind === "change",
      materialized: false,
      generations: []
    },
    stages: {
      queued: {
        name: "queued",
        status: "RUNNING",
        revision: 1,
        startedAt: now
      }
    },
    participants: {},
    progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 }
  };
  await saveOperation(absoluteRoot, record);

  const completionAgentId = options.completionAgentId?.trim() || process.env.PASEO_AGENT_ID?.trim() || undefined;
  if (completionAgentId) {
    const source = options.completionSource ?? (options.completionAgentId ? "explicit" : "environment");
    await registerOperationCompletionTarget(absoluteRoot, id, completionAgentId, source);
    record = await bindOperationLead(absoluteRoot, id, completionAgentId, source);
  }
  if (config) await syncOperationPortfolio(absoluteRoot, config.project.name, record);

  const spawnProcess = options.spawnProcess ?? spawn;
  let child: ChildProcess;
  try {
    child = spawnProcess(
      options.nodeExecutable,
      [options.entryFile, "operation", "execute", id, absoluteRoot],
      {
        cwd: absoluteRoot,
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          AEH_CONTROL_ROOT: absoluteRoot,
          AEH_OPERATION_ID: id,
          AEH_OPERATION_KIND: kind
        }
      }
    );
  } catch (error) {
    if (completionAgentId) {
      await disableOperationCompletionTarget(
        absoluteRoot,
        id,
        `Detached controller spawn failed before the initiating tool returned: ${String(error)}`
      ).catch(() => undefined);
    }
    record = await patchOperation(absoluteRoot, id, {
      status: "FAILED",
      phase: "spawn-failed",
      error: String(error),
      finishedAt: new Date().toISOString()
    });
    if (config) await syncOperationPortfolio(absoluteRoot, config.project.name, record);
    return record;
  }
  child.unref();
  record = await patchOperation(absoluteRoot, id, {
    pid: child.pid,
    phase: "dispatched"
  });
  if (config) await syncOperationPortfolio(absoluteRoot, config.project.name, record);
  return record;
}

export async function executeOperation(
  root: string,
  operationId: string,
  deps: OperationControllerDeps = {}
): Promise<OperationRecordV2> {
  const absoluteRoot = path.resolve(root);
  process.env.AEH_CONTROL_ROOT = absoluteRoot;
  const trace = deps.trace ?? recordPaseoTrace;
  let record = await loadOperation(absoluteRoot, operationId);
  if (record.status === "CANCELLED") return record;
  record = await patchOperation(absoluteRoot, operationId, {
    status: "RUNNING",
    phase: "preparing",
    startedAt: record.startedAt ?? new Date().toISOString(),
    pid: process.pid,
    error: undefined
  });
  process.env.AEH_OPERATION_ID = record.id;
  process.env.AEH_OPERATION_KIND = record.kind;

  const config = await loadProjectConfig(absoluteRoot);
  await syncOperationPortfolio(absoluteRoot, config.project.name, record);
  let stopWatchdog: (() => void) | undefined;
  try {
    const workspace = await ensureOperationWorkspace(
      absoluteRoot,
      record,
      config,
      deps.run ?? runProcess,
      trace
    );
    if (workspace.workspaceId) process.env.AEH_OPERATION_WORKSPACE_ID = workspace.workspaceId;
    const executionRoot = path.resolve(workspace.workspaceRoot ?? absoluteRoot);
    record = await patchOperation(absoluteRoot, operationId, {
      workspaceId: workspace.workspaceId,
      workspaceRoot: executionRoot,
      workspaceWarning: workspace.warning
    });
    await syncOperationPortfolio(absoluteRoot, config.project.name, record);
    stopWatchdog = (deps.startWatchdog ?? startOperationWatchdog)(absoluteRoot, config, operationId);

    if (record.kind === "audit") {
      const payload = record.payload as AuditOperationPayload;
      const report = await (deps.runAudit ?? runAudit)(executionRoot, config, { ...payload, auditId: record.id });
      const current = await loadOperation(absoluteRoot, operationId);
      if (current.status === "CANCELLED") return current;
      return terminalizeOperation(
        absoluteRoot,
        operationId,
        {
          status: "SUCCEEDED",
          phase: "finished",
          finishedAt: new Date().toISOString(),
          result: {
            auditId: report.auditId,
            status: report.status,
            productionSafe: report.productionSafe,
            report: `.harness/audits/${report.auditId}.json`
          }
        },
        deps,
        config
      );
    }

    if (record.kind === "change") {
      const result = await (deps.runChange ?? runChangeOperation)(
        executionRoot,
        absoluteRoot,
        config,
        await loadOperation(absoluteRoot, operationId),
        record.payload as ChangeOperationPayload
      );
      const current = await loadOperation(absoluteRoot, operationId);
      if (current.status === "CANCELLED") return current;
      return terminalizeOperation(
        absoluteRoot,
        operationId,
        {
          status: result.run.status === "PASS" ? "SUCCEEDED" : "FAILED",
          phase: "finished",
          finishedAt: new Date().toISOString(),
          result: {
            taskId: result.taskId,
            mode: result.mode,
            status: result.run.status,
            attempts: result.run.attempts,
            specChange: result.specChange,
            triageReasons: result.triageReasons
          }
        },
        deps,
        config
      );
    }

    const payload = record.payload as RunOperationPayload;
    const contract = await loadTaskContract(absoluteRoot, payload.taskId, config);
    if (executionRoot !== absoluteRoot) {
      await materializeTaskContext(absoluteRoot, executionRoot, config, contract);
    }
    const result = await (deps.runTask ?? runTask)(executionRoot, config, contract, { profile: payload.profile });
    const current = await loadOperation(absoluteRoot, operationId);
    if (current.status === "CANCELLED") return current;
    return terminalizeOperation(
      absoluteRoot,
      operationId,
      {
        status: result.status === "PASS" ? "SUCCEEDED" : "FAILED",
        phase: "finished",
        finishedAt: new Date().toISOString(),
        result: {
          taskId: result.taskId,
          status: result.status,
          attempts: result.attempts
        }
      },
      deps,
      config
    );
  } catch (error) {
    const current = await loadOperation(absoluteRoot, operationId).catch(() => record);
    if (current.status === "CANCELLED") return current;
    return terminalizeOperation(
      absoluteRoot,
      operationId,
      {
        status: "FAILED",
        phase: "failed",
        error: error instanceof Error ? error.stack ?? error.message : String(error),
        finishedAt: new Date().toISOString()
      },
      deps,
      config
    );
  } finally {
    stopWatchdog?.();
  }
}

export async function waitForOperation(
  root: string,
  operationId: string,
  timeoutMs = 1_800_000,
  pollMs = 500
): Promise<OperationRecordV2> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = await loadOperation(root, operationId);
    if (isTerminalOperation(record.status)) return record;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for operation ${operationId} after ${timeoutMs}ms.`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export async function cancelOperation(
  root: string,
  operationId: string,
  deps: OperationControllerDeps = {}
): Promise<OperationRecordV2> {
  const absoluteRoot = path.resolve(root);
  const trace = deps.trace ?? recordPaseoTrace;
  const run = deps.run ?? runProcess;
  const record = await loadOperation(absoluteRoot, operationId);
  if (isTerminalOperation(record.status)) return record;
  const cleanupWarnings: string[] = [];

  if (record.pid && record.pid !== process.pid) {
    try { process.kill(record.pid, "SIGTERM"); }
    catch (error) { if (!/ESRCH/.test(String(error))) cleanupWarnings.push(`controller: ${String(error)}`); }
  }

  let agentIds = [...new Set((record.agents ?? []).map((agent) => agent.id).filter(Boolean))];
  if (agentIds.length > 0) {
    await trace(absoluteRoot, "cleanup.discovery", { operationId, source: "operation-state", agentCount: agentIds.length });
  } else {
    try {
      const discovered = await listManagedPaseoAgents(absoluteRoot, { "aeh.operation": operationId });
      agentIds = [...new Set(discovered.map((agent) => agent.id))];
      await trace(absoluteRoot, "cleanup.discovery", { operationId, source: "paseo-list-compatibility", agentCount: agentIds.length, reason: "legacy operation record has no registered agent identities" });
    } catch (error) {
      cleanupWarnings.push(`agent discovery: ${String(error)}`);
      await trace(absoluteRoot, "cleanup.cli.error", { operationId, error: String(error) });
    }
  }

  await trace(absoluteRoot, "cleanup.cli.required", {
    operationId,
    reason: "Paseo public SDK lacks cancel/kill parity for external controller cleanup",
    agentCount: agentIds.length
  });
  for (const agentId of agentIds) {
    const stopped = await run(`paseo stop ${quote(agentId)}`, { cwd: absoluteRoot, timeoutMs: 30_000 }).catch((error) => ({ exitCode: 1, stdout: "", stderr: String(error), durationMs: 0 }));
    await trace(absoluteRoot, "cleanup.cli.stop", { operationId, agentId, exitCode: stopped.exitCode });
    if (stopped.exitCode !== 0) cleanupWarnings.push(`agent ${agentId}: ${stopped.stderr || stopped.stdout || `exit ${stopped.exitCode}`}`);
  }

  const config = await loadProjectConfigIfPresent(absoluteRoot);
  return terminalizeOperation(
    absoluteRoot,
    operationId,
    {
      status: "CANCELLED",
      phase: "cancelled",
      finishedAt: new Date().toISOString(),
      cleanupWarnings: cleanupWarnings.length ? cleanupWarnings : undefined
    },
    deps,
    config
  );
}

export function createOperationId(kind: OperationKind, seed: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const hash = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 8);
  return `${kind.toUpperCase()}-${stamp}-${hash}`;
}

async function terminalizeOperation(
  root: string,
  operationId: string,
  patch: Partial<OperationRecordV2> & { status: "SUCCEEDED" | "FAILED" | "CANCELLED" },
  deps: OperationControllerDeps,
  config?: HarnessProjectConfig
): Promise<OperationRecordV2> {
  const { record: terminal, transitioned } = await transitionOperationToTerminal(root, operationId, patch);
  if (config) await syncOperationPortfolio(root, config.project.name, terminal).catch(() => undefined);
  if (!transitioned) return terminal;
  const trace = deps.trace ?? recordPaseoTrace;
  try {
    if (deps.notifyCompletion) await deps.notifyCompletion(root, terminal);
    else await notifyOperationCompletion(root, terminal, { trace });
  } catch (error) {
    await trace(root, "operation.callback.failed", {
      operationId,
      operationStatus: terminal.status,
      error: error instanceof Error ? error.message : String(error),
      boundary: "controller"
    }).catch(() => undefined);
  }
  return loadOperation(root, operationId).catch(() => terminal);
}

async function ensureOperationWorkspace(
  root: string,
  record: OperationRecordV2,
  config: HarnessProjectConfig,
  run: typeof runProcess,
  trace: typeof recordPaseoTrace
): Promise<OperationWorkspace> {
  if (record.kind === "run") {
    const payload = record.payload as RunOperationPayload;
    const [existingRoot, existingId] = await Promise.all([
      deliveryWorkspacePath(root, config, payload.taskId),
      deliveryWorkspaceId(root, config, payload.taskId)
    ]);
    if (existingRoot) {
      await trace(root, "workspace.delivery.reused", {
        operationId: record.id,
        workspaceId: existingId ?? "",
        workspaceRoot: existingRoot
      });
      return { workspaceId: existingId, workspaceRoot: existingRoot, reusedDelivery: true };
    }
  }

  const title = `AEH ${record.kind.toUpperCase()} · ${record.id}`;
  if (record.kind === "audit") {
    const command = `paseo workspace create --isolation local --path ${quote(root)} --title ${quote(title)} --json`;
    await trace(root, "workspace.cli.required", { operationId: record.id, kind: record.kind, reason: "Paseo public SDK workspace create lacks isolation/title parity", isolation: "local" });
    const result = await safeRun(run, command, root, 60_000);
    if (result.exitCode !== 0) {
      const warning = `Paseo audit workspace could not be created: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`;
      await trace(root, "workspace.cli.error", { operationId: record.id, error: warning });
      // AUDIT is read-only, so a local workspace failure does not create a
      // write race; execution may continue at the repository root.
      return { workspaceRoot: root, warning };
    }
    return { workspaceId: extractWorkspaceId(result.stdout), workspaceRoot: root };
  }

  const slug = `aeh-${record.id.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 80)}`;
  const branch = `aeh/op-${record.id.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 96)}`;
  const base = config.validation?.baseRef ?? "HEAD";
  const command = [
    "paseo workspace create",
    "--isolation worktree",
    `--path ${quote(root)}`,
    "--mode branch-off",
    `--new-branch ${quote(branch)}`,
    `--base ${quote(base)}`,
    `--worktree-slug ${quote(slug)}`,
    `--title ${quote(title)}`,
    "--json"
  ].join(" ");
  await trace(root, "workspace.cli.required", { operationId: record.id, kind: record.kind, reason: "mutating operations require isolated worktree execution", isolation: "worktree", branch, base });
  const result = await safeRun(run, command, root, 180_000);
  if (result.exitCode !== 0) {
    throw new Error(`AEH_OPERATION_WORKTREE_REQUIRED: unable to create isolated worktree for ${record.id}: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
  }
  let workspaceId = extractWorkspaceId(result.stdout);
  let workspaceRoot = extractWorkspacePath(result.stdout);
  if (!workspaceId || !workspaceRoot) {
    const list = await safeRun(run, "paseo workspace ls --json", root, 60_000);
    if (list.exitCode === 0) {
      workspaceId ??= findWorkspaceByBranch(list.stdout, branch)?.workspaceId;
      workspaceRoot ??= findWorkspaceByBranch(list.stdout, branch)?.workspaceRoot;
    }
  }
  if (!workspaceRoot) {
    throw new Error(`AEH_OPERATION_WORKTREE_REQUIRED: Paseo created a worktree workspace for ${record.id} but did not expose a resolvable worktree path.`);
  }
  await trace(root, "workspace.cli.created", { operationId: record.id, workspaceId: workspaceId ?? "", workspaceRoot, isolation: "worktree", branch });
  return { workspaceId, workspaceRoot };
}

export function extractWorkspaceId(text: string): string | undefined {
  if (!text.trim()) return undefined;
  try { return findWorkspaceId(JSON.parse(text) as unknown); }
  catch { return text.match(/\b(?:workspace(?:Id)?[=: ]+)?(workspace-[A-Za-z0-9._-]+)\b/i)?.[1]; }
}

export function extractWorkspacePath(text: string): string | undefined {
  if (!text.trim()) return undefined;
  try { return findWorkspacePath(JSON.parse(text) as unknown); }
  catch { return undefined; }
}

function findWorkspaceId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) { const id = findWorkspaceId(item); if (id) return id; }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["workspaceId", "workspace_id", "id"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate && (key !== "id" || /workspace/i.test(candidate) || "cwd" in record || "worktreePath" in record || "path" in record)) return candidate;
  }
  for (const child of Object.values(record)) { const id = findWorkspaceId(child); if (id) return id; }
  return undefined;
}

function findWorkspacePath(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) { const found = findWorkspacePath(item); if (found) return found; }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["worktreePath", "worktree_path", "checkoutPath", "checkout_path"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && path.isAbsolute(candidate)) return candidate;
  }
  if (String(record.isolation ?? record.isolationMode ?? "").toLowerCase().includes("worktree")) {
    for (const key of ["path", "cwd"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && path.isAbsolute(candidate)) return candidate;
    }
  }
  for (const child of Object.values(record)) { const found = findWorkspacePath(child); if (found) return found; }
  return undefined;
}

function findWorkspaceByBranch(text: string, branch: string): { workspaceId?: string; workspaceRoot?: string } | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return findBranchWorkspace(value, branch);
  } catch { return undefined; }
}

function findBranchWorkspace(value: unknown, branch: string): { workspaceId?: string; workspaceRoot?: string } | undefined {
  if (Array.isArray(value)) {
    for (const item of value) { const found = findBranchWorkspace(item, branch); if (found) return found; }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const branchValue = [record.branch, record.branchName, record.branch_name, record.gitBranch].find((item) => typeof item === "string") as string | undefined;
  if (branchValue === branch) return { workspaceId: findWorkspaceId(record), workspaceRoot: findWorkspacePath(record) };
  for (const child of Object.values(record)) { const found = findBranchWorkspace(child, branch); if (found) return found; }
  return undefined;
}

async function safeRun(run: typeof runProcess, command: string, cwd: string, timeoutMs: number): Promise<ProcessResult> {
  try { return await run(command, { cwd, timeoutMs }); }
  catch (error) { return { exitCode: 1, stdout: "", stderr: String(error), durationMs: 0 }; }
}

async function loadProjectConfigIfPresent(root: string): Promise<HarnessProjectConfig | undefined> {
  try { await fs.access(path.resolve(root, ".harness/project.yaml")); }
  catch { return undefined; }
  return loadProjectConfig(root);
}

function initialIntent(kind: OperationKind, payload: OperationPayload): OperationRecordV2["intent"] {
  if (kind === "audit") {
    const audit = payload as AuditOperationPayload;
    return { request: audit.request, classification: "AUDIT", risk: audit.risk, priority: 50 };
  }
  if (kind === "change") {
    const change = payload as ChangeOperationPayload;
    return { request: change.request, classification: "CHANGE", risk: change.risk, priority: change.priority ?? 50 };
  }
  return { classification: "RUN", priority: (payload as RunOperationPayload).priority ?? 50 };
}

function operationPriority(payload: OperationPayload): number {
  const value = "priority" in payload ? payload.priority : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : 50;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
