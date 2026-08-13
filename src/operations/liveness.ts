import type { HarnessProjectConfig } from "../core/types.js";
import { dispatchManagedPaseoAgent, inspectManagedPaseoAgent } from "../paseo/runtime.js";
import { recordPaseoTrace } from "../paseo/trace.js";
import { loadOperationCompletionTarget, notifyOperationCompletion } from "./completion.js";
import { syncOperationPortfolio } from "./portfolio.js";
import { activeOperationSupervisor, isTerminalOperation, loadOperation, patchOperationMetadata, type OperationRecordV2 } from "./state.js";

export type OperationWakeReason = "progress" | "blocked" | "stalled" | "terminal";
export interface OperationLivenessPolicy {
  pollIntervalMs: number;
  progressWakeIntervalMs: number;
  stallThresholdMs: number;
  supervisorStallWakeLimit: number;
  retryDelaysMs: number[];
}
export interface OperationWakeDecision {
  reason?: OperationWakeReason;
  target: "none" | "lead" | "supervisor";
  revision: number;
  message: string;
}
interface LivenessConfigExtension {
  operations?: {
    liveness?: {
      pollIntervalMs?: number;
      progressWakeIntervalMs?: number;
      stallThresholdMs?: number;
      supervisorStallWakeLimit?: number;
      retryDelaysMs?: number[];
    };
  };
}
export interface OperationLivenessDeps {
  dispatch?: typeof dispatchManagedPaseoAgent;
  inspect?: typeof inspectManagedPaseoAgent;
  trace?: typeof recordPaseoTrace;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Number of supervisor watchdog wakes already accepted for this exact revision. */
  stallSupervisorWakeCount?: number;
}

export function operationLivenessPolicy(config: HarnessProjectConfig): OperationLivenessPolicy {
  const orchestration = config.orchestration as (HarnessProjectConfig["orchestration"] & LivenessConfigExtension) | undefined;
  const configured = orchestration?.operations?.liveness;
  return {
    pollIntervalMs: positive(configured?.pollIntervalMs, 15_000),
    progressWakeIntervalMs: positive(configured?.progressWakeIntervalMs, 45_000),
    stallThresholdMs: positive(configured?.stallThresholdMs, 120_000),
    supervisorStallWakeLimit: positive(configured?.supervisorStallWakeLimit, 2),
    retryDelaysMs: configured?.retryDelaysMs?.filter((value) => Number.isFinite(value) && value >= 0) ?? [0, 500, 1_500]
  };
}

export function operationRevisionAcknowledged(operation: OperationRecordV2): boolean {
  return Boolean(operation.lead && operation.lead.acknowledgedRevision >= operation.revision);
}

export function evaluateOperationWake(
  operation: OperationRecordV2,
  policy: OperationLivenessPolicy,
  nowMs = Date.now(),
  stallSupervisorWakeCount = 0
): OperationWakeDecision {
  const terminal = isTerminalOperation(operation.status);
  if (terminal) {
    if (!operation.lead?.agentId) return { target: "none", revision: operation.revision, message: "terminal operation has no bound lead" };
    if (operationRevisionAcknowledged(operation)) return { target: "none", revision: operation.revision, message: "terminal revision was acknowledged by the lead" };
    const lastWakeMs = operation.notification.lastLeadWakeAt ? Date.parse(operation.notification.lastLeadWakeAt) : 0;
    if (!operation.notification.terminalDelivered || nowMs - lastWakeMs >= policy.progressWakeIntervalMs) {
      return {
        reason: "terminal",
        target: "lead",
        revision: operation.revision,
        message: operation.notification.terminalDelivered
          ? "terminal wake was accepted previously but the bound lead has not acknowledged this revision"
          : "terminal operation has not been delivered to the lead"
      };
    }
    return { target: "none", revision: operation.revision, message: "terminal wake accepted; awaiting lead acknowledgement" };
  }

  const blocked = Object.values(operation.stages).some((stage) => stage.status === "BLOCKED") || operation.progress.blocked > 0;
  if (blocked && operation.revision > operation.notification.lastLeadWakeRevision) {
    return { reason: "blocked", target: "lead", revision: operation.revision, message: "operation is blocked and the lead has not seen this revision" };
  }

  // A stalled operation is a stronger liveness condition than ordinary unseen
  // progress. Route it to the operation-local supervisor first. If that
  // supervisor has already accepted bounded watchdog wakes for the same exact
  // revision without producing durable progress, escalate to the lead instead
  // of suppressing the stalled revision forever.
  const progressAt = Date.parse(operation.lastProgressAt);
  if (operation.status === "RUNNING" && Number.isFinite(progressAt) && nowMs - progressAt >= policy.stallThresholdMs) {
    const supervisor = activeOperationSupervisor(operation);
    const supervisorBudgetRemaining = Boolean(supervisor?.agentId) && stallSupervisorWakeCount < policy.supervisorStallWakeLimit;
    return {
      reason: "stalled",
      target: supervisorBudgetRemaining ? "supervisor" : "lead",
      revision: operation.revision,
      message: `operation has made no durable progress for ${Math.round((nowMs - progressAt) / 1000)}s${supervisor?.agentId ? `; supervisor watchdog wakes for this revision=${stallSupervisorWakeCount}/${policy.supervisorStallWakeLimit}` : ""}`
    };
  }

  const lastWakeMs = operation.notification.lastLeadWakeAt ? Date.parse(operation.notification.lastLeadWakeAt) : 0;
  const unseen = operation.revision > operation.notification.lastLeadWakeRevision;
  if (unseen && nowMs - lastWakeMs >= policy.progressWakeIntervalMs) {
    return { reason: "progress", target: "lead", revision: operation.revision, message: "operation has unseen durable progress" };
  }
  return { target: "none", revision: operation.revision, message: "no liveness action required" };
}

