import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { runAudit } from "../audit/run.js";
import { loadProjectConfig, loadTaskContract } from "../core/config.js";
import { runTask } from "../core/run.js";
import { listManagedPaseoAgents } from "../paseo/runtime.js";
import { recordPaseoTrace } from "../paseo/trace.js";
import { runProcess, type ProcessResult } from "../utils/process.js";
import {
  disableOperationCompletionTarget,
  notifyOperationCompletion,
  registerOperationCompletionTarget
} from "./completion.js";
import {
  loadOperation,
  patchOperation,
  saveOperation,
  transitionOperationToTerminal,
  type AuditOperationPayload,
  type OperationKind,
  type OperationPayload,
  type OperationRecord,
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
}

export async function startDetachedOperation(
  root: string,
  kind: OperationKind,
  payload: OperationPayload,
  options: StartOperationOptions
): Promise<OperationRecord> {
  const absoluteRoot = path.resolve(root);
  const now = new Date().toISOString();
  const id = createOperationId(kind, JSON.stringify(payload));
  const record: OperationRecord = {
    version: 1,
    id,
    kind,
    status: "QUEUED",
    phase: "queued",
    root: absoluteRoot,
    payload,
    createdAt: now,
    updatedAt: now
  };
  await saveOperation(absoluteRoot, record);

  const completionAgentId =
    options.completionAgentId?.trim() || process.env.PASEO_AGENT_ID?.trim() || undefined;
  if (completionAgentId) {
    await registerOperationCompletionTarget(
      absoluteRoot,
      id,
      completionAgentId,
      options.completionSource ?? (options.completionAgentId ? "explicit" : "environment")
    );
  }

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
    return patchOperation(absoluteRoot, id, {
      status: "FAILED",
      phase: "spawn-failed",
      error: String(error),
      finishedAt: new Date().toISOString()
    });
  }
  child.unref();
  return patchOperation(absoluteRoot, id, {
    pid: child.pid,
    phase: "dispatched"
  });
}

export async function executeOperation(
  root: string,
  operationId: string,
  deps: OperationControllerDeps = {}
): Promise<OperationRecord> {
  const absoluteRoot = path.resolve(root);
  const trace = deps.trace ?? recordPaseoTrace;
  let record = await loadOperation(absoluteRoot, operationId);
  if (record.status === "CANCELLED") return record;
  record = await patchOperation(absoluteRoot, operationId, {
    status: "RUNNING",
    phase: "preparing",
    startedAt: new Date().toISOString(),
    pid: process.pid,
    error: undefined
  });

  process.env.AEH_OPERATION_ID = record.id;
  process.env.AEH_OPERATION_KIND = record.kind;
  const workspace = await ensureOperationWorkspace(
    absoluteRoot,
    record,
    deps.run ?? runProcess,
    trace
  );
  if (workspace.workspaceId) {
    process.env.AEH_OPERATION_WORKSPACE_ID = workspace.workspaceId;
    record = await patchOperation(absoluteRoot, operationId, {
      workspaceId: workspace.workspaceId,
      workspaceWarning: undefined
    });
  } else if (workspace.warning) {
    record = await patchOperation(absoluteRoot, operationId, {
      workspaceWarning: workspace.warning
    });
  }

  try {
    const config = await loadProjectConfig(absoluteRoot);
    if (record.kind === "audit") {
      const payload = record.payload as AuditOperationPayload;
      const report = await runAudit(absoluteRoot, config, {
        ...payload,
        auditId: record.id
      });
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
        deps
      );
    }

    const payload = record.payload as RunOperationPayload;
    const contract = await loadTaskContract(absoluteRoot, payload.taskId, config);
    const result = await runTask(absoluteRoot, config, contract, {
      profile: payload.profile
    });
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
      deps
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
      deps
    );
  }
}

