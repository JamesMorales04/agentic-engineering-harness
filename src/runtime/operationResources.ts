import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AehError } from "../core/errors.js";
import { sha256Canonical, sha256Utf8 } from "../core/digest.js";
import { loadProjectConfig } from "../core/config.js";
import { isDeterministicPaseoSessionId, isDeterministicPaseoRuntimeEnabled } from "../paseo/deterministicRuntime.js";
import { inspectManagedPaseoAgent, listManagedPaseoAgents } from "../paseo/runtime.js";
import { archivePaseoSdkAgent } from "../paseo/sdk.js";
import { recordPaseoTrace } from "../paseo/trace.js";
import {
  clearManagedProcessHandles,
  listManagedProcessHandles,
  runShell,
  terminateManagedProcessGroup,
  type ProcessResult
} from "../utils/process.js";
import {
  isTerminalOperation,
  loadOperation,
  operationArtifactDir,
  resolveOperationStateRoot,
  type OperationRecordV2,
  type OperationStatus
} from "../operations/state.js";
import { readManagedRuntimeSnapshot } from "./managed.js";
import { persistCandidateForensicsV1 } from "../operations/forensics.js";
import {
  RuntimeSupervisorV1,
  findConflictingProviderLeases,
  queuedForConflictingLeases,
  type ProviderLeaseQueuedV1,
  type ProviderLeaseV1,
  type RuntimeSnapshotV1,
} from "./supervisorV2.js";
import { randomUUID } from "node:crypto";

export const operationResourceKinds = [
  "paseo-workspace",
  "paseo-agent",
  "provider-session",
  "managed-process",
  "staging-root"
] as const;
export type OperationResourceKindV1 = (typeof operationResourceKinds)[number];

export const operationResourceStates = ["OWNED", "ARCHIVED", "RELEASED", "TERMINATED", "REMOVED"] as const;
export type OperationResourceStateV1 = (typeof operationResourceStates)[number];

export const operationResourceClassifications = ["LIVE_OWNED", "TERMINAL_ORPHAN", "UNKNOWN_OR_UNOWNED"] as const;
export type OperationResourceClassificationV1 = (typeof operationResourceClassifications)[number];

export const operationResourceReclaimPolicies = [
  "ARCHIVE_ON_TERMINAL",
  "STOP_ON_TERMINAL",
  "TERMINATE_ON_TERMINAL",
  "REMOVE_ON_TERMINAL",
  "RETAIN_SHARED"
] as const;
export type OperationResourceReclaimPolicyV1 = (typeof operationResourceReclaimPolicies)[number];

/** Durable ownership entry. Identity and operation binding are the only authority. */
export interface OperationResourceV1 {
  version: 1;
  resourceId: string;
  kind: OperationResourceKindV1;
  identity: string;
  operationId: string;
  reclaim: OperationResourceReclaimPolicyV1;
  path?: string;
  label?: string;
  owner: {
    candidateDigest?: string;
    operationExecutionRevision?: number;
    controllerEpoch?: number;
    participantId?: string;
    participantGeneration?: string;
    supervisorAgentId?: string;
    leaseId?: string;
    source: "controller-registration" | "operation-record" | "provider-lease" | "managed-process-handle" | "workspace-title-discovery";
  };
  createdAt: string;
  state: OperationResourceStateV1;
  releasedAt?: string;
  releaseEvidence?: Record<string, unknown>;
}

export interface OperationResourceRegistryV1 {
  version: 1;
  operationId: string;
  updatedAt: string;
  resources: OperationResourceV1[];
}

export interface OperationResourcePolicyV1 {
  maxOwnedResourcesPerOperation: number;
  maxConcurrentProviderSessionsPerOperation: number;
}

export const DEFAULT_OPERATION_RESOURCE_POLICY: OperationResourcePolicyV1 = {
  maxOwnedResourcesPerOperation: 64,
  maxConcurrentProviderSessionsPerOperation: 16
};

/**
 * Provider backpressure QUEUE helpers (Unit 3).
 *
 * MECHANISM: DETERMINISTIC for classification; bounded polling for waits.
 * `assertProviderSessionCapacity` keeps its throwing fail-closed contract.
 * `checkProviderSessionBackpressure` is the pure QUEUE classifier; waits are
 * bounded (`PROVIDER_BACKPRESSURE_MAX_WAIT_MS_V1`) and always count against
 * the caller's existing deadline (never extend caps; exhausted waits are
 * terminal). Telemetry attributes follow existing `recordEvent` conventions
 * (bounded counter/gauge observation, never a gate).
 */
export const PROVIDER_BACKPRESSURE_MAX_WAIT_MS_V1 = 30_000;
export const PROVIDER_BACKPRESSURE_POLL_MS_V1 = 50;
export const PROVIDER_BACKPRESSURE_EVENT_V1 = "harness.provider.backpressure";

export type ProviderSessionBackpressureV1 =
  | { allowed: true; active: number; ceiling: number }
  | { allowed: false; disposition: "QUEUE"; active: number; ceiling: number; retryAfterMs: number };

export interface ProviderBackpressureTelemetryV1 {
  operationId: string;
  active: number;
  ceiling: number;
  queued: number;
  retryAfterMs: number;
  disposition: "QUEUE" | "PROCEED";
}

export interface OperationResourceReconcileDeps {
  run?: typeof runShell;
  inspectAgent?: (root: string, agentId: string) => Promise<{ status?: string; workspaceId?: string } | undefined>;
  archiveAgent?: (root: string, agentId: string) => Promise<void>;
  archiveWorkspace?: (root: string, workspaceId: string) => Promise<void>;
  terminateProcess?: (pid: number) => Promise<void>;
  removeStagingRoot?: (target: string) => Promise<void>;
  /** Durable label-bound ownership discovery (`aeh.operation` is minted only by this product). */
  listOwnedAgents?: (root: string, operationId: string) => Promise<Array<{ id?: string; workspaceId?: string }>>;
  /**
   * Unbounded Paseo workspace listing for title-anchored discovery. The caller
   * filters by exact minted title; entries carry no trust until matched.
   */
  listOwnedWorkspaces?: (root: string) => Promise<OwnedWorkspaceRecord[]>;
  trace?: typeof recordPaseoTrace;
  now?: () => Date;
}

export interface OperationResourceDispositionV1 {
  resourceId: string;
  kind: OperationResourceKindV1;
  identity: string;
  classification: OperationResourceClassificationV1;
  reclaim: OperationResourceReclaimPolicyV1;
  action: "preserve" | "archive" | "stop+archive" | "terminate" | "remove" | "already-reconciled" | "none";
  outcome: "preserved-live" | "preserved-unowned" | "preserved-shared" | "reconciled" | "already-reconciled" | "failed";
  alreadyReconciled: boolean;
  error?: string;
}

export interface OperationResourceReconciliationReceiptV1 {
  version: 1;
  kind: "operation-resource-reconciliation";
  operationId: string;
  operationStatus: OperationStatus;
  operationTerminal: boolean;
  candidateDigest?: string;
  operationExecutionRevision?: number;
  controllerEpoch?: number;
  reconciledAt: string;
  classification: { liveOwned: number; terminalOrphans: number; unknownOrUnowned: number };
  dispositions: OperationResourceDispositionV1[];
  terminalOrphansRemaining: number;
  cleanupComplete: boolean;
  errors: string[];
}

export interface OperationResourceSweepResultV1 {
  version: 1;
  sweptAt: string;
  operationsScanned: number;
  terminalOperationsReconciled: number;
  terminalOperationsCurrent: number;
  liveOperationsPreserved: number;
  failures: Array<{ operationId: string; error: string }>;
}

export function operationResourcePolicy(config: { orchestration?: unknown } | undefined): OperationResourcePolicyV1 {
  const operations = (config?.orchestration as { operations?: { resources?: Partial<OperationResourcePolicyV1> } } | undefined)?.operations;
  const configured = operations?.resources;
  return {
    maxOwnedResourcesPerOperation: positive(configured?.maxOwnedResourcesPerOperation, DEFAULT_OPERATION_RESOURCE_POLICY.maxOwnedResourcesPerOperation),
    maxConcurrentProviderSessionsPerOperation: positive(configured?.maxConcurrentProviderSessionsPerOperation, DEFAULT_OPERATION_RESOURCE_POLICY.maxConcurrentProviderSessionsPerOperation)
  };
}

export function operationResourceRegistryFile(root: string, operationId: string): string {
  return path.join(operationArtifactDir(root, operationId), "resources.json");
}

export function operationResourceReceiptFile(root: string, operationId: string): string {
  return path.join(operationArtifactDir(root, operationId), "resource-reconciliation.json");
}

export function operationResourceId(operationId: string, kind: OperationResourceKindV1, identity: string): string {
  return `resource:${sha256Utf8(`${operationId}\u0000${kind}\u0000${identity}`).slice(0, 24)}`;
}

