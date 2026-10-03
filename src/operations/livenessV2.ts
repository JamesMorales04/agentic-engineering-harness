import type { HarnessProjectConfig } from "../core/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dispatchManagedPaseoAgent, inspectManagedPaseoAgent } from "../paseo/runtime.js";
import { recordPaseoTrace } from "../paseo/trace.js";
import { loadOperationCompletionTarget, notifyOperationCompletion } from "./completion.js";
import { syncOperationPortfolio } from "./portfolio.js";
import { activeOperationSupervisor, currentControllerEpoch, isTerminalOperation, loadOperation, operationArtifactDir, updateOperationMetadata, type OperationRecordV2 } from "./state.js";
import { loadOperationWakeBudget, recordOperationWakeAccepted } from "./wakeBudget.js";
import { hardDeadlineFor, participantLivenessSnapshotV1, readExecutionActivityEventsV1, setParticipantExecutionStateV1, type ExecutionActivityEventV1 } from "./executionLiveness.js";
import { analyzeOperationExecutionV1, operationsAnalystAdvisoryDigestV1, type OperationsAnalystAdvisoryV1 } from "./operationsAnalyst.js";
import { createSemanticAssessmentRuntimeV1, createSemanticRepositoryBindingV1 } from "../semantic/runtime.js";
import { sha256Canonical, sha256Utf8 } from "../core/digest.js";
import { loadOperationCapabilityRegistryV1 } from "../capabilities/registry.js";
import { projectOperationalSkillsV1, type ProjectedOperationalSkillV1 } from "../capabilities/operationalSkills.js";
import { readOperationEfficiencyObservations } from "../telemetry/efficiency.js";