export async function waitForOperation(
  root: string,
  operationId: string,
  timeoutMs = 1_800_000,
  pollMs = 500
): Promise<OperationRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = await loadOperation(root, operationId);
    if (isTerminal(record.status)) return record;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for operation ${operationId} after ${timeoutMs}ms.`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export async function cancelOperation(
  root: string,
  operationId: string,
  deps: OperationControllerDeps = {}
): Promise<OperationRecord> {
  const absoluteRoot = path.resolve(root);
  const trace = deps.trace ?? recordPaseoTrace;
  const run = deps.run ?? runProcess;
  const record = await loadOperation(absoluteRoot, operationId);
  if (isTerminal(record.status)) return record;
  const cleanupWarnings: string[] = [];

  if (record.pid && record.pid !== process.pid) {
    try {
      process.kill(record.pid, "SIGTERM");
    } catch (error) {
      if (!/ESRCH/.test(String(error))) {
        cleanupWarnings.push(`controller: ${String(error)}`);
      }
    }
  }

  let agentIds = [...new Set((record.agents ?? []).map((agent) => agent.id).filter(Boolean))];
  if (agentIds.length > 0) {
    await trace(absoluteRoot, "cleanup.discovery", {
      operationId,
      source: "operation-state",
      agentCount: agentIds.length
    });
  } else {
    try {
      const discovered = await listManagedPaseoAgents(absoluteRoot, {
        "aeh.operation": operationId
      });
      agentIds = [...new Set(discovered.map((agent) => agent.id))];
      await trace(absoluteRoot, "cleanup.discovery", {
        operationId,
        source: "paseo-list-compatibility",
        agentCount: agentIds.length,
        reason: "legacy operation record has no registered agent identities"
      });
    } catch (error) {
      cleanupWarnings.push(`agent discovery: ${String(error)}`);
      await trace(absoluteRoot, "cleanup.cli.error", {
        operationId,
        error: String(error)
      });
    }
  }

  await trace(absoluteRoot, "cleanup.cli.required", {
    operationId,
    reason:
      "Paseo public SDK 0.3.1 lacks cancel/kill parity for external controller cleanup",
    agentCount: agentIds.length
  });
  for (const agentId of agentIds) {
    const stopped = await run(`paseo stop ${quote(agentId)}`, {
      cwd: absoluteRoot,
      timeoutMs: 30_000
    }).catch((error) => ({
      exitCode: 1,
      stdout: "",
      stderr: String(error),
      durationMs: 0
    }));
    await trace(absoluteRoot, "cleanup.cli.stop", {
      operationId,
      agentId,
      exitCode: stopped.exitCode
    });
    if (stopped.exitCode !== 0) {
      cleanupWarnings.push(
        `agent ${agentId}: ${stopped.stderr || stopped.stdout || `exit ${stopped.exitCode}`}`
      );
    }
  }

  return terminalizeOperation(
    absoluteRoot,
    operationId,
    {
      status: "CANCELLED",
      phase: "cancelled",
      finishedAt: new Date().toISOString(),
      cleanupWarnings: cleanupWarnings.length ? cleanupWarnings : undefined
    },
    deps
  );
}

export function createOperationId(kind: OperationKind, seed: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const hash = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 8);
  return `${kind.toUpperCase()}-${stamp}-${hash}`;
}

async function terminalizeOperation(
  root: string,
  operationId: string,
  patch: Partial<OperationRecord> & { status: "SUCCEEDED" | "FAILED" | "CANCELLED" },
  deps: OperationControllerDeps
): Promise<OperationRecord> {
  const { record: terminal, transitioned } = await transitionOperationToTerminal(
    root,
    operationId,
    patch
  );
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
  return terminal;
}

async function ensureOperationWorkspace(
  root: string,
  record: OperationRecord,
  run: typeof runProcess,
  trace: typeof recordPaseoTrace
): Promise<{ workspaceId?: string; warning?: string }> {
  const title = `AEH ${record.kind.toUpperCase()} · ${record.id}`;
  const command = `paseo workspace create --isolation local --path ${quote(root)} --title ${quote(title)} --json`;
  await trace(root, "workspace.cli.required", {
    operationId: record.id,
    kind: record.kind,
    reason: "Paseo SDK 0.3.1 workspace create lacks isolation/title parity",
    isolation: "local"
  });

  let result: ProcessResult;
  try {
    result = await run(command, { cwd: root, timeoutMs: 60_000 });
  } catch (error) {
    await trace(root, "workspace.cli.error", {
      operationId: record.id,
      error: String(error)
    });
    return {
      warning: `Paseo operation workspace could not be created: ${String(error)}`
    };
  }
  if (result.exitCode !== 0) {
    await trace(root, "workspace.cli.error", {
      operationId: record.id,
      exitCode: result.exitCode,
      error: result.stderr || result.stdout
    });
    return {
      warning: `Paseo operation workspace could not be created: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`
    };
  }
  const workspaceId = extractWorkspaceId(result.stdout);
  if (workspaceId) {
    await trace(root, "workspace.cli.created", {
      operationId: record.id,
      workspaceId,
      isolation: "local"
    });
    return { workspaceId };
  }
  await trace(root, "workspace.cli.error", {
    operationId: record.id,
    error: "workspace id missing from CLI response"
  });
  return {
    warning: "Paseo created an operation workspace but AEH could not resolve its id."
  };
}

export function extractWorkspaceId(text: string): string | undefined {
  if (!text.trim()) return undefined;
  try {
    return findWorkspaceId(JSON.parse(text) as unknown);
  } catch {
    return text.match(
      /\b(?:workspace(?:Id)?[=: ]+)?(workspace-[A-Za-z0-9._-]+)\b/i
    )?.[1];
  }
}

function findWorkspaceId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const id = findWorkspaceId(item);
      if (id) return id;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["workspaceId", "workspace_id", "id"]) {
    const candidate = record[key];
    if (
      typeof candidate === "string" &&
      candidate &&
      (key !== "id" ||
        /workspace/i.test(candidate) ||
        "cwd" in record ||
        "worktreePath" in record ||
        "path" in record)
    ) {
      return candidate;
    }
  }
  for (const child of Object.values(record)) {
    const id = findWorkspaceId(child);
    if (id) return id;
  }
  return undefined;
}

function isTerminal(status: OperationRecord["status"]): boolean {
  return status === "SUCCEEDED" || status === "FAILED" || status === "CANCELLED";
}
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