export interface OwnedWorkspaceRecord {
  workspaceId: string;
  title?: string;
  path?: string;
}

/**
 * Canonical operation workspace title minted at `paseo workspace create`
 * (E-NEW-3). The Paseo workspace CLI offers no label surface, so this title —
 * which embeds the operation id — is the durable ownership signal a recovery
 * sweep can match. Create and discovery must share this exact function.
 */
export function operationWorkspaceTitle(kind: string, operationId: string): string {
  return `AEH ${kind.toUpperCase()} · ${operationId}`;
}

/**
 * DETERMINISTIC ownership filter: keeps only workspaces whose title is
 * exactly this operation's minted title. Substring/prefix matching is refused
 * so a sibling id (for example `OP-1` vs `OP-10`) can never be claimed.
 */
export function selectOwnedWorkspaces(
  workspaces: Array<{ workspaceId: string; title?: string; path?: string }>,
  kind: string,
  operationId: string
): OwnedWorkspaceRecord[] {
  const minted = operationWorkspaceTitle(kind, operationId);
  const selected = new Map<string, OwnedWorkspaceRecord>();
  for (const workspace of workspaces) {
    if (!workspace.workspaceId || workspace.title !== minted) continue;
    const existing = selected.get(workspace.workspaceId);
    if (!existing) selected.set(workspace.workspaceId, { workspaceId: workspace.workspaceId, ...(workspace.title ? { title: workspace.title } : {}), ...(workspace.path ? { path: workspace.path } : {}) });
    else if (!existing.path && workspace.path) existing.path = workspace.path;
  }
  return [...selected.values()];
}

/** Default unbounded workspace listing (`paseo workspace ls --json`); unfiltered, untrusted until title-matched. */
export function defaultListOwnedWorkspaces(run: typeof runShell): (root: string) => Promise<OwnedWorkspaceRecord[]> {
  return async (root) => {
    if (isDeterministicPaseoRuntimeEnabled()) return [];
    const result = await run("paseo workspace ls --json", { cwd: root, timeoutMs: 60_000 }).catch(() => undefined);
    if (!result || result.exitCode !== 0 || !result.stdout.trim()) return [];
    let value: unknown;
    try { value = JSON.parse(result.stdout); }
    catch { return []; }
    const collected: OwnedWorkspaceRecord[] = [];
    collectWorkspaceRecords(value, collected);
    const deduped = new Map<string, OwnedWorkspaceRecord>();
    for (const workspace of collected) {
      if (!workspace.workspaceId || deduped.has(workspace.workspaceId)) continue;
      deduped.set(workspace.workspaceId, workspace);
    }
    return [...deduped.values()];
  };
}

function collectWorkspaceRecords(value: unknown, out: OwnedWorkspaceRecord[]): void {
  if (Array.isArray(value)) { for (const item of value) collectWorkspaceRecords(item, out); return; }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const workspaceId = typeof record.workspaceId === "string" && record.workspaceId
    ? record.workspaceId
    : typeof record.workspace_id === "string" && record.workspace_id ? record.workspace_id : undefined;
  const title = typeof record.name === "string" && record.name
    ? record.name
    : typeof record.title === "string" && record.title ? record.title : undefined;
  if (workspaceId) {
    const workspacePath = [record.cwd, record.path, record.worktreePath, record.worktree_path, record.checkoutPath]
      .find((item): item is string => typeof item === "string" && item.length > 0);
    out.push({ workspaceId, ...(title ? { title } : {}), ...(workspacePath ? { path: workspacePath } : {}) });
  }
  for (const child of Object.values(record)) collectWorkspaceRecords(child, out);
}

/**
 * Register one durably owned resource for the current operation. Registration is
 * idempotent by (kind, identity) and refuses to exceed the configured generic
 * per-operation resource ceiling (typed `RESOURCE_CEILING_EXHAUSTED`).
 */
export async function registerOperationResource(
  root: string,
  operationId: string,
  input: {
    kind: OperationResourceKindV1;
    identity: string;
    reclaim?: OperationResourceReclaimPolicyV1;
    path?: string;
    label?: string;
    owner?: Partial<OperationResourceV1["owner"]>;
  },
  options: { policy?: OperationResourcePolicyV1; now?: () => Date } = {}
): Promise<OperationResourceV1> {
  const identity = input.identity?.trim();
  if (!identity) throw new Error("OPERATION_RESOURCE_INVALID: resource identity is required.");
  if (input.path !== undefined && !path.isAbsolute(input.path)) throw new Error("OPERATION_RESOURCE_INVALID: a resource path must be absolute when provided.");
  const file = operationResourceRegistryFile(root, operationId);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  return withRegistryLock(file, async () => {
    const registry = await readRegistry(file, operationId);
    const resourceId = operationResourceId(operationId, input.kind, identity);
    const existing = registry.resources.find((resource) => resource.resourceId === resourceId);
    if (existing) return existing;
    const policy = options.policy ?? DEFAULT_OPERATION_RESOURCE_POLICY;
    const active = registry.resources.filter((resource) => resource.state === "OWNED").length;
    if (active >= policy.maxOwnedResourcesPerOperation) {
      throw new AehError("RESOURCE_CEILING_EXHAUSTED", `operation ${operationId} already owns ${active} live resources; configured ceiling ${policy.maxOwnedResourcesPerOperation}.`, {
        details: { operationId, kind: input.kind, active, ceiling: policy.maxOwnedResourcesPerOperation, disposition: "WAIT_OR_RAISE" }
      });
    }
    const resource: OperationResourceV1 = {
      version: 1,
      resourceId,
      kind: input.kind,
      identity,
      operationId,
      reclaim: input.reclaim ?? defaultReclaim(input.kind),
      ...(input.path ? { path: input.path } : {}),
      ...(input.label ? { label: input.label.slice(0, 300) } : {}),
      owner: { source: "controller-registration", ...(input.owner ?? {}) },
      createdAt: (options.now?.() ?? new Date()).toISOString(),
      state: "OWNED"
    };
    registry.resources.push(resource);
    await writeRegistry(file, registry, options.now);
    return resource;
  });
}

export async function listOperationResources(root: string, operationId: string): Promise<OperationResourceV1[]> {
  const registry = await readRegistry(operationResourceRegistryFile(root, operationId), operationId).catch(() => undefined);
  return registry?.resources ?? [];
}

/** Mark a registered resource released after the owner removed/released it in-line (idempotent). */
export async function markOperationResourceReleased(
  root: string,
  operationId: string,
  resourceId: string,
  evidence: Record<string, unknown>,
  options: { now?: () => Date } = {}
): Promise<void> {
  const file = operationResourceRegistryFile(root, operationId);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await withRegistryLock(file, async () => {
    const registry = await readRegistry(file, operationId);
    const resource = registry.resources.find((item) => item.resourceId === resourceId);
    if (!resource || resource.operationId !== operationId || resource.state !== "OWNED") return;
    resource.state = terminalStateFor(resource.kind);
    resource.releasedAt = (options.now?.() ?? new Date()).toISOString();
    resource.releaseEvidence = evidence;
    await writeRegistry(file, registry, options.now);
  });
}

export async function readOperationResourceReceipt(root: string, operationId: string): Promise<OperationResourceReconciliationReceiptV1 | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(operationResourceReceiptFile(root, operationId), "utf8")) as OperationResourceReconciliationReceiptV1;
    return parsed?.kind === "operation-resource-reconciliation" && parsed.operationId === operationId ? parsed : undefined;
  } catch { return undefined; }
}

/**
 * Reconcile the durable resources of one operation.
 *
 * Only a durably terminal operation may release resources. A live/non-terminal
 * operation is classified LIVE_OWNED and preserved; a resource without exact
 * durable ownership proof is classified UNKNOWN_OR_UNOWNED and preserved. The
 * same call on already released resources is a no-op that reports
 * `alreadyReconciled` instead of failing.
 */
