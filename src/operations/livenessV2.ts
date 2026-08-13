import type { HarnessProjectConfig } from "../core/types.js";
import { dispatchManagedPaseoAgent, inspectManagedPaseoAgent } from "../paseo/runtime.js";
import { recordPaseoTrace } from "../paseo/trace.js";
import { loadOperationCompletionTarget, notifyOperationCompletion } from "./completion.js";
import { syncOperationPortfolio } from "./portfolio.js";
import { activeOperationSupervisor, isTerminalOperation, loadOperation, patchOperationMetadata, type OperationRecordV2 } from "./state.js";
import { loadOperationWakeBudget, recordOperationWakeAccepted } from "./wakeBudget.js";

export type OperationWakeReason = "progress" | "blocked" | "stalled" | "terminal";
export interface OperationLivenessPolicy {
  pollIntervalMs: number;
  progressWakeIntervalMs: number;
  stallThresholdMs: number;
  supervisorStallWakeLimit: number;
  leadWakeLimit: number;
  terminalLeadWakeLimit: number;
  retryDelaysMs: number[];
}
export interface OperationWakeDecision {
  reason?: OperationWakeReason;
  target: "none" | "lead" | "supervisor";
  revision: number;
  message: string;
}
export interface SupervisorWatchdogParticipantSnapshot {
  id: string;
  logicalAgent?: string;
  role?: string;
  phase?: string;
  durableStatus: string;
  runtimeStatus: string;
  resultArtifact?: string;
  error?: string;
}
export interface SupervisorWatchdogSnapshot {
  operationId: string;
  revision: number;
  phase: string;
  stallSeconds: number;
  progress: OperationRecordV2["progress"];
  activeRuntimeParticipants: number;
  participants: SupervisorWatchdogParticipantSnapshot[];
}
interface LivenessConfigExtension {
  operations?: {
    liveness?: {
      pollIntervalMs?: number;
      progressWakeIntervalMs?: number;
      stallThresholdMs?: number;
      supervisorStallWakeLimit?: number;
      leadWakeLimit?: number;
      terminalLeadWakeLimit?: number;
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
    leadWakeLimit: positive(configured?.leadWakeLimit, 1),
    terminalLeadWakeLimit: positive(configured?.terminalLeadWakeLimit, 2),
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
  stallSupervisorWakeCount = 0,
  leadWakeCount = 0,
  terminalLeadWakeCount = 0
): OperationWakeDecision {
  if (isTerminalOperation(operation.status)) {
    if (!operation.lead?.agentId) return { target: "none", revision: operation.revision, message: "terminal operation has no bound lead" };
    if (operationRevisionAcknowledged(operation)) return { target: "none", revision: operation.revision, message: "terminal revision was acknowledged by the lead" };
    if (operation.notification.terminalDelivered && terminalLeadWakeCount >= policy.terminalLeadWakeLimit) {
      return { target: "none", revision: operation.revision, message: `terminal lead wake budget exhausted for revision ${operation.revision}` };
    }
    const lastWakeMs = operation.notification.lastLeadWakeAt ? Date.parse(operation.notification.lastLeadWakeAt) : 0;
    if (!operation.notification.terminalDelivered || nowMs - lastWakeMs >= policy.progressWakeIntervalMs) {
      return {
        reason: "terminal",
        target: "lead",
        revision: operation.revision,
        message: operation.notification.terminalDelivered
          ? `terminal wake was accepted previously but the bound lead has not acknowledged this revision; retry ${terminalLeadWakeCount + 1}/${policy.terminalLeadWakeLimit}`
          : "terminal operation has not been delivered to the lead"
      };
    }
    return { target: "none", revision: operation.revision, message: "terminal wake accepted; awaiting lead acknowledgement" };
  }

  const blocked = Object.values(operation.stages).some((stage) => stage.status === "BLOCKED") || operation.progress.blocked > 0;
  if (blocked && operation.revision > operation.notification.lastLeadWakeRevision) {
    if (leadWakeCount >= policy.leadWakeLimit) return { target: "none", revision: operation.revision, message: "blocked revision lead wake budget exhausted" };
    return { reason: "blocked", target: "lead", revision: operation.revision, message: "operation is blocked and the lead has not seen this revision" };
  }

  const progressAt = Date.parse(operation.lastProgressAt);
  if (operation.status === "RUNNING" && Number.isFinite(progressAt) && nowMs - progressAt >= policy.stallThresholdMs) {
    const supervisor = activeOperationSupervisor(operation);
    if (supervisor?.agentId && stallSupervisorWakeCount < policy.supervisorStallWakeLimit) {
      return {
        reason: "stalled",
        target: "supervisor",
        revision: operation.revision,
        message: `operation has made no durable progress for ${Math.round((nowMs - progressAt) / 1000)}s; supervisor watchdog wakes for this revision=${stallSupervisorWakeCount}/${policy.supervisorStallWakeLimit}`
      };
    }
    if (leadWakeCount >= policy.leadWakeLimit) {
      return { target: "none", revision: operation.revision, message: `stalled revision wake budget exhausted: supervisor=${stallSupervisorWakeCount}/${policy.supervisorStallWakeLimit}, lead=${leadWakeCount}/${policy.leadWakeLimit}` };
    }
    return {
      reason: "stalled",
      target: "lead",
      revision: operation.revision,
      message: `operation has made no durable progress for ${Math.round((nowMs - progressAt) / 1000)}s${supervisor?.agentId ? `; supervisor watchdog wakes for this revision=${stallSupervisorWakeCount}/${policy.supervisorStallWakeLimit}` : ""}`
    };
  }

  if (operation.revision > operation.notification.lastLeadWakeRevision) {
    return { target: "none", revision: operation.revision, message: "healthy durable progress is controller-owned; lead wake suppressed" };
  }
  return { target: "none", revision: operation.revision, message: "no liveness action required" };
}

export async function buildSupervisorWatchdogSnapshot(
  root: string,
  operation: OperationRecordV2,
  nowMs = Date.now(),
  inspect: OperationLivenessDeps["inspect"] = inspectManagedPaseoAgent
): Promise<SupervisorWatchdogSnapshot> {
  const unresolved = Object.values(operation.participants).filter((participant) => !isParticipantTerminal(participant.status));
  const participants = await Promise.all(unresolved.map(async (participant) => {
    const runtime = await inspect(root, participant.id).catch(() => undefined);
    return {
      id: participant.id,
      logicalAgent: participant.logicalAgent,
      role: participant.role,
      phase: participant.phase,
      durableStatus: participant.status,
      runtimeStatus: runtime?.status?.toLowerCase() || "unknown",
      resultArtifact: participant.resultArtifact,
      error: participant.error
    } satisfies SupervisorWatchdogParticipantSnapshot;
  }));
  const progressAt = Date.parse(operation.lastProgressAt);
  return {
    operationId: operation.id,
    revision: operation.revision,
    phase: operation.phase,
    stallSeconds: Number.isFinite(progressAt) ? Math.max(0, Math.round((nowMs - progressAt) / 1000)) : 0,
    progress: { ...operation.progress },
    activeRuntimeParticipants: participants.filter((participant) => isRuntimeBusyStatus(participant.runtimeStatus)).length,
    participants
  };
}

export async function runOperationLivenessCheck(root: string, config: HarnessProjectConfig, operationId: string, deps: OperationLivenessDeps = {}): Promise<OperationWakeDecision> {
  const operation = await loadOperation(root, operationId);
  await syncOperationPortfolio(root, config.project.name, operation).catch(() => undefined);
  const policy = operationLivenessPolicy(config);
  const now = (deps.now ?? Date.now)();
  const budget = await loadOperationWakeBudget(root, operationId, operation.revision);
  const supervisorWakeCount = deps.stallSupervisorWakeCount ?? budget.supervisorAccepted;
  const decision = evaluateOperationWake(operation, policy, now, supervisorWakeCount, budget.leadAccepted, budget.terminalLeadAccepted);
  if (!decision.reason || decision.target === "none") return decision;
  const trace = deps.trace ?? recordPaseoTrace;

  if (decision.reason === "terminal" && !operation.notification.terminalDelivered) {
    const target = await loadOperationCompletionTarget(root, operationId).catch(() => undefined);
    if (target?.status === "FAILED" && (target.attempts ?? 0) >= policy.retryDelaysMs.length) {
      await trace(root, "operation.watchdog.completion-exhausted", { operationId, revision: operation.revision, attempts: target.attempts ?? 0 });
      return { target: "none", revision: operation.revision, message: "terminal completion delivery retry budget exhausted" };
    }
    await notifyOperationCompletion(root, operation, { dispatch: deps.dispatch, trace, retryDelaysMs: policy.retryDelaysMs, sleep: deps.sleep });
    const latest = await loadOperation(root, operationId);
    await syncOperationPortfolio(root, config.project.name, latest).catch(() => undefined);
    return decision;
  }

  if (decision.target === "supervisor") {
    const supervisor = activeOperationSupervisor(operation);
    const snapshot = await buildSupervisorWatchdogSnapshot(root, operation, now, deps.inspect ?? inspectManagedPaseoAgent);
    if (snapshot.activeRuntimeParticipants > 0) {
      await trace(root, "operation.watchdog.supervisor-suppressed-active-children", {
        operationId,
        revision: operation.revision,
        activeRuntimeParticipants: snapshot.activeRuntimeParticipants,
        unresolvedParticipants: snapshot.participants.length
      });
      return {
        target: "none",
        revision: operation.revision,
        message: `${snapshot.activeRuntimeParticipants} child runtime(s) are still active; deterministic watchdog will continue observing without an LLM wake`
      };
    }
    if (supervisor?.agentId && await isBusy(root, supervisor.agentId, deps.inspect)) {
      await trace(root, "operation.watchdog.supervisor-busy", { operationId, revision: operation.revision, supervisorAgentId: supervisor.agentId });
      return { target: "none", revision: operation.revision, message: "supervisor is already active; duplicate watchdog wake suppressed" };
    }
    if (supervisor?.agentId) {
      const result = await retryDispatch(root, supervisor.agentId, supervisorWatchdogPrompt(operation, decision, snapshot), policy.retryDelaysMs, deps);
      if (result.success) await recordOperationWakeAccepted(root, operationId, operation.revision, "supervisor", decision.reason);
      await trace(root, "operation.watchdog.supervisor", {
        operationId,
        revision: operation.revision,
        supervisorAgentId: supervisor.agentId,
        success: result.success,
        attempts: result.attempts,
        acceptedWakeCount: supervisorWakeCount + (result.success ? 1 : 0),
        unresolvedParticipants: snapshot.participants.length,
        error: result.error ?? ""
      });
      if (result.success) return decision;
    }
  }

  const latestBudget = await loadOperationWakeBudget(root, operationId, operation.revision);
  const leadLimit = decision.reason === "terminal" ? policy.terminalLeadWakeLimit : policy.leadWakeLimit;
  const acceptedLeadWakes = decision.reason === "terminal" ? latestBudget.terminalLeadAccepted : latestBudget.leadAccepted;
  if (acceptedLeadWakes >= leadLimit) {
    await trace(root, "operation.watchdog.lead-suppressed", { operationId, revision: operation.revision, reason: decision.reason, acceptedLeadWakes, leadLimit });
    return { target: "none", revision: operation.revision, message: `${decision.reason} lead wake budget exhausted` };
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
  if (result.success) await recordOperationWakeAccepted(root, operationId, operation.revision, "lead", decision.reason);
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

export async function monitorOperationLiveness(root: string, config: HarnessProjectConfig, operationId: string, deps: OperationLivenessDeps = {}): Promise<void> {
  const policy = operationLivenessPolicy(config);
  const sleep = deps.sleep ?? delay;
  const trace = deps.trace ?? recordPaseoTrace;
  let stallRevision: number | undefined;
  let lastStallWakeAt = 0;
  await trace(root, "operation.watchdog.started", {
    operationId,
    pollIntervalMs: policy.pollIntervalMs,
    progressWakeIntervalMs: policy.progressWakeIntervalMs,
    stallThresholdMs: policy.stallThresholdMs,
    supervisorStallWakeLimit: policy.supervisorStallWakeLimit,
    leadWakeLimit: policy.leadWakeLimit,
    terminalLeadWakeLimit: policy.terminalLeadWakeLimit
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
      if (target?.status === "FAILED" && (target.attempts ?? 0) >= policy.retryDelaysMs.length) {
        await trace(root, "operation.watchdog.stopped", { operationId, reason: "completion-retry-budget-exhausted", attempts: target.attempts ?? 0 });
        return;
      }
      const budget = await loadOperationWakeBudget(root, operationId, operation.revision);
      if (operation.notification.terminalDelivered && budget.terminalLeadAccepted >= policy.terminalLeadWakeLimit) {
        await trace(root, "operation.watchdog.stopped", { operationId, reason: "terminal-lead-wake-budget-exhausted", revision: operation.revision, accepted: budget.terminalLeadAccepted });
        return;
      }
    }

    const now = (deps.now ?? Date.now)();
    const budget = await loadOperationWakeBudget(root, operationId, operation.revision);
    const decision = evaluateOperationWake(operation, policy, now, budget.supervisorAccepted, budget.leadAccepted, budget.terminalLeadAccepted);
    if (decision.reason === "stalled" && stallRevision === operation.revision && now - lastStallWakeAt < policy.progressWakeIntervalMs) {
      await sleep(policy.pollIntervalMs);
      continue;
    }
    try {
      const executed = await runOperationLivenessCheck(root, config, operationId, deps);
      if (executed.reason === "stalled") {
        stallRevision = operation.revision;
        lastStallWakeAt = now;
      } else if (executed.reason) {
        stallRevision = undefined;
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
  let lastStallWakeAt = 0;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = true;
    void (async () => {
      const operation = await loadOperation(root, operationId);
      if (isTerminalOperation(operation.status) && operationRevisionAcknowledged(operation)) {
        stopped = true;
        clearInterval(timer);
        return;
      }
      const now = (deps.now ?? Date.now)();
      const budget = await loadOperationWakeBudget(root, operationId, operation.revision);
      if (isTerminalOperation(operation.status) && operation.notification.terminalDelivered && budget.terminalLeadAccepted >= policy.terminalLeadWakeLimit) {
        stopped = true;
        clearInterval(timer);
        return;
      }
      const decision = evaluateOperationWake(operation, policy, now, budget.supervisorAccepted, budget.leadAccepted, budget.terminalLeadAccepted);
      if (decision.reason === "stalled" && stallRevision === operation.revision && now - lastStallWakeAt < policy.progressWakeIntervalMs) return;
      const executed = await runOperationLivenessCheck(root, config, operationId, deps);
      if (executed.reason === "stalled") {
        stallRevision = operation.revision;
        lastStallWakeAt = now;
      } else if (executed.reason) {
        stallRevision = undefined;
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
      `Progress: completed=${operation.progress.completed}/${operation.progress.expected}, failed=${operation.progress.failed}, blocked=${operation.progress.blocked}.`,
      decision.message,
      "This is bounded internal recovery, not a new user task. Do not repeat a user-facing status if this exact terminal revision was already handled.",
      `Do not start a duplicate operation. Use aeh_operation_digest for compact state. Use aeh_operation_status with detail=full at most once if the terminal result requires it, then call aeh_operation_ack for exactly revision ${operation.revision}.`
    ].join("\n");
  }
  const instruction = decision.reason === "blocked"
    ? "Inspect the durable block/exception and involve the user only if the state requires a product/external decision."
    : "The operation-local supervisor did not restore durable progress within its bounded watchdog budget. Inspect compact state first and recover or escalate without starting a duplicate operation.";
  return [
    `[AEH_OPERATION_${decision.reason?.toUpperCase()}]`,
    `Operation ${operation.id} (${operation.kind}) revision ${operation.revision}: status=${operation.status}, phase=${operation.phase}.`,
    `Progress: completed=${operation.progress.completed}/${operation.progress.expected}, running=${operation.progress.running}, failed=${operation.progress.failed}, blocked=${operation.progress.blocked}.`,
    decision.message,
    "Do not start a duplicate operation. Use aeh_operation_digest first; request a full OperationRecord only if the compact state is insufficient.",
    instruction
  ].join("\n");
}
function supervisorWatchdogPrompt(operation: OperationRecordV2, decision: OperationWakeDecision, snapshot: SupervisorWatchdogSnapshot): string {
  return [
    "[AEH_OPERATION_WATCHDOG]",
    `Your operation ${operation.id} has stalled at revision ${operation.revision}, phase=${operation.phase}.`,
    decision.message,
    `Deterministic watchdog snapshot (authoritative for this wake): ${JSON.stringify(snapshot)}`,
    "Do not run shell commands, filesystem discovery, process inspection, Paseo CLI/daemon commands, or any other tools to rediscover operation state. The controller already performed runtime inspection.",
    "Reason only from this snapshot and your existing semantic context. Return a compact assessment: whether semantic intervention is required, which existing participant is implicated if any, and whether the controller should wait or escalate. Do not start another AEH operation or create new children from a watchdog wake."
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
  return isRuntimeBusyStatus(snapshot?.status?.toLowerCase());
}
function isRuntimeBusyStatus(status?: string): boolean {
  return status === "running" || status === "working" || status === "streaming" || status === "initializing";
}
function isParticipantTerminal(status: string): boolean {
  return status === "COMPLETED" || status === "FAILED" || status === "BLOCKED" || status === "CANCELLED";
}
function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