export async function runOperationLivenessCheck(root: string, config: HarnessProjectConfig, operationId: string, deps: OperationLivenessDeps = {}): Promise<OperationWakeDecision> {
  const operation = await loadOperation(root, operationId);
  await syncOperationPortfolio(root, config.project.name, operation).catch(() => undefined);
  const policy = operationLivenessPolicy(config);
  const now = (deps.now ?? Date.now)();
  const decision = evaluateOperationWake(operation, policy, now, deps.stallSupervisorWakeCount ?? 0);
  if (!decision.reason || decision.target === "none") return decision;
  const trace = deps.trace ?? recordPaseoTrace;

  if (decision.reason === "terminal" && !operation.notification.terminalDelivered) {
    await notifyOperationCompletion(root, operation, { dispatch: deps.dispatch, trace, retryDelaysMs: policy.retryDelaysMs, sleep: deps.sleep });
    const latest = await loadOperation(root, operationId);
    await syncOperationPortfolio(root, config.project.name, latest).catch(() => undefined);
    return decision;
  }

  if (decision.target === "supervisor") {
    const supervisor = activeOperationSupervisor(operation);
    if (supervisor?.agentId && !(await isBusy(root, supervisor.agentId, deps.inspect))) {
      const result = await retryDispatch(root, supervisor.agentId, supervisorWatchdogPrompt(operation, decision), policy.retryDelaysMs, deps);
      await trace(root, "operation.watchdog.supervisor", {
        operationId,
        revision: operation.revision,
        supervisorAgentId: supervisor.agentId,
        success: result.success,
        attempts: result.attempts,
        acceptedWakeCount: (deps.stallSupervisorWakeCount ?? 0) + (result.success ? 1 : 0),
        error: result.error ?? ""
      });
      if (result.success) return decision;
      // Dispatch failure is a transport/runtime failure, so fall through and
      // wake the lead immediately rather than consuming the semantic wake budget.
    }
  }

  const leadId = operation.lead?.agentId;
  if (!leadId) {
    await trace(root, "operation.watchdog.no-lead", { operationId, revision: operation.revision, reason: decision.reason });
    return decision;
  }
  if (await isBusy(root, leadId, deps.inspect)) {
    await trace(root, "operation.watchdog.lead-busy", { operationId, revision: operation.revision, leadAgentId: leadId, reason: decision.reason });
    return decision;
  }
  const result = await retryDispatch(root, leadId, leadWakePrompt(operation, decision), policy.retryDelaysMs, deps);
  const latest = await loadOperation(root, operationId);
  const updated = await patchOperationMetadata(root, operationId, {
    notification: {
      ...latest.notification,
      lastLeadWakeRevision: result.success ? operation.revision : latest.notification.lastLeadWakeRevision,
      lastLeadWakeAt: result.success ? new Date(now).toISOString() : latest.notification.lastLeadWakeAt,
      lastLeadWakeReason: result.success ? decision.reason : latest.notification.lastLeadWakeReason,
      terminalDelivered: latest.notification.terminalDelivered || (decision.reason === "terminal" && result.success),
      attempts: latest.notification.attempts + result.attempts,
      lastError: result.error
    }
  });
  await syncOperationPortfolio(root, config.project.name, updated).catch(() => undefined);
  await trace(root, "operation.watchdog.lead", {
    operationId,
    revision: operation.revision,
    leadAgentId: leadId,
    reason: decision.reason,
    success: result.success,
    attempts: result.attempts,
    acknowledged: operationRevisionAcknowledged(updated),
    error: result.error ?? ""
  });
  return decision;
}