export async function reconcileOperationResources(
  root: string,
  operationId: string,
  deps: OperationResourceReconcileDeps = {}
): Promise<OperationResourceReconciliationReceiptV1> {
  const now = deps.now ?? (() => new Date());
  const trace = deps.trace ?? recordPaseoTrace;
  const record = await loadOperation(root, operationId);
  const terminal = isTerminalOperation(record.status);
  const registry = await readRegistry(operationResourceRegistryFile(root, operationId), operationId);
  const dispositions: OperationResourceDispositionV1[] = [];
  const errors: string[] = [];
  const updated: OperationResourceV1[] = [...registry.resources];
  if (record.status === "FAILED") {
    try {
      const forensic = await persistCandidateForensicsV1(root, record);
      await trace(root, "operation.candidate.forensics", {
        operationId,
        candidateId: record.candidateRevision?.candidateId ?? null,
        artifact: forensic.path,
        changedFiles: forensic.artifact.changedFiles.length,
        diffDigestCoverage: forensic.artifact.diffDigestCoverage
      }).catch(() => undefined);
    } catch (error) {
      errors.push(`candidate forensics capture failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500));
    }
  }
  // Capture failed-candidate facts before collecting/releasing operation-owned resources.
  const candidates = await collectResourceCandidates(root, record, registry, deps);
  // Luna durable-handoff: a cancel-terminal operation (CANCELLED or
  // UNCERTAIN_EXTERNAL_EFFECTS) with leftover handles and WITHOUT the hook's
  // durable cleanup flag is a transition→hook crash-window orphan. Its pids
  // were already fenced by the cancellation kill loop; the numbers may since
  // have been reused. Recovery must re-run FENCED cleanup (revalidate +
  // clear, never blind-signal) instead of terminating the pids.
  // MECHANISM: DETERMINISTIC gate. Non-cancel terminals (whose handles were
  // never hook-cleared) keep the normal terminate path.
  const cancelTerminalWithoutCleanupFlag = terminal
    && (record.status === "CANCELLED" || record.phase === "UNCERTAIN_EXTERNAL_EFFECTS")
    && !record.processHandlesCleanupCompletedAt;
  const fencedManagedResources: OperationResourceV1[] = [];

  const upsert = (candidate: ResourceCandidate): OperationResourceV1 => {
    const resourceId = operationResourceId(operationId, candidate.kind, candidate.identity);
    const existing = updated.find((resource) => resource.resourceId === resourceId);
    if (existing) return existing;
    const resource: OperationResourceV1 = {
      version: 1,
      resourceId,
      kind: candidate.kind,
      identity: candidate.identity,
      operationId,
      reclaim: candidate.reclaim,
      ...(candidate.path ? { path: candidate.path } : {}),
      ...(candidate.label ? { label: candidate.label.slice(0, 300) } : {}),
      owner: candidate.owner,
      createdAt: now().toISOString(),
      state: "OWNED"
    };
    updated.push(resource);
    return resource;
  };

  for (const candidate of candidates) {
    const resource = upsert(candidate);
    if (!terminal) {
      dispositions.push({
        resourceId: resource.resourceId,
        kind: resource.kind,
        identity: resource.identity,
        classification: "LIVE_OWNED",
        reclaim: resource.reclaim,
        action: "preserve",
        outcome: "preserved-live",
        alreadyReconciled: false
      });
      continue;
    }
    if (candidate.classification === "UNKNOWN_OR_UNOWNED") {
      dispositions.push({
        resourceId: resource.resourceId,
        kind: resource.kind,
        identity: resource.identity,
        classification: "UNKNOWN_OR_UNOWNED",
        reclaim: resource.reclaim,
        action: "preserve",
        outcome: candidate.reason === "retained-shared" ? "preserved-shared" : "preserved-unowned",
        alreadyReconciled: false
      });
      continue;
    }
    // Terminal operation + exact durable ownership proof.
    if (resource.state !== "OWNED") {
      dispositions.push({
        resourceId: resource.resourceId,
        kind: resource.kind,
        identity: resource.identity,
        classification: "TERMINAL_ORPHAN",
        reclaim: resource.reclaim,
        action: "already-reconciled",
        outcome: "already-reconciled",
        alreadyReconciled: true
      });
      continue;
    }
    if (candidate.kind === "managed-process" && cancelTerminalWithoutCleanupFlag) {
      // Deferred to the fenced cleanup below: observe, never signal.
      fencedManagedResources.push(resource);
      continue;
    }
    try {
      const evidence = await releaseResource(root, record, resource, deps);
      resource.state = terminalStateFor(resource.kind);
      resource.releasedAt = now().toISOString();
      resource.releaseEvidence = evidence;
      dispositions.push({
        resourceId: resource.resourceId,
        kind: resource.kind,
        identity: resource.identity,
        classification: "TERMINAL_ORPHAN",
        reclaim: resource.reclaim,
        action: actionFor(resource.kind),
        outcome: "reconciled",
        alreadyReconciled: false
      });
      await trace(root, "operation.resource.reconciled", { operationId, kind: resource.kind, identity: resource.identity, evidence }).catch(() => undefined);
    } catch (error) {
      const message = `${resource.kind} ${resource.identity}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500);
      errors.push(message);
      dispositions.push({
        resourceId: resource.resourceId,
        kind: resource.kind,
        identity: resource.identity,
        classification: "TERMINAL_ORPHAN",
        reclaim: resource.reclaim,
        action: actionFor(resource.kind),
        outcome: "failed",
        alreadyReconciled: false,
        error: message
      });
      await trace(root, "operation.resource.reconcile-failed", { operationId, kind: resource.kind, identity: resource.identity, error: message }).catch(() => undefined);
    }
  }

  const reconciled = dispositions.filter((item) => item.outcome === "reconciled").length;
  const alreadyReconciled = dispositions.filter((item) => item.alreadyReconciled).length;
  const failed = dispositions.filter((item) => item.outcome === "failed").length;
  const liveOwned = dispositions.filter((item) => item.classification === "LIVE_OWNED").length;
  const unknownOrUnowned = dispositions.filter((item) => item.classification === "UNKNOWN_OR_UNOWNED").length;
  // FENCED cleanup for crash-window handles: revalidate each pid by
  // observation only (liveness probe, no signal), then clear the stale handle
  // files. Clearing is reported, never swallowed: a failed clear keeps the
  // dispositions failed so the next sweep retries instead of proceeding.
  let fencedClearError: string | undefined;
  if (terminal && fencedManagedResources.length) {
    const aliveness = new Map<string, boolean>();
    for (const resource of fencedManagedResources) {
      aliveness.set(resource.resourceId, await probeManagedPidAlive(Number.parseInt(resource.identity, 10)));
    }
    try {
      await clearManagedProcessHandles(root, operationId);
    } catch (error) {
      fencedClearError = `managed-process fenced handle clear failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500);
    }
    for (const resource of fencedManagedResources) {
      const alive = aliveness.get(resource.resourceId) ?? false;
      const evidence = {
        action: "fenced-handle-clear",
        pid: Number.parseInt(resource.identity, 10),
        alive,
        fenced: true,
        reason: "cancel-terminal operation without the durable handle-cleanup flag: crash-window handles cleared without signaling (pids were already fenced by cancellation; numbers may be reused)"
      };
      if (fencedClearError) {
        const message = `${resource.kind} ${resource.identity}: ${fencedClearError}`.slice(0, 500);
        errors.push(message);
        dispositions.push({
          resourceId: resource.resourceId,
          kind: resource.kind,
          identity: resource.identity,
          classification: "TERMINAL_ORPHAN",
          reclaim: resource.reclaim,
          action: "none",
          outcome: "failed",
          alreadyReconciled: false,
          error: message
        });
      } else {
        resource.state = terminalStateFor(resource.kind);
        resource.releasedAt = now().toISOString();
        resource.releaseEvidence = evidence;
        dispositions.push({
          resourceId: resource.resourceId,
          kind: resource.kind,
          identity: resource.identity,
          classification: "TERMINAL_ORPHAN",
          reclaim: resource.reclaim,
          action: "none",
          outcome: "reconciled",
          alreadyReconciled: false
        });
      }
    }
    await trace(root, "operation.resource.fenced-handle-clear", {
      operationId,
      pids: fencedManagedResources.map((resource) => resource.identity),
      alive: [...aliveness.entries()].filter(([, value]) => value).map(([key]) => fencedManagedResources.find((resource) => resource.resourceId === key)?.identity),
      cleared: !fencedClearError,
      ...(fencedClearError ? { error: fencedClearError } : {})
    }).catch(() => undefined);
  }

  const terminalOrphansRemaining = dispositions.filter((item) => item.classification === "TERMINAL_ORPHAN" && item.outcome === "failed").length;
  // Handle-dir clear failures are REPORTED, never swallowed: the clear runs
  // before the receipt is built so a failed clear keeps cleanupComplete false
  // and the next sweep retries instead of proceeding with stale handles.
  let handleClearError: string | undefined;
  if (terminal && deps.archiveWorkspace === undefined && deps.archiveAgent === undefined) {
    try {
      await clearManagedProcessHandles(root, operationId);
    } catch (error) {
      handleClearError = `managed-process handle clear failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500);
      errors.push(handleClearError);
    }
  }
  const receipt: OperationResourceReconciliationReceiptV1 = {
    version: 1,
    kind: "operation-resource-reconciliation",
    operationId,
    operationStatus: record.status,
    operationTerminal: terminal,
    ...(record.candidateRevision ? { candidateDigest: record.candidateRevision.identityDigest } : {}),
    ...(record.operationExecutionRevision !== undefined ? { operationExecutionRevision: record.operationExecutionRevision } : {}),
    ...(record.controller ? { controllerEpoch: record.controller.epoch } : {}),
    reconciledAt: now().toISOString(),
    classification: { liveOwned, terminalOrphans: dispositions.filter((item) => item.classification === "TERMINAL_ORPHAN").length, unknownOrUnowned },
    dispositions,
    terminalOrphansRemaining,
    cleanupComplete: terminal && terminalOrphansRemaining === 0 && !handleClearError,
    errors
  };

  if (terminal) {
    await writeRegistry(fileFor(root, operationId), { version: 1, operationId, updatedAt: now().toISOString(), resources: updated }, deps.now);
    await writeJsonAtomic(operationResourceReceiptFile(root, operationId), receipt);
    if (handleClearError) {
      await trace(root, "operation.resource.handle-clear-failed", { operationId, error: handleClearError }).catch(() => undefined);
    }
  }
  return receipt;
}

