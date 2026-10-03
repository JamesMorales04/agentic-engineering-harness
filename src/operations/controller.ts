import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { runAudit } from "../audit/run.js";
import { loadProjectConfig, loadTaskContract } from "../core/config.js";
import { createControlPlaneSnapshot, materializeControlPlaneRuntimeSurface, materializeControlPlaneSnapshot } from "../core/controlPlane.js";
import { operationFailureDetail, runTask } from "../core/run.js";
import type { AssuranceLevel, ImplementationRoute } from "../architecture/contracts.js";
import type { HarnessProjectConfig, TaskContract } from "../core/types.js";
import { assertResolvedOperationPolicyV2, compileResolvedOperationPolicy } from "../architecture/executionIdentity.js";
import {
  deliveryWorkspaceId,
  deliveryWorkspacePath,
  materializeTaskContext
} from "../delivery/handoff.js";
import { inspectManagedPaseoAgent, listManagedPaseoAgents } from "../paseo/runtime.js";
import { isDeterministicPaseoRuntimeEnabled, isDeterministicPaseoSessionId } from "../paseo/deterministicRuntime.js";
import { createManagedRuntime, readManagedRuntimeSnapshot, runtimeProjectId } from "../runtime/index.js";
import {
  operationResourcePolicy,
  reconcileOperationResources,
  reconcileTerminalOperationResources,
  registerOperationResource
} from "../runtime/operationResources.js";
import { recordPaseoTrace } from "../paseo/trace.js";
import {
  clearManagedProcessHandles,
  listManagedProcessHandles,
  runShell,
  terminateManagedProcessGroup,
  type ProcessResult
} from "../utils/process.js";
import { prepareChangeOperation, resolveChangePreflightV1, runChangeOperation, type PreparedChangeOperation } from "./change.js";
import { prepareGithubIssueTask, type IssuePreparationResult } from "../issues/intake.js";
import { createSemanticAssessmentRuntimeV1 } from "../semantic/runtime.js";
import type { ChangePreflightV1 } from "../core/triage.js";
import { computeWorktreeDigest, resolveBaseRef } from "../core/git.js";
import { sha256Canonical, sha256Utf8 } from "../core/digest.js";
import { assertIntentDecisionForRoute } from "../audit/intentDecision.js";
import { executeGatedAction } from "../security/gatedAction.js";
import { reconcileToolAction } from "../security/actionReconciliation.js";
import { controllerActorId, listUnresolvedToolActionIntents, type ToolActionAuthorityEvidenceV1 } from "../security/toolActionGate.js";
import { writeOperationEfficiencySummary } from "../telemetry/efficiency.js";
import { persistCandidateForensicsV1 } from "./forensics.js";
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
  frozenOperationHardDeadlineAt,
  isTerminalOperation,
  loadOperation,
  patchOperation,
  resolveOperationStateRoot,
  rebindPauseRecordToCurrentIdentity,
  saveOperation,
  transitionOperationToTerminal,
  transitionOperationAtHardDeadlineV1,
  withOperationRecoveryParentLock,
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
import { bindBootstrapOperationPolicy } from "./bootstrapPolicy.js";
import { compileOperationOriginV1, type OperationOwnerResolutionRefV1 } from "./operationProvenance.js";
import { collectOperationEconomicUsageV1, remainingEconomicEnvelopeForRecoveryV1 } from "./economicUsage.js";

export { bindBootstrapOperationPolicy };

export interface StartOperationOptions {
  nodeExecutable: string;
  entryFile: string;
  spawnProcess?: typeof spawn;
  completionAgentId?: string;
  completionSource?: string;
  initiator?: { kind: "LEAD" | "CLI"; agentId?: string; userTurnId?: string; requestEventId?: string };
  /** Pending Owner boundaries/task chains this explicit CLI request resolves. */
  ownerResolutionOperationIds?: string[];
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
  runIssueIntake?: typeof prepareGithubIssueTask;
  createSemanticRuntime?: typeof createSemanticAssessmentRuntimeV1;
  /** Trusted actor from the paired Control Center session; absent callers must present a recorded scoped decision. */
  humanActorId?: string;
  /** Deterministic provider observation seam for cleanup tests and disposable packed fixtures. */
  inspectProviderSession?: (root: string, provider: string, sessionId: string) => Promise<{ status?: string } | undefined>;
  /** Deterministic seam for durable label-bound agent discovery during resource reconciliation. */
  listOperationAgents?: (root: string, operationId: string) => Promise<Array<{ id?: string; workspaceId?: string }>>;
}

interface OperationWorkspace {
  workspaceId?: string;
  workspaceRoot?: string;
  warning?: string;
  reusedDelivery?: boolean;
  disposition?: "OPERATION_OWNED" | "DELIVERY_REUSED";
}

