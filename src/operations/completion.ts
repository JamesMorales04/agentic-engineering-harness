import fs from "node:fs/promises";
import path from "node:path";
import { dispatchManagedPaseoAgent } from "../paseo/runtime.js";
import { recordPaseoTrace } from "../paseo/trace.js";
import { loadOperation, patchOperation, type OperationRecord } from "./state.js";

export type OperationCompletionStatus = "PENDING" | "SENT" | "FAILED" | "DISABLED";

export interface OperationCompletionTarget {
  version: 1;
  operationId: string;
  agentId: string;
  source?: string;
  status: OperationCompletionStatus;
  registeredAt: string;
  attemptedAt?: string;
  attempts?: number;
  sentAt?: string;
  failedAt?: string;
  error?: string;
}

export interface OperationCompletionDeps {
  dispatch?: typeof dispatchManagedPaseoAgent;
  trace?: typeof recordPaseoTrace;
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_RETRY_DELAYS_MS = [0, 500, 1_500];
const COMPLETION_WARNING_PREFIX = "completion callback:";

export function operationCompletionFile(root: string, operationId: string): string {
  return path.resolve(root, ".harness/operations", `${safeId(operationId)}.completion.json`);
}

export async function registerOperationCompletionTarget(
  root: string,
  operationId: string,
  agentId: string,
  source?: string,
  trace: typeof recordPaseoTrace = recordPaseoTrace
): Promise<OperationCompletionTarget> {
  const target: OperationCompletionTarget = {
    version: 1,
    operationId,
    agentId: requiredId(agentId, "agent id"),
    source,
    status: "PENDING",
    registeredAt: new Date().toISOString()
  };
  await persist(root, target);
  await trace(root, "operation.callback.registered", {
    operationId,
    agentId: target.agentId,
    source: source ?? "unknown"
  });
  return target;
}

export async function disableOperationCompletionTarget(
  root: string,
  operationId: string,
  reason: string,
  trace: typeof recordPaseoTrace = recordPaseoTrace
): Promise<void> {
  const target = await loadOperationCompletionTarget(root, operationId);
  if (!target || target.status === "SENT") return;
  const disabled: OperationCompletionTarget = {
    ...target,
    status: "DISABLED",
    attemptedAt: new Date().toISOString(),
    error: reason
  };
  await persist(root, disabled);
  await trace(root, "operation.callback.disabled", {
    operationId,
    agentId: target.agentId,
    reason
  });
}

export async function loadOperationCompletionTarget(
  root: string,
  operationId: string
): Promise<OperationCompletionTarget | undefined> {
  try {
    const value = JSON.parse(
      await fs.readFile(operationCompletionFile(root, operationId), "utf8")
    ) as OperationCompletionTarget;
    if (
      value.version !== 1 ||
      value.operationId !== operationId ||
      !value.agentId ||
      !["PENDING", "SENT", "FAILED", "DISABLED"].includes(value.status)
    ) {
      throw new Error("invalid completion target record");
    }
    return value;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export async function notifyOperationCompletion(
  root: string,
  operation: OperationRecord,
  deps: OperationCompletionDeps = {}
): Promise<OperationCompletionTarget | undefined> {
  let target = await loadOperationCompletionTarget(root, operation.id);
  if (!target || target.status === "SENT" || target.status === "DISABLED") return target;

  const dispatch = deps.dispatch ?? dispatchManagedPaseoAgent;
  const trace = deps.trace ?? recordPaseoTrace;
  const retryDelaysMs = normalizeRetryDelays(deps.retryDelaysMs);
  const sleep = deps.sleep ?? delay;

  for (let index = 0; index < retryDelaysMs.length; index += 1) {
    const retryDelayMs = retryDelaysMs[index];
    if (retryDelayMs > 0) await sleep(retryDelayMs);

    const attemptedAt = new Date().toISOString();
    const attempts = (target.attempts ?? 0) + 1;
    await trace(root, "operation.callback.attempt", {
      operationId: operation.id,
      operationStatus: operation.status,
      agentId: target.agentId,
      attempt: attempts,
      invocationAttempt: index + 1,
      maxInvocationAttempts: retryDelaysMs.length,
      retryDelayMs
    });

    try {
      const result = await dispatch(root, target.agentId, completionPrompt(operation), 60);
      if (result.exitCode !== 0) {
        throw new Error(
          result.stderr || result.stdout || `Paseo dispatch exited with code ${result.exitCode}`
        );
      }
      const sent: OperationCompletionTarget = {
        ...target,
        status: "SENT",
        attemptedAt,
        attempts,
        sentAt: new Date().toISOString(),
        failedAt: undefined,
        error: undefined
      };
      await persist(root, sent);
      await clearCompletionWarning(root, operation.id);
      await trace(root, "operation.callback.sent", {
        operationId: operation.id,
        operationStatus: operation.status,
        agentId: target.agentId,
        transport: result.transport,
        attempts,
        resultPath: resultPath(operation) ?? ""
      });
      return sent;
    } catch (error) {
      const failed: OperationCompletionTarget = {
        ...target,
        status: "FAILED",
        attemptedAt,
        attempts,
        failedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      };
      await persist(root, failed);
      target = failed;
      await trace(root, "operation.callback.failed", {
        operationId: operation.id,
        operationStatus: operation.status,
        agentId: target.agentId,
        attempt: attempts,
        invocationAttempt: index + 1,
        maxInvocationAttempts: retryDelaysMs.length,
        willRetry: index + 1 < retryDelaysMs.length,
        error: failed.error ?? "unknown"
      });
    }
  }

  await surfaceCompletionFailure(root, operation.id, target);
  return target;
}

export function completionPrompt(operation: OperationRecord): string {
  const artifact = resultPath(operation);
  const result = operation.result ? JSON.stringify(operation.result) : "{}";
  return [
    "[AEH_OPERATION_COMPLETED]",
    `Detached AEH operation ${operation.id} (${operation.kind}) reached terminal state ${operation.status}.`,
    "This is an internal AEH controller completion callback for the user request that launched this operation; it is not a new user task.",
    "Do not start a duplicate AUDIT/RUN and do not restart the completed operation.",
    `Use aeh_operation_status for ${operation.id} only if you need to refresh durable metadata.${artifact ? ` Read the authoritative artifact ${artifact}.` : ""}`,
    "Continue and finish the original pending user-facing request now, using the durable operation result and artifacts as the source of truth.",
    operation.error ? `Operation error: ${operation.error.split("\n", 1)[0]}` : `Operation result: ${result}`
  ].join("\n");
}

function resultPath(operation: OperationRecord): string | undefined {
  const report = operation.result?.report;
  return typeof report === "string" && report.trim() ? report.trim() : undefined;
}

async function surfaceCompletionFailure(
  root: string,
  operationId: string,
  target: OperationCompletionTarget
): Promise<void> {
  try {
    const operation = await loadOperation(root, operationId);
    const warning = `${COMPLETION_WARNING_PREFIX} failed to reactivate ${target.agentId} after ${target.attempts ?? 0} attempt(s): ${target.error ?? "unknown error"}`;
    const existing = (operation.cleanupWarnings ?? []).filter(
      (item) => !item.startsWith(COMPLETION_WARNING_PREFIX)
    );
    await patchOperation(root, operationId, {
      cleanupWarnings: [...existing, warning]
    });
  } catch {
    // The dedicated completion record remains authoritative even when the
    // operation record cannot be annotated (for example in isolated unit tests).
  }
}

async function clearCompletionWarning(root: string, operationId: string): Promise<void> {
  try {
    const operation = await loadOperation(root, operationId);
    const warnings = (operation.cleanupWarnings ?? []).filter(
      (item) => !item.startsWith(COMPLETION_WARNING_PREFIX)
    );
    if (warnings.length === (operation.cleanupWarnings ?? []).length) return;
    await patchOperation(root, operationId, {
      cleanupWarnings: warnings.length ? warnings : undefined
    });
  } catch {
    // Callback success is already durable in the completion target. Warning
    // cleanup is secondary observability metadata.
  }
}

async function persist(root: string, target: OperationCompletionTarget): Promise<void> {
  const file = operationCompletionFile(root, target.operationId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(target, null, 2)}\n`);
  try {
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

function normalizeRetryDelays(value?: number[]): number[] {
  const candidate = value?.length ? value : DEFAULT_RETRY_DELAYS_MS;
  const normalized = candidate.filter(
    (item) => Number.isFinite(item) && item >= 0
  );
  return normalized.length ? normalized : [0];
}

function requiredId(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} is required.`);
  return trimmed;
}

function safeId(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`Invalid operation id '${value}'.`);
  return value;
}

function isMissing(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