/**
 * Deterministic recovery sweep: reconcile every durably terminal operation in
 * this control root with an incomplete resource receipt, and preserve every
 * non-terminal operation without touching its resources.
 */
export async function reconcileTerminalOperationResources(root: string, deps: OperationResourceReconcileDeps = {}): Promise<OperationResourceSweepResultV1> {
  const sweep: OperationResourceSweepResultV1 = {
    version: 1,
    sweptAt: new Date().toISOString(),
    operationsScanned: 0,
    terminalOperationsReconciled: 0,
    terminalOperationsCurrent: 0,
    liveOperationsPreserved: 0,
    failures: []
  };
  for (const operationId of await listOperationIds(root)) {
    sweep.operationsScanned += 1;
    try {
      const record = await loadOperation(root, operationId);
      if (!isTerminalOperation(record.status)) { sweep.liveOperationsPreserved += 1; continue; }
      const receipt = await readOperationResourceReceipt(root, operationId);
      if (receipt?.cleanupComplete) { sweep.terminalOperationsCurrent += 1; continue; }
      const resources = await listOperationResources(root, operationId);
      const handles = await listManagedProcessHandles(root, operationId);
      const recordOwned = Boolean(record.workspaceId || record.agents?.length || Object.keys(record.participants ?? {}).length);
      if (!resources.length && !handles.length && !recordOwned) {
        // E-NEW-3: a crash between workspace create and durable registration
        // leaves zero local surface. Consult title-anchored discovery before
        // declaring the operation current so the orphaned worktree is swept.
        const listWorkspaces = deps.listOwnedWorkspaces ?? defaultListOwnedWorkspaces(deps.run ?? runShell);
        const listed = await listWorkspaces(root).catch(() => [] as OwnedWorkspaceRecord[]);
        if (selectOwnedWorkspaces(listed, record.kind, record.id).length === 0) { sweep.terminalOperationsCurrent += 1; continue; }
      }
      const result = await reconcileOperationResources(root, operationId, deps);
      if (result.cleanupComplete) sweep.terminalOperationsReconciled += 1;
      else sweep.failures.push({ operationId, error: result.errors.join("; ") || "terminal orphaned resources remain" });
    } catch (error) {
      sweep.failures.push({ operationId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return sweep;
}

/** Capacity check for concurrent provider sessions of one operation (policy-driven, generic). */
export async function assertProviderSessionCapacity(root: string, operationId: string, ceiling?: number): Promise<void> {
  const policy = ceiling ?? (await loadResourcePolicy(root)).maxConcurrentProviderSessionsPerOperation;
  // Fail-closed: unreadable durable state BLOCKS (throws), never passes as clear.
  // Missing file means no leases yet (empty snapshot, proceed); corrupt/unreadable throws.
  const snapshot = await readManagedRuntimeSnapshot(root);
  const active = snapshot.providerLeases.filter((lease) => lease.lifecycle?.operationId === operationId).length;
  if (active >= policy) {
    throw new AehError("RESOURCE_CEILING_EXHAUSTED", `operation ${operationId} already holds ${active} active provider sessions; configured ceiling ${policy}.`, {
      details: { operationId, active, ceiling: policy, disposition: "WAIT_OR_RAISE" }
    });
  }
}

/**
 * Pure QUEUE classifier for provider session capacity. Returns QUEUE (not
 * throw) when `active` meets or exceeds `ceiling`; callers honor the bounded
 * WAIT against their existing deadline and treat exhaustion as terminal.
 */
export function checkProviderSessionBackpressure(active: number, ceiling?: number): ProviderSessionBackpressureV1 {
  const safeCeiling = typeof ceiling === "number" && Number.isFinite(ceiling) && ceiling > 0
    ? Math.floor(ceiling)
    : DEFAULT_OPERATION_RESOURCE_POLICY.maxConcurrentProviderSessionsPerOperation;
  const safeActive = typeof active === "number" && Number.isFinite(active) && active >= 0 ? Math.floor(active) : 0;
  if (safeActive < safeCeiling) return { allowed: true, active: safeActive, ceiling: safeCeiling };
  return {
    allowed: false,
    disposition: "QUEUE",
    active: safeActive,
    ceiling: safeCeiling,
    retryAfterMs: PROVIDER_BACKPRESSURE_POLL_MS_V1
  };
}

/** DETERMINISTIC classifier: true when the error is provider capacity/lease backpressure (QUEUE, not FAIL). */
export function isProviderCapacityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (message.includes("RESOURCE_CEILING_EXHAUSTED") && message.includes("active provider sessions")) return true;
  if (message.includes("already leased in")) return true;
  if (message.includes("PASEO_PROVIDER_LEASE_TAKEOVER_BLOCKED")) return true;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if ((record as { code?: unknown }).code === "RESOURCE_CEILING_EXHAUSTED") {
      const details = (record as { details?: unknown }).details;
      if (details && typeof details === "object" && (details as Record<string, unknown>).disposition === "WAIT_OR_RAISE") return true;
    }
  }
  return false;
}

/**
 * Bounded QUEUE wait for provider session capacity. Polls the durable lease
 * snapshot without widening any ceiling; the total wait never exceeds
 * `min(maxWaitMs, deadlineAtMs - now)` and an exhausted budget returns
 * `acquired: false` (terminal, fail-closed). Injectable clock/sleep/snapshot
 * keeps fixtures scripted with no network.
 *
 * MECHANISM: DETERMINISTIC. Never mints fresh time: when `deadlineAtMs` is
 * undefined (no existing wave/operation deadline can be established) the wait
 * does a single immediate check only (no sleep, no fresh 30s budget). Allowed
 * headroom proceeds immediately (no wait needed); saturation returns terminal
 * `acquired: false` with zero waits. Unreadable durability BLOCKS (terminal
 * false, never passes as clear with active=0).
 */
export async function waitForProviderSessionCapacity(
  root: string,
  operationId: string,
  options: {
    ceiling?: number;
    deadlineAtMs?: number;
    maxWaitMs?: number;
    pollMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    countActive?: () => Promise<number> | number;
  } = {}
): Promise<{ acquired: boolean; waitedMs: number; active: number; ceiling: number }> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pollMs = options.pollMs !== undefined && Number.isFinite(options.pollMs) && options.pollMs > 0
    ? Math.min(PROVIDER_BACKPRESSURE_MAX_WAIT_MS_V1, Math.floor(options.pollMs))
    : PROVIDER_BACKPRESSURE_POLL_MS_V1;
  const maxWaitMs = options.maxWaitMs !== undefined && Number.isFinite(options.maxWaitMs) && options.maxWaitMs >= 0
    ? Math.min(PROVIDER_BACKPRESSURE_MAX_WAIT_MS_V1, Math.floor(options.maxWaitMs))
    : PROVIDER_BACKPRESSURE_MAX_WAIT_MS_V1;
  const startedAt = now();
  // Luna F1: never mint fresh `now+maxWait` when no operation deadline exists.
  // Undefined deadline means no wait budget: single immediate check only.
  const hasDeadline = options.deadlineAtMs !== undefined && Number.isFinite(options.deadlineAtMs);
  const deadlineAt = hasDeadline ? Math.floor(options.deadlineAtMs!) : undefined;
  const effectiveDeadline = deadlineAt !== undefined ? Math.min(deadlineAt, startedAt + maxWaitMs) : undefined;
  const countActive = options.countActive ?? (async (): Promise<number> => {
    // Fail-closed: unreadable throws (caught below as BLOCKED terminal false);
    // missing file returns empty snapshot (active 0, proceed). Never swallow
    // corrupt into 0 (fail-open).
    const snapshot = await readManagedRuntimeSnapshot(root);
    return snapshot.providerLeases.filter((lease) => lease.lifecycle?.operationId === operationId).length;
  });
  const loadCeiling = async (): Promise<number> =>
    options.ceiling ?? (await loadResourcePolicy(root).catch(() => DEFAULT_OPERATION_RESOURCE_POLICY)).maxConcurrentProviderSessionsPerOperation;
  const ceilingForTerminal = await loadCeiling().catch(() => DEFAULT_OPERATION_RESOURCE_POLICY.maxConcurrentProviderSessionsPerOperation);
  for (;;) {
    let active: number;
    try {
      active = await countActive();
    } catch {
      // Fail-closed on unreadable durability: BLOCK (terminal false, no wait, no sleep).
      return { acquired: false, waitedMs: Math.max(0, now() - startedAt), active: ceilingForTerminal, ceiling: ceilingForTerminal };
    }
    const verdict = checkProviderSessionBackpressure(active, await loadCeiling().catch(() => DEFAULT_OPERATION_RESOURCE_POLICY.maxConcurrentProviderSessionsPerOperation));
    if (verdict.allowed) return { acquired: true, waitedMs: Math.max(0, now() - startedAt), active: verdict.active, ceiling: verdict.ceiling };
    // No existing deadline: immediate terminal, never mint a fresh wait (zero sleeps).
    if (effectiveDeadline === undefined) {
      return { acquired: false, waitedMs: Math.max(0, now() - startedAt), active: verdict.active, ceiling: verdict.ceiling };
    }
    const elapsed = now() - startedAt;
    const remainingBudget = effectiveDeadline - now();
    if (remainingBudget <= 0 || elapsed >= maxWaitMs) {
      return { acquired: false, waitedMs: Math.max(0, elapsed), active: verdict.active, ceiling: verdict.ceiling };
    }
    await sleep(Math.min(pollMs, remainingBudget, maxWaitMs - elapsed));
  }
}

/**
 * Durable atomic wave-slot acquire-or-queue (Luna F2+F3, fail-closed).
 *
 * MECHANISM: DETERMINISTIC + file-locked transact (atomic w.r.t. shared store).
 * ATOMICITY NOTE: `RuntimeSupervisorV1.acquire/tryAcquireProviderLease` is
 * synchronous and therefore atomic within one process, but it is NOT atomic
 * w.r.t. the shared durable snapshot file across waves/operations/processes
 * (each wave used a fresh in-memory supervisor, blind by construction). The
 * previous `checkDurableWaveSlotConflict` was read-only check-then-proceed
 * (TOCTOU): two racers could both read empty and both proceed. It is deleted.
 * This primitive is the REAL atomic lease path: one root-scoped `.lock` file
 * serializes reload→check→write so concurrent callers never both proceed.
 * The same `findConflictingProviderLeases` predicate as `tryAcquireProviderLease`
 * is evaluated inside the lock; ACQUIRED persists the new lease atomically,
 * QUEUED persists nothing.
 *
 * Fail-closed: missing file means no leases yet (empty snapshot, may ACQUIRE);
 * corrupt/unreadable/invalid snapshot never proceeds (QUEUED-terminal, no write,
 * no wait when retryAfter is 0). Missing/empty identity throws (never ACQUIRE).
 * No fresh time: `remainingBudgetMs` undefined means single immediate attempt
 * only (no sleep, no fresh 30s); defined budget bounds total WAIT via
 * `min(retryAfter, remaining)`; exhaustion is terminal QUEUED (caller FAILs).
 * Deterministic clocks via `nowMs`/`sleepMs`; observation-only telemetry via
 * existing `recordEvent` conventions (callers emit, never gate on it).
 */
export interface DurableWaveSlotInputV1 {
  provider: string;
  projectId: string;
  canonicalRoot: string;
  workspaceId: string;
  ownerId: string;
  mode?: "read" | "write";
  ttlMs?: number;
}

export interface DurableWaveSlotAcquiredV1 {
  acquired: true;
  leaseId: string;
  retryAfterMs: number;
  queueDepth: number;
  scope: "shared-durable";
}

export interface DurableWaveSlotQueuedV1 {
  acquired: false;
  retryAfterMs: number;
  queueDepth: number;
  scope: "shared-durable";
  reason: string;
}

export type DurableWaveSlotResultV1 = DurableWaveSlotAcquiredV1 | DurableWaveSlotQueuedV1;

function durableWaveSlotFile(snapshotRoot: string): string {
  return path.resolve(path.join(snapshotRoot, ".harness", "runtime", "snapshot.json"));
}

async function writeRuntimeSnapshotAtomic(file: string, snapshot: RuntimeSnapshotV1): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function withDurableSlotLock<T>(
  file: string,
  action: () => Promise<T>,
  options: {
    remainingBudgetMs?: number;
    nowMs?: () => number;
    sleepMs?: (ms: number) => Promise<void>;
  } = {}
): Promise<T> {
  const lockPath = `${file}.lock`;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const now = options.nowMs ?? Date.now;
  const sleep = options.sleepMs ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const remaining = options.remainingBudgetMs;
  // Same pattern as capacity WAIT: min(requested 10s, remaining);
  // exhausted/undefined → terminal FAIL, no wait (never mint fresh 10s).
  const hasBudget = remaining !== undefined && Number.isFinite(remaining) && remaining > 0;
  const effectiveMaxWaitMs = hasBudget ? Math.min(10_000, Math.floor(remaining!)) : 0;
  const startedAt = now();
  const deadline = startedAt + effectiveMaxWaitMs;
  for (;;) {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`);
        return await action();
      } finally {
        await handle.close().catch(() => undefined);
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
      }
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => undefined);
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Stale lock recovery (dead owner pid or >30s old), else bounded wait.
      try {
        const [rawPid, stat] = await Promise.all([
          fs.readFile(lockPath, "utf8").catch(() => ""),
          fs.stat(lockPath).catch(() => undefined),
        ]);
        const pid = Number.parseInt(rawPid.trim(), 10);
        let recoverable = false;
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
            recoverable = false;
          } catch (killError) {
            recoverable = (killError as NodeJS.ErrnoException).code === "ESRCH";
          }
        } else if (stat) {
          recoverable = Date.now() - stat.mtimeMs > 30_000;
        } else {
          recoverable = true;
        }
        if (recoverable) {
          await fs.rm(lockPath, { force: true }).catch(() => undefined);
          continue;
        }
      } catch {
        // Best-effort stale check never fails acquisition; fall through to wait.
      }
      // Exhausted budget → terminal FAIL, no wait (no sleep, no fresh time).
      if (effectiveMaxWaitMs <= 0 || now() >= deadline) {
        throw new Error(`Timed out acquiring durable wave-slot lock for ${path.basename(file)}.`);
      }
      await sleep(Math.min(20, Math.max(0, deadline - now())));
    }
  }
}

/**
 * Single atomic attempt (lock → reload → check → write): lock wait honors the
 * caller's remaining budget (`min(10s requested, remaining)`; exhausted or
 * undefined → single immediate attempt, no wait, terminal on contention).
 * Returns ACQUIRED with durable leaseId (persisted) or QUEUED (persisted nothing).
 * Unreadable/invalid durability returns QUEUED-terminal (BLOCKED, retryAfter 0).
 */
export async function tryAcquireDurableWaveSlotAtomic(
  snapshotRoot: string,
  input: DurableWaveSlotInputV1,
  options: { nowMs?: () => number; leaseTtlMs?: number; remainingBudgetMs?: number; sleepMs?: (ms: number) => Promise<void> } = {}
): Promise<DurableWaveSlotResultV1> {
  const nowMs = options.nowMs ?? Date.now;
  const file = durableWaveSlotFile(snapshotRoot);
  try {
    return await withDurableSlotLock(
      file,
      async () => {
      let snapshot: RuntimeSnapshotV1;
      try {
        snapshot = await readManagedRuntimeSnapshot(snapshotRoot);
      } catch {
        return {
          acquired: false,
          retryAfterMs: 0,
          queueDepth: 1,
          scope: "shared-durable",
          reason: "durable provider lease snapshot unreadable; fail-closed QUEUED.",
        } satisfies DurableWaveSlotQueuedV1;
      }
      const supervisor = new RuntimeSupervisorV1({
        clock: () => new Date(nowMs()),
        ...(options.leaseTtlMs !== undefined ? { leaseTtlMs: options.leaseTtlMs } : {}),
      });
      try {
        supervisor.restoreSnapshot(snapshot);
      } catch {
        return {
          acquired: false,
          retryAfterMs: 0,
          queueDepth: 1,
          scope: "shared-durable",
          reason: "durable provider lease snapshot invalid; fail-closed QUEUED.",
        } satisfies DurableWaveSlotQueuedV1;
      }
      let result: ReturnType<RuntimeSupervisorV1["tryAcquireProviderLease"]>;
      try {
        result = supervisor.tryAcquireProviderLease({
          provider: input.provider,
          projectId: input.projectId,
          canonicalRoot: input.canonicalRoot,
          workspaceId: input.workspaceId,
          mode: input.mode ?? "write",
          ownerId: input.ownerId,
          ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
        });
      } catch (error) {
        // Invalid identity/ttl: fail-closed throw (BLOCKS caller, never ACQUIRE).
        throw error;
      }
      if (result.status === "QUEUED") {
        return {
          acquired: false,
          retryAfterMs: result.retryAfterMs,
          queueDepth: result.queueDepth,
          scope: "shared-durable",
          reason: result.reason,
        } satisfies DurableWaveSlotQueuedV1;
      }
      // ACQUIRED: persist atomically under the same lock before returning.
      await writeRuntimeSnapshotAtomic(file, supervisor.snapshot());
      return {
        acquired: true,
        leaseId: result.lease.leaseId,
        retryAfterMs: 0,
        queueDepth: 0,
        scope: "shared-durable",
      } satisfies DurableWaveSlotAcquiredV1;
      },
      {
        ...(options.remainingBudgetMs !== undefined ? { remainingBudgetMs: options.remainingBudgetMs } : {}),
        nowMs,
        ...(options.sleepMs ? { sleepMs: options.sleepMs } : {}),
      }
    );
  } catch (error) {
    // Lock timeout or validation throw: fail-closed QUEUED-terminal (no proceed).
    // Preserve validation throws (empty identity) as throws for callers that
    // must not swallow programming errors? No: wave path treats any throw as
    // FAIL, but acquire-or-queue contract returns QUEUED for contention and
    // throws only for invalid input. Distinguish by message.
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("must not be empty") || message.includes("ttl must be")) throw error;
    return {
      acquired: false,
      retryAfterMs: 0,
      queueDepth: 1,
      scope: "shared-durable",
      reason: `durable wave-slot lock unavailable; fail-closed QUEUED: ${message.slice(0, 200)}`,
    } satisfies DurableWaveSlotQueuedV1;
  }
}

/**
 * Atomic release (lock → reload → delete → write). Idempotent: missing lease
 * returns silently. Owner mismatch throws fail-closed (caller treats as FAIL,
 * best-effort in wave finally blocks).
 */
export async function releaseDurableWaveSlot(
  snapshotRoot: string,
  leaseId: string,
  ownerId: string,
  options: { nowMs?: () => number; remainingBudgetMs?: number; sleepMs?: (ms: number) => Promise<void> } = {}
): Promise<void> {
  const nowMs = options.nowMs ?? Date.now;
  const file = durableWaveSlotFile(snapshotRoot);
  await withDurableSlotLock(
    file,
    async () => {
    let snapshot: RuntimeSnapshotV1;
    try {
      snapshot = await readManagedRuntimeSnapshot(snapshotRoot);
    } catch {
      // Unreadable on release: fail-closed throw (caller best-effort catches).
      throw new Error("durable provider lease snapshot unreadable; fail-closed release BLOCKED.");
    }
    const supervisor = new RuntimeSupervisorV1({ clock: () => new Date(nowMs()) });
    supervisor.restoreSnapshot(snapshot);
    // Best-effort idempotent: missing lease is already released.
    const existing = supervisor.snapshot().providerLeases.find((lease) => lease.leaseId === leaseId);
    if (!existing) return;
    supervisor.releaseProviderLease(leaseId, ownerId);
    await writeRuntimeSnapshotAtomic(file, supervisor.snapshot());
    },
    {
      // Cleanup defaults to the historical 10s patience when the caller has no
      // budget; an explicitly exhausted budget (<=0) still means no wait.
      remainingBudgetMs: options.remainingBudgetMs ?? 10_000,
      nowMs,
      ...(options.sleepMs ? { sleepMs: options.sleepMs } : {}),
    }
  );
}

/**
 * Bounded atomic acquire-or-wait-or-fail (production wave path).
 * Single immediate attempt when `remainingBudgetMs` is undefined or <=0 (never
 * mints fresh 30s); otherwise single bounded WAIT (`min(retryAfter, remaining)`)
 * then one atomic re-attempt; exhaustion on second QUEUED is terminal (caller
 * FAILs). Single-retry bound keeps waits deterministic with pinned clocks
 * (tests pin `nowMs`/`sleepMs` with no clock advance; infinite polling would
 * hang). Unreadable (retryAfter 0) never sleeps.
 */
export async function acquireDurableWaveSlotOrQueue(
  snapshotRoot: string,
  input: DurableWaveSlotInputV1,
  options: {
    remainingBudgetMs?: number;
    sleepMs?: (ms: number) => Promise<void>;
    nowMs?: () => number;
    leaseTtlMs?: number;
  } = {}
): Promise<DurableWaveSlotResultV1> {
  const nowMs = options.nowMs ?? Date.now;
  const sleepMs = options.sleepMs ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const remaining = options.remainingBudgetMs;
  const hasBudget = remaining !== undefined && Number.isFinite(remaining) && remaining > 0;

  // Thread the caller's remaining budget into the lock itself (same pattern as
  // capacity WAIT: min(requested 10s, remaining); exhausted → terminal, no wait).
  // The first attempt gets the full remaining; the re-attempt after WAIT gets
  // the leftover (remaining - waitMs) so the lock never exceeds the budget.
  const attempt = (budgetMs?: number) =>
    tryAcquireDurableWaveSlotAtomic(snapshotRoot, input, {
      nowMs,
      ...(options.leaseTtlMs !== undefined ? { leaseTtlMs: options.leaseTtlMs } : {}),
      ...(budgetMs !== undefined ? { remainingBudgetMs: budgetMs } : { remainingBudgetMs: 0 }),
      sleepMs,
    });

  const first = await attempt(remaining);
  if (first.acquired) return first;
  // No existing budget: immediate terminal, never mint a fresh wait (zero sleeps).
  if (!hasBudget) return first;
  // Exhausted/invalid QUEUED (retryAfter 0 on unreadable): immediate terminal, no sleep.
  if (first.retryAfterMs <= 0) return first;

  const waitMs = Math.min(first.retryAfterMs, Math.floor(remaining!));
  if (waitMs <= 0) return first;
  await sleepMs(waitMs);
  const second = await attempt(Math.max(0, Math.floor(remaining!) - waitMs));
  if (second.acquired) return { ...second, retryAfterMs: waitMs };
  return second;
}

/**
 * Bounded backpressure telemetry attributes for existing `recordEvent`
 * conventions (counter: queued/active observations; gauge: ceiling). Refs-only,
 * never provider content; observation only, never a gate.
 */
export function providerBackpressureAttributes(signal: ProviderBackpressureTelemetryV1): Record<string, unknown> {
  const operationId = signal.operationId.slice(0, 200);
  const active = Math.max(0, Math.floor(signal.active));
  const ceiling = Math.max(1, Math.floor(signal.ceiling));
  const queued = Math.max(0, Math.floor(signal.queued));
  const retryAfterMs = Math.max(0, Math.min(PROVIDER_BACKPRESSURE_MAX_WAIT_MS_V1, Math.floor(signal.retryAfterMs)));
  return { operationId, active, ceiling, queued, retryAfterMs, disposition: signal.disposition };
}

export async function loadResourcePolicy(root: string): Promise<OperationResourcePolicyV1> {
  try {
    await fs.access(path.join(path.resolve(root), ".harness", "project.yaml"));
    return operationResourcePolicy(await loadProjectConfig(root));
  } catch { return DEFAULT_OPERATION_RESOURCE_POLICY; }
}

interface ResourceCandidate {
  kind: OperationResourceKindV1;
  identity: string;
  reclaim: OperationResourceReclaimPolicyV1;
  path?: string;
  label?: string;
  owner: OperationResourceV1["owner"];
  classification: OperationResourceClassificationV1;
  reason?: "retained-shared";
}

async function collectResourceCandidates(
  root: string,
  record: OperationRecordV2,
  registry: OperationResourceRegistryV1,
  deps: OperationResourceReconcileDeps
): Promise<ResourceCandidate[]> {
  const candidates = new Map<string, ResourceCandidate>();
  const add = (candidate: ResourceCandidate): void => {
    const key = `${candidate.kind}\u0000${candidate.identity}`;
    const existing = candidates.get(key);
    if (!existing) candidates.set(key, candidate);
    else if (existing.classification === "UNKNOWN_OR_UNOWNED" && candidate.classification !== "UNKNOWN_OR_UNOWNED") candidates.set(key, candidate);
  };
  const ownerBase = {
    candidateDigest: record.candidateRevision?.identityDigest,
    operationExecutionRevision: record.operationExecutionRevision,
    controllerEpoch: record.controller?.epoch,
    source: "operation-record" as const
  };

  for (const resource of registry.resources) {
    if (resource.operationId !== record.id) continue;
    add(resource.reclaim === "RETAIN_SHARED"
      ? { ...toCandidate(resource), classification: "UNKNOWN_OR_UNOWNED", reason: "retained-shared" }
      : { ...toCandidate(resource), classification: "TERMINAL_ORPHAN" });
  }

  // Workspace ownership is proven by the operation record plus the recorded disposition.
  // A workspace without a Paseo workspace id is a local execution root, not an external resource.
  const workspaceIdentity = record.workspaceId;
  if (workspaceIdentity) {
    if (record.workspaceDisposition === "DELIVERY_REUSED") {
      add({
        kind: "paseo-workspace",
        identity: workspaceIdentity,
        reclaim: "RETAIN_SHARED",
        ...(record.workspaceRoot ? { path: record.workspaceRoot } : {}),
        label: `operation workspace (${record.workspaceDisposition})`,
        owner: ownerBase,
        classification: "UNKNOWN_OR_UNOWNED",
        reason: "retained-shared"
      });
    } else if (record.workspaceDisposition === "OPERATION_OWNED") {
      add({
        kind: "paseo-workspace",
        identity: workspaceIdentity,
        reclaim: "ARCHIVE_ON_TERMINAL",
        ...(record.workspaceRoot ? { path: record.workspaceRoot } : {}),
        label: record.id,
        owner: ownerBase,
        classification: "TERMINAL_ORPHAN"
      });
    } else {
      add({
        kind: "paseo-workspace",
        identity: workspaceIdentity,
        reclaim: "RETAIN_SHARED",
        ...(record.workspaceRoot ? { path: record.workspaceRoot } : {}),
        label: `operation workspace (unproven disposition)`,
        owner: ownerBase,
        classification: "UNKNOWN_OR_UNOWNED"
      });
    }
  }

  // E-NEW-3 crash-window discovery: a worktree created between `paseo
  // workspace create` and the durable record/registry writes carries no local
  // ownership proof. The title minted at create is the durable signal; only an
  // exact title match proves ownership. This runs before the surface gate so a
  // surfaceless crashed operation stays recoverable.
  let discoveredWorkspaceCount = 0;
  if (!isDeterministicPaseoRuntimeEnabled()) {
    const listWorkspaces = deps.listOwnedWorkspaces ?? defaultListOwnedWorkspaces(deps.run ?? runShell);
    const listed = await listWorkspaces(root).catch(() => [] as OwnedWorkspaceRecord[]);
    for (const workspace of selectOwnedWorkspaces(listed, record.kind, record.id)) {
      discoveredWorkspaceCount += 1;
      add({
        kind: "paseo-workspace",
        identity: workspace.workspaceId,
        reclaim: "ARCHIVE_ON_TERMINAL",
        ...(workspace.path ? { path: workspace.path } : {}),
        label: "operation workspace (title discovery)",
        owner: { ...ownerBase, source: "workspace-title-discovery" },
        classification: "TERMINAL_ORPHAN"
      });
    }
  }

  const hasDurableOwnershipSurface = registry.resources.length > 0
    || Boolean(record.workspaceDisposition)
    || (await listManagedProcessHandles(root, record.id)).length > 0
    || discoveredWorkspaceCount > 0;
  if (!hasDurableOwnershipSurface || isDeterministicPaseoRuntimeEnabled()) return [...candidates.values()];

  // Participant and supervisor agent sessions are proven by the operation record.
  const leadAgentId = record.lead?.agentId;
  const selfAgentId = process.env.PASEO_AGENT_ID?.trim();
  const agentIds = new Map<string, { owner: OperationResourceV1["owner"]; workspaceId?: string }>();
  for (const agent of record.agents ?? []) {
    if (!agent.id || agent.id === leadAgentId || agent.id === selfAgentId) continue;
    agentIds.set(agent.id, { workspaceId: agent.workspaceId, owner: { ...ownerBase, source: "operation-record", ...(agent.role?.startsWith("operation-supervisor") ? { supervisorAgentId: agent.id } : {}) } });
  }
  for (const [participantId, participant] of Object.entries(record.participants ?? {})) {
    const sessionId = participant.executionBinding?.runtime.sessionId;
    if (!sessionId || sessionId === leadAgentId || sessionId === selfAgentId) continue;
    agentIds.set(sessionId, {
      workspaceId: participant.workspaceId,
      owner: {
        ...ownerBase,
        participantId,
        ...(participant.executionBinding?.participantGeneration !== undefined ? { participantGeneration: participant.executionBinding.participantGeneration } : {})
      }
    });
  }
  for (const generation of record.supervision?.generations ?? []) {
    if (!generation.agentId || generation.agentId === leadAgentId || generation.agentId === selfAgentId) continue;
    agentIds.set(generation.agentId, { owner: { ...ownerBase, supervisorAgentId: generation.agentId } });
  }
  // Durable label-bound discovery: `aeh.operation` is minted only by this product
  // at launch; agents carrying it are operation-owned even when they are not
  // WorkGraph participants (for example Semantic Assessor sessions).
  const discover = deps.listOwnedAgents ?? ((cwd: string, ownedOperationId: string) => listManagedPaseoAgents(cwd, { "aeh.operation": ownedOperationId }));
  for (const discovered of await discover(root, record.id).catch(() => [])) {
    if (!discovered.id || discovered.id === leadAgentId || discovered.id === selfAgentId) continue;
    if (!agentIds.has(discovered.id)) agentIds.set(discovered.id, { workspaceId: discovered.workspaceId, owner: { ...ownerBase, source: "operation-record" } });
  }
  const inspectAgent = deps.inspectAgent ?? ((cwd: string, agentId: string) => inspectManagedPaseoAgent(cwd, agentId));
  for (const [identity, meta] of agentIds) {
    if (isAuthorityOnlyIdentity(identity) || isDeterministicPaseoSessionId(identity)) continue;
    // The list/binding surfaces may omit the agent's Paseo workspace id (the
    // CLI launch returns only an explicit --workspace). The exact session
    // inspection boundary is the authoritative binding for that agent.
    if (!meta.workspaceId) {
      const observed = await inspectAgent(root, identity).catch(() => undefined);
      if (observed?.workspaceId && observed.workspaceId !== record.workspaceId) meta.workspaceId = observed.workspaceId;
    }
    add({ kind: "paseo-agent", identity, reclaim: "ARCHIVE_ON_TERMINAL", owner: meta.owner, classification: "TERMINAL_ORPHAN" });
    // A workspace bound to an operation-owned agent session is operation-owned:
    // the exact binding is durable in the operation record, label discovery or
    // the exact session inspection.
    if (meta.workspaceId && meta.workspaceId !== record.workspaceId) {
      add({
        kind: "paseo-workspace",
        identity: meta.workspaceId,
        reclaim: "ARCHIVE_ON_TERMINAL",
        label: `agent workspace of ${identity}`,
        owner: meta.owner,
        classification: "TERMINAL_ORPHAN"
      });
    }
  }

  // Provider lease sessions are proven by the durable runtime lease lifecycle.
  const runtimeSnapshot = await readManagedRuntimeSnapshot(root).catch(() => undefined);
  for (const lease of runtimeSnapshot?.providerLeases ?? []) {
    if (lease.lifecycle?.operationId !== record.id) continue;
    const sessionId = lease.lifecycle?.sessionId;
    if (!sessionId || sessionId === leadAgentId || sessionId === selfAgentId || isDeterministicPaseoSessionId(sessionId)) continue;
    add({
      kind: "provider-session",
      identity: sessionId,
      reclaim: "STOP_ON_TERMINAL",
      owner: { ...ownerBase, source: "provider-lease", leaseId: lease.leaseId },
      classification: "TERMINAL_ORPHAN"
    });
  }

  // Registered managed process handles are durable per-operation ownership proof.
  for (const handle of await listManagedProcessHandles(root, record.id)) {
    add({
      kind: "managed-process",
      identity: String(handle.pid),
      reclaim: "TERMINATE_ON_TERMINAL",
      owner: { ...ownerBase, source: "managed-process-handle" },
      classification: "TERMINAL_ORPHAN"
    });
  }
  return [...candidates.values()];
}

/**
 * Best-effort liveness observation for fenced handle cleanup (Luna
 * durable-handoff). Observation ONLY — never signals. ESRCH proves death;
 * anything else (alive, EPERM, unknown) counts as alive for the trace record.
 */
async function probeManagedPidAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

async function releaseResource(
  root: string,
  record: OperationRecordV2,
  resource: OperationResourceV1,
  deps: OperationResourceReconcileDeps
): Promise<Record<string, unknown>> {
  switch (resource.kind) {
    case "paseo-workspace": {
      const archive = deps.archiveWorkspace ?? defaultArchiveWorkspace(deps.run ?? runShell);
      // The worktree is removed by `paseo workspace archive`; persist the bounded
      // run-evidence subtrees durably under the operation artifact dir first so
      // post-terminal verification reads product-owned bytes instead of the
      // deleted worktree.
      const evidenceSnapshot = await snapshotWorkspaceEvidence(root, resource);
      await archive(root, resource.identity);
      return { action: "paseo.workspace.archive", workspaceId: resource.identity, path: resource.path ?? null, evidenceSnapshot };
    }
    case "paseo-agent":
    case "provider-session": {
      const inspect = deps.inspectAgent ?? (async (cwd: string, agentId: string) => inspectManagedPaseoAgent(cwd, agentId));
      const archive = deps.archiveAgent ?? defaultArchiveAgent(deps.run ?? runShell);
      const observed = await inspect(root, resource.identity).catch(() => undefined);
      const status = observed?.status?.toLowerCase();
      if (status === "archived") return { action: "already-archived", status };
      await archive(root, resource.identity).catch(async (error) => {
        // Archive can fail for an already-removed session; re-observe before failing.
        const after = await inspect(root, resource.identity).catch(() => undefined);
        if (after?.status?.toLowerCase() === "archived") return;
        throw error;
      });
      return { action: "paseo.agent.archive", agentId: resource.identity, observedStatus: status ?? null };
    }
    case "managed-process": {
      const pid = Number.parseInt(resource.identity, 10);
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid managed process identity '${resource.identity}'`);
      const terminate = deps.terminateProcess ?? ((value: number) => terminateManagedProcessGroup(value));
      try {
        await terminate(pid);
      } catch (error) {
        // Honest terminators reject with ESRCH when the target is already
        // gone: the goal is achieved, so this reconciles as already-exited
        // instead of failing (and being retried forever). Any other delivery
        // failure still throws and stays visible in the receipt.
        if ((error as NodeJS.ErrnoException)?.code !== "ESRCH") throw error;
        return { action: "already-exited", pid };
      }
      return { action: "process.terminate", pid };
    }
    case "staging-root": {
      const target = resource.path ?? resource.identity;
      const remove = deps.removeStagingRoot ?? defaultRemoveStagingRoot;
      await remove(target);
      return { action: "staging.remove", path: target };
    }
  }
}

function defaultArchiveWorkspace(run: typeof runShell): (root: string, workspaceId: string) => Promise<void> {
  return async (root, workspaceId) => {
    const result = await run(`paseo workspace archive ${quote(workspaceId)}`, { cwd: root, timeoutMs: 120_000 }).catch((error) => ({ exitCode: 1, stdout: "", stderr: String(error), durationMs: 0 } as ProcessResult));
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `paseo workspace archive exited ${result.exitCode}`);
  };
}

function defaultArchiveAgent(run: typeof runShell): (root: string, agentId: string) => Promise<void> {
  return async (root, agentId) => {
    try {
      await archivePaseoSdkAgent(root, agentId);
      return;
    } catch {
      const result = await run(`paseo agent archive ${quote(agentId)}`, { cwd: root, timeoutMs: 120_000 }).catch((error) => ({ exitCode: 1, stdout: "", stderr: String(error), durationMs: 0 } as ProcessResult));
      if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `paseo agent archive exited ${result.exitCode}`);
    }
  };
}

const WORKSPACE_EVIDENCE_SUBTREES = ["reports", "capsules", "contracts", "seals", "repairs", "telemetry", "evidence", "audits"] as const;
const WORKSPACE_EVIDENCE_MAX_FILES = 256;
const WORKSPACE_EVIDENCE_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Copy the bounded run-evidence subtrees of an operation's execution workspace
 * into the durable operation artifact directory before the workspace is
 * archived. The snapshot is best-effort and explicitly reports skips or
 * truncation; it never changes the reconciliation outcome.
 */
async function snapshotWorkspaceEvidence(root: string, resource: OperationResourceV1): Promise<Record<string, unknown>> {
  if (!resource.path) return { skipped: "no-workspace-path" };
  const sourceHarness = path.join(resource.path, ".harness");
  const target = path.join(operationArtifactDir(root, resource.operationId), "workspace-evidence", "latest");
  const copied: Array<{ path: string; sha256: string; bytes: number }> = [];
  let totalBytes = 0;
  for (const subtree of WORKSPACE_EVIDENCE_SUBTREES) {
    const files = await listFilesBounded(path.join(sourceHarness, subtree), WORKSPACE_EVIDENCE_MAX_FILES - copied.length);
    for (const file of files) {
      const data = await fs.readFile(file).catch(() => undefined);
      if (!data) continue;
      if (copied.length >= WORKSPACE_EVIDENCE_MAX_FILES || totalBytes + data.byteLength > WORKSPACE_EVIDENCE_MAX_BYTES) {
        return { path: target, files: copied.length, bytes: totalBytes, truncated: "evidence-ceiling", digest: sha256Canonical(copied) };
      }
      const relative = path.relative(sourceHarness, file);
      const output = path.join(target, ".harness", relative);
      await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
      await fs.writeFile(output, data, { mode: 0o600 });
      copied.push({ path: relative.split(path.sep).join("/"), sha256: sha256Utf8(data), bytes: data.byteLength });
      totalBytes += data.byteLength;
    }
  }
  if (!copied.length) return { skipped: "no-evidence" };
  return { path: target, files: copied.length, bytes: totalBytes, digest: sha256Canonical(copied) };
}

async function listFilesBounded(directory: string, limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  const files: string[] = [];
  const queue = [directory];
  while (queue.length && files.length < limit) {
    const current = queue.shift()!;
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (files.length >= limit) break;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  return files;
}

async function defaultRemoveStagingRoot(target: string): Promise<void> {
  const resolved = path.resolve(target);
  const relative = path.relative(path.resolve(os.tmpdir()), resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative === "") {
    throw new Error(`refusing to remove a staging root outside the system temporary directory: ${resolved}`);
  }
  if (!path.basename(resolved).startsWith("aeh-")) {
    throw new Error(`refusing to remove a staging root that is not AEH-owned by path convention: ${resolved}`);
  }
  await fs.rm(resolved, { recursive: true, force: true });
}

async function listOperationIds(root: string): Promise<string[]> {
  const stateRoot = resolveOperationStateRoot(root);
  const directory = path.join(stateRoot, ".harness", "operations");
  let entries: string[];
  try { entries = await fs.readdir(directory); } catch { return []; }
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => entry.slice(0, -".json".length))
    .filter((entry) => entry !== "portfolio")
    .sort()
    .slice(0, 200);
}

function toCandidate(resource: OperationResourceV1): ResourceCandidate {
  return {
    kind: resource.kind,
    identity: resource.identity,
    reclaim: resource.reclaim,
    path: resource.path,
    label: resource.label,
    owner: resource.owner,
    classification: "TERMINAL_ORPHAN"
  };
}

function defaultReclaim(kind: OperationResourceKindV1): OperationResourceReclaimPolicyV1 {
  switch (kind) {
    case "paseo-workspace": return "ARCHIVE_ON_TERMINAL";
    case "paseo-agent": return "ARCHIVE_ON_TERMINAL";
    case "provider-session": return "STOP_ON_TERMINAL";
    case "managed-process": return "TERMINATE_ON_TERMINAL";
    case "staging-root": return "REMOVE_ON_TERMINAL";
  }
}

function actionFor(kind: OperationResourceKindV1): OperationResourceDispositionV1["action"] {
  switch (kind) {
    case "paseo-workspace": return "archive";
    case "paseo-agent": return "stop+archive";
    case "provider-session": return "stop+archive";
    case "managed-process": return "terminate";
    case "staging-root": return "remove";
  }
}

function terminalStateFor(kind: OperationResourceKindV1): OperationResourceStateV1 {
  switch (kind) {
    case "paseo-workspace":
    case "paseo-agent": return "ARCHIVED";
    case "provider-session": return "RELEASED";
    case "managed-process": return "TERMINATED";
    case "staging-root": return "REMOVED";
  }
}

function isAuthorityOnlyIdentity(identity: string): boolean {
  return /^participant:[0-9a-f]{16}$/.test(identity);
}

function fileFor(root: string, operationId: string): string {
  return operationResourceRegistryFile(root, operationId);
}

async function readRegistry(file: string, operationId: string): Promise<OperationResourceRegistryV1> {
  let raw: string;
  try { raw = await fs.readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, operationId, updatedAt: new Date(0).toISOString(), resources: [] };
    throw error;
  }
  const parsed = JSON.parse(raw) as Partial<OperationResourceRegistryV1>;
  if (parsed?.version !== 1 || parsed.operationId !== operationId || !Array.isArray(parsed.resources)) {
    throw new Error(`OPERATION_RESOURCE_REGISTRY_INVALID: ${file} is not a valid resource registry for ${operationId}.`);
  }
  return parsed as OperationResourceRegistryV1;
}

async function writeRegistry(file: string, registry: OperationResourceRegistryV1, now?: () => Date): Promise<void> {
  registry.updatedAt = (now?.() ?? new Date()).toISOString();
  await writeJsonAtomic(file, registry);
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try { await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
}

async function withRegistryLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  const lockPath = `${file}.lock`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`);
        return await action();
      } finally {
        await handle.close().catch(() => undefined);
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
      }
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => undefined);
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await canRecoverRegistryLock(lockPath)) { await fs.rm(lockPath, { force: true }).catch(() => undefined); continue; }
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring operation resource registry lock for ${path.basename(file)}.`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

async function canRecoverRegistryLock(lockPath: string): Promise<boolean> {
  try {
    const [rawPid, stat] = await Promise.all([fs.readFile(lockPath, "utf8").catch(() => ""), fs.stat(lockPath)]);
    const pid = Number.parseInt(rawPid.trim(), 10);
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    }
    return Date.now() - stat.mtimeMs > 30_000;
  } catch { return true; }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