export async function startDetachedOperation(
  root: string,
  kind: OperationKind,
  payload: OperationPayload,
  options: StartOperationOptions
): Promise<OperationRecordV2> {
  const absoluteRoot = path.resolve(root);
  const config = await loadProjectConfigIfPresent(absoluteRoot);
  const suppliedDecision = "intentDecision" in payload ? payload.intentDecision : undefined;
  const initiator = options.initiator ?? (options.completionAgentId ? { kind: "LEAD" as const, agentId: options.completionAgentId } : { kind: "CLI" as const });
  const leadInitiated = initiator.kind === "LEAD" || Boolean(suppliedDecision && suppliedDecision.source !== "explicit-cli");
  await materializeOverdueOperationDeadlines(absoluteRoot, config);
  // Restart recovery: any proven terminal operation in this control root with an
  // incomplete resource receipt is reconciled before new work starts.
  await reconcileTerminalOperationResources(absoluteRoot).catch(() => undefined);
  if (suppliedDecision) assertIntentDecisionForRoute(suppliedDecision, kind === "audit" ? "audit" : kind === "change" ? "change" : "run");
  if (leadInitiated) {
    if (!suppliedDecision?.continuation?.operationId) await assertNoImplicitLeadRecoveryForLineage(absoluteRoot, initiator.userTurnId, operationTaskId(payload));
    await assertConfiguredGlobalOwnerBoundaryForLead(absoluteRoot, config);
  }
  if (config) await assertOperationCapacity(absoluteRoot, config, operationPriority(payload));

  let changePreflight: ChangePreflightV1 | undefined;
  if (kind === "change" && !(payload as ChangeOperationPayload).issueIntake) {
    if (!config) throw new Error("CHANGE_PREFLIGHT_CONFIG_REQUIRED: project configuration must be loaded before resolving route and assurance.");
    changePreflight = await (options.resolveChangePreflight ?? resolveChangePreflightV1)(absoluteRoot, config, payload as ChangeOperationPayload);
  }

  const now = new Date().toISOString();
  const id = createOperationId(kind, JSON.stringify(payload));
  const createAndPersistRecord = async (recoveryParent?: OperationRecordV2): Promise<OperationRecordV2> => {
    const origin = await createOperationOrigin(absoluteRoot, kind, payload, initiator, now, config, options.ownerResolutionOperationIds, recoveryParent);
    const initial: OperationRecordV2 = {
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
      origin,
      intent: initialIntent(kind, payload, changePreflight),
      ...(changePreflight ? { changePreflight } : {}),
      supervision: { required: kind === "audit" || kind === "change", materialized: false, generations: [] },
      stages: { queued: { name: "queued", status: "RUNNING", revision: 1, startedAt: now } },
      participants: {},
      progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
      notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 }
    };
    await saveOperation(absoluteRoot, initial);
    return initial;
  };
  const parentOperationId = suppliedDecision?.continuation?.operationId;
  let record: OperationRecordV2;
  if (parentOperationId) {
    record = await withOperationRecoveryParentLock(absoluteRoot, parentOperationId, async (parent, existingChildOperationId) => {
      if (parent.status !== "FAILED") throw new Error("OPERATION_RECOVERY_PARENT_NOT_FAILED: only a terminal failed operation can authorize a recovery continuation.");
      if (existingChildOperationId) throw Object.assign(new Error(`OPERATION_RECOVERY_PARENT_NOT_LEAF: operation ${parent.id} already has child ${existingChildOperationId}; continue only from the current failed leaf.`), { code: "OPERATION_RECOVERY_PARENT_NOT_LEAF", relatedOperationId: existingChildOperationId });
      return createAndPersistRecord(parent);
    });
  } else {
    record = await createAndPersistRecord();
  }

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
  if (isTerminalOperation(record.status)) {
    // Crash-recovery reconciliation: a controller that died between
    // terminalization and cleanup leaves a durable terminal operation whose
    // registry is incomplete. Re-running the operation execute path (or the
    // project-level sweep) reclaims exactly those proven terminal orphans.
    await reconcileOperationResources(absoluteRoot, operationId, {
      ...(deps.run ? { run: deps.run } : {}),
      ...(deps.trace ? { trace: deps.trace } : {}),
      ...(deps.inspectProviderSession
        ? { inspectAgent: (cwd: string, agentId: string) => deps.inspectProviderSession!(cwd, "paseo", agentId) }
        : {}),
      ...(deps.listOperationAgents ? { listOwnedAgents: deps.listOperationAgents } : {})
    }).catch(async (error: unknown) => {
      await trace(absoluteRoot, "operation.resource.recovery-failed", { operationId, error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
    });
    return record;
  }
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
      phase: record.ownerEconomicBoundary ? "HUMAN_REQUIRED" : record.pause ? "PAUSED" : record.continuation?.state === "WAITING" ? "HUMAN_REQUIRED" : "preparing",
      startedAt: record.startedAt ?? new Date().toISOString(),
      pid: process.pid,
      error: undefined
    });
    process.env.AEH_OPERATION_ID = record.id;

    if (record.ownerEconomicBoundary) {
      config = await loadProjectConfigIfPresent(absoluteRoot);
      return await terminalizeOperation(absoluteRoot, operationId, {
        status: "FAILED",
        phase: "HUMAN_REQUIRED",
        error: `HUMAN_REQUIRED: ${record.ownerEconomicBoundary.reason}`,
        finishedAt: new Date().toISOString()
      }, deps, config);
    }

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
      // AUDIT executes bounded read-only reviewers under the delegated review route; the
      // bootstrap policy must bind the same route/assurance the audit TaskContract declares,
      // otherwise participant structured-result launches reject the policy as stale.
      const payload = record.payload as AuditOperationPayload;
      bootstrapRoute = "DELEGATED";
      bootstrapAssurance = payload.risk === "high" ? "CRITICAL" : "STANDARD";
      record = await patchOperation(absoluteRoot, operationId, {
        intent: { ...record.intent, route: bootstrapRoute, assurance: bootstrapAssurance }
      });
    } else if (record.kind === "run") {
      const payload = record.payload as RunOperationPayload;
      runContract = await loadTaskContract(absoluteRoot, payload.taskId, config);
      bootstrapRoute = runContract.routing?.route;
      bootstrapAssurance = runContract.routing?.assurance;
    } else {
      const payload = record.payload as ChangeOperationPayload;
      if (payload.issueIntake) {
        // Controller-owned GitHub issue intake: the operation's deliverable is the authored,
        // sealed TaskContract, so it binds a deterministic normalization policy and never runs
        // the change implementation pipeline. The Planner launches inside this managed operation
        // with controller-issued authority, a candidate revision, and the current epoch.
        bootstrapRoute = "DELEGATED";
        bootstrapAssurance = "STANDARD";
        record = await patchOperation(absoluteRoot, operationId, {
          intent: { ...record.intent, route: bootstrapRoute, assurance: bootstrapAssurance }
        });
      } else {
        preparedChange = await prepareChangeOperation(absoluteRoot, config, record, payload);
      }
      if (!payload.issueIntake && record.continuation) {
        if (record.intent?.route !== "FORMAL_SDD" || !record.intent.assurance) throw new Error("DECISION_CONTINUATION_TARGET_INVALID: persisted Spec Manager continuation has no frozen FORMAL_SDD route.");
        bootstrapRoute = record.intent.route;
        bootstrapAssurance = record.intent.assurance;
      } else if (!payload.issueIntake) {
        bootstrapRoute = preparedChange!.triage.route;
        bootstrapAssurance = preparedChange!.triage.assurance;
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

    if (record.kind === "change" && (record.payload as ChangeOperationPayload).issueIntake) {
      return await executeIssueIntakeOperation(absoluteRoot, config, record, deps, trace);
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
      workspaceWarning: workspace.warning,
      ...(workspace.disposition ? { workspaceDisposition: workspace.disposition } : {})
    });
    if (workspace.disposition && workspace.workspaceId) {
      const workspaceIdentity = workspace.workspaceId;
      await registerOperationResource(absoluteRoot, operationId, {
        kind: "paseo-workspace",
        identity: workspaceIdentity,
        reclaim: workspace.disposition === "DELIVERY_REUSED" ? "RETAIN_SHARED" : "ARCHIVE_ON_TERMINAL",
        path: executionRoot,
        label: `${record.kind} ${record.id}`,
        owner: {
          candidateDigest: record.candidateRevision?.identityDigest,
          operationExecutionRevision: record.operationExecutionRevision,
          controllerEpoch: record.controller?.epoch,
          source: "controller-registration"
        }
      }, { policy: operationResourcePolicy(config) }).catch((error: unknown) => trace(absoluteRoot, "operation.resource.register-failed", {
        operationId,
        kind: "paseo-workspace",
        identity: workspaceIdentity,
        error: error instanceof Error ? error.message : String(error)
      }).catch(() => undefined));
    }
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
      // Binding a workspace candidate clears the frozen policy; participant launches require
      // a policy that binds the current candidate revision and digest before they can start.
      record = await bindBootstrapOperationPolicy(absoluteRoot, config, record, bootstrapRoute, bootstrapAssurance, runContract);
    } else await assertWorkspaceMatchesCandidate(executionRoot, priorCandidate);
    await syncOperationPortfolio(absoluteRoot, config.project.name, record);
    stopWatchdog = (deps.startWatchdog ?? startOperationWatchdog)(absoluteRoot, config, operationId);

    if (record.kind === "audit") {
      const payload = record.payload as AuditOperationPayload;
      const report = await (deps.runAudit ?? runAudit)(executionRoot, config, { ...payload, auditId: record.id });
      const current = await loadOperation(absoluteRoot, operationId);
      if (current.status === "CANCELLED") return current;
      const ownerBoundary = current.ownerEconomicBoundary;
      return await terminalizeOperation(
        absoluteRoot,
        operationId,
        {
          status: ownerBoundary ? "FAILED" : "SUCCEEDED",
          phase: ownerBoundary ? "HUMAN_REQUIRED" : "finished",
          ...(ownerBoundary ? { error: `HUMAN_REQUIRED: ${ownerBoundary.reason}` } : {}),
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
      const ownerBoundary = current.ownerEconomicBoundary;
      // A FAILED change run must carry its owning failing checks in the durable operation record
      // instead of terminalizing with `error: null` (AEH-V2-0118).
      const runFailure = result.run.status === "PASS" ? undefined : operationFailureDetail(result.run);
      return await terminalizeOperation(
        absoluteRoot,
        operationId,
        {
          status: !ownerBoundary && result.run.status === "PASS" ? "SUCCEEDED" : "FAILED",
          phase: ownerBoundary ? "HUMAN_REQUIRED" : "finished",
          ...(ownerBoundary ? { error: `HUMAN_REQUIRED: ${ownerBoundary.reason}` } : runFailure ? { error: runFailure } : {}),
          finishedAt: new Date().toISOString(),
          result: {
            taskId: result.taskId,
            route: result.route,
            status: result.run.status,
            attempts: result.run.attempts,
            acceptanceOracle: result.run.acceptanceOracle,
            acceptanceOracleArtifact: result.run.acceptanceOracleArtifact,
            ...(result.run.delivery ? { delivery: { status: result.run.delivery.status, committed: result.run.delivery.committed, pushed: result.run.delivery.pushed, pullRequest: result.run.delivery.pullRequest } } : {}),
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
    const ownerBoundary = current.ownerEconomicBoundary;
    const runFailure = result.status === "PASS" ? undefined : operationFailureDetail(result);
    return await terminalizeOperation(
      absoluteRoot,
      operationId,
      {
        status: !ownerBoundary && result.status === "PASS" ? "SUCCEEDED" : "FAILED",
        phase: ownerBoundary ? "HUMAN_REQUIRED" : "finished",
        ...(ownerBoundary ? { error: `HUMAN_REQUIRED: ${ownerBoundary.reason}` } : runFailure ? { error: runFailure } : {}),
        finishedAt: new Date().toISOString(),
        result: {
          taskId: result.taskId,
          status: result.status,
          attempts: result.attempts,
          acceptanceOracle: result.acceptanceOracle,
          acceptanceOracleArtifact: result.acceptanceOracleArtifact,
          ...(result.delivery ? { delivery: { status: result.delivery.status, committed: result.delivery.committed, pushed: result.delivery.pushed, pullRequest: result.delivery.pullRequest } } : {}),
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
    const ownerBoundary = current.ownerEconomicBoundary;
    return await terminalizeOperation(
      absoluteRoot,
      operationId,
      {
        status: "FAILED",
        phase: ownerBoundary ? "HUMAN_REQUIRED" : "failed",
        error: ownerBoundary ? `HUMAN_REQUIRED: ${ownerBoundary.reason}` : error instanceof Error ? error.stack ?? error.message : String(error),
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
      reason: "the controller uses the Paseo CLI to stop exact operation-owned agents",
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
  assertResolvedOperationPolicyV2(policy);
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

async function createOperationOrigin(root: string, kind: OperationKind, payload: OperationPayload, initiator: StartOperationOptions["initiator"], createdAt: string, config?: HarnessProjectConfig, ownerResolutionOperationIds?: string[], recoveryParent?: OperationRecordV2) {
  const decision = "intentDecision" in payload ? payload.intentDecision : undefined;
  // A Lead's IntentDecision userTurnId is semantic model output, not trusted
  // Owner provenance. Only a controller-supplied initiator identity may bind it.
  const userTurnId = initiator?.userTurnId;
  // `decision.userTurnId` is descriptive semantic output. Only the trusted
  // controller initiator may supply a user-turn identity for durable origin.
  const request = "request" in payload ? payload.request : "taskId" in payload ? payload.taskId : `${kind} operation`;
  const requestDigest = sha256Canonical({ kind, request, userTurnId: userTurnId ?? null });
  const authorizationDigest = sha256Canonical(decision ?? { initiator: initiator?.kind ?? "CLI", requestDigest });
  const controllerOwnerId = `controller:${process.pid}`;
  const parentOperationId = decision?.continuation?.operationId;
  const leadInitiated = initiator?.kind === "LEAD" || Boolean(decision && decision.source !== "explicit-cli");
  if (ownerResolutionOperationIds?.length && initiator?.kind !== "CLI") throw new Error("OWNER_RESOLUTION_AUTHORITY_DENIED: only an explicit Owner CLI start may resolve a pending boundary or failed task chain.");
  if (parentOperationId && ownerResolutionOperationIds?.length) throw new Error("OWNER_RESOLUTION_TARGET_INVALID: a linked recovery cannot also resolve an Owner boundary.");
  if (leadInitiated && !initiator?.requestEventId && !userTurnId) throw new Error("OPERATION_ORIGIN_CAUSAL_EVENT_REQUIRED: Lead-started operations require a durable MCP request event id or user-turn id.");
  if (parentOperationId) {
    const parent = recoveryParent ?? await loadOperation(root, parentOperationId);
    if (parent.status !== "FAILED") throw new Error("OPERATION_RECOVERY_PARENT_NOT_FAILED: only a terminal failed operation can authorize a recovery continuation.");
    if (parent.ownerEconomicBoundary) throw new Error("OPERATION_RECOVERY_OWNER_BOUNDARY: a linked continuation cannot bypass an Owner economic boundary; the human Owner must authorize a fresh top-level request under a changed policy.");
    if (parent.ownerContinuationBoundary) throw new Error("OPERATION_RECOVERY_OWNER_BOUNDARY: a hard-deadline operation cannot be continued as a linked child; a distinct new Owner request is required.");
    const parentPolicy = parent.resolvedOperationPolicy;
    if (!parentPolicy) throw new Error("OPERATION_RECOVERY_AUTHORITY_MISSING: failed parent has no frozen policy to inherit.");
    assertResolvedOperationPolicyV2(parentPolicy);
    const parentUsage = await collectOperationEconomicUsageV1(root, parent);
    remainingEconomicEnvelopeForRecoveryV1(parentPolicy.economicEnvelope, parentUsage);
    const recoveryDepth = (parent.origin?.recoveryDepth ?? 0) + 1;
    if (recoveryDepth > 2) throw new Error("OPERATION_RECOVERY_BUDGET_EXHAUSTED: failed-operation recovery depth is limited to two linked continuations.");
    const rootHardDeadlineAt = parent.origin?.rootHardDeadlineAt
      ?? parentPolicy.economicEnvelope.hardDeadlineAt
      ?? new Date(Date.parse(parent.createdAt) + parentPolicy.executionLiveness.hardDeadlineMs).toISOString();
    return compileOperationOriginV1({
      kind: "FAILED_OPERATION_RECOVERY",
      ...(initiator?.agentId ? { leadAgentId: initiator.agentId } : {}),
      controllerOwnerId,
      ...(initiator?.requestEventId ? { requestEventId: initiator.requestEventId } : {}),
      authorizationDigest,
      ...(userTurnId ? { userTurnId } : parent.origin?.userTurnId ? { userTurnId: parent.origin.userTurnId } : {}),
      parentOperationId: parent.id,
      parentTerminalRevision: parent.revision,
      triggerEventId: `operation.terminal:${parent.id}:${parent.revision}`,
      requestDigest,
      inheritedAuthorityDigest: sha256Canonical({ parentPolicyDigest: parentPolicy.digest, allowedExternalEffects: parentPolicy.allowedExternalEffects, parentOriginDigest: parent.origin?.digest ?? null, inheritedEconomicUsageDigest: parentUsage.digest }),
      inheritedEconomicUsageDigest: parentUsage.digest,
      recoveryDepth,
      rootHardDeadlineAt,
      reason: (decision?.requestedOutcome ?? request).slice(0, 1000),
      createdAt
    });
  }
  const ownerResolutionRefs = initiator?.kind === "CLI" ? await ownerResolutionRefsForCliStart(root, ownerResolutionOperationIds, config) : undefined;
  const hardDeadlineMs = configLivenessHardDeadline(config);
  return compileOperationOriginV1({
    kind: initiator?.kind === "CLI" ? "EXPLICIT_CLI" : userTurnId ? "USER_REQUEST" : "LEAD_ACTION",
    ...(initiator?.agentId ? { leadAgentId: initiator.agentId } : {}),
    controllerOwnerId,
    ...(initiator?.requestEventId ? { requestEventId: initiator.requestEventId } : {}),
    ...(ownerResolutionRefs?.length ? { ownerResolutionRefs } : {}),
    authorizationDigest,
    ...(userTurnId ? { userTurnId } : {}),
    triggerEventId: userTurnId ? `user.turn:${userTurnId}` : initiator?.requestEventId ? `aeh-control.request:${initiator.requestEventId}` : `cli.request:${requestDigest}`,
    requestDigest,
    recoveryDepth: 0,
    rootHardDeadlineAt: new Date(Date.parse(createdAt) + hardDeadlineMs).toISOString(),
    reason: (decision?.requestedOutcome ?? request).slice(0, 1000),
    createdAt
  });
}

async function readOperationRecords(stateRoot: string): Promise<OperationRecordV2[]> {
  const directory = path.resolve(stateRoot, ".harness", "operations");
  const entries = (await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error)))
    .filter((name) => name !== "portfolio.json" && /^[A-Z][A-Za-z0-9_-]+\.json$/.test(name));
  return Promise.all(entries.map((entry) => loadOperation(stateRoot, entry.slice(0, -".json".length))));
}

async function materializeOverdueOperationDeadlines(root: string, config?: HarnessProjectConfig): Promise<void> {
  const stateRoot = resolveOperationStateRoot(root);
  for (const operation of await readOperationRecords(stateRoot)) {
    if (operation.status !== "QUEUED" && operation.status !== "RUNNING") continue;
    // Expire only a deadline that was frozen with the operation. A current
    // project default cannot retroactively authorize watchdog terminalization.
    const deadline = frozenOperationHardDeadlineAt(operation);
    if (deadline === undefined) continue;
    const now = Date.now();
    if (now >= deadline) await expireOperationAtHardDeadline(stateRoot, operation.id, new Date(now), config);
  }
}

function pendingOwnerResolutionRefs(records: OperationRecordV2[]): OperationOwnerResolutionRefV1[] {
  const refs: OperationOwnerResolutionRefV1[] = [];
  for (const operation of records) {
    const economic = operation.ownerEconomicBoundary;
    if (economic?.state === "WAITING") refs.push({ kind: "OWNER_ECONOMIC_BOUNDARY", operationId: operation.id, operationRevision: operation.revision, evidenceDigest: economic.digest });
    const deadline = operation.ownerContinuationBoundary;
    if (deadline?.state === "WAITING") refs.push({ kind: "OWNER_HARD_DEADLINE", operationId: operation.id, operationRevision: operation.revision, evidenceDigest: deadline.digest });
  }
  const children = new Map<string, OperationRecordV2[]>();
  for (const operation of records) {
    const parent = operation.origin?.parentOperationId;
    if (parent) children.set(parent, [...(children.get(parent) ?? []), operation]);
  }
  const collectDescendants = (operationId: string, seen = new Set<string>()): OperationRecordV2[] => {
    if (seen.has(operationId)) return [];
    seen.add(operationId);
    return (children.get(operationId) ?? []).flatMap((child) => [child, ...collectDescendants(child.id, seen)]);
  };
  for (const operation of records) {
    if ((operation.status !== "FAILED" && operation.status !== "CANCELLED") || operation.origin?.parentOperationId) continue;
    const chain = [operation, ...collectDescendants(operation.id)];
    const leaves = chain.filter((item) => !(children.get(item.id)?.length));
    const unresolvedLeaves = leaves.filter((item) => item.status !== "SUCCEEDED");
    if (!unresolvedLeaves.length) continue;
    const evidenceDigest = sha256Canonical(chain.map((item) => ({
      operationId: item.id,
      status: item.status,
      finishedAt: item.finishedAt ?? null,
      originDigest: item.origin?.digest ?? null,
      parentOperationId: item.origin?.parentOperationId ?? null,
      candidateDigest: item.candidateRevision?.identityDigest ?? null,
      policyDigest: item.resolvedOperationPolicy?.digest ?? null
    })).sort((left, right) => left.operationId.localeCompare(right.operationId)));
    refs.push({
      kind: operation.status === "CANCELLED" ? "CANCELLED_TASK_CHAIN" : "FAILED_TASK_CHAIN",
      operationId: operation.id,
      operationRevision: operation.revision,
      evidenceDigest
    });
  }
  return refs.sort((left, right) => left.operationId.localeCompare(right.operationId) || left.kind.localeCompare(right.kind));
}

async function ownerResolutionRefsForCliStart(root: string, operationIds: string[] | undefined, config?: HarnessProjectConfig): Promise<OperationOwnerResolutionRefV1[] | undefined> {
  if (!operationIds?.length) return undefined;
  const uniqueIds = [...new Set(operationIds)];
  if (uniqueIds.length !== operationIds.length) throw new Error("OWNER_RESOLUTION_TARGET_INVALID: duplicate operation ids are not allowed.");
  const stateRoot = resolveOperationStateRoot(root);
  const records = await readOperationRecords(stateRoot);
  const pending = pendingOwnerResolutionRefs(records);
  const selected = pending.filter((reference) => uniqueIds.includes(reference.operationId));
  const missing = uniqueIds.filter((operationId) => !selected.some((reference) => reference.operationId === operationId));
  if (missing.length) throw new Error(`OWNER_RESOLUTION_TARGET_INVALID: operation(s) ${missing.join(", ")} have no current pending Owner boundary or failed task chain to resolve.`);

  const byId = new Map(records.map((operation) => [operation.id, operation]));
  const children = new Map<string, OperationRecordV2[]>();
  for (const operation of records) {
    const parent = operation.origin?.parentOperationId;
    if (parent) children.set(parent, [...(children.get(parent) ?? []), operation]);
  }
  const chainMembers = new Map<string, OperationRecordV2>();
  const addChain = (operationId: string, seen = new Set<string>()): void => {
    if (seen.has(operationId)) return;
    seen.add(operationId);
    const operation = byId.get(operationId);
    if (!operation) return;
    chainMembers.set(operation.id, operation);
    for (const child of children.get(operationId) ?? []) addChain(child.id, seen);
  };
  for (const operationId of uniqueIds) addChain(operationId);
  const active = [...chainMembers.values()].filter((operation) => operation.status === "QUEUED" || operation.status === "RUNNING");
  if (active.length) throw new Error(`OWNER_RESOLUTION_OPERATION_ACTIVE: cannot resolve ${uniqueIds.join(", ")} while operation(s) ${active.map((operation) => operation.id).join(", ")} still have active controllers or participants.`);
  for (const operation of chainMembers.values()) {
    const receipt = await reconcileOperationResources(stateRoot, operation.id);
    if (!receipt.cleanupComplete || receipt.classification.liveOwned > 0) {
      throw new Error(`OWNER_RESOLUTION_CLEANUP_REQUIRED: operation ${operation.id} must have zero live owned resources and a complete terminal cleanup receipt before Owner resolution.`);
    }
  }
  const currentPending = pendingOwnerResolutionRefs(await readOperationRecords(stateRoot));
  const currentSelected = currentPending.filter((reference) => uniqueIds.includes(reference.operationId));
  if (selected.some((reference) => !currentSelected.some((current) => current.kind === reference.kind && current.operationId === reference.operationId
    && current.evidenceDigest === reference.evidenceDigest && reference.operationRevision <= current.operationRevision))) {
    throw new Error("OWNER_RESOLUTION_EVIDENCE_STALE: selected boundary/task-chain evidence changed during terminal resource reconciliation; inspect the current operation and retry with exact pending state.");
  }
  for (const reference of selected.filter((item) => item.kind === "OWNER_ECONOMIC_BOUNDARY")) {
    const operation = await loadOperation(stateRoot, reference.operationId);
    const boundary = operation.ownerEconomicBoundary;
    const envelope = config?.orchestration?.operations?.economicEnvelope;
    const newLimit = boundary?.budget === "HARD_COST_USD" ? envelope?.hardCostUsd
      : boundary?.budget === "HARD_TOTAL_TOKENS" ? envelope?.hardTotalTokens
        : envelope?.hardToolCalls;
    if (!boundary || !envelope || Object.is(newLimit, boundary.configuredLimit)) {
      throw new Error(`OWNER_POLICY_CHANGE_REQUIRED: resolving ${boundary?.budget ?? "an economic boundary"} on operation ${operation.id} requires a reviewed project economicEnvelope change before an explicit CLI start.`);
    }
  }
  return selected;
}

function configuredOwnerBoundaryScope(config?: HarnessProjectConfig): "CHAIN_SCOPED_BOUNDARY" | "PROJECT_OR_OWNER_GLOBAL_BOUNDARY" {
  return config?.orchestration?.operations?.ownerBoundaryScope ?? "CHAIN_SCOPED_BOUNDARY";
}

async function assertConfiguredGlobalOwnerBoundaryForLead(root: string, config?: HarnessProjectConfig): Promise<void> {
  if (configuredOwnerBoundaryScope(config) !== "PROJECT_OR_OWNER_GLOBAL_BOUNDARY") return;
  const records = await readOperationRecords(resolveOperationStateRoot(root));
  // A FAILED_TASK_CHAIN/CANCELLED_TASK_CHAIN is never promoted to a project lock.
  const pending = pendingOwnerResolutionRefs(records).filter((reference) => reference.kind === "OWNER_ECONOMIC_BOUNDARY" || reference.kind === "OWNER_HARD_DEADLINE");
  const resolved = records.flatMap((operation) => operation.origin?.kind === "EXPLICIT_CLI" ? operation.origin.ownerResolutionRefs ?? [] : []);
  for (const reference of pending.sort((left, right) => left.operationId.localeCompare(right.operationId))) {
    const hasResolution = resolved.some((ownerResolution) => ownerResolution.kind === reference.kind
      && ownerResolution.operationId === reference.operationId
      && ownerResolution.evidenceDigest === reference.evidenceDigest
      && ownerResolution.operationRevision <= reference.operationRevision);
    if (hasResolution) continue;
    if (reference.kind === "OWNER_ECONOMIC_BOUNDARY") {
      const operation = records.find((item) => item.id === reference.operationId)!;
      const boundary = operation.ownerEconomicBoundary!;
      throw new Error(`PROJECT_OR_OWNER_GLOBAL_BOUNDARY_STILL_WAITING: operation ${operation.id} is reserved project-wide for an explicit Owner decision after ${boundary.budget}; run an Owner-authorized CLI start naming --resolve-operation ${operation.id} after reviewing the policy.`);
    }
    throw new Error(`PROJECT_OR_OWNER_GLOBAL_BOUNDARY_STILL_WAITING: operation ${reference.operationId} reached its frozen hard deadline; run an Owner-authorized CLI start naming --resolve-operation ${reference.operationId}.`);
  }
}

function operationTaskId(payload: OperationPayload): string | undefined {
  if (!("taskId" in payload)) return undefined;
  const taskId = payload.taskId;
  return typeof taskId === "string" && taskId.trim() ? taskId.trim() : undefined;
}

async function assertNoImplicitLeadRecoveryForLineage(root: string, userTurnId?: string, taskId?: string): Promise<void> {
  if (!userTurnId && !taskId) return;
  const records = await readOperationRecords(resolveOperationStateRoot(root));
  const byId = new Map(records.map((operation) => [operation.id, operation]));
  const children = new Map<string, OperationRecordV2[]>();
  for (const operation of records) {
    const parent = operation.origin?.parentOperationId;
    if (parent) children.set(parent, [...(children.get(parent) ?? []), operation]);
  }
  const collectChain = (rootId: string): OperationRecordV2[] => {
    const chain: OperationRecordV2[] = [];
    const seen = new Set<string>();
    const visit = (operationId: string): void => {
      if (seen.has(operationId)) return;
      seen.add(operationId);
      const operation = byId.get(operationId);
      if (!operation) return;
      chain.push(operation);
      for (const child of children.get(operationId) ?? []) visit(child.id);
    };
    visit(rootId);
    return chain;
  };
  const pending = pendingOwnerResolutionRefs(records);
  for (const reference of [...pending.filter((item) => item.kind === "OWNER_ECONOMIC_BOUNDARY" || item.kind === "OWNER_HARD_DEADLINE"), ...pending.filter((item) => item.kind === "FAILED_TASK_CHAIN" || item.kind === "CANCELLED_TASK_CHAIN")]) {
    const chain = collectChain(reference.operationId);
    const sameTurn = Boolean(userTurnId && chain.some((operation) => operation.origin?.userTurnId === userTurnId));
    const sameTask = Boolean(taskId && chain.some((operation) => operationTaskId(operation.payload) === taskId));
    if (!sameTurn && !sameTask) continue;
    if (reference.kind === "OWNER_ECONOMIC_BOUNDARY" || reference.kind === "OWNER_HARD_DEADLINE") {
      throw new Error(`OPERATION_OWNER_BOUNDARY_STILL_WAITING: operation ${reference.operationId} has a chain-scoped Owner boundary for this lineage; continue only through its explicit linked path or wait for a distinct Owner request.`);
    }
    throw new Error(`OPERATION_RECOVERY_PARENT_REQUIRED: failed task chain ${reference.operationId} matches this trusted user turn or prepared task id. Continue it with an explicit continuation.operationId.`);
  }
}

function configLivenessHardDeadline(config?: HarnessProjectConfig): number {
  return config?.orchestration?.operations?.liveness?.hardDeadlineMs ?? 8 * 60 * 60_000;
}

export async function terminalizeOperation(
  root: string,
  operationId: string,
  patch: Partial<OperationRecordV2> & { status: "SUCCEEDED" | "FAILED" | "CANCELLED" },
  deps: OperationControllerDeps,
  config?: HarnessProjectConfig
): Promise<OperationRecordV2> {
  let transition: Awaited<ReturnType<typeof transitionOperationToTerminal>>;
  const evaluateEconomicBoundary = async (operation: OperationRecordV2, targetStatus: "SUCCEEDED" | "FAILED") => {
    const { inspectOwnerEconomicBoundaryAtTerminalV1 } = await import("./executionLiveness.js");
    return inspectOwnerEconomicBoundaryAtTerminalV1(root, operation, targetStatus);
  };
  try { transition = await transitionOperationToTerminal(root, operationId, patch, evaluateEconomicBoundary); }
  catch (error) {
    const latest = await loadOperation(root, operationId).catch(() => undefined);
    if (patch.status !== "SUCCEEDED" || !latest?.ownerEconomicBoundary || !(error instanceof Error && error.message.includes("OWNER_DECISION_REQUIRED"))) throw error;
    transition = await transitionOperationToTerminal(root, operationId, {
      status: "FAILED",
      phase: "HUMAN_REQUIRED",
      error: `HUMAN_REQUIRED: ${latest.ownerEconomicBoundary.reason}`,
      finishedAt: patch.finishedAt ?? new Date().toISOString(),
      result: { ...(patch.result ?? {}), economicBoundary: { budget: latest.ownerEconomicBoundary.budget, configuredLimit: latest.ownerEconomicBoundary.configuredLimit, observed: latest.ownerEconomicBoundary.observed, usageCoverage: latest.ownerEconomicBoundary.usageCoverage, evidenceRefs: latest.ownerEconomicBoundary.evidenceRefs } }
    }, evaluateEconomicBoundary);
  }
  const { record: terminal, transitioned } = transition;
  if (terminal.status === "FAILED") {
    try {
      const forensic = await persistCandidateForensicsV1(root, terminal);
      await (deps.trace ?? recordPaseoTrace)(root, "operation.failure.forensics", {
        operationId,
        candidateId: terminal.candidateRevision?.candidateId ?? "",
        artifact: forensic.path,
        changedFileCount: forensic.artifact.changedFiles.length,
        diffDigestCoverage: forensic.artifact.diffDigestCoverage
      }).catch(() => undefined);
    } catch (error) {
      await (deps.trace ?? recordPaseoTrace)(root, "operation.failure.forensics-failed", {
        operationId,
        error: error instanceof Error ? error.message : String(error)
      }).catch(() => undefined);
    }
  }
  if (config) await writeOperationEfficiencySummary(root, config, terminal).catch(() => undefined);
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
  // Durable product-owned terminal reconciliation: release/archive/stop every
  // resource whose ownership this operation proved. Failures stay visible in
  // the receipt and are retried by the recovery sweep; they never rewrite the
  // terminal status.
  try {
    const receipt = await reconcileOperationResources(root, operationId, {
      ...(deps.run ? { run: deps.run } : {}),
      ...(deps.trace ? { trace: deps.trace } : {}),
      ...(deps.inspectProviderSession
        ? { inspectAgent: (cwd: string, agentId: string) => deps.inspectProviderSession!(cwd, "paseo", agentId) }
        : {}),
      ...(deps.listOperationAgents ? { listOwnedAgents: deps.listOperationAgents } : {})
    });
    await trace(root, "operation.resource.reconciliation", {
      operationId,
      operationStatus: terminal.status,
      cleanupComplete: receipt.cleanupComplete,
      reconciled: receipt.dispositions.filter((item) => item.outcome === "reconciled").length,
      alreadyReconciled: receipt.dispositions.filter((item) => item.alreadyReconciled).length,
      failed: receipt.errors.length
    }).catch(() => undefined);
  } catch (error) {
    await trace(root, "operation.resource.reconciliation-failed", {
      operationId,
      operationStatus: terminal.status,
      error: error instanceof Error ? error.message : String(error)
    }).catch(() => undefined);
  }
  return loadOperation(root, operationId).catch(() => terminal);
}

/** Enforce the frozen hard safety fuse from the detached watchdog. This path can only fail an
 * operation after its immutable Owner deadline, so it does not borrow controller-token authority. */
export async function expireOperationAtHardDeadline(root: string, operationId: string, at = new Date(), config?: HarnessProjectConfig, deps: OperationControllerDeps = {}): Promise<OperationRecordV2> {
  const trace = deps.trace ?? recordPaseoTrace;
  const transition = await transitionOperationAtHardDeadlineV1(root, operationId, at);
  const terminal = transition.record;
  if (!transition.transitioned) return terminal;
  try {
    const forensic = await persistCandidateForensicsV1(root, terminal);
    await trace(root, "operation.failure.forensics", { operationId, candidateId: terminal.candidateRevision?.candidateId ?? "", artifact: forensic.path, diffDigestCoverage: forensic.artifact.diffDigestCoverage }).catch(() => undefined);
  } catch (error) {
    await trace(root, "operation.failure.forensics-failed", { operationId, error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
  }
  if (config) await writeOperationEfficiencySummary(root, config, terminal).catch(() => undefined);
  if (config) await syncOperationPortfolio(root, config.project.name, terminal).catch(() => undefined);
  if (terminal.pid && terminal.pid !== process.pid) await terminateManagedProcessGroup(terminal.pid).catch(() => undefined);
  try {
    if (deps.notifyCompletion) await deps.notifyCompletion(root, terminal);
    else await notifyOperationCompletion(root, terminal, { trace });
  } catch (error) {
    await trace(root, "operation.callback.failed", { operationId, operationStatus: terminal.status, error: error instanceof Error ? error.message : String(error), boundary: "hard-deadline" }).catch(() => undefined);
  }
  try {
    await reconcileOperationResources(root, operationId, {
      ...(deps.run ? { run: deps.run } : {}),
      ...(deps.trace ? { trace: deps.trace } : {}),
      ...(deps.inspectProviderSession ? { inspectAgent: (cwd: string, agentId: string) => deps.inspectProviderSession!(cwd, "paseo", agentId) } : {}),
      ...(deps.listOperationAgents ? { listOwnedAgents: deps.listOperationAgents } : {})
    });
  } catch (error) {
    await trace(root, "operation.resource.reconciliation-failed", { operationId, operationStatus: terminal.status, error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
  }
  return loadOperation(root, operationId).catch(() => terminal);
}

/**
 * Run the controller-owned GitHub issue import inside the already-bootstrapped managed operation.
 * The bounded Planner launches with controller-issued ExecutionAuthorityV1 (candidate + epoch),
 * the authored contract and normalized snapshot persist under the control root, and the intake
 * terminal evidence is verified deterministically by the terminal gate.
 */
async function executeIssueIntakeOperation(root: string, config: HarnessProjectConfig, record: OperationRecordV2, deps: OperationControllerDeps, trace: typeof recordPaseoTrace): Promise<OperationRecordV2> {
  const operationId = record.id;
  const payload = record.payload as ChangeOperationPayload;
  const intake = payload.issueIntake!;
  const semanticRuntime = await (deps.createSemanticRuntime ?? createSemanticAssessmentRuntimeV1)(root, config, payload.profile ? { profile: payload.profile } : {});
  const prepared: IssuePreparationResult = await (deps.runIssueIntake ?? prepareGithubIssueTask)(root, config, intake.number, {
    refresh: intake.refresh,
    force: intake.force,
    semanticRuntime,
    authoringPolicy: { route: "DELEGATED", assurance: "STANDARD" }
  });
  const snapshotPath = path.posix.join((config.workflow?.issueIntake?.snapshotDir ?? ".harness/issues").replaceAll("\\", "/"), `${prepared.taskId}.json`);
  const contractPath = path.posix.join((config.sdd?.contractsDir ?? ".harness/contracts").replaceAll("\\", "/"), `${prepared.taskId}.yaml`);
  const contractContent = await fs.readFile(path.resolve(root, contractPath), "utf8");
  const sourceDigest = await computeWorktreeDigest(root);
  const current = await loadOperation(root, operationId);
  let candidateAdvanced = false;
  if (current.status === "CANCELLED") return current;
  if (current.candidateRevision && current.candidateRevision.sourceDigest !== sourceDigest) {
    await bindOperationCandidate(root, operationId, createCandidateRevisionV1({
      operationId,
      candidateId: `candidate:${operationId}:r${current.candidateRevision.revision + 1}`,
      projectId: current.candidateRevision.projectId,
      taskId: current.candidateRevision.taskId,
      revision: current.candidateRevision.revision + 1,
      parentCandidateId: current.candidateRevision.candidateId,
      sourceDigest,
      workspace: current.workspaceId,
      worktree: root,
      createdAt: new Date().toISOString()
    }));
    candidateAdvanced = true;
    await trace(root, "operation.issue-intake.candidate-advanced", { operationId, taskId: prepared.taskId, sourceDigest });
  }
  return await terminalizeOperation(root, operationId, {
    status: "SUCCEEDED",
    phase: "issue-intake-finished",
    finishedAt: new Date().toISOString(),
    result: {
      issueIntake: {
        version: 1,
        taskId: prepared.taskId,
        route: prepared.route,
        normalizedBy: prepared.normalizedBy,
        snapshot: { repository: prepared.snapshot.repository, number: prepared.snapshot.number, contentSha256: prepared.snapshot.contentSha256, path: snapshotPath },
        contract: { path: contractPath, digest: sha256Utf8(contractContent) },
        planner: { participantId: prepared.plannerParticipantId, sessionId: prepared.plannerSessionId },
        semanticAssessmentDigest: prepared.semanticAssessment?.assessmentDigest,
        traceability: prepared.traceability,
        candidateAdvanced
      }
    }
  }, deps, config);
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
      return { workspaceId: existingId, workspaceRoot: existingRoot, reusedDelivery: true, disposition: "DELIVERY_REUSED" };
    }
  }

  const title = `AEH ${record.kind.toUpperCase()} · ${record.id}`;
  if (record.kind === "audit") {
    const command = `paseo workspace create --isolation local --path ${quote(root)} --title ${quote(title)} --json`;
    await trace(root, "workspace.cli.required", { operationId: record.id, kind: record.kind, reason: "the current integration creates operation workspaces through the Paseo CLI", isolation: "local" });
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
    return { workspaceId: extractWorkspaceId(result.stdout), workspaceRoot: root, disposition: "OPERATION_OWNED" };
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
  return { workspaceId, workspaceRoot, disposition: "OPERATION_OWNED" };
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