/** Detached liveness owner. It outlives the operation controller and exits only
 * after terminal state has been acknowledged by the currently bound lead. */
export async function monitorOperationLiveness(root: string, config: HarnessProjectConfig, operationId: string, deps: OperationLivenessDeps = {}): Promise<void> {
  const policy = operationLivenessPolicy(config);
  const sleep = deps.sleep ?? delay;
  const trace = deps.trace ?? recordPaseoTrace;
  let stallRevision: number | undefined;
  let supervisorWakeCount = 0;
  let lastStallWakeAt = 0;
  await trace(root, "operation.watchdog.started", {
    operationId,
    pollIntervalMs: policy.pollIntervalMs,
    progressWakeIntervalMs: policy.progressWakeIntervalMs,
    stallThresholdMs: policy.stallThresholdMs,
    supervisorStallWakeLimit: policy.supervisorStallWakeLimit
  });

  for (;;) {
    const operation = await loadOperation(root, operationId);
    await syncOperationPortfolio(root, config.project.name, operation).catch(() => undefined);
    if (isTerminalOperation(operation.status)) {
      if (!operation.lead?.agentId) {
        await trace(root, "operation.watchdog.stopped", { operationId, reason: "terminal-without-lead" });
        return;
      }
      if (operationRevisionAcknowledged(operation)) {
        await trace(root, "operation.watchdog.stopped", { operationId, reason: "terminal-acknowledged", revision: operation.revision });
        return;
      }
      const target = await loadOperationCompletionTarget(root, operationId).catch(() => undefined);
      if (target?.status === "DISABLED") {
        await trace(root, "operation.watchdog.stopped", { operationId, reason: "completion-disabled" });
        return;
      }
    }

    if (stallRevision !== operation.revision) {
      stallRevision = undefined;
      supervisorWakeCount = 0;
      lastStallWakeAt = 0;
    }
    const now = (deps.now ?? Date.now)();
    const decision = evaluateOperationWake(operation, policy, now, supervisorWakeCount);
    if (decision.reason === "stalled" && stallRevision === operation.revision && now - lastStallWakeAt < policy.progressWakeIntervalMs) {
      await sleep(policy.pollIntervalMs);
      continue;
    }
    try {
      const executed = await runOperationLivenessCheck(root, config, operationId, {
        ...deps,
        stallSupervisorWakeCount: supervisorWakeCount
      });
      if (executed.reason === "stalled") {
        stallRevision = operation.revision;
        lastStallWakeAt = now;
        if (executed.target === "supervisor") supervisorWakeCount += 1;
      } else if (executed.reason) {
        stallRevision = undefined;
        supervisorWakeCount = 0;
        lastStallWakeAt = 0;
      }
    } catch (error) {
      await trace(root, "operation.watchdog.error", { operationId, error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
    }
    await sleep(policy.pollIntervalMs);
  }
}

export function startOperationWatchdog(root: string, config: HarnessProjectConfig, operationId: string, deps: OperationLivenessDeps = {}): () => void {
  const policy = operationLivenessPolicy(config);
  let stopped = false;
  let running = false;
  let stallRevision: number | undefined;
  let supervisorWakeCount = 0;
  let lastStallWakeAt = 0;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = true;
    void (async () => {
      const operation = await loadOperation(root, operationId);
      const now = (deps.now ?? Date.now)();
      if (stallRevision !== operation.revision) {
        stallRevision = undefined;
        supervisorWakeCount = 0;
        lastStallWakeAt = 0;
      }
      const decision = evaluateOperationWake(operation, policy, now, supervisorWakeCount);
      if (decision.reason === "stalled" && stallRevision === operation.revision && now - lastStallWakeAt < policy.progressWakeIntervalMs) return;
      const executed = await runOperationLivenessCheck(root, config, operationId, { ...deps, stallSupervisorWakeCount: supervisorWakeCount });
      if (executed.reason === "stalled") {
        stallRevision = operation.revision;
        lastStallWakeAt = now;
        if (executed.target === "supervisor") supervisorWakeCount += 1;
      } else if (executed.reason) {
        stallRevision = undefined;
        supervisorWakeCount = 0;
        lastStallWakeAt = 0;
      }
    })()
      .catch(async (error) => {
        await (deps.trace ?? recordPaseoTrace)(root, "operation.watchdog.error", { operationId, error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
      })
      .finally(() => { running = false; });
  }, policy.pollIntervalMs);
  timer.unref?.();
  return () => { stopped = true; clearInterval(timer); };
}

function leadWakePrompt(operation: OperationRecordV2, decision: OperationWakeDecision): string {
  if (decision.reason === "terminal") {
    return [
      "[AEH_OPERATION_COMPLETED_UNACKNOWLEDGED]",
      `Operation ${operation.id} (${operation.kind}) is terminal at revision ${operation.revision}: status=${operation.status}, phase=${operation.phase}.`,
      decision.message,
      "Do not start a duplicate operation. Read the existing OperationRecord and result/report artifact now. Use aeh_operation_status so AEH can acknowledge this exact revision, then complete the original pending user-facing request."
    ].join("\n");
  }
  const instruction = decision.reason === "blocked"
    ? "Inspect the durable block/exception and involve the user only if the state requires a product/external decision."
    : decision.reason === "stalled"
      ? "The operation-local supervisor did not restore durable progress within its bounded watchdog budget. Inspect the OperationRecord/supervisor generation and recover or escalate without starting a duplicate operation."
      : "If the operation is healthy and non-terminal, do not create user-facing status noise; acknowledge the durable revision internally and return idle.";
  return [
    `[AEH_OPERATION_${decision.reason?.toUpperCase()}]`,
    `Operation ${operation.id} (${operation.kind}) revision ${operation.revision}: status=${operation.status}, phase=${operation.phase}.`,
    `Progress: completed=${operation.progress.completed}, running=${operation.progress.running}, failed=${operation.progress.failed}, blocked=${operation.progress.blocked}.`,
    decision.message,
    "Do not start a duplicate operation. Read the existing OperationRecord/artifacts if more detail is required.",
    instruction
  ].join("\n");
}
function supervisorWatchdogPrompt(operation: OperationRecordV2, decision: OperationWakeDecision): string {
  return [
    "[AEH_OPERATION_WATCHDOG]",
    `Your operation ${operation.id} has stalled at revision ${operation.revision}, phase=${operation.phase}.`,
    decision.message,
    "Inspect only your existing children and durable OperationRecord/artifacts. Do not start another AEH operation. Produce a bounded diagnosis/follow-up that causes durable progress when possible. If no semantic action is required, say so explicitly; repeated no-progress watchdog wakes will escalate to the lead."
  ].join("\n");
}
async function retryDispatch(root: string, agentId: string, prompt: string, delays: number[], deps: OperationLivenessDeps): Promise<{ success: boolean; attempts: number; error?: string }> {
  const dispatch = deps.dispatch ?? dispatchManagedPaseoAgent;
  const sleep = deps.sleep ?? delay;
  let error: string | undefined;
  let attempts = 0;
  for (const wait of delays.length ? delays : [0]) {
    if (wait > 0) await sleep(wait);
    attempts += 1;
    try {
      const result = await dispatch(root, agentId, prompt, 60);
      if (result.exitCode === 0) return { success: true, attempts };
      error = result.stderr || result.stdout || `dispatch exited ${result.exitCode}`;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }
  return { success: false, attempts, error };
}
async function isBusy(root: string, agentId: string, inspect: OperationLivenessDeps["inspect"]): Promise<boolean> {
  const snapshot = await (inspect ?? inspectManagedPaseoAgent)(root, agentId).catch(() => undefined);
  const status = snapshot?.status?.toLowerCase();
  return status === "running" || status === "working" || status === "streaming" || status === "initializing";
}
function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
