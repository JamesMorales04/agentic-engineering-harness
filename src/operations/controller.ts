import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { runAudit } from "../audit/run.js";
import { loadProjectConfig, loadTaskContract } from "../core/config.js";
import { createControlPlaneSnapshot, materializeControlPlaneRuntimeSurface, materializeControlPlaneSnapshot } from "../core/controlPlane.js";
import { runTask } from "../core/run.js";
import type { AssuranceLevel, ImplementationRoute } from "../architecture/contracts.js";
import type { HarnessProjectConfig, TaskContract } from "../core/types.js";
import { assertResolvedOperationPolicyV1, compileResolvedOperationPolicy } from "../architecture/executionIdentity.js";
import {
  deliveryWorkspaceId,
  deliveryWorkspacePath,
  materializeTaskContext
} from "../delivery/handoff.js";
import { inspectManagedPaseoAgent, listManagedPaseoAgents } from "../paseo/runtime.js";
import { isDeterministicPaseoRuntimeEnabled, isDeterministicPaseoSessionId } from "../paseo/deterministicRuntime.js";
import { createManagedRuntime, readManagedRuntimeSnapshot, runtimeProjectId } from "../runtime/index.js";
import { recordPaseoTrace } from "../paseo/trace.js";
import {
  clearManagedProcessHandles,
  listManagedProcessHandles,
  runShell,
  terminateManagedProcessGroup,
  type ProcessResult
} from "../utils/process.js";
import { prepareChangeOperation, resolveChangePreflightV1, runChangeOperation, type PreparedChangeOperation } from "./change.js";
import type { ChangePreflightV1 } from "../core/triage.js";
import { computeWorktreeDigest, resolveBaseRef } from "../core/git.js";
import { sha256Canonical, sha256Utf8 } from "../core/digest.js";
import { assertIntentDecisionForRoute } from "../audit/intentDecision.js";
import { executeGatedAction } from "../security/gatedAction.js";
import { reconcileToolAction } from "../security/actionReconciliation.js";
import { controllerActorId, listUnresolvedToolActionIntents, type ToolActionAuthorityEvidenceV1 } from "../security/toolActionGate.js";
import { configuredExternalEffects, requiredHumanActionAuthorizations } from "../security/actionPolicy.js";
import {
  disableOperationCompletionTarget,
  notifyOperationCompletion,
  registerOperationCompletionTarget
} from "./completion.js";
import { startOperationWatchdog } from "./liveness.js";
import { assertOperationCapacity, syncOperationPortfolio } from "./portfolio.js";
import {
  awaitOperationResume,
  bindOperationLead,
  bindOperationCandidate,
  bindResolvedOperationPolicy,
  assertCurrentControllerOwner,
  bindControllerProcess,
  claimControllerEpoch,
  controllerEpochFromEnvironment,
  controllerTokenFromEnvironment,
  currentControllerEpoch,
  isTerminalOperation,
  loadOperation,
  patchOperation,
  rebindPauseRecordToCurrentIdentity,
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
import { candidateRevisionsEqual, createCandidateRevisionV1, type CandidateRevisionV1 } from "./v2Contracts.js";
import { assertWorkspaceMatchesCandidate } from "../candidates/identity.js";

export interface StartOperationOptions {
  nodeExecutable: string;
  entryFile: string;
  spawnProcess?: typeof spawn;
  completionAgentId?: string;
  completionSource?: string;
  /** Test seam for deterministic preflight-ordering regressions; public callers use the semantic resolver. */
  resolveChangePreflight?: typeof resolveChangePreflightV1;
}

export interface OperationControllerDeps {
  run?: typeof runShell;
  trace?: typeof recordPaseoTrace;
  notifyCompletion?: (root: string, operation: OperationRecord) => Promise<unknown>;
  startWatchdog?: typeof startOperationWatchdog;
  runAudit?: typeof runAudit;
  runTask?: typeof runTask;
  runChange?: typeof runChangeOperation;
  /** Trusted actor from the paired Control Center session; absent callers must present a recorded scoped decision. */
  humanActorId?: string;
  /** Deterministic provider observation seam for cleanup tests and disposable packed fixtures. */
  inspectProviderSession?: (root: string, provider: string, sessionId: string) => Promise<{ status?: string } | undefined>;
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
  const suppliedDecision = "intentDecision" in payload ? payload.intentDecision : undefined;
  if (suppliedDecision) assertIntentDecisionForRoute(suppliedDecision, kind === "audit" ? "audit" : kind === "change" ? "change" : "run");

  let changePreflight: ChangePreflightV1 | undefined;
  if (kind === "change") {
    if (!config) throw new Error("CHANGE_PREFLIGHT_CONFIG_REQUIRED: project configuration must be loaded before resolving route and assurance.");
    changePreflight = await (options.resolveChangePreflight ?? resolveChangePreflightV1)(absoluteRoot, config, payload as ChangeOperationPayload);
  }

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
    operationExecutionRevision: 1,
    createdAt: now,
    updatedAt: now,
    lastProgressAt: now,
    intent: initialIntent(kind, payload, changePreflight),
    ...(changePreflight ? { changePreflight } : {}),
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

  const spawnProcess = options.spawnProcess ?? spawn;
  record = await claimControllerEpoch(absoluteRoot, id, `controller:${process.pid}`, { pid: process.pid });
  const controllerEpoch = currentControllerEpoch(record);
  const controllerToken = controllerTokenFromEnvironment() ?? "";

  const completionAgentId = options.completionAgentId?.trim() || process.env.PASEO_AGENT_ID?.trim() || undefined;
  if (completionAgentId) {
    const source = options.completionSource ?? (options.completionAgentId ? "explicit" : "environment");
    await registerOperationCompletionTarget(absoluteRoot, id, completionAgentId, source);
    record = await bindOperationLead(absoluteRoot, id, completionAgentId, source);
  }
  if (config) await syncOperationPortfolio(absoluteRoot, config.project.name, record);

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
          AEH_OPERATION_KIND: kind,
          AEH_OPERATION_STATE_REDIRECT: "1",
          AEH_CONTROLLER_EPOCH: String(controllerEpoch),
          AEH_CONTROLLER_TOKEN: controllerToken
        }
      }
    );
    if (typeof child.pid === "number") record = await bindControllerProcess(absoluteRoot, id, child.pid);
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
  if (typeof child.once === "function") child.once("error", (error) => {
    void (async () => {
      const current = await loadOperation(absoluteRoot, id).catch(() => record);
      if (isTerminalOperation(current.status)) return;
      if (completionAgentId) {
        await disableOperationCompletionTarget(
          absoluteRoot,
          id,
          `Detached controller spawn failed asynchronously before execution started: ${String(error)}`
        ).catch(() => undefined);
      }
      const failed = await patchOperation(absoluteRoot, id, {
        status: "FAILED",
        phase: "spawn-failed",
        error: String(error),
        finishedAt: new Date().toISOString()
      });
      if (config) await syncOperationPortfolio(absoluteRoot, config.project.name, failed).catch(() => undefined);
    })().catch(() => undefined);
  });
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
  const environmentKeys = [
    "AEH_CONTROL_ROOT",
    "AEH_OPERATION_ID",
    "AEH_OPERATION_KIND",
    "AEH_OPERATION_STATE_REDIRECT",
    "AEH_OPERATION_WORKSPACE_ID",
    "AEH_CONTROLLER_EPOCH",
    "AEH_CONTROLLER_TOKEN"
  ] as const;
  const previous = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]])) as Record<string, string | undefined>;
  try {
    return await executeOperationWithEnvironment(root, operationId, deps);
  } finally {
    for (const key of environmentKeys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function executeOperationWithEnvironment(
  root: string,
  operationId: string,
  deps: OperationControllerDeps = {}
): Promise<OperationRecordV2> {
  const absoluteRoot = path.resolve(root);
  process.env.AEH_CONTROL_ROOT = absoluteRoot;
  process.env.AEH_OPERATION_ID = operationId;
  const trace = deps.trace ?? recordPaseoTrace;
  let record = await loadOperation(absoluteRoot, operationId);
  if (isTerminalOperation(record.status)) return record;
  process.env.AEH_OPERATION_KIND = record.kind;
  process.env.AEH_OPERATION_STATE_REDIRECT = "1";
  const inheritedEpoch = controllerEpochFromEnvironment();
  const inheritedToken = controllerTokenFromEnvironment();
  const epochMatches = inheritedEpoch !== undefined && inheritedEpoch === currentControllerEpoch(record);
  const tokenMatches = inheritedToken !== undefined && record.controller?.tokenDigest === sha256Utf8(inheritedToken);
  if (!epochMatches || !tokenMatches) {
    record = await claimControllerEpoch(absoluteRoot, operationId, `controller:${process.pid}`, { pid: process.pid });
  }
  process.env.AEH_CONTROLLER_EPOCH = String(currentControllerEpoch(record));
  assertCurrentControllerOwner(record, "operation execution startup");
  let config: HarnessProjectConfig | undefined;
  let stopWatchdog: (() => void) | undefined;
  let preparedChange: PreparedChangeOperation | undefined;
  let runContract: TaskContract | undefined;
  try {
    record = await patchOperation(absoluteRoot, operationId, {
      status: "RUNNING",
      phase: record.pause ? "PAUSED" : record.continuation?.state === "WAITING" ? "HUMAN_REQUIRED" : "preparing",
      startedAt: record.startedAt ?? new Date().toISOString(),
      pid: process.pid,
      error: undefined
    });
    process.env.AEH_OPERATION_ID = record.id;

    config = await loadProjectConfig(absoluteRoot);
    if (record.kind !== "audit") {
      const configured = config.validation?.baseRef ?? "HEAD";
      const resolved = await resolveBaseRef(absoluteRoot, configured);
      if (resolved.ref !== configured) {
        config = { ...config, validation: { ...config.validation, baseRef: resolved.ref } };
        await trace(absoluteRoot, "operation.base-ref.fallback", { operationId, configured, resolved: resolved.ref, reason: "configured base ref is not resolvable" });
      }
    }
    await syncOperationPortfolio(absoluteRoot, config.project.name, record);

    let bootstrapRoute: ImplementationRoute | undefined;
    let bootstrapAssurance: AssuranceLevel | undefined;
    if (record.kind === "audit") {
      bootstrapRoute = "NO_AGENT";
      bootstrapAssurance = "NONE";
    } else if (record.kind === "run") {
      const payload = record.payload as RunOperationPayload;
      runContract = await loadTaskContract(absoluteRoot, payload.taskId, config);
      bootstrapRoute = runContract.routing?.route;
      bootstrapAssurance = runContract.routing?.assurance;
    } else {
      const payload = record.payload as ChangeOperationPayload;
      preparedChange = await prepareChangeOperation(absoluteRoot, config, record, payload);
      if (record.continuation) {
        if (record.intent?.route !== "FORMAL_SDD" || !record.intent.assurance) throw new Error("DECISION_CONTINUATION_TARGET_INVALID: persisted Spec Manager continuation has no frozen FORMAL_SDD route.");
        bootstrapRoute = record.intent.route;
        bootstrapAssurance = record.intent.assurance;
      } else {
        bootstrapRoute = preparedChange.triage.route;
        bootstrapAssurance = preparedChange.triage.assurance;
        record = await patchOperation(absoluteRoot, operationId, {
          intent: { ...record.intent, route: bootstrapRoute, assurance: bootstrapAssurance }
        });
      }
    }
    if (!bootstrapRoute || !bootstrapAssurance) throw new Error("EXECUTION_POLICY_INPUT_MISSING: route and assurance must be resolved before a sensitive bootstrap action.");
    record = await bindBootstrapOperationPolicy(absoluteRoot, config, record, bootstrapRoute, bootstrapAssurance, runContract);

    // A recovered PAUSED operation stays suspended until a scoped RESUME control
    // revalidates the current operation, candidate, policy, revision, and epoch.
    record = await loadOperation(absoluteRoot, operationId);
    if (record.pause) {
      record = await rebindPauseRecordToCurrentIdentity(absoluteRoot, operationId);
      record = await awaitOperationResume(absoluteRoot, operationId);
    }

  const workspace = await ensureOperationWorkspace(
      absoluteRoot,
      record,
      config,
      deps.run ?? runShell,
      trace
  );
  if (workspace.workspaceId) process.env.AEH_OPERATION_WORKSPACE_ID = workspace.workspaceId;
  const executionRoot = path.resolve(workspace.workspaceRoot ?? absoluteRoot);
  if (executionRoot !== absoluteRoot) {
    const controllerSnapshot = await createControlPlaneSnapshot(absoluteRoot, config, `operation-${operationId}`);
    await materializeControlPlaneSnapshot(controllerSnapshot, executionRoot, config);
    await materializeControlPlaneRuntimeSurface(controllerSnapshot, executionRoot);
  }
  record = await patchOperation(absoluteRoot, operationId, {
      workspaceId: workspace.workspaceId,
      workspaceRoot: executionRoot,
      workspaceWarning: workspace.warning
    });
    if (!record.candidateRevision) {
      throw new Error(`CANDIDATE_BINDING_REQUIRED: operation ${operationId} did not bind its initial workspace candidate.`);
    }
    const priorCandidate = record.candidateRevision;
    if (path.resolve(priorCandidate.worktree ?? absoluteRoot) !== executionRoot) {
      record = await bindOperationCandidate(absoluteRoot, operationId, createCandidateRevisionV1({
        operationId,
        candidateId: `candidate:${operationId}:r${priorCandidate.revision + 1}`,
        projectId: priorCandidate.projectId,
        taskId: priorCandidate.taskId,
        revision: priorCandidate.revision + 1,
        parentCandidateId: priorCandidate.candidateId,
        sourceDigest: await computeWorktreeDigest(executionRoot),
        workspace: workspace.workspaceId,
        worktree: executionRoot,
        createdAt: new Date().toISOString()
      }));
    } else await assertWorkspaceMatchesCandidate(executionRoot, priorCandidate);
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
        record.payload as ChangeOperationPayload,
        preparedChange
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
            route: result.route,
            status: result.run.status,
            attempts: result.run.attempts,
            acceptanceOracle: result.run.acceptanceOracle,
            acceptanceOracleArtifact: result.run.acceptanceOracleArtifact,
            objectiveCompletion: result.run.objectiveCompletion,
            objectiveCompletionDecision: result.run.objectiveCompletionDecision,
            specChange: result.specChange,
            triageReasons: result.triageReasons
          }
        },
        deps,
        config
      );
    }

    const payload = record.payload as RunOperationPayload;
    const contract = runContract ?? await loadTaskContract(absoluteRoot, payload.taskId, config);
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
          attempts: result.attempts,
          acceptanceOracle: result.acceptanceOracle,
          acceptanceOracleArtifact: result.acceptanceOracleArtifact,
          objectiveCompletion: result.objectiveCompletion,
          objectiveCompletionDecision: result.objectiveCompletionDecision
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
  const run = deps.run ?? runShell;
  const previousEpoch = process.env.AEH_CONTROLLER_EPOCH;
  const previousToken = process.env.AEH_CONTROLLER_TOKEN;
  try {
    let record = await loadOperation(absoluteRoot, operationId);
    if (isTerminalOperation(record.status)) return record;
    const priorPolicy = assertCurrentCancellationPolicy(record);

    try {
      record = await claimControllerEpoch(absoluteRoot, operationId, `controller:cancel:${process.pid}`, {
        pid: process.pid,
        cause: "cancellation",
        humanActorId: deps.humanActorId,
        expectedCancellation: {
          operationExecutionRevision: record.operationExecutionRevision!,
          candidateDigest: record.candidateRevision!.identityDigest,
          policyDigest: priorPolicy.digest,
          controllerEpoch: currentControllerEpoch(record)
        }
      });
    } catch (error) {
      const latest = await loadOperation(absoluteRoot, operationId).catch(() => undefined);
      if (latest && isTerminalOperation(latest.status)) return latest;
      throw error;
    }
    process.env.AEH_CONTROLLER_EPOCH = String(currentControllerEpoch(record));
    assertCurrentControllerOwner(record, "operation cancellation");
    record = await rebindPolicyToCurrentCancellationEpoch(absoluteRoot, record, priorPolicy);
    const cancellationFence = {
      operationId: record.id,
      candidate: record.candidateRevision!,
      operationExecutionRevision: record.operationExecutionRevision!,
      policyDigest: record.resolvedOperationPolicy!.digest,
      controllerEpoch: currentControllerEpoch(record)
    };
    const cleanupWarnings: string[] = [];
    const config = await loadProjectConfigIfPresent(absoluteRoot);

    const processHandles = await listManagedProcessHandles(absoluteRoot, operationId);
    const descendantPids = record.pid ? await findDescendantProcessIds(record.pid, absoluteRoot) : [];
    const processGroups = [...new Set(([
      ...processHandles.map((handle) => handle.processGroupId),
      ...processHandles.map((handle) => handle.pid),
      ...descendantPids,
      record.pid
    ] as Array<number | undefined>).filter((pid): pid is number => typeof pid === "number" && Number.isInteger(pid) && pid > 0 && pid !== process.pid))];
    for (const pid of processGroups) {
      const latest = await loadOperation(absoluteRoot, operationId);
      assertCancellationFence(latest, cancellationFence, "operation cancellation process fencing");
      try { await terminateManagedProcessGroup(pid); }
      catch (error) { cleanupWarnings.push(`process group ${pid}: ${String(error)}`); }
      if (!(await waitForProcessExit(pid, 1_000))) cleanupWarnings.push(`process group ${pid}: process remained live after termination signals`);
    }
    const beforeHandleCleanup = await loadOperation(absoluteRoot, operationId);
    assertCancellationFence(beforeHandleCleanup, cancellationFence, "operation cancellation handle cleanup");
    await clearManagedProcessHandles(absoluteRoot, operationId);

    let agentIds = [...new Set([
      ...(record.agents ?? []).map((agent) => agent.id),
      ...Object.keys(record.participants),
      ...record.supervision.generations.map((generation) => generation.agentId)
    ].filter((agentId): agentId is string => Boolean(agentId)))];
    // Authority participant identities (`participant:<digest>`) are not provider
    // sessions and cannot be stopped through the Paseo boundary; actual sdk/cli
    // sessions and explicitly registered agents are still stopped.
    const authorityOnly = agentIds.filter((agentId) => /^participant:[0-9a-f]{16}$/.test(agentId));
    if (authorityOnly.length) {
      agentIds = agentIds.filter((agentId) => !authorityOnly.includes(agentId));
      await trace(absoluteRoot, "cleanup.authority-identities.skipped", { operationId, agentIds: authorityOnly });
    }
    if (agentIds.length > 0) {
      await trace(absoluteRoot, "cleanup.discovery", { operationId, source: "operation-state", agentCount: agentIds.length });
    } else if (config?.orchestration?.provider === "paseo") {
      try {
        const discovered = await listManagedPaseoAgents(absoluteRoot, { "aeh.operation": operationId });
        agentIds = [...new Set(discovered.map((agent) => agent.id))];
        await trace(absoluteRoot, "cleanup.discovery", { operationId, source: "paseo-list-compatibility", agentCount: agentIds.length, reason: "operation record has no registered agent identities" });
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
      const latest = await loadOperation(absoluteRoot, operationId);
      assertCancellationFence(latest, cancellationFence, "operation cancellation participant fencing");
      if (isDeterministicPaseoSessionId(agentId)) {
        // Scripted fixture sessions have no external process; their quiescence is
        // observed through the deterministic inspect boundary instead.
        await trace(absoluteRoot, "cleanup.deterministic.session-skipped", { operationId, agentId });
        continue;
      }
      const stopped = await run(`paseo stop ${quote(agentId)}`, { cwd: absoluteRoot, timeoutMs: 30_000 }).catch((error) => ({ exitCode: 1, stdout: "", stderr: String(error), durationMs: 0 }));
      await trace(absoluteRoot, "cleanup.cli.stop", { operationId, agentId, exitCode: stopped.exitCode });
      if (stopped.exitCode !== 0) cleanupWarnings.push(`agent ${agentId}: ${stopped.stderr || stopped.stdout || `exit ${stopped.exitCode}`}`);
    }

    const runtimeSnapshot = await readManagedRuntimeSnapshot(absoluteRoot).catch((error) => {
      cleanupWarnings.push(`provider runtime snapshot: ${String(error)}`);
      return undefined;
    });
    for (const lease of runtimeSnapshot?.providerLeases.filter((item) => item.lifecycle?.operationId === operationId) ?? []) {
      const current = await loadOperation(absoluteRoot, operationId);
      assertCancellationFence(current, cancellationFence, "operation cancellation provider lease cleanup");
      const sessionId = lease.lifecycle?.sessionId;
      if (!sessionId) {
        cleanupWarnings.push(`provider lease ${lease.leaseId}: no durable provider session id is available to prove cleanup`);
        continue;
      }
      if (isDeterministicPaseoSessionId(sessionId)) {
        // Scripted fixture sessions have no external process to inspect or stop.
        const latest = await loadOperation(absoluteRoot, operationId);
        assertCancellationFence(latest, cancellationFence, "operation cancellation deterministic lease release");
        const leaseOwner = await createManagedRuntime({ root: absoluteRoot, projectId: runtimeProjectId(absoluteRoot), ownerId: lease.ownerId });
        await leaseOwner.releaseProviderLease(lease.leaseId);
        await trace(absoluteRoot, "cleanup.provider.lease.released", { operationId, provider: lease.provider, sessionId, leaseId: lease.leaseId, observedStatus: "idle" });
        continue;
      }
      // Lease.provider names the model provider (for example, opencode). Its
      // session ID is still a Paseo-managed session and must be inspected at
      // that runtime boundary.
      const inspect = deps.inspectProviderSession ?? (async (cwd: string, _provider: string, id: string) => inspectManagedPaseoAgent(cwd, id));
      let observed = await inspect(absoluteRoot, lease.provider, sessionId).catch(() => undefined);
      let status = observed?.status?.toLowerCase();
      if (!isProviderSessionQuiescent(status)) {
        const stopped = await run(`paseo stop ${quote(sessionId)}`, { cwd: absoluteRoot, timeoutMs: 30_000 }).catch((error) => ({ exitCode: 1, stdout: "", stderr: String(error), durationMs: 0 }));
        await trace(absoluteRoot, "cleanup.provider.stop", { operationId, provider: lease.provider, sessionId, exitCode: stopped.exitCode });
        if (stopped.exitCode !== 0) cleanupWarnings.push(`provider session ${sessionId}: ${stopped.stderr || stopped.stdout || `stop exited ${stopped.exitCode}`}`);
        observed = await inspect(absoluteRoot, lease.provider, sessionId).catch(() => undefined);
        status = observed?.status?.toLowerCase();
      }
      if (!isProviderSessionQuiescent(status)) {
        cleanupWarnings.push(`provider session ${sessionId}: lifecycle remains uncertain after stop (status ${status ?? "unavailable"}); lease ${lease.leaseId} remains fenced`);
        continue;
      }
      const latest = await loadOperation(absoluteRoot, operationId);
      assertCancellationFence(latest, cancellationFence, "operation cancellation provider lease release");
      const leaseOwner = await createManagedRuntime({ root: absoluteRoot, projectId: runtimeProjectId(absoluteRoot), ownerId: lease.ownerId });
      await leaseOwner.releaseProviderLease(lease.leaseId);
      await trace(absoluteRoot, "cleanup.provider.lease.released", { operationId, provider: lease.provider, sessionId, leaseId: lease.leaseId, observedStatus: status });
    }

    if (cleanupWarnings.length) {
      const latest = await loadOperation(absoluteRoot, operationId);
      assertCancellationFence(latest, cancellationFence, "operation cancellation fencing report");
      await patchOperation(absoluteRoot, operationId, {
        phase: "cancellation-fencing-required",
        error: `Cancellation is not terminal because active writers could not be proven stopped: ${cleanupWarnings.join("; ")}.`,
        cleanupWarnings
      });
      throw new Error(`AEH_CANCELLATION_FENCING_REQUIRED: cancellation cannot become terminal until every writer is fenced: ${cleanupWarnings.join("; ")}.`);
    }

    const latest = await loadOperation(absoluteRoot, operationId);
    assertCancellationFence(latest, cancellationFence, "operation cancellation terminal transition");
    const unresolvedActions = await listUnresolvedToolActionIntents(absoluteRoot, operationId);
    if (unresolvedActions.length) {
      const current = await loadOperation(absoluteRoot, operationId);
      assertCancellationFence(current, cancellationFence, "operation cancellation reconciliation report");
      await patchOperation(absoluteRoot, operationId, {
        phase: "reconciling",
        error: `Cancellation is fenced pending reconciliation of ${unresolvedActions.length} action intent(s): ${unresolvedActions.map((intent) => intent.actionKey).join(", ")}.`
      });
      throw new Error(`AEH_CANCELLATION_RECONCILIATION_REQUIRED: unresolved action intents must be reconciled before cancellation can become terminal: ${unresolvedActions.map((intent) => intent.actionKey).join(", ")}.`);
    }
    return await terminalizeOperation(
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
  } finally {
    if (previousEpoch === undefined) delete process.env.AEH_CONTROLLER_EPOCH;
    else process.env.AEH_CONTROLLER_EPOCH = previousEpoch;
    if (previousToken === undefined) delete process.env.AEH_CONTROLLER_TOKEN;
    else process.env.AEH_CONTROLLER_TOKEN = previousToken;
  }
}

function assertCurrentCancellationPolicy(record: OperationRecordV2) {
  const candidate = record.candidateRevision;
  const policy = record.resolvedOperationPolicy;
  if (!candidate || !policy || !Number.isSafeInteger(record.operationExecutionRevision)) {
    throw new Error("AEH_CANCELLATION_AUTHORITY_REQUIRED: cancellation requires current candidate, execution revision, and frozen policy identity.");
  }
  assertResolvedOperationPolicyV1(policy);
  if (policy.operationId !== record.id || policy.operationExecutionRevision !== record.operationExecutionRevision
    || policy.candidateRevision !== candidate.revision || policy.candidateDigest !== candidate.identityDigest
    || policy.controllerEpoch !== currentControllerEpoch(record) || (candidate.projectId && policy.projectId !== candidate.projectId)) {
    throw new Error("AEH_CANCELLATION_POLICY_STALE: cancellation policy does not match the current operation, candidate, execution revision, project, and epoch.");
  }
  return policy;
}

function isProviderSessionQuiescent(status?: string): status is "idle" | "completed" | "failed" | "stopped" {
  return status === "idle" || status === "completed" || status === "failed" || status === "stopped";
}

function assertCancellationFence(record: OperationRecordV2, expected: { operationId: string; candidate: CandidateRevisionV1; operationExecutionRevision: number; policyDigest: string; controllerEpoch: number }, action: string): void {
  assertCurrentControllerOwner(record, action);
  if (record.id !== expected.operationId || currentControllerEpoch(record) !== expected.controllerEpoch
    || record.operationExecutionRevision !== expected.operationExecutionRevision
    || !record.candidateRevision || !candidateRevisionsEqual(record.candidateRevision, expected.candidate)
    || record.resolvedOperationPolicy?.digest !== expected.policyDigest) {
    throw new Error(`AEH_CANCELLATION_FENCED: ${action} no longer matches the operation, candidate, policy, execution revision, and controller epoch authorized for this cancellation.`);
  }
}

async function rebindPolicyToCurrentCancellationEpoch(root: string, record: OperationRecordV2, previousPolicy: ReturnType<typeof assertCurrentCancellationPolicy>): Promise<OperationRecordV2> {
  const { version: _version, digest: _digest, ...body } = previousPolicy;
  const policy = compileResolvedOperationPolicy({ ...body, controllerEpoch: currentControllerEpoch(record) });
  return bindResolvedOperationPolicy(root, record.id, policy);
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

export async function bindBootstrapOperationPolicy(
  root: string,
  config: HarnessProjectConfig,
  operation: OperationRecordV2,
  route: ImplementationRoute,
  minimumAssurance: AssuranceLevel,
  contract?: TaskContract
): Promise<OperationRecordV2> {
  const candidate = operation.candidateRevision;
  const controllerEpoch = currentControllerEpoch(operation);
  if (!candidate || !Number.isSafeInteger(operation.operationExecutionRevision) || !operation.controller?.tokenDigest) {
    throw new Error("EXECUTION_POLICY_INPUT_MISSING: bootstrap policy requires current candidate, operation execution revision, and claimed controller epoch.");
  }
  if (operation.resolvedOperationPolicy) {
    const frozen = operation.resolvedOperationPolicy;
    assertResolvedOperationPolicyV1(frozen);
    if (frozen.operationId !== operation.id || frozen.candidateRevision !== candidate.revision || frozen.candidateDigest !== candidate.identityDigest
      || frozen.operationExecutionRevision !== operation.operationExecutionRevision || frozen.controllerEpoch !== controllerEpoch
      || (candidate.projectId && frozen.projectId !== candidate.projectId) || frozen.route !== route || frozen.minimumAssurance !== minimumAssurance) {
      throw new Error("EXECUTION_POLICY_STALE: existing frozen bootstrap policy does not match the current operation, candidate, route, assurance, and controller epoch.");
    }
    return operation;
  }
  const allowedExternalEffects = configuredExternalEffects(config, operation.kind);
  const humanDecisionRequirements = requiredHumanActionAuthorizations(allowedExternalEffects);
  const validationPolicy = contract?.verification ?? {};
  const deliveryPolicy = {
    githubEnabled: config.delivery?.github?.enabled === true,
    paseoEnabled: config.delivery?.paseo?.enabled === true,
    allowedExternalEffects
  };
  const policy = compileResolvedOperationPolicy({
    projectId: candidate.projectId ?? config.project.name,
    operationId: operation.id,
    operationExecutionRevision: operation.operationExecutionRevision!,
    candidateRevision: candidate.revision,
    candidateDigest: candidate.identityDigest,
    controllerEpoch,
    intent: operation.intent?.request ?? contract?.routing?.intent ?? `${operation.kind} operation ${operation.id}`,
    route,
    minimumAssurance,
    policyVersions: { resolvedOperationPolicy: "1", roleInvocationPolicy: "1", executionBlueprint: "2", executionBinding: "2", skillManifest: "1" },
    policyDigests: {
      validation: sha256Canonical(validationPolicy),
      delivery: sha256Canonical({ ...deliveryPolicy, humanDecisionRequirements }),
      knowledge: sha256Canonical([]),
      context: sha256Canonical(config.context ?? null)
    },
    validationPolicy,
    reviewPolicy: {
      minimumAssurance,
      independentReviewRequired: minimumAssurance === "ELEVATED" || minimumAssurance === "CRITICAL",
      leadAcceptance: config.workflow?.reviews?.leadAcceptance !== false,
      leadAcceptanceDirect: config.workflow?.reviews?.leadAcceptanceDirect === true
    },
    deliveryPolicy,
    knowledgePolicy: { bootstrap: true },
    contextPolicy: config.context ?? { mode: "disabled" },
    allowedExternalEffects,
    humanDecisionRequirements
  });
  return bindResolvedOperationPolicy(root, operation.id, policy);
}

async function ensureOperationWorkspace(
  root: string,
  record: OperationRecordV2,
  config: HarnessProjectConfig,
  run: typeof runShell,
  trace: typeof recordPaseoTrace
): Promise<OperationWorkspace> {
  if (isDeterministicPaseoRuntimeEnabled()) {
    // Fixture journeys execute against the disposable control root; no external
    // Paseo worktree is materialized for the scripted provider boundary.
    await trace(root, "workspace.deterministic.local-root", { operationId: record.id, kind: record.kind });
    return { workspaceRoot: root };
  }
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
    let result: ProcessResult;
    try {
      result = await gatedWorkspaceCreate({ root, record, run, command, timeoutMs: 60_000, payload: { isolation: "local", path: root, title } });
    } catch (error) {
      const warning = `Paseo audit workspace could not be created: ${String(error)}`;
      await trace(root, "workspace.cli.error", { operationId: record.id, error: warning });
      return { workspaceRoot: root, warning };
    }
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
  const result = await gatedWorkspaceCreate({ root, record, run, command, timeoutMs: 180_000, payload: { isolation: "worktree", path: root, title, branch, base, slug } });
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

async function gatedWorkspaceCreate(input: {
  root: string;
  record: OperationRecordV2;
  run: typeof runShell;
  command: string;
  timeoutMs: number;
  payload: Record<string, unknown>;
}): Promise<ProcessResult> {
  const candidate = input.record.candidateRevision;
  if (!candidate) throw new Error("AEH_OPERATION_WORKTREE_REQUIRED: workspace creation requires a bound CandidateRevision.");
  const controllerEpoch = controllerEpochFromEnvironment();
  if (controllerEpoch === undefined) throw new Error("DELIVERY_AUTHORITY_REQUIRED: workspace creation requires a fenced controller epoch.");
  const authority: ToolActionAuthorityEvidenceV1 = { kind: "controller-authority", operationId: input.record.id, controllerEpoch };
  let observed: ProcessResult | undefined;
  const gate = await executeGatedAction({
    root: input.root,
    request: { root: input.root, operationId: input.record.id, participantId: controllerActorId(input.record.id), candidate, actionKey: `workspace:${input.record.id}:create`, action: "paseo.workspace.create", payload: input.payload, authority },
    execute: async () => {
      observed = await safeRun(input.run, input.command, input.root, input.timeoutMs);
      return { outcome: observed.exitCode === 0 ? "SUCCEEDED" as const : "FAILED" as const, evidence: { exitCode: observed.exitCode, stderr: (observed.stderr ?? "").slice(-2000), stdout: (observed.stdout ?? "").slice(-2000) } };
    },
    reconcile: (intent) => reconcileToolAction(input.root, intent, input.payload)
  });
  if (gate.status === "HUMAN_REQUIRED" || gate.status === "RECONCILIATION_REQUIRED") throw new Error(`AEH_OPERATION_WORKTREE_REQUIRED: workspace creation requires human reconciliation: ${gate.detail}`);
  if (!observed) throw new Error(`AEH_OPERATION_WORKTREE_REQUIRED: workspace creation did not run: ${gate.detail}`);
  return observed;
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

async function safeRun(run: typeof runShell, command: string, cwd: string, timeoutMs: number): Promise<ProcessResult> {
  try { return await run(command, { cwd, timeoutMs }); }
  catch (error) { return { exitCode: 1, stdout: "", stderr: String(error), durationMs: 0 }; }
}

async function loadProjectConfigIfPresent(root: string): Promise<HarnessProjectConfig | undefined> {
  try { await fs.access(path.resolve(root, ".harness/project.yaml")); }
  catch { return undefined; }
  return loadProjectConfig(root);
}

function initialIntent(kind: OperationKind, payload: OperationPayload, changePreflight?: ChangePreflightV1): OperationRecordV2["intent"] {
  if (kind === "audit") {
    const audit = payload as AuditOperationPayload;
    return { request: audit.request, classification: "AUDIT", risk: audit.risk, priority: 50, semanticDecision: audit.intentDecision };
  }
  if (kind === "change") {
    const change = payload as ChangeOperationPayload;
    return {
      request: change.request,
      classification: "CHANGE",
      route: changePreflight?.triage.route,
      assurance: changePreflight?.triage.assurance,
      risk: change.risk,
      priority: change.priority ?? 50,
      semanticDecision: change.intentDecision
    };
  }
  return { classification: "RUN", priority: (payload as RunOperationPayload).priority ?? 50, semanticDecision: (payload as RunOperationPayload).intentDecision };
}

function operationPriority(payload: OperationPayload): number {
  const value = "priority" in payload ? payload.priority : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : 50;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function findDescendantProcessIds(rootPid: number, operationRoot: string): Promise<number[]> {
  if (process.platform !== "linux" || !Number.isInteger(rootPid) || rootPid <= 0 || rootPid === process.pid) return [];
  try { process.kill(rootPid, 0); }
  catch { return []; }

  let entries: string[];
  try { entries = await fs.readdir("/proc"); }
  catch { return []; }

  const children = new Map<number, number[]>();
  await Promise.all(entries.filter((entry) => /^\d+$/.test(entry)).map(async (entry) => {
    const pid = Number(entry);
    try {
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
      const closingParen = stat.lastIndexOf(")");
      if (closingParen < 0) return;
      const fields = stat.slice(closingParen + 2).trim().split(/\s+/);
      const parentPid = Number(fields[1]);
      if (!Number.isInteger(parentPid) || parentPid <= 0) return;
      const siblings = children.get(parentPid) ?? [];
      siblings.push(pid);
      children.set(parentPid, siblings);
    } catch { /* process exited while the snapshot was being collected */ }
  }));

  const descendants: number[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const parentPid = queue.shift();
    if (parentPid === undefined) break;
    for (const childPid of children.get(parentPid) ?? []) {
      if (descendants.includes(childPid)) continue;
      descendants.push(childPid);
      queue.push(childPid);
    }
  }
  const related = await Promise.all(entries.filter((entry) => /^\d+$/.test(entry)).map(async (entry) => {
    const pid = Number(entry);
    if (pid === process.pid || pid === rootPid || descendants.includes(pid)) return undefined;
    try {
      const cwd = await fs.realpath(`/proc/${pid}/cwd`);
      return cwd === operationRoot ? pid : undefined;
    } catch { return undefined; }
  }));
  return [...new Set([...descendants, ...related.filter((pid): pid is number => pid !== undefined)])];
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { process.kill(pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      return false;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