export type OperationWakeReason = "progress" | "blocked" | "stalled" | "economic" | "owner-boundary" | "terminal" | "hard-deadline";
export interface OperationLivenessPolicy {
  hardDeadlineMs: number;
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
  target: "none" | "lead" | "supervisor" | "controller";
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
  executionBindingDigest?: string;
  resultArtifact?: string;
  errorDigest?: string;
  activityEvidence: Array<{ eventId: string; kind: string; level: string; observedAt: string; evidenceDigest: string; toolName?: string; toolCallId?: string }>;
  executionState: string;
  lastActivityAt?: string;
  lastMeaningfulProgressAt?: string;
  timeSinceLastMeaningfulProgressMs?: number;
  progressLeaseExpiresAt?: string;
  waitingToolName?: string;
  waitingKind?: "TOOL" | "PROVIDER";
  waitingDeadlineAt?: string;
  firstToolCallAt?: string;
  firstMutationAt?: string;
  toolCallsBeforeFirstMutation: number;
  turnsBeforeFirstMutation: number | null;
  providerTurns: number;
  repositoryMutationCount: number;
}
export interface SupervisorWatchdogSnapshot {
  operationId: string;
  revision: number;
  phase: string;
  stallSeconds: number;
  progress: OperationRecordV2["progress"];
  activeRuntimeParticipants: number;
  participants: SupervisorWatchdogParticipantSnapshot[];
  recoverySkills: ProjectedOperationalSkillV1[];
  recentToolCalls: Array<{ participantId: string; role: string; phase: string; toolName: string; outcome: string; attemptIndex: number | null; causalStatus: string; durationMs: number | null; finishedAt: string | null }>;
  commandDiagnostics: Array<{ reference: string; command: string; cwd: string; exitCode: number; tool: string; toolVersion: string | null; startedAt: string; finishedAt: string; durationMs: number; stdoutTail: string; stderrTail: string }>;
}
interface LivenessConfigExtension {
  operations?: {
    liveness?: {
      pollIntervalMs?: number;
      progressWakeIntervalMs?: number;
      stallThresholdMs?: number;
      stallWindowMs?: number;
      supervisorStallWakeLimit?: number;
      leadWakeLimit?: number;
      terminalLeadWakeLimit?: number;
      retryDelaysMs?: number[];
      hardDeadlineMs?: number;
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
  analyzeOperations?: (input: { root: string; config: HarnessProjectConfig; operation: OperationRecordV2; snapshot: SupervisorWatchdogSnapshot }) => Promise<OperationsAnalystAdvisoryV1>;
}

export function operationLivenessPolicy(config: HarnessProjectConfig, operation?: OperationRecordV2): OperationLivenessPolicy {
  const orchestration = config.orchestration as (HarnessProjectConfig["orchestration"] & LivenessConfigExtension) | undefined;
  const configured = orchestration?.operations?.liveness;
  const frozen = operation?.resolvedOperationPolicy?.executionLiveness;
  return {
    hardDeadlineMs: positive(frozen?.hardDeadlineMs ?? configured?.hardDeadlineMs, 8 * 60 * 60_000),
    pollIntervalMs: positive(configured?.pollIntervalMs, 15_000),
    progressWakeIntervalMs: positive(configured?.progressWakeIntervalMs, 45_000),
    stallThresholdMs: positive(frozen?.stallWindowMs ?? configured?.stallWindowMs ?? configured?.stallThresholdMs, 15 * 60_000),
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
  if (!isTerminalOperation(operation.status)) {
    const operationDeadline = hardDeadlineFor(operation, policy.hardDeadlineMs);
    if (Number.isFinite(operationDeadline) && nowMs >= operationDeadline) {
      return { reason: "hard-deadline", target: "controller", revision: operation.revision, message: `owner-delegated hard execution deadline elapsed at ${new Date(operationDeadline).toISOString()}` };
    }
  }
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

  if (operation.ownerEconomicBoundary) {
    if (operation.revision > operation.notification.lastLeadWakeRevision) return {
      reason: "owner-boundary", target: "lead", revision: operation.revision,
      message: `A configured Owner economic boundary stopped participant ${operation.ownerEconomicBoundary.participantId}: ${operation.ownerEconomicBoundary.reason}`
    };
    return { target: "none", revision: operation.revision, message: "waiting for the Owner to decide whether a new authorized operation may continue this work" };
  }
  if (operation.phase === "HUMAN_REQUIRED") return { target: "none", revision: operation.revision, message: "operation is suspended on an existing human decision request" };

  const blocked = Object.values(operation.stages).some((stage) => stage.status === "BLOCKED") || operation.progress.blocked > 0;
  if (blocked && operation.revision > operation.notification.lastLeadWakeRevision) {
    if (leadWakeCount >= policy.leadWakeLimit) return { target: "none", revision: operation.revision, message: "blocked revision lead wake budget exhausted" };
    return { reason: "blocked", target: "lead", revision: operation.revision, message: "operation is blocked and the lead has not seen this revision" };
  }

  const progressAt = Date.parse(operation.lastProgressAt);
  const stalledParticipants = Object.values(operation.participants).filter((participant) => {
    if (participant.status !== "RUNNING") return false;
    const liveness = participant.executionLiveness;
    if (!liveness) return Number.isFinite(progressAt) && nowMs - progressAt >= policy.stallThresholdMs;
    if (liveness.state === "WAITING_TOOL" && liveness.waitingDeadlineAt) return Date.parse(liveness.waitingDeadlineAt) <= nowMs;
    // Paseo SDK providers do not guarantee interim heartbeats while reasoning.
    // Provider silence alone is not evidence of a hung provider; the turn's
    // frozen wall-clock deadline and the independent meaningful-progress lease
    // provide bounded detection without preempting a legitimate provider turn.
    const baseline = Date.parse(liveness.lastMeaningfulProgressAt ?? liveness.startedAt ?? participant.startedAt ?? participant.registeredAt);
    return liveness.state === "STALL_SUSPECTED" || Boolean(liveness.progressLease && Date.parse(liveness.progressLease.expiresAt) <= nowMs)
      || Number.isFinite(baseline) && nowMs - baseline >= policy.stallThresholdMs;
  });
  if (operation.status === "RUNNING" && (stalledParticipants.length > 0 || Number.isFinite(progressAt) && nowMs - progressAt >= policy.stallThresholdMs && !Object.values(operation.participants).some((participant) => participant.executionLiveness?.lastMeaningfulProgressAt && nowMs - Date.parse(participant.executionLiveness.lastMeaningfulProgressAt) < policy.stallThresholdMs))) {
    const supervisor = activeOperationSupervisor(operation);
    if (supervisor?.agentId && stallSupervisorWakeCount < policy.supervisorStallWakeLimit) {
      return {
        reason: "stalled",
        target: "supervisor",
        revision: operation.revision,
        message: `participant liveness window expired for ${stalledParticipants.map((participant) => participant.id).join(", ") || "operation"}; supervisor watchdog wake=${stallSupervisorWakeCount}/${policy.supervisorStallWakeLimit}`
      };
    }
    if (leadWakeCount >= policy.leadWakeLimit) {
      return { target: "none", revision: operation.revision, message: `stalled revision wake budget exhausted: supervisor=${stallSupervisorWakeCount}/${policy.supervisorStallWakeLimit}, lead=${leadWakeCount}/${policy.leadWakeLimit}` };
    }
    return {
      reason: "stalled",
      target: "lead",
      revision: operation.revision,
      message: `participant liveness window expired for ${stalledParticipants.map((participant) => participant.id).join(", ") || "operation"}${supervisor?.agentId ? `; supervisor watchdog wakes=${stallSupervisorWakeCount}/${policy.supervisorStallWakeLimit}` : ""}`
    };
  }

  const softThreshold = operation.resolvedOperationPolicy?.economicEnvelope.softThreshold ?? 0.8;
  const budgetPressure = operation.status === "RUNNING" ? Object.values(operation.participants).find((participant) => {
    const liveness = participant.executionLiveness;
    if (participant.status !== "RUNNING" || !liveness || liveness.currentProviderTurnBudget < 1) return false;
    const thresholdTurns = Math.max(1, Math.ceil(liveness.currentProviderTurnBudget * softThreshold));
    return liveness.providerTurns >= thresholdTurns && (liveness.lastRecoveryDecision?.observedProviderTurns ?? -1) < liveness.providerTurns;
  }) : undefined;
  if (budgetPressure) {
    const supervisor = activeOperationSupervisor(operation);
    if (supervisor?.agentId && stallSupervisorWakeCount < policy.supervisorStallWakeLimit) {
      return { reason: "economic", target: "supervisor", revision: operation.revision, message: `participant ${budgetPressure.id} entered the frozen soft provider-turn budget threshold (${budgetPressure.executionLiveness!.providerTurns}/${budgetPressure.executionLiveness!.currentProviderTurnBudget}); analyze and renew only within delegated authority.` };
    }
    if (leadWakeCount < policy.leadWakeLimit) return { reason: "economic", target: "lead", revision: operation.revision, message: `Supervisor authority is unavailable or exhausted at the soft provider-turn threshold for ${budgetPressure.id}; Lead may extend only within Owner-delegated policy.` };
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
  const activity = await readExecutionActivityEventsV1(root, operation.id).catch(() => []);
  const participants = await Promise.all(unresolved.map(async (participant) => {
    const runtime = await inspect(root, participant.id).catch(() => undefined);
    const binding = participant.executionBinding;
    return {
      id: participant.id,
      logicalAgent: participant.logicalAgent,
      role: participant.role,
      phase: participant.phase,
      durableStatus: participant.status,
      runtimeStatus: runtime?.status?.toLowerCase() || "unknown",
      ...(binding ? { executionBindingDigest: binding.digest } : {}),
      resultArtifact: participant.resultArtifact,
      ...(participant.error ? { errorDigest: sha256Utf8(participant.error) } : {}),
      activityEvidence: activity.filter((item) => item.participantId === participant.id && item.participantGeneration === binding?.participantGeneration)
        .slice(-12).map((item) => ({ eventId: item.eventId, kind: item.kind, level: item.level, observedAt: item.observedAt, evidenceDigest: item.evidenceDigest, ...(item.toolName ? { toolName: item.toolName } : {}), ...(item.toolCallId ? { toolCallId: item.toolCallId } : {}) })),
      executionState: participantLivenessSnapshotV1(participant, nowMs),
      ...(participant.executionLiveness?.lastActivityAt ? { lastActivityAt: participant.executionLiveness.lastActivityAt } : {}),
      ...(participant.executionLiveness?.lastMeaningfulProgressAt ? { lastMeaningfulProgressAt: participant.executionLiveness.lastMeaningfulProgressAt } : {}),
      ...(participant.executionLiveness?.lastMeaningfulProgressAt ? { timeSinceLastMeaningfulProgressMs: Math.max(0, nowMs - Date.parse(participant.executionLiveness.lastMeaningfulProgressAt)) } : {}),
      ...(participant.executionLiveness?.progressLease?.expiresAt ? { progressLeaseExpiresAt: participant.executionLiveness.progressLease.expiresAt } : {}),
      ...(participant.executionLiveness?.waitingToolName ? { waitingToolName: participant.executionLiveness.waitingToolName } : {}),
      ...(participant.executionLiveness?.waitingKind ? { waitingKind: participant.executionLiveness.waitingKind } : {}),
      ...(participant.executionLiveness?.waitingDeadlineAt ? { waitingDeadlineAt: participant.executionLiveness.waitingDeadlineAt } : {}),
      ...(participant.executionLiveness?.firstToolCallAt ? { firstToolCallAt: participant.executionLiveness.firstToolCallAt } : {}),
      ...(participant.executionLiveness?.firstMutationAt ? { firstMutationAt: participant.executionLiveness.firstMutationAt } : {}),
      toolCallsBeforeFirstMutation: participant.executionLiveness?.toolCallsBeforeFirstMutation ?? 0,
      turnsBeforeFirstMutation: participant.executionLiveness?.turnsBeforeFirstMutation ?? null,
      providerTurns: participant.executionLiveness?.providerTurns ?? 0,
      repositoryMutationCount: participant.executionLiveness?.repositoryMutationCount ?? 0
    } satisfies SupervisorWatchdogParticipantSnapshot;
  }));
  const efficiency = await readOperationEfficiencyObservations(root, operation.id).catch(() => undefined);
  const recentToolCalls = (efficiency?.tools ?? []).slice(-16).map((item) => ({ participantId: item.participantId, role: item.role, phase: item.phase, toolName: item.toolName, outcome: item.outcome, attemptIndex: item.attemptIndex, causalStatus: item.causalStatus, durationMs: item.durationMs, finishedAt: item.finishedAt }));
  const commandDiagnostics = await readRecentCommandDiagnostics(root, operation.id);
  const progressAt = Date.parse(operation.lastProgressAt);
  const recoverySkills = await projectWatchdogRecoverySkills(root, operation, participants, nowMs);
  return {
    operationId: operation.id,
    revision: operation.revision,
    phase: operation.phase,
    stallSeconds: Number.isFinite(progressAt) ? Math.max(0, Math.round((nowMs - progressAt) / 1000)) : 0,
    progress: { ...operation.progress },
    activeRuntimeParticipants: participants.filter((participant) => isRuntimeBusyStatus(participant.runtimeStatus)).length,
    participants,
    recoverySkills,
    recentToolCalls,
    commandDiagnostics
  };
}

export async function runOperationLivenessCheck(root: string, config: HarnessProjectConfig, operationId: string, deps: OperationLivenessDeps = {}): Promise<OperationWakeDecision> {
  const operation = await loadOperation(root, operationId);
  await syncOperationPortfolio(root, config.project.name, operation).catch(() => undefined);
  const controllerRecovery = !isTerminalOperation(operation.status)
    ? Object.values(operation.participants).flatMap((participant) => {
      const decision = participant.executionLiveness?.lastRecoveryDecision;
      const binding = participant.executionBinding;
      const requestPending = decision !== undefined
        && (decision.actorRole === "LEAD" ? decision.application === "REQUESTED" : decision.application === "ESCALATE_TO_LEAD");
      return requestPending
        && ["ROTATE_SESSION", "REPLAN", "SPLIT_WORK", "REASSIGN"].includes(decision.action)
        && binding?.digest === decision.executionBindingDigest
        && operation.candidateRevision?.identityDigest === decision.candidateDigest
        && operation.resolvedOperationPolicy?.digest === decision.policyDigest
        && currentControllerEpoch(operation) === decision.controllerEpoch
        ? [decision]
        : [];
    })[0]
    : undefined;
  const policy = operationLivenessPolicy(config, operation);
  const now = (deps.now ?? Date.now)();
  const budget = await loadOperationWakeBudget(root, operationId, operation.revision);
  const supervisorWakeCount = deps.stallSupervisorWakeCount ?? budget.supervisorAccepted;
  const decision = evaluateOperationWake(operation, policy, now, supervisorWakeCount, budget.leadAccepted, budget.terminalLeadAccepted);
  const trace = deps.trace ?? recordPaseoTrace;

  if (decision.reason === "hard-deadline") {
    const { expireOperationAtHardDeadline } = await import("./controller.js");
    await expireOperationAtHardDeadline(root, operationId, new Date(now), config, { trace });
    await trace(root, "operation.watchdog.hard-deadline", { operationId, revision: operation.revision, deadlineMs: policy.hardDeadlineMs });
    return decision;
  }

  if (controllerRecovery) {
    const { terminalizeOperation } = await import("./controller.js");
    const terminal = await terminalizeOperation(root, operationId, {
      status: "FAILED",
      phase: "failed",
      error: `${controllerRecovery.actorRole} requested ${controllerRecovery.action} for participant ${controllerRecovery.participantId}: ${controllerRecovery.reason}. The controller ended and cleaned this execution so the bound Lead can choose an explicit linked recovery operation under inherited Owner policy.`,
      finishedAt: new Date(now).toISOString(),
      result: { recoveryRequest: { actorRole: controllerRecovery.actorRole, action: controllerRecovery.action, participantId: controllerRecovery.participantId, decisionDigest: controllerRecovery.digest, application: "LEAD_LINKED_OPERATION_REQUIRED" } }
    }, { trace: deps.trace }, config);
    await (deps.trace ?? recordPaseoTrace)(root, "operation.recovery.controller-boundary", { operationId, actorRole: controllerRecovery.actorRole, participantId: controllerRecovery.participantId, action: controllerRecovery.action, decisionDigest: controllerRecovery.digest }).catch(() => undefined);
    return { reason: "terminal", target: "none", revision: terminal.revision, message: `Supervisor ${controllerRecovery.action} request was applied as a durable failed-parent boundary; Lead may now choose an explicit linked recovery.` };
  }

  if (!decision.reason || decision.target === "none") return decision;

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

  let analystAdvisory: OperationsAnalystAdvisoryV1 | undefined;
  if (decision.target === "supervisor") {
    const supervisor = activeOperationSupervisor(operation);
    for (const participant of Object.values(operation.participants)) {
      if (participant.status === "RUNNING" && participantLivenessSnapshotV1(participant, now) === "STALL_SUSPECTED") {
        await setParticipantExecutionStateV1(root, operationId, participant.id, "STALL_SUSPECTED", new Date(now)).catch(() => undefined);
      }
    }
    const snapshot = await buildSupervisorWatchdogSnapshot(root, operation, now, deps.inspect ?? inspectManagedPaseoAgent);
    if (supervisor?.agentId && await isBusy(root, supervisor.agentId, deps.inspect)) {
      const latestBudget = await recordOperationWakeAccepted(root, operationId, operation.revision, "supervisor", decision.reason);
      const message = `Supervisor session remains busy; bounded recovery opportunity ${latestBudget.supervisorAccepted}/${policy.supervisorStallWakeLimit} recorded before Lead fallback.`;
      await trace(root, "operation.watchdog.supervisor-busy", { operationId, revision: operation.revision, supervisorAgentId: supervisor.agentId, acceptedWakeCount: latestBudget.supervisorAccepted });
      return { ...decision, message };
    }
    if (supervisor?.agentId) {
      analystAdvisory = await requestOperationsAnalyst(root, config, operation, snapshot, deps, trace);
      const result = await retryDispatch(root, supervisor.agentId, supervisorWatchdogPrompt(operation, decision, snapshot, analystAdvisory), policy.retryDelaysMs, deps);
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
  if (!analystAdvisory && (decision.reason === "stalled" || decision.reason === "economic")) {
    const snapshot = await buildSupervisorWatchdogSnapshot(root, operation, now, deps.inspect ?? inspectManagedPaseoAgent);
    analystAdvisory = await requestOperationsAnalyst(root, config, operation, snapshot, deps, trace);
  }
  const result = await retryDispatch(root, leadId, leadWakePrompt(operation, decision, analystAdvisory), policy.retryDelaysMs, deps);
  if (result.success) await recordOperationWakeAccepted(root, operationId, operation.revision, "lead", decision.reason);
  const updated = await updateOperationMetadata(root, operationId, (current) => {
    const sameRevision = current.revision === operation.revision;
    return {
      notification: {
        ...current.notification,
        lastLeadWakeRevision: result.success && sameRevision ? operation.revision : current.notification.lastLeadWakeRevision,
        lastLeadWakeAt: result.success && sameRevision ? new Date(now).toISOString() : current.notification.lastLeadWakeAt,
        lastLeadWakeReason: result.success && sameRevision ? decision.reason : current.notification.lastLeadWakeReason,
        terminalDelivered: current.notification.terminalDelivered || (decision.reason === "terminal" && result.success && sameRevision),
        attempts: current.notification.attempts + result.attempts,
        lastError: result.error
      }
    };
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
    const effectivePolicy = operationLivenessPolicy(config, operation);
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
      if (target?.status === "FAILED" && (target.attempts ?? 0) >= effectivePolicy.retryDelaysMs.length) {
        await trace(root, "operation.watchdog.stopped", { operationId, reason: "completion-retry-budget-exhausted", attempts: target.attempts ?? 0 });
        return;
      }
      const budget = await loadOperationWakeBudget(root, operationId, operation.revision);
      if (operation.notification.terminalDelivered && budget.terminalLeadAccepted >= effectivePolicy.terminalLeadWakeLimit) {
        await trace(root, "operation.watchdog.stopped", { operationId, reason: "terminal-lead-wake-budget-exhausted", revision: operation.revision, accepted: budget.terminalLeadAccepted });
        return;
      }
    }

    const now = (deps.now ?? Date.now)();
    const budget = await loadOperationWakeBudget(root, operationId, operation.revision);
    const decision = evaluateOperationWake(operation, effectivePolicy, now, budget.supervisorAccepted, budget.leadAccepted, budget.terminalLeadAccepted);
    if (decision.reason === "stalled" && stallRevision === operation.revision && now - lastStallWakeAt < effectivePolicy.progressWakeIntervalMs) {
      await sleep(effectivePolicy.pollIntervalMs);
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
    await sleep(effectivePolicy.pollIntervalMs);
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
      const effectivePolicy = operationLivenessPolicy(config, operation);
      if (isTerminalOperation(operation.status) && operationRevisionAcknowledged(operation)) {
        stopped = true;
        clearInterval(timer);
        return;
      }
      const now = (deps.now ?? Date.now)();
      const budget = await loadOperationWakeBudget(root, operationId, operation.revision);
      if (isTerminalOperation(operation.status) && operation.notification.terminalDelivered && budget.terminalLeadAccepted >= effectivePolicy.terminalLeadWakeLimit) {
        stopped = true;
        clearInterval(timer);
        return;
      }
      const decision = evaluateOperationWake(operation, effectivePolicy, now, budget.supervisorAccepted, budget.leadAccepted, budget.terminalLeadAccepted);
      if (decision.reason === "stalled" && stallRevision === operation.revision && now - lastStallWakeAt < effectivePolicy.progressWakeIntervalMs) return;
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

function leadWakePrompt(operation: OperationRecordV2, decision: OperationWakeDecision, analyst?: OperationsAnalystAdvisoryV1): string {
  if (decision.reason === "owner-boundary" && operation.ownerEconomicBoundary) {
    const boundary = operation.ownerEconomicBoundary;
    return [
      "[AEH_OWNER_ECONOMIC_DECISION_REQUIRED]",
      `Operation ${operation.id} is waiting at revision ${operation.revision}; phase=${operation.phase}.`,
      `Boundary: ${boundary.budget}; observed=${boundary.observed ?? "unknown"}; configured Owner limit=${boundary.configuredLimit}; usage coverage=${boundary.usageCoverage}.`,
      `Reason: ${boundary.reason}`,
      `Bound evidence: ${boundary.evidenceRefs.join(", ")}`,
      "This request is reserved for the human Owner. Do not change policy, budgets, or operation authority. Tell the Owner exactly what boundary was reached and wait for a new explicit user instruction. Do not start a child or replacement operation automatically."
    ].join("\n");
  }
  if (decision.reason === "terminal") {
    const linkedRecovery = Object.values(operation.participants).map((participant) => participant.executionLiveness?.lastRecoveryDecision)
      .find((recovery) => ["ROTATE_SESSION", "REPLAN", "SPLIT_WORK", "REASSIGN"].includes(recovery?.action ?? "")
        && (recovery?.actorRole === "LEAD" ? recovery.application === "REQUESTED" : recovery?.application === "ESCALATE_TO_LEAD"));
    return [
      "[AEH_OPERATION_COMPLETED_UNACKNOWLEDGED]",
      `Operation ${operation.id} (${operation.kind}) is terminal at revision ${operation.revision}: status=${operation.status}, phase=${operation.phase}.`,
      ...(operation.ownerEconomicBoundary ? [`Owner economic boundary requires the human Owner: ${operation.ownerEconomicBoundary.budget}; observed=${operation.ownerEconomicBoundary.observed ?? "unknown"}; configured limit=${operation.ownerEconomicBoundary.configuredLimit}; coverage=${operation.ownerEconomicBoundary.usageCoverage}; reason=${operation.ownerEconomicBoundary.reason}. Tell the Owner and do not create a replacement operation automatically.`] : []),
      ...(operation.ownerContinuationBoundary ? [`Owner hard execution deadline requires a distinct explicit Owner request before starting another execution root: ${operation.ownerContinuationBoundary.reason}`] : []),
      ...(linkedRecovery ? [`The ${linkedRecovery.actorRole} requested ${linkedRecovery.action} for participant ${linkedRecovery.participantId}; the deterministic controller has ended and cleaned this parent operation. If that recovery is within inherited Owner policy, start exactly one linked operation with intentDecision.continuation.operationId=${operation.id}, preserve userTurnId=${operation.origin?.userTurnId ?? "unknown"}, and let the controller inherit the remaining economic envelope and hard deadline.`] : []),
      ...((operation.status === "FAILED" || operation.status === "CANCELLED") && !operation.ownerEconomicBoundary && !operation.ownerContinuationBoundary && !linkedRecovery
        ? [operation.status === "CANCELLED" ? "This operation was explicitly cancelled. A Lead cannot restart it; wait for an explicit Owner-authorized CLI start." : `This failed operation remains the pending task. Any continued work must be a linked child with intentDecision.continuation.operationId=${operation.id}; unlinked Lead starts are rejected until recovery succeeds or an explicit Owner-authorized CLI start.`]
        : []),
      `Progress: completed=${operation.progress.completed}/${operation.progress.expected}, failed=${operation.progress.failed}, blocked=${operation.progress.blocked}.`,
      decision.message,
      "This is bounded internal recovery, not a new user task. Do not repeat a user-facing status if this exact terminal revision was already handled.",
      `Do not start a duplicate operation. Use aeh_operation_digest for compact state. Use aeh_operation_status with detail=full at most once if the terminal result requires it, then call aeh_operation_ack for exactly revision ${operation.revision}.`
    ].join("\n");
  }
  const instruction = decision.reason === "blocked"
    ? "Inspect the durable block/exception and involve the user only if the state requires a product/external decision."
    : decision.reason === "economic"
      ? "Review the frozen economic envelope and Supervisor analysis. Continue automatically while within Lead-delegated authority; involve the human Owner only if a concrete hard Owner boundary prevents further execution."
    : "The operation-local supervisor did not restore durable progress within its bounded watchdog budget. Inspect compact state first and recover or escalate without starting a duplicate operation.";
  return [
    `[AEH_OPERATION_${decision.reason?.toUpperCase()}]`,
    `Operation ${operation.id} (${operation.kind}) revision ${operation.revision}: status=${operation.status}, phase=${operation.phase}.`,
    `Progress: completed=${operation.progress.completed}/${operation.progress.expected}, running=${operation.progress.running}, failed=${operation.progress.failed}, blocked=${operation.progress.blocked}.`,
    decision.message,
    analyst ? `Operations Analyst advisory (MODEL, evidence-bound, ADVISORY_ONLY): ${JSON.stringify(analyst)}. Treat it as a hypothesis; the Lead decides within its delegated authority.` : undefined,
    "Do not start a duplicate operation. Use aeh_operation_digest first; request a full OperationRecord only if the compact state is insufficient.",
    instruction
  ].join("\n");
}
function supervisorWatchdogPrompt(operation: OperationRecordV2, decision: OperationWakeDecision, snapshot: SupervisorWatchdogSnapshot, analyst?: OperationsAnalystAdvisoryV1): string {
  return [
    "[AEH_OPERATION_WATCHDOG]",
    `Your operation ${operation.id} requires ${decision.reason === "economic" ? "a soft economic-envelope review" : "stall recovery"} at revision ${operation.revision}, phase=${operation.phase}.`,
    decision.message,
    `Deterministic watchdog snapshot (authoritative for this wake): ${JSON.stringify(snapshot)}`,
    `Just-in-time Operational Skills (guidance only; version/certification status is visible and no capability or authority is granted): ${JSON.stringify(snapshot.recoverySkills)}`,
    analyst ? `Operations Analyst advisory (MODEL, evidence-bound, ADVISORY_ONLY): ${JSON.stringify(analyst)}. Treat this as a hypothesis; it grants no authority and cannot choose recovery, policy, budgets, acceptance, or delivery.` : "Operations Analyst is unavailable for this wake; use deterministic evidence and your Supervisor authority.",
    "If recovery is needed, choose exactly one bounded action and call aeh_supervisor_recovery_decide with the participantId, executionBindingDigest, action, one or more exact activityEvidence eventIds, and an evidence-based reason. CONTINUE or RESUME_SAME_SESSION can renew only within the frozen execution/economic envelope. Use ESCALATE_TO_LEAD when Supervisor authority is insufficient. A vague uncertainty is not grounds to request the human Owner.",
    "Do not run shell commands, filesystem discovery, process inspection, Paseo CLI/daemon commands, or any other tools to rediscover operation state. The controller already performed runtime inspection.",
    "Reason only from this snapshot and your existing semantic context. Return a compact assessment: whether semantic intervention is required, which existing participant is implicated if any, and whether the controller should wait or escalate. Do not start another AEH operation or create new children from a watchdog wake."
  ].join("\n");
}

async function requestOperationsAnalyst(
  root: string,
  config: HarnessProjectConfig,
  operation: OperationRecordV2,
  snapshot: SupervisorWatchdogSnapshot,
  deps: OperationLivenessDeps,
  trace: OperationLivenessDeps["trace"]
): Promise<OperationsAnalystAdvisoryV1 | undefined> {
  const candidate = operation.candidateRevision;
  if (!candidate) return undefined;
  try {
    const input = { root, config, operation, snapshot };
    const advisory = deps.analyzeOperations ? await deps.analyzeOperations(input) : await (async () => {
      const runtime = await createSemanticAssessmentRuntimeV1(root, config);
      const binding = await createSemanticRepositoryBindingV1(root, config, { operationId: operation.id, candidate });
      const evidenceEvents = await readExecutionActivityEventsV1(root, operation.id);
      const efficiency = await readOperationEfficiencyObservations(root, operation.id).catch(() => undefined);
      const commandDiagnostics = await readRecentCommandDiagnostics(root, operation.id);
      const evidence = [
        { ref: `operation://${operation.id}/watchdog/${operation.revision}`, content: JSON.stringify(snapshot).slice(0, 4_000) },
        { ref: `operation://${operation.id}/activity/${operation.revision}`, content: JSON.stringify(compactRecentActivity(evidenceEvents, operation.id)).slice(0, 4_000) },
        { ref: `operation://${operation.id}/tool-calls/${operation.revision}`, content: JSON.stringify((efficiency?.tools ?? []).slice(-16).map(({ participantId, role, phase, toolName, outcome, attemptIndex, causalStatus, durationMs, finishedAt }) => ({ participantId, role, phase, toolName, outcome, attemptIndex, causalStatus, durationMs, finishedAt }))).slice(0, 4_000) },
        { ref: `operation://${operation.id}/command-diagnostics/${operation.revision}`, content: JSON.stringify(commandDiagnostics).slice(0, 4_000) }
      ];
      return analyzeOperationExecutionV1({ service: runtime.service, binding: { ...binding, operationId: operation.id }, evidence });
    })();
    if (advisory.operationId !== operation.id || advisory.authority !== "ADVISORY_ONLY") throw new Error("OPERATIONS_ANALYST_OUTPUT_INVALID: advisory operation identity or authority label is invalid.");
    const digest = operationsAnalystAdvisoryDigestV1(advisory);
    const directory = path.join(operationArtifactDir(root, operation.id), "operations-analyst");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const artifact = { version: 1, kind: "operations-analyst-finding", authority: "ADVISORY_ONLY", operationId: operation.id, operationRevision: operation.revision, candidateDigest: candidate.identityDigest, advisoryDigest: digest, advisory, createdAt: new Date().toISOString() };
    const file = path.join(directory, `${operation.revision}-${digest.slice(0, 16)}.json`);
    await writeJsonAtomic(file, artifact);
    await (trace ?? recordPaseoTrace)(root, "operation.operations-analyst.finding", { operationId: operation.id, revision: operation.revision, advisoryDigest: digest, artifact: path.relative(root, file).replaceAll("\\", "/"), classification: advisory.classification, probableCause: advisory.probableCause }).catch(() => undefined);
    return advisory;
  } catch (error) {
    await (trace ?? recordPaseoTrace)(root, "operation.operations-analyst.unavailable", { operationId: operation.id, revision: operation.revision, error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) }).catch(() => undefined);
    return undefined;
  }
}

async function readRecentCommandDiagnostics(root: string, operationId: string): Promise<SupervisorWatchdogSnapshot["commandDiagnostics"]> {
  const directory = path.join(operationArtifactDir(root, operationId), "diagnostics");
  const files = (await fs.readdir(directory).catch(() => [] as string[])).filter((name) => /^command-[0-9]+-[A-Za-z0-9-]+\.json$/.test(name)).sort().slice(-4);
  const diagnostics: SupervisorWatchdogSnapshot["commandDiagnostics"] = [];
  for (const name of files) {
    try {
      const value = JSON.parse(await fs.readFile(path.join(directory, name), "utf8")) as {
        version?: unknown; kind?: unknown; operationId?: unknown; exitCode?: unknown; durationMs?: unknown; startedAt?: unknown; finishedAt?: unknown;
        command?: { display?: unknown }; cwd?: unknown; tool?: { name?: unknown; version?: unknown };
        stdout?: { diagnosticTail?: unknown }; stderr?: { diagnosticTail?: unknown };
      };
      if (value.version !== 1 || value.kind !== "command-diagnostic" || value.operationId !== operationId) continue;
      diagnostics.push({
        reference: path.relative(operationArtifactDir(root, operationId), path.join(directory, name)).replaceAll("\\", "/"),
        command: String(value.command?.display ?? "unknown").slice(0, 500),
        cwd: String(value.cwd ?? "").slice(0, 500),
        exitCode: typeof value.exitCode === "number" && Number.isSafeInteger(value.exitCode) ? value.exitCode : 1,
        tool: String(value.tool?.name ?? "unknown").slice(0, 100),
        toolVersion: typeof value.tool?.version === "string" ? value.tool.version.slice(0, 100) : null,
        startedAt: String(value.startedAt ?? ""),
        finishedAt: String(value.finishedAt ?? ""),
        durationMs: typeof value.durationMs === "number" && Number.isSafeInteger(value.durationMs) ? value.durationMs : 0,
        stdoutTail: String(value.stdout?.diagnosticTail ?? "").slice(-1_500),
        stderrTail: String(value.stderr?.diagnosticTail ?? "").slice(-1_500)
      });
    } catch { /* corrupt diagnostics are omitted, never promoted as authority */ }
  }
  return diagnostics;
}

function compactRecentActivity(events: ExecutionActivityEventV1[], operationId: string): Array<Pick<ExecutionActivityEventV1, "eventId" | "participantId" | "participantGeneration" | "role" | "phase" | "kind" | "level" | "observedAt" | "evidenceDigest" | "toolName">> {
  return events.filter((event) => event.operationId === operationId).slice(-24).map(({ eventId, participantId, participantGeneration, role, phase, kind, level, observedAt, evidenceDigest, toolName }) => ({ eventId, participantId, participantGeneration, role, phase, kind, level, observedAt, evidenceDigest, ...(toolName ? { toolName } : {}) }));
}

async function projectWatchdogRecoverySkills(
  root: string,
  operation: OperationRecordV2,
  participants: SupervisorWatchdogParticipantSnapshot[],
  nowMs: number
): Promise<ProjectedOperationalSkillV1[]> {
  const expectedDigest = operation.resolvedOperationPolicy?.capabilityRegistryDigest;
  if (!expectedDigest) return [];
  const registry = await loadOperationCapabilityRegistryV1(root, operation.id).catch(() => undefined);
  if (!registry || registry.digest !== expectedDigest) return [];
  const stalled = participants.filter((participant) => participant.executionState === "STALL_SUSPECTED");
  if (!stalled.length) return [];
  const projections = stalled.flatMap((participant) => {
    const liveness = operation.participants[participant.id]?.executionLiveness;
    const failureClass = liveness?.waitingDeadlineAt && Date.parse(liveness.waitingDeadlineAt) <= nowMs ? "TIMEOUT" : "PROGRESS_WINDOW_EXPIRED";
    return [projectOperationalSkillsV1({
      role: "Operation Supervisor",
      observedFailure: { capabilityId: "aeh:paseo-participant-lifecycle", failureClass },
      capabilityRegistry: registry
    })];
  });
  return [...new Map(projections.flatMap((projection) => projection.skills).map((skill) => [`${skill.id}:${skill.procedureVersion}:${skill.certificationStatus}`, skill])).values()];
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try { await fs.rename(temporary, file); }
  catch (error) { await fs.rm(temporary, { force: true }).catch(() => undefined); throw error; }
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
