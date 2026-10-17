import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { minimatch } from "minimatch";
import type { AgentExecutionSelection, PermissionDecision } from "./types.js";
import { planParallelism, type ParallelismPlan } from "./parallelism.js";
import { knowledgePackOutputSchema, plannerOutputSchema, type PlannerOutput, type WorkUnitOutput } from "./outputContracts.js";
import { extractMarkedJson } from "./structuredOutput.js";
import { validateExecutionCapabilities } from "./permissions.js";
import type { ControlPlaneSnapshot } from "../core/controlPlane.js";
import { materializeControlPlaneSnapshot } from "../core/controlPlane.js";
import type { HarnessProjectConfig, TaskContract, ValidationCheck, ValidationReport, WorkerSession } from "../core/types.js";
import { executeAgentPrompt, prepareAgentExecutionIdentity } from "../workers/agentPrompt.js";
import { dispatchDistributedDelegation } from "../distributed/worker.js";
import { enforceSandboxPolicy } from "../security/sandbox.js";
import { clearToolchainEnvCache, runExecutable } from "../utils/process.js";
import { materializeToolchainStateForIsolatedRoot } from "../toolchain/config.js";
import { recordEvent } from "../telemetry/events.js";
import { existingRepositoryPath, repositoryPath } from "../utils/repositoryPath.js";
import { compileExecutionBlueprint, type ExecutionBlueprint, type ParticipantAssignmentV1 } from "../architecture/participantPlan.js";
import { createWorkGraph } from "../architecture/workGraph.js";
import { bindOperationExecutionSemantics, bindResolvedOperationPolicy, currentOperationContext, loadOperation } from "../operations/state.js";
import { compileResolvedOperationPolicy } from "../architecture/executionIdentity.js";
import { configuredDeliveryPolicy, requiredHumanActionAuthorizations } from "../security/actionPolicy.js";
import type { ExecutionCatalogV1 } from "../architecture/executionCatalog.js";
import type { CapabilityRegistryV1 } from "../capabilities/registry.js";
import type { CandidateImpactAssessmentRuntimeV1, CandidateImpactV1, CandidateScopeEscapeV1, ChangeSetV1 } from "../candidates/assembler.js";
import { assemblerScopeEscapeDiffV1 } from "../candidates/assembler.js";
import {
  buildScopeEscapeCorrectionPrompt,
  isScopeCorrectionTimeoutError,
} from "../candidates/scopeEscapeCorrection.js";
import {
  assertRepairScopeBlockerReceipt,
  createRepairScopeBlockerReceipt,
  findRepairHardProtectedViolations,
  isExactRepairScopeFilePath,
  isSafeRepairScopePath,
  MAX_REPAIR_SCOPE_BLOCKER_FILES_V1,
  normalizeRepairScopePath,
  parseRepairScopeBlockerFromSession,
  partitionHardViolationsByNewTestTier,
  repairHardProtectedPaths,
  repairScopeBlockerValidationCheck,
  resolveRepairScopeBlockerViaProductChoice,
  scopePatternOverlapsHardPattern,
  writeRepairScopeBlockerReceipt,
  type RepairScopeAmendmentV1,
  type RepairScopeBlockerReceiptV1,
} from "../candidates/repairScope.js";
import { partitionRepairScopeBlockerFiles, repairProtectedPaths } from "../candidates/repair.js";
import { materializeCandidateState, DIRECT_STAGING_HEARTBEAT_FILENAME } from "../candidates/direct.js";
import { createWaveBase, integrateWaveChangeSets, type WaveChangeSetSubmissionV1 } from "../candidates/wave.js";
import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { sha256Canonical, sha256Utf8 } from "../core/digest.js";
import { AehError } from "../core/errors.js";
import { FileKnowledgeCacheV1, resolveKnowledgeGate, validateKnowledgePack, type KnowledgeCacheV1, type KnowledgeLookupResultV1, type KnowledgeModeV1, type KnowledgePackV1, type KnowledgeResolutionV1 } from "../knowledge/index.js";
import { defaultSkillSeed } from "../participants/index.js";
import { contractValidationRequirementsV1, mergeContractValidationRequirementsV1, resolveValidationRequirements, type ValidationResolutionV1 } from "../architecture/validationRequirements.js";
import { contractValidationSourcesForContractV1, partitionMergedValidationRequirementsV1 } from "../core/contract.js";
import { directRouteMultiUnitBlockedV1 } from "./routingV2.js";
import { projectedAuthorizedReadRoots } from "../paseo/launchSpec.js";
import type { ProjectStackProfileV1 } from "../participants/stack.js";
import { compilePlannerWorkGraphWithOneCorrection, PlannerWorkGraphCorrectionError } from "./plannerWorkGraphCorrection.js";
import {
  DEFAULT_OPERATION_RESOURCE_POLICY,
  PROVIDER_BACKPRESSURE_EVENT_V1,
  acquireDurableWaveSlotOrQueue,
  isProviderCapacityError,
  providerBackpressureAttributes,
  releaseDurableWaveSlot,
  waitForProviderSessionCapacity
} from "../runtime/operationResources.js";
import {
  RuntimeSupervisorV1,
  isProviderLeaseConflictError,
  providerLeaseBackpressureSignal,
  providerLeaseQueueWaitMs,
  type ProviderLeaseQueuedV1
} from "../runtime/supervisorV2.js";
import { frozenOperationHardDeadlineAt } from "../operations/state.js";
import { isProvisionedToolchainPath } from "../core/git.js";
import { isProviderRateLimited, parseProviderRateLimitDetail } from "../paseo/sdk.js";

export interface DelegationExecutionResult { task: WorkUnitOutput; session: WorkerSession; changedFiles: string[]; patch: string; status: "PASS" | "FAIL"; message?: string; distributed?: boolean; candidate?: CandidateRevisionV1; impact?: CandidateImpactV1; changeSet?: ChangeSetV1; escapeCorrectionUsed?: boolean; escapeCorrectionSessions?: WorkerSession[]; scopeBlocker?: RepairScopeBlockerReceiptV1; }
export interface WaveExecutionSummary { wave: number; taskIds: string[]; status: "PASS" | "FAIL"; results: DelegationExecutionResult[]; barrier?: ValidationReport; }
export interface PlannerWaveResult { used: boolean; plan?: PlannerOutput; amendedContract?: TaskContract; blueprint?: ExecutionBlueprint; schedule?: ParallelismPlan; waves: WaveExecutionSummary[]; sessions: WorkerSession[]; aggregateSession?: WorkerSession; report?: ValidationReport; preExecutionFailure?: boolean; correctionAttempts?: 0 | 1; escapeCorrections?: number; }

/**
 * Round-2 B1 (DETERMINISTIC): existing repair budget for scope-escape
 * corrections. No new budget knob — reuses `repair.maxAttempts` (frozen
 * contract) falling back to the configured worker max, then 2.
 */
export function escapeCorrectionBudgetV1(contract: TaskContract, config: HarnessProjectConfig): number {
  const fromContract = (contract as { repair?: { maxAttempts?: unknown } }).repair?.maxAttempts;
  if (typeof fromContract === "number" && Number.isSafeInteger(fromContract) && fromContract >= 0) return fromContract;
  const fromConfig = (config as { orchestration?: { worker?: { maxRepairAttempts?: unknown } } }).orchestration?.worker?.maxRepairAttempts;
  if (typeof fromConfig === "number" && Number.isSafeInteger(fromConfig) && fromConfig >= 0) return fromConfig;
  return 2;
}

export interface EscapeCorrectionBudgetGateV1 {
  readonly max: number;
  readonly used: number;
  /** Synchronous reserve-then-check: true reserves one slot, false means exhausted (no correction). */
  tryReserve(): boolean;
}

/**
 * Round-2 B1 (DETERMINISTIC): shared synchronous reservation gate.
 * Check + increment happen synchronously (no await between), so parallel
 * wave tasks cannot double-spend the remaining budget. Reserve BEFORE the
 * async correction turn; exhausted → original FAIL immediately, no correction.
 */
export function createEscapeCorrectionBudgetGateV1(max: number, alreadyUsed = 0): EscapeCorrectionBudgetGateV1 {
  const safeMax = Number.isSafeInteger(max) && max >= 0 ? max : 2;
  let used = Number.isSafeInteger(alreadyUsed) && alreadyUsed >= 0 ? alreadyUsed : 0;
  return {
    get max() { return safeMax; },
    get used() { return used; },
    tryReserve() {
      if (used >= safeMax) return false;
      used += 1;
      return true;
    },
  };
}

/**
 * Round-2 B2 (DETERMINISTIC): classify a wave correction session for
 * outside-scope declarations. Same no-mutation semantics as DIRECT/repair:
 * - schema-valid `filesNeededOutsideScope` with no file changes → BLOCKED
 *   when genuinely outside scope (partition strips in-scope confusion);
 * - vacuous (all stripped) → not blocked;
 * - conflicting (changes + declaration, or parse CONFLICT/INVALID throw) →
 *   BLOCKED fail-closed, never PASS-with-declaration.
 * Model content, deterministic gate. Never widens scope.
 */
export function classifyWaveCorrectionDeclarationV1(input: {
  session: Pick<WorkerSession, "stdout" | "stderr">;
  changedFiles: readonly string[];
  operationId: string;
  taskId: string;
  workUnitId: string;
  participantId?: string;
  taskScope: readonly string[];
  contract: TaskContract;
  config: HarnessProjectConfig;
}): { blocked: boolean; blocker?: RepairScopeBlockerReceiptV1; strippedCount: number } {
  let needed: { path: string; reason: string }[] | undefined;
  try {
    needed = parseRepairScopeBlockerFromSession(input.session);
  } catch {
    // CONFLICT/INVALID declaration alongside a correction → BLOCKED
    // fail-closed (never PASS-with-declaration). Synthesize a minimal
    // blocker receipt citing the conflict so run.ts can merge a FAIL check.
    const blocker = createRepairScopeBlockerReceipt({
      operationId: input.operationId,
      taskId: input.taskId,
      workUnitId: input.workUnitId,
      ...(input.participantId ? { participantId: input.participantId } : {}),
      filesNeededOutsideScope: [{ path: "correction-conflict", reason: "correction declared filesNeededOutsideScope alongside file changes or an invalid blocker payload" }],
    });
    return { blocked: true, blocker, strippedCount: 0 };
  }
  if (!needed?.length) return { blocked: false, strippedCount: 0 };
  // No-mutation invariant: declaration requires no file changes. A correction
  // that both mutates and declares is contradictory → BLOCKED fail-closed.
  if (input.changedFiles.length > 0) {
    const blocker = createRepairScopeBlockerReceipt({
      operationId: input.operationId,
      taskId: input.taskId,
      workUnitId: input.workUnitId,
      ...(input.participantId ? { participantId: input.participantId } : {}),
      filesNeededOutsideScope: [{ path: "correction-conflict", reason: "correction declared filesNeededOutsideScope while also producing file changes" }],
    });
    return { blocked: true, blocker, strippedCount: 0 };
  }
  const allowedScope = [...input.taskScope];
  const forbiddenScope = [
    ...(input.contract.scope?.forbidden ?? []),
    ...(input.contract.scope?.frozen ?? []),
    ...(input.config.validation?.frozenPaths ?? []),
    ...repairProtectedPaths(input.config, input.contract),
  ];
  const partitioned = partitionRepairScopeBlockerFiles(needed, allowedScope, forbiddenScope);
  if (!partitioned.genuinelyBlocked.length) return { blocked: false, strippedCount: partitioned.stripped.length };
  const blocker = createRepairScopeBlockerReceipt({
    operationId: input.operationId,
    taskId: input.taskId,
    workUnitId: input.workUnitId,
    ...(input.participantId ? { participantId: input.participantId } : {}),
    filesNeededOutsideScope: partitioned.genuinelyBlocked,
  });
  return { blocked: true, blocker, strippedCount: partitioned.stripped.length };
}

/**
 * FAM-WAVE live off-patch gate (DETERMINISTIC, fail-closed, hardcoded-deny).
 *
 * Per-unit worker filesystem writes used to be observed only through the
 * captured `git diff` (assembler defense-in-depth). The live gate below
 * snapshots the per-unit worktree file set at unit launch (after
 * `materializeCandidateState` + baseline commit) and scope-checks the live
 * worktree filesystem state immediately after EACH worker invocation on the
 * unit worktree (initial turn and correction turn each get a fresh
 * pre-invocation snapshot paired with an immediate post-invocation check),
 * BEFORE the diff is captured. A write introduced by one invocation is
 * therefore caught by that invocation's post-check even if a later
 * invocation reverts it (cross-invocation revert is caught; only a
 * write+revert fully contained inside a SINGLE worker invocation leaves no
 * observable filesystem trace). Entries carry full-precision ctime + inode
 * alongside the content hash, so an in-place write+revert that restores bytes
 * and mtime is still flagged (restoring mtime via utime updates ctime, and
 * delete+recreate changes the inode). Any new/modified/deleted/unreadable
 * file outside the unit's claimed pathspec — plus any regular file whose
 * content cannot be read (fail-closed sentinel, in or out of scope) — is
 * DENIED live with an OFF_PATCH_WRITE_DENIED receipt (terminal FAIL, no
 * correction turn on the local path). The distributed branch applies the same
 * off-patch check to the remotely reported changed-file list UNION the files
 * named by the returned patch. Harness-owned heartbeat and provider-generated
 * scratch paths (same set the DIRECT path excludes from ChangeSet diffs) are
 * excluded from the walker and the matcher. The assembler diff gate stays as
 * defense-in-depth.
 *
 * NARROWED RESIDUAL (honest): an intra-single-invocation write+revert that
 * restores content bytes, mtime, ctime and inode leaves no observable state
 * trace for any snapshot-compare gate; the assembler diff gate plus
 * per-invocation checks stand as defense-in-depth for that residue.
 *
 * MECHANISM: DETERMINISTIC (filesystem snapshot + minimatch pathspec; no model).
 */
export const WAVE_OFF_PATCH_DENIED_EVENT_V1 = "harness.wave.off-patch-denied";

/**
 * Sentinel content hash marking a regular file that was present in the unit
 * worktree but whose bytes could not be read. Unreadable means unprovable
 * containment, so the matcher treats sentinel entries as touched (a
 * violation) rather than skipping them. The value is deliberately not a hex
 * digest so it can never collide with a real content hash.
 */
export const WAVE_WORKTREE_UNREADABLE_HASH_V1 = "wave-unreadable:v1";

export interface WaveWorktreeSnapshotEntryV1 {
  hash: string;
  mtimeMs: number;
  size: number;
  symlink: boolean;
  /** Full-precision ctime (NOT floored): restoring mtime via utime updates
   * ctime, so in-place write+revert with mtime restore is still detected. */
  ctimeMs: number;
  /** Inode number (0 when unavailable): delete+recreate with restored
   * content/mtime still changes identity. Compared only when both sides
   * carry a nonzero value. */
  ino: number;
}

/**
 * Harness-owned paths that are never product source and never scope
 * evidence: the owner heartbeat file (root-only), pure provider scratch
 * (`.serena`, `graphify-out` — exact or descendant, uncontested), plus
 * the NARROW toolchain-provisioned set in src/core/git.ts
 * (`isProvisionedToolchainPath`: exact `.config/mise/conf.d/aeh.toml`,
 * exact `.config/mise/mise.lock`, `.config/mise/locks/` descendants).
 * Deliberately NOT the BROAD accounting predicate
 * (`isManagedProvisionedPath`, D22): accounting-exclusion must not equal
 * enforcement-blindness, so project-authored files such as
 * `.config/mise/config.toml` stay enforced here. Applied to the
 * unit-worktree walker AND the off-patch matcher so heartbeat liveness
 * refreshes and toolchain droppings can never read as off-patch writes.
 *
 * MECHANISM: DETERMINISTIC (fixed name/prefix match; no model).
 */
const WAVE_WORKTREE_SCRATCH_PREFIXES_V1 = [".serena", "graphify-out"];
export function isWaveWorktreeExcludedV1(file: string): boolean {
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
  const segments = normalized.split("/");
  // R2: the heartbeat exemption is ROOT-ONLY. DIRECT's pathspec exclusion
  // covers only the root heartbeat file; a nested heartbeat-named file
  // (e.g. outside/.aeh-direct-heartbeat.json) is an ordinary off-patch write
  // and must not be excluded at any depth.
  if (segments.length === 1 && segments[0] === DIRECT_STAGING_HEARTBEAT_FILENAME) return true;
  const first = segments[0] ?? normalized;
  if (WAVE_WORKTREE_SCRATCH_PREFIXES_V1.some((prefix) => first === prefix)) return true;
  return isProvisionedToolchainPath(normalized);
}

export interface WaveOffPatchDenialV1 {
  version: 1;
  operationId: string;
  taskId: string;
  workUnitId: string;
  participantId?: string;
  files: string[];
  fileCount: number;
  digest: string;
}

export function createWaveOffPatchDenialV1(input: {
  operationId: string;
  taskId: string;
  workUnitId: string;
  participantId?: string;
  files: readonly string[];
}): WaveOffPatchDenialV1 {
  const files = [...new Set(input.files.map((f) => f.replaceAll("\\", "/").replace(/^\.\//, "")))].sort();
  const digest = sha256Canonical({
    version: 1,
    operationId: input.operationId,
    taskId: input.taskId,
    workUnitId: input.workUnitId,
    ...(input.participantId ? { participantId: input.participantId } : {}),
    files,
  });
  return {
    version: 1,
    operationId: input.operationId,
    taskId: input.taskId,
    workUnitId: input.workUnitId,
    ...(input.participantId ? { participantId: input.participantId } : {}),
    files,
    fileCount: files.length,
    digest,
  };
}

/** Pure set-difference core: touched files (new/changed/deleted vs snapshot) outside scope. */
export function findOffPatchWritesV1(input: {
  snapshot: ReadonlyMap<string, WaveWorktreeSnapshotEntryV1> | readonly string[];
  current: ReadonlyMap<string, WaveWorktreeSnapshotEntryV1> | readonly string[];
  allowedScope: readonly string[];
}): string[] {
  const snapMap = Array.isArray(input.snapshot)
    ? new Map(input.snapshot.map((f) => [f, undefined] as const))
    : input.snapshot;
  const curMap = Array.isArray(input.current)
    ? new Map(input.current.map((f) => [f, undefined] as const))
    : input.current;
  const touched: string[] = [];
  const unreadable: string[] = [];
  for (const [file, cur] of curMap as Map<string, WaveWorktreeSnapshotEntryV1 | undefined>) {
    const prev = (snapMap as Map<string, WaveWorktreeSnapshotEntryV1 | undefined>).get(file);
    if (cur !== undefined && (cur as WaveWorktreeSnapshotEntryV1).hash === WAVE_WORKTREE_UNREADABLE_HASH_V1) {
      // Fail-closed: a regular file present but unreadable is unprovable
      // containment — always a violation, even when a previous snapshot also
      // carries the sentinel (hash-equal would otherwise hide it) and even
      // inside the claimed scope (scope filtering below never applies).
      unreadable.push(file);
      touched.push(file);
      continue;
    }
    if (prev === undefined && cur === undefined) {
      // String-set mode: every current file counts as touched (caller passes
      // post-turn listing); scope filter below decides.
      touched.push(file);
      continue;
    }
    if (prev === undefined) {
      touched.push(file); // new file
      continue;
    }
    if (cur === undefined) {
      touched.push(file); // deleted (present in snapshot, absent now)
      continue;
    }
    const p = prev as WaveWorktreeSnapshotEntryV1;
    const c = cur as WaveWorktreeSnapshotEntryV1;
    if (p.hash !== c.hash || p.mtimeMs !== c.mtimeMs || p.size !== c.size || p.symlink !== c.symlink || waveWorktreeIdentityChangedV1(p, c)) {
      touched.push(file);
    }
  }
  // Deletions: snapshot files absent from current.
  for (const file of (snapMap as Map<string, unknown>).keys()) {
    if (!(curMap as Map<string, unknown>).has(file)) touched.push(file);
  }
  const unique = [...new Set(touched)].sort();
  const unreadableSet = new Set(unreadable);
  // Harness-owned heartbeat/generated paths are never scope evidence
  // (walker + matcher exclusion, same set the DIRECT path excludes from
  // ChangeSet diffs). Unreadable sentinels bypass the scope filter (deny even
  // in-scope) but never bypass the harness-owned exclusion.
  return unique.filter((file) => !isWaveWorktreeExcludedV1(file) && (unreadableSet.has(file) || !matchesAny(file, [...input.allowedScope])));
}

/**
 * Identity change beyond content hash: full-precision ctime or inode
 * differs. Catches in-place write+revert with restored bytes+mtime (utime
 * updates ctime) and delete+recreate with restored bytes+mtime (new inode).
 * Compared only when both sides carry the signal (hand-built maps without
 * ctime/ino degrade to hash/mtime/size comparison, never to a false hit).
 *
 * MECHANISM: DETERMINISTIC.
 */
function waveWorktreeIdentityChangedV1(prev: WaveWorktreeSnapshotEntryV1, cur: WaveWorktreeSnapshotEntryV1): boolean {
  if (Number.isFinite(prev.ctimeMs) && Number.isFinite(cur.ctimeMs) && prev.ctimeMs !== cur.ctimeMs) return true;
  if (Number.isFinite(prev.ino) && Number.isFinite(cur.ino) && prev.ino !== 0 && cur.ino !== 0 && prev.ino !== cur.ino) return true;
  return false;
}

/**
 * List files named by a unified patch (DETERMINISTIC, pure, no I/O).
 * Parses `diff --git a/<p> b/<p>` headers plus `---`/`+++` file lines
 * (`/dev/null` sides skipped), so a remotely reported patch cannot smuggle
 * an off-scope file the changed-file list omits. Over-approximates: unparseable
 * lines are ignored, never allow-listed.
 */
export function listWavePatchFilesV1(patch: string): string[] {
  const files = new Set<string>();
  const add = (raw: string): void => {
    let file = raw.trim();
    if (!file || file === "/dev/null") return;
    if ((file.startsWith('"') && file.endsWith('"')) || (file.startsWith("'") && file.endsWith("'"))) file = file.slice(1, -1);
    for (const prefix of ["a/", "b/"]) if (file.startsWith(prefix)) { file = file.slice(2); break; }
    file = file.replaceAll("\\", "/").replace(/^\.\//, "");
    if (file && file !== "/dev/null") files.add(file);
  };
  for (const line of patch.split(/\r?\n/)) {
    const git = line.match(/^diff --git\s+(\S+)\s+(\S+)\s*$/);
    if (git) { add(git[1]!); add(git[2]!); continue; }
    const side = line.match(/^[+-]{3}\s+(\S.*)$/);
    if (side) add(side[1]!.split("\t")[0]!);
  }
  return [...files].sort();
}

/**
 * Distributed-branch off-patch check: the remotely reported changed-file
 * list UNION the files named by the returned patch, validated against the
 * unit's claimed pathspec. A remote worker's file list is self-reported, so
 * the patch it ships is cross-checked too — either channel naming an
 * off-scope (non-harness-owned) file is a violation.
 *
 * MECHANISM: DETERMINISTIC.
 */
export function findDistributedWaveOffPatchV1(input: { changedFiles: readonly string[]; patch: string; allowedScope: readonly string[] }): string[] {
  const claimed = [...new Set([...input.changedFiles, ...listWavePatchFilesV1(input.patch)].map((f) => f.replaceAll("\\", "/").replace(/^\.\//, "")))].sort();
  return claimed.filter((file) => !isWaveWorktreeExcludedV1(file) && !matchesAny(file, [...input.allowedScope]));
}

async function walkWaveWorktreeFiles(worktree: string, dir = "", out: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(path.join(worktree, dir), { withFileTypes: true });
  for (const entry of entries) {
    if (!dir && entry.name === ".git") continue;
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    // Harness-owned heartbeat/generated paths never enter the snapshot
    // (same set the DIRECT path excludes from ChangeSet diffs); excluded
    // directories are not descended into.
    if (isWaveWorktreeExcludedV1(rel)) continue;
    if (entry.isDirectory()) await walkWaveWorktreeFiles(worktree, rel, out);
    else out.push(rel);
  }
  return out;
}

/** Snapshot the live per-unit worktree file set (after materialize + baseline). Fail-closed: throws on I/O. */
export async function snapshotWaveWorktreeV1(worktree: string): Promise<Map<string, WaveWorktreeSnapshotEntryV1>> {
  const files = (await walkWaveWorktreeFiles(worktree)).sort();
  const snapshot = new Map<string, WaveWorktreeSnapshotEntryV1>();
  for (const file of files) {
    const absolute = path.join(worktree, ...file.split("/"));
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(absolute).catch(() => "");
      snapshot.set(file, { hash: sha256Utf8(`link:${target}`), mtimeMs: Math.floor(stat.mtimeMs), size: target.length, symlink: true, ctimeMs: stat.ctimeMs, ino: stat.ino });
    } else if (stat.isFile()) {
      const bytes = await fs.readFile(absolute).catch(() => undefined);
      if (bytes === undefined) {
        // Fail-closed: a regular file present in the worktree whose bytes
        // cannot be read proves nothing about containment — record the
        // unreadable sentinel (matcher treats it as a violation, deny)
        // instead of silently omitting it.
        snapshot.set(file, { hash: WAVE_WORKTREE_UNREADABLE_HASH_V1, mtimeMs: Math.floor(stat.mtimeMs), size: stat.size, symlink: false, ctimeMs: stat.ctimeMs, ino: stat.ino });
        continue;
      }
      snapshot.set(file, { hash: sha256Utf8(bytes.toString("utf8")), mtimeMs: Math.floor(stat.mtimeMs), size: bytes.length, symlink: false, ctimeMs: stat.ctimeMs, ino: stat.ino });
    }
    // Non-regular, non-symlink entries (sockets, fifos, block/char devices)
    // are explicitly skipped: they carry no stable content bytes to hash, so
    // snapshotting them would either false-positive on every state poll
    // (ephemeral socket identity) or block on read. A worker exfiltrating
    // through a socket still lands bytes in a regular file elsewhere (or in
    // no file at all, which no filesystem gate can observe); regular-file
    // coverage above is the containment boundary.
  }
  return snapshot;
}

/** List + hash the current per-unit worktree state for the live gate. */
export async function currentWaveWorktreeStateV1(worktree: string): Promise<Map<string, WaveWorktreeSnapshotEntryV1>> {
  return snapshotWaveWorktreeV1(worktree);
}

/** Live gate check: touched-off-scope files vs the launch snapshot. */
export async function checkWaveWorktreeOffPatchV1(worktree: string, snapshot: ReadonlyMap<string, WaveWorktreeSnapshotEntryV1>, allowedScope: readonly string[]): Promise<string[]> {
  const current = await currentWaveWorktreeStateV1(worktree);
  return findOffPatchWritesV1({ snapshot, current, allowedScope });
}

/**
 * Per-invocation live check: snapshot the current unit-worktree state and
 * scope-check it against a pre-invocation snapshot, returning both the fresh
 * state (for chaining the next invocation's pre-snapshot) and the violation
 * list. Every worker invocation on the unit worktree pairs one fresh
 * pre-snapshot (taken immediately before dispatch) with one immediate call
 * here (before any further worker or git activity), so a write introduced by
 * one invocation is caught even if a later invocation reverts it.
 *
 * MECHANISM: DETERMINISTIC.
 */
export async function checkWaveUnitTurnOffPatchV1(worktree: string, preSnapshot: ReadonlyMap<string, WaveWorktreeSnapshotEntryV1>, allowedScope: readonly string[]): Promise<{ current: Map<string, WaveWorktreeSnapshotEntryV1>; offPatch: string[] }> {
  const current = await snapshotWaveWorktreeV1(worktree);
  return { current, offPatch: findOffPatchWritesV1({ snapshot: preSnapshot, current, allowedScope }) };
}

/**
 * Local-path live denial: emit the OFF_PATCH_WRITE_DENIED receipt event and
 * return the terminal FAIL result (patch "" is protection). Shared by the
 * initial-turn and correction-turn post-invocation checks so both denial
 * sites stay identical.
 *
 * MECHANISM: DETERMINISTIC.
 */
async function denyWaveUnitLiveOffPatchV1(input: { stateRoot: string; config: HarnessProjectConfig; operationId: string; contract: TaskContract; task: WorkUnitOutput; participantId: string; session: WorkerSession; files: readonly string[]; correction?: boolean }): Promise<DelegationExecutionResult> {
  const denial = createWaveOffPatchDenialV1({ operationId: input.operationId, taskId: input.contract.task.id, workUnitId: input.task.id, participantId: input.participantId, files: input.files });
  await recordEvent(input.stateRoot, input.config, WAVE_OFF_PATCH_DENIED_EVENT_V1, { operationId: input.operationId, taskId: input.contract.task.id, workUnitId: input.task.id, participantId: input.participantId, files: denial.files, fileCount: denial.fileCount, denialDigest: denial.digest, status: "FAIL", ...(input.correction ? { correction: true } : {}) }).catch(() => undefined);
  return { task: input.task, session: input.session, changedFiles: denial.files, patch: "", status: "FAIL", message: `OFF_PATCH_WRITE_DENIED: worker wrote outside its claimed scope live: ${denial.files.slice(0, 8).join(", ")} (denial ${denial.digest.slice(0, 16)}). Writes outside the unit pathspec are denied; declare via filesNeededOutsideScope.` };
}

/**
 * Distributed-branch live denial: same OFF_PATCH_WRITE_DENIED receipt and
 * event as the local path, plus the WAVE_RECONCILIATION_REQUIRED prefix so
 * the wave boundary routes the sibling to reconciliation (the distributed
 * branch never reaches the assembler's reconciliation path with a built
 * ChangeSet — denial happens before `buildWaveChangeSet`). Terminal FAIL,
 * no correction turn for a live denial.
 *
 * MECHANISM: DETERMINISTIC.
 */
async function denyDistributedWaveOffPatchV1(input: { stateRoot: string; config: HarnessProjectConfig; operationId: string; contract: TaskContract; task: WorkUnitOutput; participantId: string; session: WorkerSession; files: readonly string[] }): Promise<DelegationExecutionResult> {
  const denial = createWaveOffPatchDenialV1({ operationId: input.operationId, taskId: input.contract.task.id, workUnitId: input.task.id, participantId: input.participantId, files: input.files });
  await recordEvent(input.stateRoot, input.config, WAVE_OFF_PATCH_DENIED_EVENT_V1, { operationId: input.operationId, taskId: input.contract.task.id, workUnitId: input.task.id, participantId: input.participantId, files: denial.files, fileCount: denial.fileCount, denialDigest: denial.digest, status: "FAIL", distributed: true }).catch(() => undefined);
  return { task: input.task, session: input.session, changedFiles: denial.files, patch: "", status: "FAIL", distributed: true, message: `WAVE_RECONCILIATION_REQUIRED: OFF_PATCH_WRITE_DENIED: distributed worker reported files outside its claimed scope: ${denial.files.slice(0, 8).join(", ")} (denial ${denial.digest.slice(0, 16)}). Writes outside the unit pathspec are denied; declare via filesNeededOutsideScope.` };
}

export async function executePlannerWaves(input: { root: string; stateRoot: string; config: HarnessProjectConfig; contract: TaskContract; plannerSelection?: AgentExecutionSelection; librarianSelection?: AgentExecutionSelection; implementationSelection: AgentExecutionSelection; executionCatalog: ExecutionCatalogV1; capabilityRegistry: CapabilityRegistryV1; controller?: ControlPlaneSnapshot; precomputedPlan?: PlannerOutput; plannerPromptContext?: { operationId?: string; request?: string; explorerContext?: string; inputsPrompt?: string; readRoots?: readonly string[] }; semanticAssessment?: CandidateImpactAssessmentRuntimeV1; projectStack?: ProjectStackProfileV1; knowledgeMode?: KnowledgeModeV1; knowledgeCache?: KnowledgeCacheV1; knowledgeResolutions?: readonly KnowledgeResolutionV1[]; knowledgeLookup?: (gap: Parameters<NonNullable<Parameters<typeof resolveKnowledgeGate>[0]["lookup"]>>[0]) => Promise<KnowledgePackV1 | KnowledgeLookupResultV1>; revalidate: () => Promise<ValidationReport>; onScopeEscape?: (record: CandidateScopeEscapeV1) => Promise<void> | void }): Promise<PlannerWaveResult> {
  const planning = input.config.workflow?.planning;
  // AEH-V2-0128 residual (single source `directRouteMultiUnitBlockedV1`): a
  // DIRECT/NO_AGENT-sealed contract decomposed into more than one work unit
  // must never silently execute as DIRECT. The no-planning short-circuit below
  // would drop the multi-unit plan on the floor, so refuse fail-closed first.
  if (directRouteMultiUnitBlockedV1(input.contract.routing?.route, input.precomputedPlan?.workUnits.length ?? 0)) {
    const units = input.precomputedPlan!.workUnits.length;
    return { used: true, waves: [], sessions: [], preExecutionFailure: true, aggregateSession: aggregate([], 1, `DIRECT_MULTI_UNIT_ESCALATION_REQUIRED: sealed route '${input.contract.routing?.route}' decomposed into ${units} work units; escalate/re-seal to DELEGATED before execution, refusing to silently DIRECT-execute multi-unit work.`) };
  }
  if (planning?.enabled === false || input.contract.routing?.route === "DIRECT" || input.contract.routing?.route === "NO_AGENT") return { used: false, waves: [], sessions: [] };
  if (!input.precomputedPlan && !input.plannerSelection) return { used: false, waves: [], sessions: [] };
  const sessions: WorkerSession[] = [];
  let plan: PlannerOutput;
  if (input.precomputedPlan) {
    try { plan = plannerOutputSchema.parse(input.precomputedPlan); }
    catch (error) { return { used: true, waves: [], sessions, preExecutionFailure: true, aggregateSession: aggregate(sessions, 1, `Invalid Planner output schema: ${String(error)}`) }; }
  } else {
    // FAM-PROMPT unification: without a precomputed plan the fallback planner
    // turn uses the shared canonical prompt (operation id + frozen readRoots +
    // explorer evidence + competency allowlist + AEH_RESULT_JSON marker),
    // never the legacy contract-only variant. Frozen roots gate fail-closed
    // (PR#164 lease semantics): without a frozen readable boundary the planner
    // turn is refused before any provider session launches.
    const frozenRoots = input.plannerPromptContext?.readRoots ?? await projectedAuthorizedReadRoots(input.root, input.plannerSelection!, input.stateRoot);
    if (!frozenRoots.length) {
      return { used: true, waves: [], sessions, preExecutionFailure: true, aggregateSession: aggregate(sessions, 1, "PLANNER_FROZEN_ROOTS_REQUIRED: Planner planning requires frozen readable roots (projected lease); planning without a frozen root boundary is refused fail-closed.") };
    }
    const prompt = buildCanonicalPlannerPromptV1({
      operationId: input.plannerPromptContext?.operationId ?? currentOperationContext().id ?? input.contract.task.id,
      operationKind: (currentOperationContext().kind ?? "change").toUpperCase(),
      contract: input.contract,
      request: input.plannerPromptContext?.request ?? input.contract.request ?? input.contract.task.title,
      explorerContext: input.plannerPromptContext?.explorerContext ?? "Explorer is disabled/unavailable by topology; no explorer result was expected.",
      inputsPrompt: input.plannerPromptContext?.inputsPrompt ?? "Controller-resolved durable inputs: none.",
      readRoots: frozenRoots
    });
    const plannerSession = await executeAgentPrompt(input.root, input.config, input.contract, input.plannerSelection!, prompt, { outputContract: "planner", phase: "planning", requireExecutionAuthority: true });
    sessions.push(plannerSession);
    if (plannerSession.exitCode !== 0) return { used: true, waves: [], sessions, preExecutionFailure: true, aggregateSession: aggregate(sessions, 1, "Planner runtime failed.") };
    try { plan = plannerOutputSchema.parse(extractMarkedJson(plannerSession.stdout, plannerSession.stderr)); } catch (error) { return { used: true, waves: [], sessions, preExecutionFailure: true, aggregateSession: aggregate(sessions, 1, `Invalid planner output: ${String(error)}`) }; }
  }
  const initialPlanIssues = validatePlannerWavePlan(input.contract, plan, input.config);
  if (initialPlanIssues.length) {
    // D10 narrow auto-declare (DETERMINISTIC): when EVERY issue is of class
    // PLANNER_PROTECTED_SCOPE_UNDECLARED, the trigger is a mechanically
    // observable fact (WU scope x hard-protected intersection) that must not
    // depend on model protocol compliance. Partition the recomputed
    // intersections (shared `computePlannerUndeclaredHardScopes`, never regex
    // over issue prose) via the H-NEW-13 tier using the workspace root
    // (`input.root`, the same tree the existence stat must observe). The
    // new-test-tier subset is synthesized into plan-level declarations and
    // fed to the EXISTING resolvePlannerScopeDeclarations suspend/human route
    // unchanged (Owner approves/denies — authority boundary untouched).
    // Non-new-test-tier citations (existing tests/, validators, seals,
    // policy, globs), cap overflow, and any mixed remainder stay TERMINAL
    // with the current diagnostic: if re-validation still reports issues,
    // the whole plan fails (auto-declared subset discarded with it, never
    // routed). No new-test-tier paths -> original terminal unchanged.
    // Mechanism: DETERMINISTIC (glob intersection + existence stat +
    // objective-text reuse; no new model call, no new correction turn).
    const allUndeclared = initialPlanIssues.every((issue) => issue.includes("PLANNER_PROTECTED_SCOPE_UNDECLARED"));
    if (!allUndeclared) {
      return { used: true, plan, waves: [], sessions, preExecutionFailure: true, aggregateSession: aggregate(sessions, 1, `Planner contract rejected: ${initialPlanIssues.join("; ")}`) };
    }
    const auto = await autoDeclarePlannerNewTestScopes({ contract: input.contract, plan, config: input.config, root: input.root });
    if (!auto) {
      return { used: true, plan, waves: [], sessions, preExecutionFailure: true, aggregateSession: aggregate(sessions, 1, `Planner contract rejected: ${initialPlanIssues.join("; ")}`) };
    }
    const reIssues = validatePlannerWavePlan(input.contract, auto.plan, input.config);
    if (reIssues.length) {
      return { used: true, plan: auto.plan, waves: [], sessions, preExecutionFailure: true, aggregateSession: aggregate(sessions, 1, `Planner contract rejected: ${reIssues.join("; ")}`) };
    }
    plan = auto.plan;
    await recordEvent(input.stateRoot, input.config, "harness.plan.scope-auto-declared", {
      taskId: input.contract.task.id,
      autoDeclared: auto.autoDeclared,
      hardRemaining: auto.hardRemaining,
      source: "planner-new-test-auto-declare",
    }).catch(() => undefined);
  }
  // H-NEW-11 planner declaration routing (DETERMINISTIC orchestration, MODEL
  // content): plan-level filesNeededOutsideScope flows to the EXISTING
  // repairer amendment/suspend machinery (same receipt +
  // resolveRepairScopeBlockerViaProductChoice path — suspend HUMAN_REQUIRED
  // with bounded choices, Owner approval, amendment + reseal, retry). No
  // parallel flow is invented. On AMENDED the resealed contract is adopted
  // for compilation and waves, and the granted exemption makes the WU scopes
  // assemblable through the existing exemption-honoring assembly. On BLOCKED
  // planning stops fail-closed before any wave runs.
  const plannerRouting = await resolvePlannerScopeDeclarations({
    root: input.root, controlRoot: input.stateRoot, config: input.config, contract: input.contract, plan,
  });
  if (plannerRouting.status === "BLOCKED") {
    return { used: true, plan, waves: [], sessions, preExecutionFailure: true, aggregateSession: aggregate(sessions, 1, `Planner scope blocked: ${plannerRouting.check.message}`) };
  }
  let plannerAmendedContract: TaskContract | undefined;
  if (plannerRouting.status === "AMENDED") {
    input.contract = plannerRouting.contract;
    plannerAmendedContract = plannerRouting.contract;
  }
  const plannerAmendmentSpread = plannerAmendedContract ? { amendedContract: plannerAmendedContract } : {};
  if (!plan.workUnits.length) return { used: false, plan, waves: [], sessions, ...plannerAmendmentSpread };
  let blueprint: ExecutionBlueprint;
  let graph: ReturnType<typeof createWorkGraph>;
  let validationResolution: ValidationResolutionV1;
  let knowledgeResolutions: KnowledgeResolutionV1[] = [];
  let operation: Awaited<ReturnType<typeof loadOperation>> | undefined;
  let correctionAttempts: 0 | 1 = 0;
  try {
    const validatedPlan = await compilePlannerWorkGraphWithOneCorrection({
      contract: input.contract,
      plan,
      root: input.root,
      requestCorrection: input.plannerSelection ? async (correctionPrompt) => {
        const correctionSession = await executeAgentPrompt(input.root, input.config, input.contract, input.plannerSelection!, correctionPrompt, { outputContract: "planner", phase: "planning", requireExecutionAuthority: true });
        sessions.push(correctionSession);
        if (correctionSession.exitCode !== 0) throw new Error(`corrective Planner runtime failed with exit code ${correctionSession.exitCode}`);
        return extractMarkedJson(correctionSession.stdout, correctionSession.stderr);
      } : undefined
    });
    plan = validatedPlan.plan;
    graph = validatedPlan.graph;
    correctionAttempts = validatedPlan.correctionAttempts;
    knowledgeResolutions = await resolvePlannerKnowledge(plan, input);
    const operationContext = currentOperationContext();
    operation = operationContext.id ? await loadOperation(input.stateRoot, operationContext.id) : undefined;
    const candidateRevision = operation?.candidateRevision;
    const controllerEpoch = operation?.controller?.epoch;
    if (!candidateRevision || typeof controllerEpoch !== "number" || !Number.isSafeInteger(controllerEpoch) || controllerEpoch < 0 || operation?.operationExecutionRevision === undefined) {
      throw new AehError("EXECUTION_BLUEPRINT_INVALID", "A managed CandidateRevision and controller epoch are required before compiling an execution blueprint.");
    }
    // FAM-REACH: compile the frozen-contract-derived requirements BEFORE the
    // blueprint (same single semantic as the downstream oracle path), so
    // blueprint.validationRequirements/validationResolution ⊇ the downstream
    // oracle inputs instead of the oracle rejecting what the blueprint never
    // contained (AEH-V2-0099 class). A planner-declared requirement that no
    // approved project script, configured command, validator, or provider can
    // resolve stays advisory plan intent and is dropped with a durable
    // deterministic record — but a CONTRACT-derived requirement is a frozen
    // gate and must never be dropped silently (`partitionMerged...` fails
    // closed on it instead).
    const contractDerivedValidationRequirements = contractValidationRequirementsV1(contractValidationSourcesForContractV1(input.contract, input.config));
    const mergedValidationRequirements = mergeContractValidationRequirementsV1(plan.validationRequirements, contractDerivedValidationRequirements);
    plan = { ...plan, validationRequirements: mergedValidationRequirements };
    validationResolution = await resolveValidationRequirements({ root: input.root, requirements: mergedValidationRequirements, config: input.config, contract: input.contract, projectStack: input.projectStack });
    if (validationResolution.blocked.length) {
      const partition = partitionMergedValidationRequirementsV1(mergedValidationRequirements, contractDerivedValidationRequirements, validationResolution);
      await recordEvent(input.stateRoot, input.config, "harness.plan.validation-requirements-dropped", { taskId: input.contract.task.id, dropped: partition.dropped.map((requirement) => ({ id: requirement.id, kind: requirement.kind })), reasons: validationResolution.blocked });
      plan = { ...plan, validationRequirements: partition.kept };
      validationResolution = await resolveValidationRequirements({ root: input.root, requirements: partition.kept, config: input.config, contract: input.contract, projectStack: input.projectStack });
      if (validationResolution.blocked.length) throw new AehError("VALIDATION_REQUIREMENT_BLOCKED", validationResolution.blocked.map((item) => `${item.requirementId}: ${item.reason}`).join("; "), { details: { validationResolution } });
    }
    const executionSemanticsDigest = sha256Canonical({ workGraph: graph, plannerPlan: plan, executionCatalogDigest: input.executionCatalog.digest, validationResolution, knowledge: knowledgeResolutions.map((resolution) => ({ packDigest: resolution.pack?.packDigest, trustDecisionDigest: resolution.acceptedSkill?.trustDecision.decisionDigest })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), contextPolicy: input.config.context ?? null });
    operation = await bindOperationExecutionSemantics(input.stateRoot, operation!.id, executionSemanticsDigest);
  blueprint = await compileWaveExecutionBlueprint({ input, operation, graph, knowledgeResolutions, validationResolution, capabilityRegistry: input.capabilityRegistry, plan });
  } catch (error) {
    const failedCorrectionAttempts = error instanceof PlannerWorkGraphCorrectionError ? error.correctionAttempts : correctionAttempts;
    return { used: true, plan, waves: [], sessions, preExecutionFailure: true, correctionAttempts: failedCorrectionAttempts, ...plannerAmendmentSpread, aggregateSession: aggregate(sessions, 1, `Participant plan rejected: ${String(error)}`) };
  }
  // The executor consumes schedule.waves (built below), never blueprint.waves
  // directly: the frozen blueprint is the serialization contract (its wave
  // index is the per-unit lower bound), while the graphify-refined schedule
  // is the enforced execution order. Passing blueprint.waves here makes the
  // bound earnest at the single place schedule waves are built.
  const schedule = await planParallelism(input.root, input.config, input.contract.task.id, plan.workUnits, { blueprintWaves: blueprint.waves });
  const worktreeIsolation = planning?.worktreeIsolation !== false;
  await recordEvent(input.stateRoot, input.config, "harness.plan.ready", { taskId: input.contract.task.id, workUnits: plan.workUnits.length, waves: schedule.waves.length, conflicts: schedule.conflicts.length, graphUsed: schedule.graphUsed, compilerDigest: blueprint.plan.compilerDigest, worktreeIsolation, distributed: planning?.distributed === true && input.config.distributed?.enabled === true });
  const waveSummaries: WaveExecutionSummary[] = []; let finalReport: ValidationReport | undefined; let currentCandidate = operation?.candidateRevision;
  // Scope-escape one-correction accounting (no new budget knob): counts every
  // participant-attempt that used its single correction turn (success or
  // terminal second-escape/timeout). run.ts consumes this against the existing
  // repair budget (attempts + corrections < maxRepairs).
  // Round-2 B1: shared synchronous reservation gate — REMAINING budget is
  // checked BEFORE offering each correction (no remaining → original FAIL,
  // no correction); reservations happen synchronously so parallel tasks
  // cannot double-spend. Post-hoc summing is removed (was overspend).
  const escapeGate = createEscapeCorrectionBudgetGateV1(escapeCorrectionBudgetV1(input.contract, input.config));
  for (let index = 0; index < schedule.waves.length; index += 1) {
    if (index > 0 && graph && operation) {
      try {
        operation = await loadOperation(input.stateRoot, operation.id);
        currentCandidate = operation.candidateRevision;
        if (!currentCandidate) throw new AehError("EXECUTION_BLUEPRINT_INVALID", "Current candidate is required to recompile the next wave identity.");
        blueprint = await compileWaveExecutionBlueprint({ input, operation, graph, knowledgeResolutions, validationResolution, capabilityRegistry: input.capabilityRegistry, plan });
      } catch (error) {
        const summary: WaveExecutionSummary = { wave: index + 1, taskIds: schedule.waves[index]!, status: "FAIL", results: [] };
        waveSummaries.push(summary);
        return { used: true, plan, blueprint, schedule, waves: waveSummaries, sessions, ...plannerAmendmentSpread, ...(escapeGate.used ? { escapeCorrections: escapeGate.used } : {}), aggregateSession: aggregate(sessions, 1, `Next wave execution identity could not be recompiled: ${String(error)}`) };
      }
    }
    const ids = schedule.waves[index]; const tasks = ids.map((id) => plan.workUnits.find((task) => task.id === id)!).filter(Boolean);
    const participantByWorkUnit = new Map<string, ParticipantAssignmentV1>();
    for (const assignment of blueprint.plan.assignments as ParticipantAssignmentV1[]) for (const workUnitId of assignment.workUnitIds) participantByWorkUnit.set(workUnitId, assignment);
    if (!currentCandidate || !operation?.id) { const summary: WaveExecutionSummary = { wave: index + 1, taskIds: ids, status: "FAIL", results: [] }; waveSummaries.push(summary); return { used: true, plan, blueprint, schedule, waves: waveSummaries, sessions, ...plannerAmendmentSpread, ...(escapeGate.used ? { escapeCorrections: escapeGate.used } : {}), aggregateSession: aggregate(sessions, 1, "Candidate assembly requires a managed operation candidate.") }; }
    const waveOperationId = operation.id;
    const waveBlueprint = blueprint;
    const waveBase = createWaveBase({ operationId: waveOperationId, taskId: input.contract.task.id, waveIndex: index, candidate: currentCandidate });
    const concurrency = waveConcurrencyV1(planning, tasks.length);
    if (tasks.length > concurrency || (planning?.maxWaveConcurrency ?? 0) > WAVE_CONCURRENCY_LEASE_CAP_V1) {
      await recordEvent(input.stateRoot, input.config, WAVE_BACKPRESSURE_EVENT_V1, waveBackpressureAttributes({ wave: index + 1, taskId: input.contract.task.id, active: tasks.length, ceiling: WAVE_CONCURRENCY_LEASE_CAP_V1, queued: Math.max(0, tasks.length - concurrency), retryAfterMs: 0, disposition: "CLAMPED" }));
    }
    // Operation-wide provider-session QUEUE gate (durable equivalent of
    // tryAcquireProviderLease; production caller of waitForProviderSessionCapacity).
    // Luna F1: bounded WAIT against the wave's EXISTING budget — WAIT =
    // min(requested 30s, remaining wave/operation budget) when a finite frozen
    // Owner hard deadline exists; when none can be established (undefined),
    // mint NO fresh 30s (single immediate check only: headroom proceeds,
    // saturation is terminal FAIL with zero sleeps, fail-closed).
    // MECHANISM: DETERMINISTIC. Wave budget deadline = min(now + 30s, frozen
    // Owner hard deadline) when present, else undefined (no fresh); threaded
    // as deadlineAtMs so the wait never extends caps. Deterministic clocks via
    // pure helpers (tests pin it).
    const waveStartedAtMs = Date.now();
    const operationDeadlineAtMs = operation ? frozenOperationHardDeadlineAt(operation) : undefined;
    const waveCapacityDeadlineAtMs = resolveWaveCapacityDeadlineAtMs(waveStartedAtMs, operationDeadlineAtMs, WAVE_BACKPRESSURE_MAX_WAIT_MS_V1);
    const capacity = await waitForProviderSessionCapacity(input.stateRoot, waveOperationId, {
      ceiling: WAVE_CONCURRENCY_LEASE_CAP_V1,
      maxWaitMs: WAVE_BACKPRESSURE_MAX_WAIT_MS_V1,
      deadlineAtMs: waveCapacityDeadlineAtMs,
      pollMs: 50
    });
    if (!capacity.acquired) {
      await recordEvent(input.stateRoot, input.config, WAVE_BACKPRESSURE_EVENT_V1, waveBackpressureAttributes({ wave: index + 1, taskId: input.contract.task.id, active: capacity.active, ceiling: capacity.ceiling, queued: tasks.length, retryAfterMs: WAVE_BACKPRESSURE_MAX_WAIT_MS_V1, disposition: "QUEUE" }));
      // Observation-only provider backpressure telemetry via existing conventions
      // (production caller of providerBackpressureAttributes + providerLeaseBackpressureSignal;
      // never a gate).
      const providerSignal = providerLeaseBackpressureSignal(capacity.active, tasks.length, capacity.ceiling);
      await recordEvent(
        input.stateRoot,
        input.config,
        PROVIDER_BACKPRESSURE_EVENT_V1,
        providerBackpressureAttributes({
          operationId: waveOperationId,
          active: providerSignal.active,
          ceiling: providerSignal.ceiling ?? capacity.ceiling,
          queued: providerSignal.queued,
          retryAfterMs: WAVE_BACKPRESSURE_MAX_WAIT_MS_V1,
          disposition: "QUEUE"
        })
      ).catch(() => undefined);
      const summary: WaveExecutionSummary = {
        wave: index + 1,
        taskIds: ids,
        status: "FAIL",
        results: tasks.map((task) => ({
          task,
          session: { provider: "wave-queue", logicalAgent: task.id, exitCode: 1, stdout: "", stderr: `WAVE_QUEUE_EXHAUSTED: operation ${waveOperationId} holds ${capacity.active}/${capacity.ceiling} provider sessions; QUEUE budget exhausted.` },
          changedFiles: [],
          patch: "",
          status: "FAIL" as const,
          message: `WAVE_QUEUE_EXHAUSTED: operation ${waveOperationId} holds ${capacity.active}/${capacity.ceiling} provider sessions; QUEUE budget exhausted.`
        }))
      };
      waveSummaries.push(summary);
      await recordEvent(input.stateRoot, input.config, "harness.wave.finish", { taskId: input.contract.task.id, wave: index + 1, status: "FAIL", tasks: ids });
      return { used: true, plan, blueprint, schedule, waves: waveSummaries, sessions, ...plannerAmendmentSpread, ...(escapeGate.used ? { escapeCorrections: escapeGate.used } : {}), aggregateSession: aggregate(sessions, 1, `Wave ${index + 1} provider capacity QUEUE exhausted.`) };
    }
    // Per-workspace write-lease admission (Luna F2+F3: SHARED durable atomic
    // acquire, not wave-local check-then-proceed; non-throwing QUEUE, never
    // throw-on-conflict on the wired path). Isolated tasks use distinct
    // workspace keys (ACQUIRED); shared-workspace waves share one key (second
    // writer QUEUES, serializing to 1). The durable atomic acquire
    // (`acquireWaveProviderSlotSharedOrQueue` → `acquireDurableWaveSlotOrQueue`
    // file-locked transact, same store/predicate as `acquireProviderLease`)
    // sees cross-wave/operation/process contention end-to-end (acquire-or-wait-
    // or-fail, never both proceed). Residual 429/lease conflicts RETRY via
    // bounded `withWaveBackpressureRetry` within the REMAINING wave budget
    // (Luna F1: WAIT is not an attempt; exhaustion terminal; never a fresh 30s
    // unbounded by the wave/operation deadline).
    const waveProjectId = input.config.project.name;
    // Luna F1 (continued): per-slot retries share the wave's remaining budget,
    // not a fresh 30s. Remaining = waveCapacityDeadline - now (0/undefined →
    // terminal, no fresh). Undefined deadline means no wait budget (immediate).
    const waveSlotTimeoutMs = Math.max(0, remainingWaveBudgetMs(waveCapacityDeadlineAtMs, Date.now()));
    const executeWithQueue = (task: (typeof tasks)[number]): Promise<DelegationExecutionResult> =>
      withWaveBackpressureRetry(
        async (remaining) => {
          const isolated = planning?.worktreeIsolation !== false;
          const workspaceId = isolated ? `wave:${waveOperationId}:${index}:${task.id}` : `wave:${waveOperationId}:${index}`;
          const slot = await acquireWaveProviderSlotSharedOrQueue(
            input.stateRoot,
            { provider: "wave", projectId: waveProjectId, canonicalRoot: input.root, workspaceId, ownerId: task.id, mode: "write" },
            {
              ...(remaining !== undefined ? { remainingBudgetMs: remaining } : { remainingBudgetMs: 0 }),
            }
          );
          if (!slot.acquired) {
            // QUEUE budget exhausted for this slot → terminal FAIL (fail-closed, never throw).
            return {
              task,
              session: { provider: "wave-queue", logicalAgent: task.id, exitCode: 1, stdout: "", stderr: `WAVE_QUEUE_EXHAUSTED: provider wave already leased (depth ${slot.queueDepth}); QUEUE budget exhausted.` },
              changedFiles: [],
              patch: "",
              status: "FAIL" as const,
              message: `WAVE_QUEUE_EXHAUSTED: provider wave is already leased in ${workspaceId} (depth ${slot.queueDepth}); QUEUE budget exhausted.`
            };
          }
          try {
            const result = await executeDelegation({ ...input, operationId: waveOperationId, task, participantAssignment: participantByWorkUnit.get(task.id), executionBlueprint: waveBlueprint, waveBase: waveBase.candidate, escapeCorrectionGate: escapeGate });
            // Residual backpressure surfaced as FAIL message QUEUES (not terminal FAIL):
            // throw to trigger WAIT+RETRY within budget; exhaustion rethrows as FAIL below.
            // shouldQueueWaveWork is the wave QUEUE gate (alias of isWaveBackpressureError).
            if (result.status === "FAIL" && result.message && shouldQueueWaveWork(result.message)) {
              throw new Error(result.message);
            }
            return result;
          } finally {
            // Release durable wave slot for the next QUEUED waiter (best-effort
            // atomic release under the same snapshot lock; never fails delegation).
            // LeaseId is present on ACQUIRED (atomic path); missing means nothing to release.
            try {
              if (slot.leaseId) await releaseDurableWaveSlot(input.stateRoot, slot.leaseId, task.id);
            } catch { /* best-effort slot release never fails the delegation */ }
          }
        },
        { timeoutMs: waveSlotTimeoutMs }
      ).catch((error) => {
        // Exhausted QUEUE budget or terminal non-backpressure failure → FAIL (never throw).
        if (shouldQueueWaveWork(error)) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            task,
            session: { provider: "wave-queue", logicalAgent: task.id, exitCode: 1, stdout: "", stderr: message.slice(0, 500) },
            changedFiles: [],
            patch: "",
            status: "FAIL" as const,
            message: message.slice(0, 500)
          };
        }
        throw error;
      });
    const results = await mapLimit(tasks, concurrency, executeWithQueue); sessions.push(...results.map((result) => result.session));
    // Round-2 B1: reservations already counted synchronously in the gate;
    // post-hoc summing removed (was parallel overspend). Still surface
    // correction sessions for forensics.
    for (const result of results) {
      if (result.escapeCorrectionSessions?.length) sessions.push(...result.escapeCorrectionSessions);
    }
    if (results.some((result) => result.status === "FAIL")) { const summary: WaveExecutionSummary = { wave: index + 1, taskIds: ids, status: "FAIL", results }; waveSummaries.push(summary); await recordEvent(input.stateRoot, input.config, "harness.wave.finish", { taskId: input.contract.task.id, wave: index + 1, status: "FAIL", tasks: ids }); return { used: true, plan, blueprint, schedule, waves: waveSummaries, sessions, ...plannerAmendmentSpread, ...(escapeGate.used ? { escapeCorrections: escapeGate.used } : {}), aggregateSession: aggregate(sessions, 1, `Wave ${index + 1} failed.`) }; }
    const resultByWorkUnit = new Map(results.map((result) => [result.task.id, result] as const));
    const submissions: WaveChangeSetSubmissionV1[] = [];
    for (const result of results) {
      if (!result.changeSet) continue;
      submissions.push({
        workUnitId: result.task.id,
        changeSet: result.changeSet,
        allowedScope: result.task.scope,
        resourceClaims: result.task.resourceClaims ?? []
      });
    }
    if (submissions.length) {
      try {
        const integration = await integrateWaveChangeSets({ root: input.root, stateRoot: input.stateRoot, operationId: operation.id, taskId: input.contract.task.id, wave: waveBase, submissions, semanticAssessment: input.semanticAssessment, ...(input.onScopeEscape ? { onScopeEscape: input.onScopeEscape } : {}) });
        for (const step of integration.integrated) {
          const result = resultByWorkUnit.get(step.workUnitId);
          if (result) { result.candidate = step.candidate; result.impact = step.impact; }
          await recordEvent(input.stateRoot, input.config, "harness.candidate.assembled", { taskId: input.contract.task.id, workUnitId: step.workUnitId, participantId: step.changeSet.participantId, candidateRevision: step.candidate.revision, candidateDigest: step.candidate.sourceDigest, impactDigest: step.impact.digest, changeKinds: step.impact.changeKinds, reviewDimensions: step.impact.reviewDimensions, requiresIndependentReview: step.impact.requiresIndependentReview, waveBaseRevision: waveBase.candidate.revision, derivedRebase: step.derived });
        }
        for (const requirement of integration.reconciliationRequired) {
          const result = resultByWorkUnit.get(requirement.workUnitId);
          if (result) { result.status = "FAIL"; result.message = `WAVE_RECONCILIATION_REQUIRED: ${requirement.reason}`; }
        }
        const last = integration.integrated.at(-1);
        if (last) currentCandidate = last.candidate;
      } catch (error) {
        // Wave-level integration failure (stale base, wrong operation, or an
        // unrestorable workspace): no structured result exists, so mark every
        // submitted sibling as unintegrated and fall through to the shared
        // FAIL summary below, which emits `harness.wave.finish` FAIL and the
        // aggregate session the throw would otherwise skip. Earlier-sibling
        // binds, if any, remain durable on the operation candidate.
        const detail = (error instanceof Error ? error.message : String(error)).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0]?.slice(0, 500) ?? "wave integration failed";
        for (const submission of submissions) {
          const result = resultByWorkUnit.get(submission.workUnitId);
          if (result && result.status !== "FAIL") { result.status = "FAIL"; result.message = `WAVE_INTEGRATION_FAILED: ${detail}`; }
        }
      }
    }
    if (results.some((result) => result.status === "FAIL")) { const summary: WaveExecutionSummary = { wave: index + 1, taskIds: ids, status: "FAIL", results }; waveSummaries.push(summary); await recordEvent(input.stateRoot, input.config, "harness.wave.finish", { taskId: input.contract.task.id, wave: index + 1, status: "FAIL", tasks: ids, reconciliationRequired: results.filter((result) => result.message?.startsWith("WAVE_RECONCILIATION_REQUIRED")).map((result) => result.task.id) }); return { used: true, plan, blueprint, schedule, waves: waveSummaries, sessions, ...plannerAmendmentSpread, ...(escapeGate.used ? { escapeCorrections: escapeGate.used } : {}), aggregateSession: aggregate(sessions, 1, `Wave ${index + 1} candidate assembly failed.`) }; }
    finalReport = planning?.barrierValidation === false ? undefined : await input.revalidate(); const status = finalReport?.status === "FAIL" ? "FAIL" : "PASS"; const summary: WaveExecutionSummary = { wave: index + 1, taskIds: ids, status, results, barrier: finalReport }; waveSummaries.push(summary); await recordEvent(input.stateRoot, input.config, "harness.wave.finish", { taskId: input.contract.task.id, wave: index + 1, status, tasks: ids, checks: finalReport?.checks.length }); if (status === "FAIL") return { used: true, plan, schedule, waves: waveSummaries, sessions, ...plannerAmendmentSpread, ...(escapeGate.used ? { escapeCorrections: escapeGate.used } : {}), aggregateSession: aggregate(sessions, 1, `Wave ${index + 1} deterministic barrier failed.`), report: finalReport };
  }
  finalReport ??= await input.revalidate(); return { used: true, plan, blueprint, schedule, waves: waveSummaries, sessions, ...plannerAmendmentSpread, ...(escapeGate.used ? { escapeCorrections: escapeGate.used } : {}), aggregateSession: aggregate(sessions, finalReport.status === "PASS" ? 0 : 1, `Executed ${plan.workUnits.length} work unit(s) across ${schedule.waves.length} wave(s).`), report: finalReport, correctionAttempts };
}

export async function resolvePlannerKnowledge(plan: PlannerOutput, input: Pick<Parameters<typeof executePlannerWaves>[0], "contract" | "root" | "config" | "librarianSelection" | "knowledgeMode" | "knowledgeCache" | "knowledgeResolutions" | "knowledgeLookup"> & Partial<Pick<Parameters<typeof executePlannerWaves>[0], "stateRoot">>): Promise<KnowledgeResolutionV1[]> {
  const knownCompetencies = [...new Set(defaultSkillSeed().skills.flatMap((skill) => skill.competencies.map((competency) => competency.id)))];
  const provided = [...(input.knowledgeResolutions ?? [])];
  const providedByCompetency = new Map(provided.flatMap((resolution) => resolution.acceptedSkill ? [[resolution.acceptedSkill.competency, resolution] as const] : []));
  const cache = input.knowledgeCache ?? (input.stateRoot ? new FileKnowledgeCacheV1(path.join(input.stateRoot, ".harness", "cache", "knowledge-v1")) : undefined);
  const resolutions: KnowledgeResolutionV1[] = [...provided];
  const required = [...new Set(plan.workUnits.flatMap((unit) => unit.competencies))].sort();
  for (const competency of required) {
    if (knownCompetencies.includes(competency) || providedByCompetency.has(competency)) continue;
    const resolution = await resolveKnowledgeGate({
      requiredCompetencies: [competency],
      knownCompetencies,
      mode: input.knowledgeMode ?? "TRUSTED_DISCOVERY",
      cache,
      lookup: input.knowledgeLookup ?? (input.librarianSelection ? (gap) => lookupWithLibrarian(input, gap) : undefined)
    });
    if (resolution.gate !== "SUFFICIENT") throw new AehError("KNOWLEDGE_GAP_BLOCKED", `knowledge gate could not establish trusted knowledge for '${competency}'.`, { details: { competency, gap: resolution.gap } });
    resolutions.push(resolution);
    if (resolution.acceptedSkill) providedByCompetency.set(resolution.acceptedSkill.competency, resolution);
  }
  return [...new Map(resolutions.map((resolution) => [resolution.acceptedSkill?.competency ?? resolution.pack?.packDigest ?? JSON.stringify(resolution), resolution])).values()];
}

async function compileWaveExecutionBlueprint(args: {
  input: Parameters<typeof executePlannerWaves>[0];
  operation: Awaited<ReturnType<typeof loadOperation>>;
  graph: ReturnType<typeof createWorkGraph>;
  knowledgeResolutions: KnowledgeResolutionV1[];
  validationResolution: ValidationResolutionV1;
  capabilityRegistry: CapabilityRegistryV1;
  plan: PlannerOutput;
}): Promise<ExecutionBlueprint> {
  const { input, operation, graph, knowledgeResolutions, validationResolution, capabilityRegistry, plan } = args;
  const candidate = operation.candidateRevision;
  const controllerEpoch = operation.controller?.epoch;
  if (!candidate || !Number.isSafeInteger(operation.operationExecutionRevision) || operation.operationExecutionRevision! < 1 || !Number.isSafeInteger(controllerEpoch) || controllerEpoch! < 0) throw new AehError("EXECUTION_BLUEPRINT_INVALID", "Current candidate, operation execution revision, and controller epoch are required to compile an execution blueprint.");
  const knowledgePolicy = knowledgeResolutions.map((resolution) => ({ packDigest: resolution.pack?.packDigest, trustDecisionDigest: resolution.acceptedSkill?.trustDecision.decisionDigest })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const deliveryPolicy = configuredDeliveryPolicy(input.config, operation.kind);
  const allowedExternalEffects = deliveryPolicy.allowedExternalEffects;
  const humanDecisionRequirements = requiredHumanActionAuthorizations(allowedExternalEffects);
  const resolvedOperationPolicy = compileResolvedOperationPolicy({
    projectId: candidate.projectId ?? input.config.project.name,
    operationId: operation.id,
    operationExecutionRevision: operation.operationExecutionRevision!,
    candidateRevision: candidate.revision,
    candidateDigest: candidate.identityDigest,
    controllerEpoch: controllerEpoch!,
    intent: operation.intent?.request ?? input.contract.routing?.intent ?? input.contract.task.title,
    route: graph.route,
    minimumAssurance: graph.assurance,
    policyVersions: { resolvedOperationPolicy: "2", roleInvocationPolicy: "1", executionBlueprint: "3", executionBinding: "3", skillManifest: "1", capabilityRegistry: "1", operationalSkillProjection: "1" },
    policyDigests: {
      validation: validationResolution.digest,
      delivery: sha256Canonical({ ...deliveryPolicy, humanDecisionRequirements }),
      knowledge: sha256Canonical(knowledgePolicy),
      context: sha256Canonical(input.config.context ?? null),
      capabilityRegistry: capabilityRegistry.digest,
      executionLiveness: sha256Canonical(operation.resolvedOperationPolicy?.executionLiveness ?? input.config.orchestration?.operations?.liveness ?? {}),
      economicEnvelope: sha256Canonical(operation.resolvedOperationPolicy?.economicEnvelope ?? input.config.orchestration?.operations?.economicEnvelope ?? {})
    },
    capabilityRegistryDigest: capabilityRegistry.digest,
    validationPolicy: validationResolution,
    reviewPolicy: {
      minimumAssurance: graph.assurance,
      reviewDimensions: plan.workUnits.flatMap((unit) => unit.changeKinds.map((kind) => `change:${kind}`)).sort(),
      independentReviewRequired: graph.assurance === "ELEVATED" || graph.assurance === "CRITICAL",
      leadAcceptance: input.config.workflow?.reviews?.leadAcceptance !== false,
      leadAcceptanceDirect: input.config.workflow?.reviews?.leadAcceptanceDirect === true
    },
    deliveryPolicy,
    knowledgePolicy: { resolutions: knowledgePolicy },
    contextPolicy: input.config.context ?? { mode: "disabled" },
    allowedExternalEffects,
    humanDecisionRequirements,
    executionLiveness: operation.resolvedOperationPolicy?.executionLiveness ?? input.config.orchestration?.operations?.liveness,
    economicEnvelope: operation.resolvedOperationPolicy?.economicEnvelope ?? input.config.orchestration?.operations?.economicEnvelope
  });
  const persisted = operation.resolvedOperationPolicy?.digest === resolvedOperationPolicy.digest
    ? operation
    : await bindResolvedOperationPolicy(input.stateRoot, operation.id, resolvedOperationPolicy);
  return compileExecutionBlueprint({ graph, maxTokens: input.config.context?.budgets?.default?.maxTokens, candidate, controllerEpoch: controllerEpoch!, operationExecutionRevision: persisted.operationExecutionRevision!, resolvedOperationPolicy, executionCatalog: input.executionCatalog, capabilityRegistry, knowledgeResolutions, projectStack: input.projectStack, validationRequirements: plan.validationRequirements, validationResolution });
}

async function lookupWithLibrarian(input: Pick<Parameters<typeof executePlannerWaves>[0], "contract" | "root" | "config" | "librarianSelection">, gap: NonNullable<Parameters<NonNullable<Parameters<typeof resolveKnowledgeGate>[0]["lookup"]>>[0]>): Promise<KnowledgeLookupResultV1> {
  if (!input.librarianSelection) throw new AehError("KNOWLEDGE_GAP_BLOCKED", `no Librarian selection is available for '${gap.missingCompetencies.join(", ")}'.`);
  const session = await executeAgentPrompt(input.root, input.config, input.contract, input.librarianSelection, buildLibrarianPrompt(gap), { outputContract: "knowledge-pack", phase: "knowledge", operationKind: "change", requireExecutionAuthority: true });
  if (session.exitCode !== 0) throw new AehError("KNOWLEDGE_GAP_BLOCKED", `Librarian failed while resolving '${gap.missingCompetencies.join(", ")}'.`);
  try {
    const output = knowledgePackOutputSchema.parse(extractMarkedJson(session.stdout, session.stderr));
    return { pack: validateKnowledgePack(output.pack, gap), ...(output.skillCandidate ? { skillCandidate: output.skillCandidate } : {}) };
  } catch (error) {
    if (error instanceof AehError) throw error;
    throw new AehError("KNOWLEDGE_PACK_REJECTED", `Librarian returned an invalid pack for '${gap.missingCompetencies.join(", ")}'.`, { cause: error });
  }
}

function buildLibrarianPrompt(gap: { cacheKey: string; missingCompetencies: string[]; reason: string; mode: KnowledgeModeV1 }): string {
  // HYBRID: the Librarian semantically proposes claim/source links for each procedure step; SkillTrustGate deterministically verifies every reference against the accepted pack and source policy.
  return `Resolve this deterministic knowledge gap as a read-only Librarian. Do not edit source, install anything, grant tools or change policy. ${gap.mode === "DOCS_ONLY" ? "Use official, version-matched documentation only; repository examples, public code, community pages and unknown sources are not acceptable." : gap.mode === "OFFLINE" ? "Do not perform external lookup; report the gap as unresolved." : "Use approved version-matched documentation or clearly identified repository/public-code evidence."} Preserve source provenance. Return exactly one AEH_RESULT_JSON object with {"pack":{"version":1,"cacheKey":${JSON.stringify(gap.cacheKey)},"topic":...,"claims":[{"id":...,"statement":...,"competency":...,"confidence":"high|medium|low"}],"sources":[{"uri":...,"kind":"official|repository|public-code|unknown","version":...}],"retrievedAt":"ISO-8601","packDigest":"sha256"},"skillCandidate":{"version":1,"id":"ephemeral:<competency>","competency":"<competency>","procedure":["<exact step text>"],"sourcePackDigest":"<pack digest>","procedureEvidence":[{"stepIndex":0,"claimIds":["<claim id supporting this exact step>"],"sourceUris":["<supporting source URI from pack.sources>"]}]}}. If returning a procedure, provide one procedureEvidence entry for every step, with at least one pack claim ID and allowed source URI that support that exact step; do not add trust or acceptance fields because SkillTrustGate makes that decision. The pack and any candidate must address only: ${gap.missingCompetencies.join(", ")}. Gap reason: ${gap.reason}.`;
}

export async function executeDelegation(input: { root: string; stateRoot: string; config: HarnessProjectConfig; contract: TaskContract; implementationSelection: AgentExecutionSelection; executionCatalog: ExecutionCatalogV1; controller?: ControlPlaneSnapshot; operationId: string; task: WorkUnitOutput; participantAssignment?: ParticipantAssignmentV1; executionBlueprint: ExecutionBlueprint; waveBase: CandidateRevisionV1; escapeCorrectionGate?: EscapeCorrectionBudgetGateV1; }): Promise<DelegationExecutionResult> {
  if (!input.participantAssignment) return failed(input.task, input.implementationSelection, "EXECUTION_BLUEPRINT_INVALID: work unit has no frozen participant assignment.");
  const participantId = input.participantAssignment.participantId;
  let selection: AgentExecutionSelection;
  try {
    selection = selectionForParticipant(input.implementationSelection, input.participantAssignment, input.executionCatalog);
  } catch (error) {
    return failed(input.task, input.implementationSelection, String(error));
  }
  try { selection = enforceSandboxPolicy(selection, input.config, input.task.risk === "critical" ? "high" : input.task.risk).selection; } catch (error) { return failed(input.task, selection, String(error)); }
  const transport = selection.transport === "inherit" ? (input.config.orchestration?.provider ?? "none") : selection.transport; const capabilityIssues = validateExecutionCapabilities(selection, transport); if (capabilityIssues.length) return failed(input.task, selection, `Agent ${selection.logicalAgent} cannot execute: ${capabilityIssues.join("; ")}`);
  const prompt = buildDelegationPrompt(input.contract, input.task, input.participantAssignment?.operationalSkills);
  if (input.config.workflow?.planning?.distributed === true && input.config.distributed?.enabled === true) {
    try {
      const roleInvocationPolicy = input.participantAssignment.roleInvocationPolicy;
      if (!roleInvocationPolicy) throw new Error("EXECUTION_BINDING_REQUIRED: blueprint has no RoleInvocationPolicy for the distributed participant.");
      const identity = await prepareAgentExecutionIdentity(input.root, input.config, input.contract, selection, prompt, { participantId, phase: "distributed", operationKind: currentOperationContext().kind, executionBlueprint: input.executionBlueprint, executionBlueprintDigest: input.executionBlueprint.digest, roleInvocationPolicy, skillManifest: input.participantAssignment.skillManifest });
      const remote = await dispatchDistributedDelegation({ root: input.root, config: input.config, contract: input.contract, task: input.task, participantId, selection, controller: input.controller, waveBase: input.waveBase, identity });
      const violations = remote.changedFiles.filter((file) => !isWaveWorktreeExcludedV1(file) && !matchesAny(file, input.task.scope));
      if (violations.length) {
        // Distributed scope-escape ONE-correction turn (same bound/guard as
        // the local path above; re-dispatch once with the diagnostic prompt,
        // same waveBase/slot/timeout — no new budget knob).
        // Round-2 B1: REMAINING budget checked BEFORE offering; exhausted →
        // ORIGINAL FAIL immediately with no correction turn (no double-spend).
        // Round-2 B2: declaration routing below (never PASS-with-declaration).
        const escapeDiff = assemblerScopeEscapeDiffV1(violations);
        const diagnostic = buildScopeEscapeCorrectionPrompt({
          escapedFiles: escapeDiff.escapedFiles,
          escapedCount: escapeDiff.escapedCount,
          amendableManifests: escapeDiff.amendableManifests,
          amendableCount: escapeDiff.amendableCount,
          hardProtected: escapeDiff.hardProtected,
          hardProtectedCount: escapeDiff.hardProtectedCount,
          operationId: input.operationId,
          taskId: input.contract.task.id,
        });
        const originalMessage = `Remote delegation escaped scope: ${violations.join(", ")}`;
        if (input.escapeCorrectionGate && !input.escapeCorrectionGate.tryReserve()) {
          return {
            task: input.task,
            session: remote.session,
            changedFiles: remote.changedFiles,
            patch: "",
            status: "FAIL",
            distributed: true,
            message: `${originalMessage} (escape-correction budget exhausted; no correction turn offered)`,
          };
        }
        const correctionPrompt = `${prompt}\n\n${diagnostic}`;
        try {
          const correctionIdentity = await prepareAgentExecutionIdentity(input.root, input.config, input.contract, selection, correctionPrompt, { participantId, phase: "distributed", operationKind: currentOperationContext().kind, executionBlueprint: input.executionBlueprint, executionBlueprintDigest: input.executionBlueprint.digest, roleInvocationPolicy, skillManifest: input.participantAssignment.skillManifest });
          const correctionRemote = await dispatchDistributedDelegation({ root: input.root, config: input.config, contract: input.contract, task: input.task, participantId, selection, controller: input.controller, waveBase: input.waveBase, identity: correctionIdentity });
          const correctionTimeout =
            correctionRemote.session.exitCode === 124 ||
            (correctionRemote.session as { status?: string }).status === "timeout" ||
            (correctionRemote.session as { killReason?: string }).killReason === "STALLED_FIRST_ACTIVITY" ||
            (correctionRemote.session as { killReason?: string }).killReason === "DEADLINE";
          const reviolations = correctionRemote.changedFiles.filter((file) => !isWaveWorktreeExcludedV1(file) && !matchesAny(file, input.task.scope));
          if (correctionTimeout || correctionRemote.session.exitCode !== 0) {
            // Correction timeout or correction worker failure → ORIGINAL
            // terminal FAIL (exactly one correction).
            return {
              task: input.task,
              session: remote.session,
              changedFiles: remote.changedFiles,
              patch: "",
              status: "FAIL",
              distributed: true,
              message: originalMessage,
              escapeCorrectionUsed: true,
              escapeCorrectionSessions: [correctionRemote.session],
            };
          }
          // Turn-3: declaration check FIRST — a correction carrying
          // filesNeededOutsideScope routes to BLOCKED with scopeBlocker
          // REGARDLESS of remaining violations (same semantics as
          // DIRECT/repair — FAIL with blocker, never PASS-with-declaration).
          // Vacuous (no genuinely-blocked) stays unblocked and falls through
          // to the reviolations check below.
          const declaration = classifyWaveCorrectionDeclarationV1({
            session: correctionRemote.session,
            changedFiles: correctionRemote.changedFiles,
            operationId: input.operationId,
            taskId: input.contract.task.id,
            workUnitId: input.task.id,
            participantId,
            taskScope: input.task.scope,
            contract: input.contract,
            config: input.config,
          });
          if (declaration.blocked) {
            const files = declaration.blocker?.filesNeededOutsideScope.map((entry) => entry.path).join(", ") ?? "filesNeededOutsideScope";
            return {
              task: input.task,
              session: correctionRemote.session,
              changedFiles: correctionRemote.changedFiles,
              patch: "",
              status: "FAIL",
              distributed: true,
              message: `WAVE_SCOPE_BLOCKER: correction declared out-of-scope file(s): ${files}. Declare via filesNeededOutsideScope; do not expand scope without a lead-approved amendment.`,
              escapeCorrectionUsed: true,
              escapeCorrectionSessions: [remote.session],
              ...(declaration.blocker ? { scopeBlocker: declaration.blocker } : {}),
            };
          }
          if (reviolations.length) {
            // Second escape → ORIGINAL terminal FAIL (exactly one correction).
            return {
              task: input.task,
              session: remote.session,
              changedFiles: remote.changedFiles,
              patch: "",
              status: "FAIL",
              distributed: true,
              message: originalMessage,
              escapeCorrectionUsed: true,
              escapeCorrectionSessions: [correctionRemote.session],
            };
          }
          if (correctionRemote.status === "PASS" && correctionRemote.patch.trim()) {
            if (correctionRemote.observedCandidateSourceDigest !== input.waveBase.sourceDigest) {
              return {
                task: input.task,
                session: remote.session,
                changedFiles: remote.changedFiles,
                patch: "",
                status: "FAIL",
                distributed: true,
                message: originalMessage,
                escapeCorrectionUsed: true,
                escapeCorrectionSessions: [correctionRemote.session],
              };
            }
            // Distributed live gate on the accepted correction patch: deny
            // (no second correction) when the patch names off-scope files the
            // changed-file list omitted.
            const correctionPatchOffPatch = findDistributedWaveOffPatchV1({ changedFiles: correctionRemote.changedFiles, patch: correctionRemote.patch, allowedScope: input.task.scope });
            if (correctionPatchOffPatch.length) {
              return {
                ...(await denyDistributedWaveOffPatchV1({ stateRoot: input.stateRoot, config: input.config, operationId: input.operationId, contract: input.contract, task: input.task, participantId, session: correctionRemote.session, files: correctionPatchOffPatch })),
                escapeCorrectionUsed: true,
                escapeCorrectionSessions: [remote.session],
              };
            }
            return {
              task: input.task,
              session: correctionRemote.session,
              changedFiles: correctionRemote.changedFiles,
              patch: correctionRemote.patch,
              status: correctionRemote.status,
              distributed: true,
              message: correctionRemote.message,
              changeSet: buildWaveChangeSet(input, participantId, correctionRemote.changedFiles, correctionRemote.patch),
              escapeCorrectionUsed: true,
              escapeCorrectionSessions: [remote.session],
            };
          }
          return {
            task: input.task,
            session: correctionRemote.session,
            changedFiles: correctionRemote.changedFiles,
            patch: correctionRemote.patch,
            status: correctionRemote.status,
            distributed: true,
            message: correctionRemote.message,
            escapeCorrectionUsed: true,
            escapeCorrectionSessions: [remote.session],
          };
        } catch (correctionError) {
          // Correction dispatch/identity throw (including timeout) → ORIGINAL.
          void correctionError;
          return {
            task: input.task,
            session: remote.session,
            changedFiles: remote.changedFiles,
            patch: "",
            status: "FAIL",
            distributed: true,
            message: originalMessage,
            escapeCorrectionUsed: true,
          };
        }
      }
      if (remote.status === "PASS" && remote.patch.trim()) {
        if (remote.observedCandidateSourceDigest !== input.waveBase.sourceDigest) return { task: input.task, session: remote.session, changedFiles: remote.changedFiles, patch: "", status: "FAIL", distributed: true, message: "WAVE_RECONCILIATION_REQUIRED: distributed worker did not materialize the frozen wave Candidate source." };
        // Distributed live gate (P1a): the distributed branch returns here
        // without ever touching the local snapshot/check path, so the same
        // off-patch denial applies to the returned changed-file list + patch
        // before any ChangeSet is built. Deny + OFF_PATCH_WRITE_DENIED event;
        // the WAVE_RECONCILIATION_REQUIRED prefix routes the sibling to
        // reconciliation at the wave boundary (no correction turn for a live
        // denial, same as the local path).
        const liveOffPatch = findDistributedWaveOffPatchV1({ changedFiles: remote.changedFiles, patch: remote.patch, allowedScope: input.task.scope });
        if (liveOffPatch.length) {
          return denyDistributedWaveOffPatchV1({ stateRoot: input.stateRoot, config: input.config, operationId: input.operationId, contract: input.contract, task: input.task, participantId, session: remote.session, files: liveOffPatch });
        }
        return { task: input.task, session: remote.session, changedFiles: remote.changedFiles, patch: remote.patch, status: remote.status, distributed: true, message: remote.message, changeSet: buildWaveChangeSet(input, participantId, remote.changedFiles, remote.patch) };
      }
      return { task: input.task, session: remote.session, changedFiles: remote.changedFiles, patch: remote.patch, status: remote.status, distributed: true, message: remote.message };
    }
    catch (error) { return failed(input.task, selection, `Distributed delegation failed: ${String(error)}`, true); }
  }
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), `aeh-${safe(input.contract.task.id)}-${safe(input.task.id)}-`)); const add = await runExecutable("git", ["worktree", "add", "--detach", worktree, "HEAD"], { cwd: input.root, timeoutMs: 120_000 }); if (add.exitCode !== 0) return failed(input.task, selection, `Unable to create task worktree: ${add.stderr || add.stdout}`);
  try {
    // Toolchain state lands BEFORE any command resolves tools inside the
    // unit worktree: materializeCandidateState and the baseline below run
    // Git commands there, and the resolver caches the missing prefix per
    // path — copying afterward would leave the stale miss cached.
    // The copy itself clears the resolver cache (a pure recomputable memo)
    // so no earlier probe of the fresh worktree can shadow the new state.
    if (await materializeToolchainStateForIsolatedRoot(input.root, worktree, input.config)) clearToolchainEnvCache();
    await materializeCandidateState(input.root, worktree, input.waveBase);
    await copyTaskContext(input.root, worktree, input.config, input.contract); if (input.controller) await materializeControlPlaneSnapshot(input.controller, worktree, input.config);    const baselineAdd = await runExecutable("git", ["add", "-A"], { cwd: worktree, timeoutMs: 30_000 });
    if (baselineAdd.exitCode !== 0) return failed(input.task, selection, `Unable to create task baseline: ${baselineAdd.stderr || baselineAdd.stdout}`);
    const baselineCommit = await runExecutable("git", ["-c", "user.name=aeh", "-c", "user.email=aeh@localhost", "commit", "--no-gpg-sign", "-m", "aeh wave baseline", "--allow-empty"], { cwd: worktree, timeoutMs: 60_000 });
    if (baselineCommit.exitCode !== 0) return failed(input.task, selection, `Unable to create task baseline: ${baselineCommit.stderr || baselineCommit.stdout}`);
    // FAM-WAVE live gate: snapshot the per-unit worktree file set at unit
    // launch (after materialize + baseline). Fail-closed: an unsnapshotable
    // worktree cannot prove containment, so the unit FAILs before dispatch.
    let launchSnapshot: Map<string, WaveWorktreeSnapshotEntryV1>;
    try {
      launchSnapshot = await snapshotWaveWorktreeV1(worktree);
    } catch (error) {
      return { task: input.task, session: { provider: selection.runtimeAdapter, model: selection.modelName, logicalAgent: selection.logicalAgent, runtime: selection.runtimeName, profile: selection.profile, exitCode: 1, stdout: "", stderr: `OFF_PATCH_WRITE_DENIED: unable to snapshot per-unit worktree for live scope gate: ${String(error).slice(0, 300)}` }, changedFiles: [], patch: "", status: "FAIL", message: `OFF_PATCH_WRITE_DENIED: unable to snapshot per-unit worktree for live scope gate.` };
    }
    // The frozen role invocation policy's output contract is the durable structured result for this
    // work unit. It must be propagated on dispatch (provider turn activation) and finalization
    // (acceptance), or the Implementer's result channel is never activated and the participant can
    // only fall back to unstructured text (AEH-V2-0118).
    const session = await executeAgentPrompt(worktree, input.config, input.contract, selection, prompt, { outputContract: input.participantAssignment.roleInvocationPolicy?.outputContract ?? selection.outputContract ?? "implementer", participantId, phase: "implementation", operationKind: currentOperationContext().kind, requireExecutionAuthority: true, executionBlueprint: input.executionBlueprint, executionBlueprintDigest: input.executionBlueprint.digest, roleInvocationPolicy: input.participantAssignment.roleInvocationPolicy, skillManifest: input.participantAssignment.skillManifest }); if (session.exitCode !== 0) return { task: input.task, session, changedFiles: [], patch: "", status: "FAIL", message: `Agent exited with ${session.exitCode}.` };
    // FAM-WAVE live gate (per-unit worktree, hardcoded-deny): scope-check the
    // LIVE filesystem state immediately after THIS worker invocation, before
    // capturing the diff. Per-invocation pairing (fresh pre-snapshot above +
    // immediate post-check here) catches a write this turn introduced even if
    // a later turn reverts it; hash + full-precision ctime + inode comparison
    // also catches in-place write+revert with restored bytes+mtime. Terminal
    // FAIL with OFF_PATCH_WRITE_DENIED receipt — no correction turn for a
    // live denial. Assembler diff gate stays below as defense-in-depth.
    try {
      const { offPatch } = await checkWaveUnitTurnOffPatchV1(worktree, launchSnapshot, input.task.scope);
      if (offPatch.length) {
        return await denyWaveUnitLiveOffPatchV1({ stateRoot: input.stateRoot, config: input.config, operationId: input.operationId, contract: input.contract, task: input.task, participantId, session, files: offPatch });
      }
    } catch (error) {
      await recordEvent(input.stateRoot, input.config, WAVE_OFF_PATCH_DENIED_EVENT_V1, { operationId: input.operationId, taskId: input.contract.task.id, workUnitId: input.task.id, participantId, files: [], fileCount: 0, status: "FAIL", error: `live-gate unverifiable: ${String(error).slice(0, 200)}` }).catch(() => undefined);
      return { task: input.task, session, changedFiles: [], patch: "", status: "FAIL", message: `OFF_PATCH_WRITE_DENIED: per-unit live scope gate unverifiable (fail-closed).` };
    }
    const status = await runExecutable("git", ["status", "--porcelain"], { cwd: worktree, timeoutMs: 30_000 }); const untracked = status.stdout.split(/\r?\n/).filter((line) => line.startsWith("?? ")).map((line) => line.slice(3).trim()).filter(Boolean); if (untracked.length) await runExecutable("git", ["add", "-N", "--", ...untracked], { cwd: worktree, timeoutMs: 30_000 });
    const names = await runExecutable("git", ["diff", "--name-only", "HEAD"], { cwd: worktree, timeoutMs: 30_000 }); const changedFiles = names.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean); const violations = changedFiles.filter((file) => !isWaveWorktreeExcludedV1(file) && !matchesAny(file, input.task.scope));
    if (violations.length) {
      // Scope-escape ONE-correction turn (wave pre-check; same (b) pattern:
      // FAIL with patch "" is protection, FAIL wave is punishment).
      // FIRST escape gets exactly ONE correction in the SAME worktree (reuse
      // baseline HEAD; escaped diff still present so the worker sees and
      // fixes it) with a precise diagnostic (escaped + hard/amendable +
      // declare-via-filesNeededOutsideScope + second-escape-terminal). NEVER
      // echoes full scope lists ((a)=FALSE guard). Second escape or correction
      // timeout → ORIGINAL FAIL (preserving original message/session). Reuses
      // the same wave slot/timeout (no new budget knob); both sessions are
      // counted and the flag consumes one repair slot in run.ts.
      // Round-2 B1: REMAINING budget checked BEFORE offering (exhausted →
      // ORIGINAL FAIL, no correction; synchronous reserve prevents parallel
      // double-spend). Round-2 B2: declaration routing below.
      const escapeDiff = assemblerScopeEscapeDiffV1(violations);
      const diagnostic = buildScopeEscapeCorrectionPrompt({
        escapedFiles: escapeDiff.escapedFiles,
        escapedCount: escapeDiff.escapedCount,
        amendableManifests: escapeDiff.amendableManifests,
        amendableCount: escapeDiff.amendableCount,
        hardProtected: escapeDiff.hardProtected,
        hardProtectedCount: escapeDiff.hardProtectedCount,
        operationId: input.operationId,
        taskId: input.contract.task.id,
      });
      const correctionPrompt = `${prompt}\n\n${diagnostic}`;
      const originalMessage = `Delegation escaped scope: ${violations.join(", ")}`;
      if (input.escapeCorrectionGate && !input.escapeCorrectionGate.tryReserve()) {
        return {
          task: input.task,
          session,
          changedFiles,
          patch: "",
          status: "FAIL",
          message: `${originalMessage} (escape-correction budget exhausted; no correction turn offered)`,
        };
      }
      const correctionOptions = {
        outputContract: input.participantAssignment.roleInvocationPolicy?.outputContract ?? selection.outputContract ?? "implementer",
        participantId,
        phase: "implementation" as const,
        operationKind: currentOperationContext().kind,
        requireExecutionAuthority: true as const,
        executionBlueprint: input.executionBlueprint,
        executionBlueprintDigest: input.executionBlueprint.digest,
        roleInvocationPolicy: input.participantAssignment.roleInvocationPolicy,
        skillManifest: input.participantAssignment.skillManifest,
      };
      let correctionSession: import("../core/types.js").WorkerSession | undefined;
      // Per-invocation pairing for the correction turn: fresh pre-snapshot
      // taken immediately before correction dispatch (fail-closed when the
      // worktree cannot be snapshotted — an unsnapshotable worktree cannot
      // prove the correction stayed in scope).
      let correctionPreSnapshot: Map<string, WaveWorktreeSnapshotEntryV1>;
      try {
        correctionPreSnapshot = await snapshotWaveWorktreeV1(worktree);
      } catch {
        return {
          task: input.task,
          session,
          changedFiles,
          patch: "",
          status: "FAIL",
          message: `OFF_PATCH_WRITE_DENIED: per-unit live scope gate unverifiable before correction turn (fail-closed).`,
          escapeCorrectionUsed: true,
        };
      }
      try {
        correctionSession = await executeAgentPrompt(worktree, input.config, input.contract, selection, correctionPrompt, correctionOptions);
      } catch (correctionError) {
        // Any correction throw (timeout or infra) → ORIGINAL terminal FAIL
        // (fail-closed, preserves original forensics; no second correction).
        return {
          task: input.task,
          session,
          changedFiles,
          patch: "",
          status: "FAIL",
          message: originalMessage,
          escapeCorrectionUsed: true,
          ...(correctionSession ? { escapeCorrectionSessions: [correctionSession] } : {}),
        };
      }
      const isCorrectionTimeoutSession =
        correctionSession.exitCode === 124 ||
        (correctionSession as { status?: string }).status === "timeout" ||
        (correctionSession as { killReason?: string }).killReason === "STALLED_FIRST_ACTIVITY" ||
        (correctionSession as { killReason?: string }).killReason === "DEADLINE" ||
        isScopeCorrectionTimeoutError(new Error(`${correctionSession.stderr ?? ""} ${correctionSession.stdout ?? ""}`));
      if (isCorrectionTimeoutSession) {
        return {
          task: input.task,
          session,
          changedFiles,
          patch: "",
          status: "FAIL",
          message: originalMessage,
          escapeCorrectionUsed: true,
          escapeCorrectionSessions: [correctionSession],
        };
      }
      if (correctionSession.exitCode !== 0) {
        // Non-timeout worker failure on the correction turn → ORIGINAL terminal
        // FAIL (fail-closed; the escape remains unaddressed, no second turn).
        return {
          task: input.task,
          session,
          changedFiles,
          patch: "",
          status: "FAIL",
          message: originalMessage,
          escapeCorrectionUsed: true,
          escapeCorrectionSessions: [correctionSession],
        };
      }
      // FAM-WAVE live gate on the correction turn: per-invocation
      // post-check against BOTH the launch snapshot (whole-unit containment)
      // and the fresh correction pre-snapshot (this invocation's own writes),
      // before accepting the corrected diff. Either basis firing denies.
      try {
        const [againstLaunch, againstPre] = await Promise.all([
          checkWaveUnitTurnOffPatchV1(worktree, launchSnapshot, input.task.scope),
          checkWaveUnitTurnOffPatchV1(worktree, correctionPreSnapshot, input.task.scope),
        ]);
        const offPatchCorrection = [...new Set([...againstLaunch.offPatch, ...againstPre.offPatch])].sort();
        if (offPatchCorrection.length) {
          const denialResult = await denyWaveUnitLiveOffPatchV1({ stateRoot: input.stateRoot, config: input.config, operationId: input.operationId, contract: input.contract, task: input.task, participantId, session, files: offPatchCorrection, correction: true });
          return { ...denialResult, escapeCorrectionUsed: true, escapeCorrectionSessions: [correctionSession] };
        }
      } catch {
        return {
          task: input.task,
          session,
          changedFiles,
          patch: "",
          status: "FAIL",
          message: `OFF_PATCH_WRITE_DENIED: per-unit live scope gate unverifiable on correction turn (fail-closed).`,
          escapeCorrectionUsed: true,
          escapeCorrectionSessions: [correctionSession],
        };
      }
      const restatus = await runExecutable("git", ["status", "--porcelain"], { cwd: worktree, timeoutMs: 30_000 });
      const reuntracked = restatus.stdout.split(/\r?\n/).filter((line) => line.startsWith("?? ")).map((line) => line.slice(3).trim()).filter(Boolean);
      if (reuntracked.length) await runExecutable("git", ["add", "-N", "--", ...reuntracked], { cwd: worktree, timeoutMs: 30_000 });
      const renames = await runExecutable("git", ["diff", "--name-only", "HEAD"], { cwd: worktree, timeoutMs: 30_000 });
      const rechangedFiles = renames.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const reviolations = rechangedFiles.filter((file) => !isWaveWorktreeExcludedV1(file) && !matchesAny(file, input.task.scope));
      // Turn-3: declaration check FIRST — a correction carrying
      // filesNeededOutsideScope routes to BLOCKED with scopeBlocker
      // REGARDLESS of remaining violations (same semantics as DIRECT/repair —
      // FAIL with blocker, never PASS-with-declaration). Vacuous
      // (no genuinely-blocked) stays unblocked and falls through to the
      // reviolations check below. Same order as the distributed path above.
      const declaration = classifyWaveCorrectionDeclarationV1({
        session: correctionSession,
        changedFiles: rechangedFiles,
        operationId: input.operationId,
        taskId: input.contract.task.id,
        workUnitId: input.task.id,
        participantId,
        taskScope: input.task.scope,
        contract: input.contract,
        config: input.config,
      });
      if (declaration.blocked) {
        const files = declaration.blocker?.filesNeededOutsideScope.map((entry) => entry.path).join(", ") ?? "filesNeededOutsideScope";
        return {
          task: input.task,
          session: correctionSession,
          changedFiles: rechangedFiles,
          patch: "",
          status: "FAIL",
          message: `WAVE_SCOPE_BLOCKER: correction declared out-of-scope file(s): ${files}. Declare via filesNeededOutsideScope; do not expand scope without a lead-approved amendment.`,
          escapeCorrectionUsed: true,
          escapeCorrectionSessions: [session],
          ...(declaration.blocker ? { scopeBlocker: declaration.blocker } : {}),
        };
      }
      if (reviolations.length) {
        // Second escape → ORIGINAL terminal FAIL (exactly one correction).
        const rediff = await runExecutable("git", ["diff", "--binary", "--no-ext-diff", "HEAD"], { cwd: worktree, timeoutMs: 60_000 }).catch(() => undefined);
        return {
          task: input.task,
          session,
          changedFiles,
          patch: "",
          status: "FAIL",
          message: originalMessage,
          escapeCorrectionUsed: true,
          escapeCorrectionSessions: [correctionSession, ...(rediff ? [] : [])],
        };
      }
      const rediff = await runExecutable("git", ["diff", "--binary", "--no-ext-diff", "HEAD"], { cwd: worktree, timeoutMs: 60_000 });
      if (rediff.exitCode !== 0) {
        return {
          task: input.task,
          session,
          changedFiles,
          patch: "",
          status: "FAIL",
          message: originalMessage,
          escapeCorrectionUsed: true,
          escapeCorrectionSessions: [correctionSession],
        };
      }
      return {
        task: input.task,
        session: correctionSession,
        changedFiles: rechangedFiles,
        patch: rediff.stdout,
        status: "PASS",
        escapeCorrectionUsed: true,
        escapeCorrectionSessions: [session],
        ...(rediff.stdout.trim() ? { changeSet: buildWaveChangeSet(input, participantId, rechangedFiles, rediff.stdout) } : {}),
      };
    }
    const diff = await runExecutable("git", ["diff", "--binary", "--no-ext-diff", "HEAD"], { cwd: worktree, timeoutMs: 60_000 }); if (diff.exitCode !== 0) return { task: input.task, session, changedFiles, patch: "", status: "FAIL", message: diff.stderr || "Unable to capture delegation patch." };
    return { task: input.task, session, changedFiles, patch: diff.stdout, status: "PASS", changeSet: diff.stdout.trim() ? buildWaveChangeSet(input, participantId, changedFiles, diff.stdout) : undefined };
  } finally { await runExecutable("git", ["worktree", "remove", "--force", worktree], { cwd: input.root, timeoutMs: 120_000 }); await fs.rm(worktree, { recursive: true, force: true }).catch(() => undefined); }
}

function buildWaveChangeSet(input: { operationId: string; contract: TaskContract; task: WorkUnitOutput; waveBase: CandidateRevisionV1 }, participantId: string, changedFiles: string[], patch: string): ChangeSetV1 {
  return {
    version: 1,
    operationId: input.operationId,
    taskId: input.contract.task.id,
    workUnitId: input.task.id,
    participantId,
    baseCandidateRevision: input.waveBase.revision,
    baseCandidateDigest: input.waveBase.identityDigest,
    changedFiles,
    patch,
    patchDigest: sha256Utf8(patch)
  };
}

export function validatePlannerWavePlan(contract: TaskContract, plan: PlannerOutput, config: HarnessProjectConfig): string[] {
  const issues: string[] = []; const ids = new Set<string>(); const requirements = new Set((contract.requirements ?? []).map((item) => item.id)); const covered = new Set<string>();
  // D26 (DETERMINISTIC): a VALID plan-level filesNeededOutsideScope declaration
  // (same bar as the hard gate: exact file, safe path, no globs/traversal/empty)
  // exempts the matching exact-file WU scope from the PLAIN contract-scope
  // issue so the declaration can reach the existing Owner suspend/human route
  // (resolvePlannerScopeDeclarations). Declarations never auto-pass: the hard
  // gate below and the suspend route judge them (deny -> BLOCKED preserved).
  const declaredExactFiles = new Set<string>();
  for (const entry of plan.filesNeededOutsideScope ?? []) {
    const raw = typeof entry?.path === "string" ? entry.path.trim() : "";
    if (!raw || !isSafeRepairScopePath(raw) || !isExactRepairScopeFilePath(raw)) continue;
    declaredExactFiles.add(normalizeRepairScopePath(raw));
  }
  const isDeclaredExactFileScope = (scope: unknown): boolean => {
    if (typeof scope !== "string") return false;
    const rawScope = scope.trim();
    if (!rawScope || !isSafeRepairScopePath(rawScope) || !isExactRepairScopeFilePath(rawScope)) return false;
    return declaredExactFiles.has(normalizeRepairScopePath(rawScope));
  };
  for (const task of plan.workUnits) { if (ids.has(task.id)) issues.push(`duplicate work unit id ${task.id}`); ids.add(task.id); if (!task.scope.length) issues.push(`${task.id} has empty scope`); for (const scope of task.scope) { if (withinContractScope(scope, contract.scope?.allowed ?? ["**"])) continue; if (isDeclaredExactFileScope(scope)) continue; issues.push(`${task.id} scope ${scope} is outside TaskContract scope`); } for (const req of [...task.requirementRefs, ...task.acceptanceRefs]) { if (requirements.size && !requirements.has(req)) issues.push(`${task.id} references unknown requirement ${req}`); if (requirements.has(req)) covered.add(req); } }
  for (const task of plan.workUnits) for (const dependency of task.dependencies) if (!ids.has(dependency)) issues.push(`${task.id} depends on unknown work unit ${dependency}`); for (const requirement of requirements) if (!covered.has(requirement)) issues.push(`requirement ${requirement} is not assigned to any implementation work unit`);
  // H-NEW-11 DETERMINISTIC plan-level hard-protection declaration gate: a
  // work-unit scope intersecting hard-protected paths (frozen TaskContract,
  // seal, validators, acceptance/spec, policy — repairHardProtectedPaths)
  // REQUIRES a matching plan-level filesNeededOutsideScope declaration (exact
  // path). Missing declaration is a fail-fast compile rejection with a
  // precise diagnostic naming the file and instructing the declaration; the
  // planner corrects within its existing one-correction budget (no new retry
  // machinery). Mechanism: DETERMINISTIC (scope-pattern overlap +
  // exact-path declaration match); model content (declared paths + reasons).
  // No other validation behavior changes: every check above is untouched.
  for (const issue of validatePlannerHardProtectionDeclarations(contract, plan, config)) issues.push(issue);
  return [...new Set(issues)];
}

/**
 * D10 shared hard-intersection computation (DETERMINISTIC, pure, no I/O).
 * Single definition of "undeclared work-unit scope x hard-protected
 * intersection" used by BOTH the compile gate
 * (`validatePlannerHardProtectionDeclarations`, string diagnostics) and the
 * new-test auto-declare path (`autoDeclarePlannerNewTestScopes`, structured
 * candidates). No regex over model prose: candidates are recomputed from
 * scope-vs-hard glob matching, never parsed out of issue strings.
 *
 * Returns one entry per (work unit, scope) that intersects hard-protected
 * paths and lacks a satisfying declaration:
 * - exact-file scopes require an exact declaration of that same file;
 * - glob scopes intersecting ANY protected pattern are always undeclared
 *   (no declaration can satisfy them — unbounded match = unprovable
 *   coverage), so they are returned with `isExactFile: false` and are never
 *   auto-declarable.
 * Malformed declarations (glob/traversal/empty) never satisfy the gate; they
 * are reported separately by the validator and ignored here for the declared
 * set (same rule, shared).
 */
export interface PlannerHardScopeIntersectionV1 {
  workUnitId: string;
  objective: string;
  scope: string;
  normalizedScope: string;
  cited: string;
  isExactFile: boolean;
}

export function computePlannerUndeclaredHardScopes(
  contract: TaskContract,
  plan: PlannerOutput,
  config: HarnessProjectConfig,
): PlannerHardScopeIntersectionV1[] {
  const hardProtected = repairHardProtectedPaths(config, contract);
  const declared = new Map<string, string>();
  for (const entry of plan.filesNeededOutsideScope ?? []) {
    const raw = typeof entry?.path === "string" ? entry.path.trim() : "";
    if (!raw || !isSafeRepairScopePath(raw) || !isExactRepairScopeFilePath(raw)) continue;
    const normalized = normalizeRepairScopePath(raw);
    if (!declared.has(normalized)) declared.set(normalized, typeof entry?.reason === "string" ? entry.reason : "");
  }
  const intersections: PlannerHardScopeIntersectionV1[] = [];
  for (const unit of plan.workUnits) {
    for (const scope of unit.scope) {
      const rawScope = typeof scope === "string" ? scope.trim() : "";
      if (!rawScope) continue;
      const directlyViolated = findRepairHardProtectedViolations([rawScope], config, contract);
      const overlapped = hardProtected.filter((hard) => scopePatternOverlapsHardPattern(rawScope, hard));
      if (!directlyViolated.length && !overlapped.length) continue;
      const cited = [...new Set([...directlyViolated, ...overlapped])].sort((a, b) => a.localeCompare(b)).slice(0, 8).join(", ");
      if (!isExactRepairScopeFilePath(rawScope)) {
        intersections.push({
          workUnitId: unit.id,
          objective: typeof unit.objective === "string" ? unit.objective : "",
          scope: rawScope,
          normalizedScope: normalizeRepairScopePath(rawScope),
          cited,
          isExactFile: false,
        });
        continue;
      }
      const normalizedScope = normalizeRepairScopePath(rawScope);
      if (declared.has(normalizedScope)) continue;
      intersections.push({
        workUnitId: unit.id,
        objective: typeof unit.objective === "string" ? unit.objective : "",
        scope: rawScope,
        normalizedScope,
        cited,
        isExactFile: true,
      });
    }
  }
  return intersections;
}

export interface PlannerNewTestAutoDeclarationV1 {
  plan: PlannerOutput;
  autoDeclared: string[];
  hardRemaining: string[];
}

/**
 * D10 narrow auto-declare (DETERMINISTIC: glob intersection + existence stat
 * + objective-text reuse; no new model call, no new correction turn).
 *
 * When the plan validation issues are ALL of class
 * PLANNER_PROTECTED_SCOPE_UNDECLARED, the runPlanning call site offers the
 * new-test-tier subset a declaration the planner omitted: exact-file WU
 * scopes that partition into the H-NEW-13 `newTestCreations` tier
 * (non-existent tests/ files solely under the broad rule) are synthesized
 * into plan-level filesNeededOutsideScope entries with reasons auto-derived
 * from the owning WU objective, prefixed `[auto-derived from WU <id> scope]`
 * for Owner transparency.
 *
 * Security invariant: auto-declaration cannot widen what the planner can
 * express (it already controls WU scopes) and cannot bypass Owner approval —
 * the augmented plan flows into the EXISTING resolvePlannerScopeDeclarations
 * suspend/human route unchanged (deny -> BLOCKED). Only exact new-test
 * paths; total declarations capped at MAX_REPAIR_SCOPE_BLOCKER_FILES_V1 (8);
 * globs, existing tests/, validators, seals, policy and every other hard
 * class are never synthesized. Returns null when nothing is auto-declarable
 * (caller keeps the original terminal outcome unchanged). When a hard
 * remainder exists (non-tier citations, globs, cap overflow), the caller
 * keeps the whole plan terminal — the auto-declared subset is discarded with
 * the failed plan and never routed.
 */
export async function autoDeclarePlannerNewTestScopes(input: {
  contract: TaskContract;
  plan: PlannerOutput;
  config: HarnessProjectConfig;
  root: string;
}): Promise<PlannerNewTestAutoDeclarationV1 | null> {
  const intersections = computePlannerUndeclaredHardScopes(input.contract, input.plan, input.config);
  const exact = intersections.filter((item) => item.isExactFile);
  if (!exact.length) return null;
  const byPath = new Map<string, { workUnitId: string; objective: string }>();
  for (const item of exact) {
    // Luna D10 round 2 (MEDIUM): gate on the RAW scope BEFORE normalization.
    // `isExactRepairScopeFilePath` accepts traversal spellings (`..` is not a
    // glob char), so a raw `src/../tests/x.test.ts` normalizes to a safe
    // `tests/x.test.ts` that would tier as creatable. `isSafeRepairScopePath`
    // rejects `..`/absolute/drive forms in the RAW input (normalization must
    // never launder them into safe paths), so traversal spellings stay
    // ineligible for synthesis and keep the original terminal outcome. The
    // validator above is untouched (byte-identical diagnostics): it still
    // reports the raw traversal scope as an undeclared issue.
    if (!isSafeRepairScopePath(item.scope)) continue;
    if (!byPath.has(item.normalizedScope)) {
      byPath.set(item.normalizedScope, { workUnitId: item.workUnitId, objective: item.objective });
    }
  }
  const candidates = [...byPath.keys()];
  if (!candidates.length) return null;
  const tiered = await partitionHardViolationsByNewTestTier(candidates, input.config, input.contract, input.root);
  if (!tiered.newTestCreations.length) return null;
  const existing = input.plan.filesNeededOutsideScope ?? [];
  const existingPaths = new Set(existing.map((entry) => normalizeRepairScopePath(String(entry?.path ?? "").trim())));
  const fresh = tiered.newTestCreations.filter((candidate) => !existingPaths.has(normalizeRepairScopePath(candidate)));
  if (!fresh.length) return null;
  const room = MAX_REPAIR_SCOPE_BLOCKER_FILES_V1 - existing.length;
  if (room <= 0) return null;
  const capped = fresh.slice(0, room);
  const overflow = fresh.slice(room);
  const synthesized = capped.map((candidate) => {
    const owner = byPath.get(normalizeRepairScopePath(candidate)) ?? byPath.get(candidate);
    const workUnitId = owner?.workUnitId ?? "unknown";
    const objective = (owner?.objective ?? "").trim().slice(0, 500) || "requires new test file";
    let reason = `[auto-derived from WU ${workUnitId} scope] ${objective}`;
    if (reason.length > 1000) reason = reason.slice(0, 1000);
    return { path: normalizeRepairScopePath(candidate), reason };
  });
  if (!synthesized.length) return null;
  return {
    plan: { ...input.plan, filesNeededOutsideScope: [...existing, ...synthesized] },
    autoDeclared: synthesized.map((entry) => entry.path),
    hardRemaining: [...tiered.hard, ...overflow],
  };
}

/**
 * H-NEW-11 plan-level declaration check (DETERMINISTIC, pure, no I/O).
 * Extracted so the compile gate above and plan-routing diagnostics share one
 * definition of "declared". STRICT rule (R2):
 * (a) exact-file scopes require an exact declaration of that same file;
 * (b) GLOB scopes intersecting ANY protected pattern are REJECTED outright —
 *     no declaration can satisfy them; the planner must enumerate the exact
 *     protected files it needs (one exact scope + one exact declaration per
 *     file). Globs covering only non-protected paths remain free.
 * Why: an unbounded glob match is unprovable coverage — one exact declaration
 * (e.g. `src/validators/rules.ts`) cannot prove it covers every protected
 * file a broad scope (e.g. `src/validators/**`) could match
 * (`other.ts`, future files, `specs/**` siblings). Accepting it would let a
 * single declaration launder a broad protected expansion.
 * Malformed declarations (glob/traversal/empty) are rejected fail-closed so
 * they can never satisfy the gate or reach the receipt.
 * Scope-vs-hard intersection shape is shared with the D10 auto-declare path
 * via `computePlannerUndeclaredHardScopes` (no duplication); this function
 * only renders the shared intersections to the stable diagnostics.
 */
export function validatePlannerHardProtectionDeclarations(contract: TaskContract, plan: PlannerOutput, config: HarnessProjectConfig): string[] {
  const issues: string[] = [];
  for (const entry of plan.filesNeededOutsideScope ?? []) {
    const raw = typeof entry?.path === "string" ? entry.path.trim() : "";
    if (!raw || !isSafeRepairScopePath(raw) || !isExactRepairScopeFilePath(raw)) {
      issues.push(`PLANNER_BLOCKER_DECLARATION_INVALID: plan-level filesNeededOutsideScope entry '${raw || "(empty)"}' is not an exact file path; declarations allow exact paths only (no wildcards, traversal, or absolute forms).`);
    }
  }
  for (const item of computePlannerUndeclaredHardScopes(contract, plan, config)) {
    if (!item.isExactFile) {
      issues.push(`PLANNER_PROTECTED_SCOPE_UNDECLARED: work unit '${item.workUnitId}' scope '${item.scope}' is a glob intersecting hard-protected path(s): ${item.cited}. Glob scopes cannot be satisfied by declaration (unbounded match = unprovable coverage: one exact declaration cannot cover every protected file the glob could match). Replace the glob with enumerated exact protected file scopes and declare each exact file via plan-level filesNeededOutsideScope[{path, reason}].`);
      continue;
    }
    issues.push(`PLANNER_PROTECTED_SCOPE_UNDECLARED: work unit '${item.workUnitId}' scope '${item.scope}' intersects hard-protected path(s): ${item.cited}. Declare the exact file(s) via plan-level filesNeededOutsideScope[{path, reason}] (max 8, exact file paths with per-file reasons); hard-protected paths the planned work needs (validators, tests, policy, .harness/project.yaml, seals) flow to Owner-approved amendment only through this declaration channel. Glob scopes touching hard-protected paths must first be narrowed to exact file paths.`);
  }
  return issues;
}

export type PlannerScopeDeclarationRoutingV1 =
  | { status: "CLEAR"; contract: TaskContract }
  | { status: "AMENDED"; contract: TaskContract; amendment: RepairScopeAmendmentV1 }
  | { status: "BLOCKED"; blocker: RepairScopeBlockerReceiptV1; check: ValidationCheck };

/**
 * H-NEW-11 planner declaration routing (DETERMINISTIC orchestration, MODEL
 * content). Plan-level `filesNeededOutsideScope` flows to the EXISTING
 * repairer amendment/suspend machinery — the same
 * `resolveRepairScopeBlockerViaProductChoice` path repairers use (durable
 * receipt with write-then-verify, suspend HUMAN_REQUIRED with bounded
 * approve-exact-set/decline choices, Owner approval, amendment + reseal,
 * single retry). No parallel flow is invented; planner declarations are
 * plan-scoped and bound to the op task (`planner:<taskId>` work unit).
 *
 * In-scope confusion is stripped and traced exactly like the repairer path
 * (partitionRepairScopeBlockerFiles); only genuinely-blocked files reach the
 * receipt. With no managed operation to suspend, a genuinely-blocked
 * declaration is BLOCKED fail-closed. Any resolver/suspend/apply throw is
 * BLOCKED citing the blocker (never a silent pass, never an expansion).
 */
export async function resolvePlannerScopeDeclarations(input: {
  root: string;
  controlRoot: string;
  config: HarnessProjectConfig;
  contract: TaskContract;
  plan: PlannerOutput;
  operationId?: string;
}): Promise<PlannerScopeDeclarationRoutingV1> {
  const declared = input.plan.filesNeededOutsideScope ?? [];
  if (!declared.length) return { status: "CLEAR", contract: input.contract };
  const allowedScope = [...(input.contract.scope?.allowed ?? ["**"])];
  const forbiddenScope = [
    ...(input.contract.scope?.forbidden ?? []),
    ...(input.contract.scope?.frozen ?? []),
    ...(input.config.validation?.frozenPaths ?? []),
    ...repairProtectedPaths(input.config, input.contract),
  ];
  const partitioned = partitionRepairScopeBlockerFiles(declared, allowedScope, forbiddenScope);
  if (partitioned.stripped.length) {
    await recordEvent(input.controlRoot, input.config, "harness.plan.scope-blocker-stripped", {
      taskId: input.contract.task.id,
      stripped: partitioned.stripped.map((entry) => entry.path),
      strippedCount: partitioned.stripped.length,
    }).catch(() => undefined);
  }
  if (!partitioned.genuinelyBlocked.length) return { status: "CLEAR", contract: input.contract };
  const operationId = input.operationId ?? currentOperationContext().id;
  const blocker = createRepairScopeBlockerReceipt({
    operationId: operationId ?? `planner:${input.contract.task.id}`,
    taskId: input.contract.task.id,
    workUnitId: `planner:${input.contract.task.id}`,
    filesNeededOutsideScope: partitioned.genuinelyBlocked,
  });
  if (!operationId) {
    return { status: "BLOCKED", blocker, check: repairScopeBlockerValidationCheck(blocker) };
  }
  let resolution: Awaited<ReturnType<typeof resolveRepairScopeBlockerViaProductChoice>>;
  try {
    const receiptFile = await writeRepairScopeBlockerReceipt(input.controlRoot, input.config, blocker);
    const persisted: unknown = JSON.parse(await fs.readFile(receiptFile, "utf8"));
    assertRepairScopeBlockerReceipt(persisted);
    if ((persisted as RepairScopeBlockerReceiptV1).digest !== blocker.digest) {
      throw new AehError(
        "PARTICIPANT_PLAN_INVALID",
        `REPAIR_SCOPE_RECEIPT_NOT_DURABLE: persisted blocker receipt digest does not match the declared blocker (${receiptFile}).`,
      );
    }
    await recordEvent(input.controlRoot, input.config, "harness.plan.scope-blocked", {
      taskId: input.contract.task.id,
      blockerDigest: blocker.digest,
      filesNeededOutsideScope: blocker.filesNeededOutsideScope,
      source: "planner-declaration",
    }).catch(() => undefined);
    resolution = await resolveRepairScopeBlockerViaProductChoice({
      root: input.root,
      controlRoot: input.controlRoot,
      operationId,
      config: input.config,
      contract: input.contract,
      blocker,
    });
  } catch (error) {
    const check = repairScopeBlockerValidationCheck(blocker);
    await recordEvent(input.controlRoot, input.config, "harness.repair.scope-blocked", {
      taskId: input.contract.task.id, attempt: 0, status: "BLOCKED",
      blockerDigest: blocker.digest, filesNeededOutsideScope: blocker.filesNeededOutsideScope,
      source: "planner-declaration",
      error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
    }).catch(() => undefined);
    return { status: "BLOCKED", blocker, check };
  }
  if (resolution.status === "BLOCKED") {
    await recordEvent(input.controlRoot, input.config, "harness.repair.scope-blocked", {
      taskId: input.contract.task.id, attempt: 0, status: "BLOCKED",
      blockerDigest: blocker.digest, filesNeededOutsideScope: blocker.filesNeededOutsideScope,
      source: "planner-declaration",
      choiceId: resolution.choiceId ?? "denied-or-timed-out",
    }).catch(() => undefined);
    return { status: "BLOCKED", blocker, check: resolution.check };
  }
  await recordEvent(input.controlRoot, input.config, "harness.repair.scope-amended", {
    taskId: resolution.contract.task.id, attempt: 0, blockerDigest: blocker.digest,
    exemptedPaths: resolution.amendment.exemptedPaths, decisionId: resolution.amendment.decisionId,
    requestId: resolution.amendment.requestId, decidedActor: resolution.amendment.decidedActor,
    source: "planner-declaration",
  }).catch(() => undefined);
  return { status: "AMENDED", contract: resolution.contract, amendment: resolution.amendment };
}
export interface CanonicalPlannerPromptInputV1 {
  operationId: string;
  contract: TaskContract;
  request: string;
  explorerContext: string;
  inputsPrompt: string;
  readRoots: readonly string[];
  /**
   * Display word for the owning operation kind (e.g. "CHANGE", "RUN").
   * The canonical builder serves CHANGE `runPlanning` and cross-kind wave
   * fallbacks; the kind word keeps the prompt truthful per entry path.
   * MECHANISM: DETERMINISTIC (caller-supplied frozen context, never model).
   */
  operationKind: string;
}

/**
 * Canonical deterministic Planner prompt (single source for the CHANGE
 * `runPlanning` path and the `executePlannerWaves` fallback path, which may
 * serve RUN operations — the `operationKind` word keeps the entry truthful). Carries the
 * normative planning contract: operation id, frozen readable roots (exact
 * projection), explorer evidence, sealed requirement ids, the controlled
 * competency allowlist, the hard-protected declaration rule, and the exact
 * `AEH_RESULT_JSON=` marker contract.
 * MECHANISM: DETERMINISTIC.
 */
export function buildCanonicalPlannerPromptV1(input: CanonicalPlannerPromptInputV1): string {
  const requirementLines = (input.contract.requirements ?? []).map((requirement) => `- ${requirement.id}: ${requirement.description ?? ""}`).join("\n")
    || "- none: the sealed TaskContract declares no requirement ids, so leave requirementRefs and acceptanceRefs empty.";
  const knownCompetencyIds = [...new Set(defaultSkillSeed().skills.flatMap((skill) => skill.competencies.map((competency) => competency.id)))].sort();
  return [
    `Produce planning/triage evidence only for this ${input.operationKind} operation. Do not implement or author the specification.`,
    `Operation: ${input.operationId}`,
    `Request: ${input.request}`,
    `Frozen readable roots (exact projection):\n${input.readRoots.length ? input.readRoots.map((root) => `- ${root}`).join("\n") : "- unavailable; do not search outside the current repository root"}`,
    "Use repository-relative paths in evidence. Search only the frozen readable roots listed above. Do not search prior or sibling worktrees, home directories, /tmp, or any other path outside this lease. Parent operations are referenced by id only: their durable records live under .harness/operations/ inside the allowed roots — never read a parent or sibling worktree directly. Symlinks do not grant access to their targets outside these roots. If a tool raises an out-of-scope permission prompt, do not approve it; produce the plan from in-scope evidence only.",
    "When the planned work needs hard-protected paths (validators, tests, policy, .harness/project.yaml, seals), enumerate each needed file as an exact-file work-unit scope and declare each exact file with a per-file reason in plan-level filesNeededOutsideScope (max 8). Glob scopes intersecting any hard-protected pattern are rejected outright and no declaration can satisfy them: replace every such glob with enumerated exact protected file scopes first. The declaration never widens scope by itself; it routes to Owner-approved amendment. Work-unit scopes touching hard-protected paths without a matching declaration are rejected at plan validation.",
    input.inputsPrompt,
    input.explorerContext,
    `Sealed TaskContract requirement ids (immutable; map every id to at least one work unit and use only these exact ids in requirementRefs and acceptanceRefs):\n${requirementLines}`,
    `Known competency ids (use only these controlled ids for workUnits[].competencies when the work matches; a competency outside this set must genuinely require researched knowledge and will be checked by the deterministic KnowledgeGate): ${knownCompetencyIds.join(", ")}`,
    "Identify affected areas, dependencies, bounded implementer ownership, reviewers and deterministic validation gates. Keep normative requirements unchanged. Every workUnits[].objective must be concise, non-empty, and no longer than 500 characters, matching the Planner output schema and WorkGraph compiler.",
    "If a work unit requires exclusive or ordered access to a shared mutable resource (database schema, migration sequence, package lock, deployment environment, public API contract, generated client, shared config, external mutable resource), emit resourceClaims[{version,resource,mode,order}] with mode SHARED_READ, EXCLUSIVE_WRITE or ORDERED_SEQUENCE and a non-negative order for ORDERED_SEQUENCE. The deterministic scheduler validates and enforces claims; you cannot widen scheduling by claiming a resource.",
    "The deterministic resolver will choose approved project scripts, validators or providers. Do not select agents, reviewers, validators, commands, tools or credentials by name, and do not create product requirements. If validation meaning is needed, emit typed validationRequirements[{version,id,property,kind,scope,evidenceNeeded,requirementRefs,acceptanceRefs}]; state what must be demonstrated, never a command or provider. If formalization is required, set formalizationNeed=REQUIRED with one typed formalizationReason and formalizationEvidenceRefs.",
    "Your final output MUST contain exactly one line beginning AEH_RESULT_JSON= followed by the JSON object matching the planner output contract; a turn without that marker is rejected as PLANNER_RESULT_ARTIFACT_MISSING."
  ].join("\n\n");
}
function buildDelegationPrompt(contract: TaskContract, task: WorkUnitOutput, operationalSkills?: import("../capabilities/operationalSkills.js").OperationalSkillProjectionV1): string {
  const guidance = operationalSkills?.skills.length ? `\nOperational guidance selected for this role and WorkUnit (guidance only; it grants no tools or authority):\n${operationalSkills.skills.map((skill) => `- ${skill.name} v${skill.version} [${skill.certificationStatus}${skill.accessMode === "CONTROLLER_GUIDANCE" ? ", controller-guidance-only" : ""}]: ${skill.procedure.join("; ")}${skill.recovery.length ? ` Recovery: ${skill.recovery.map((item) => `${item.failureClass} → ${item.steps.join("; ")}`).join(" | ")}` : ""}`).join("\n")}` : "";
  return `Implement only work unit ${task.id} for parent ${contract.task.id}.\nObjective: ${task.objective}\nAllowed task scope: ${task.scope.join(", ")}\nScope shape: use an exact file path or 'dir/**'; a bare directory path never matches children. Repo-tree evidence writes require explicit 'dir/**' scope; otherwise write temporary output to the controller-owned scratch dir (/tmp/aeh-scratch-*, disclosed as 'AEH private scratch directory') or the operation evidence dir (.harness/evidence).\nDependencies already integrated: ${task.dependencies.join(", ") || "none"}\nAcceptance references: ${task.acceptanceRefs.join(", ") || "none"}\nRequired competencies: ${task.competencies.join(", ") || "general engineering"}\nRisk: ${task.risk}.${guidance}\nThe parent TaskContract, SDD and control-plane snapshot are frozen. Do not edit outside the declared scope, do not commit, push, rebase or change requirements. Run focused tests when practical and leave the worktree with only the implementation diff.`;
}
export function selectionForParticipant(base: AgentExecutionSelection, assignment: ParticipantAssignmentV1, catalog: ExecutionCatalogV1): AgentExecutionSelection {
  const binding = catalog.roleBindings[assignment.role];
  if (!binding) throw new Error(`EXECUTION_BLUEPRINT_INVALID: no execution binding exists for role '${assignment.role}'.`);
  const runtime = catalog.runtimeProfiles.find((profile) => profile.id === binding.runtimeId);
  const model = catalog.modelProfiles.find((profile) => profile.alias === binding.modelAlias);
  if (!runtime || !model) throw new Error(`EXECUTION_BLUEPRINT_INVALID: execution binding for role '${assignment.role}' references an unavailable runtime or model.`);
  if (model.runtime !== binding.runtimeId) throw new Error(`EXECUTION_BLUEPRINT_INVALID: execution binding for role '${assignment.role}' pairs model '${binding.modelAlias}' with runtime '${binding.runtimeId}', but the model requires '${model.runtime}'.`);
  const permissions = { ...base.permissions };
  const exposedTools = [...new Set([...assignment.toolPack.required, ...assignment.toolPack.optional])].filter((tool) => !assignment.toolPack.forbidden.includes(tool));
  // The compiled assignment toolPack is the role ceiling-checked capability set, so the launch
  // permission projection must express it explicitly instead of leaving provider defaults ("ask")
  // in place: an undefined provider permission made a real Implementer session stop for write
  // approval and return an empty result (AEH-V2-0110). An explicit base deny is never widened.
  const allowIfExposed = (current: PermissionDecision | undefined, tool: string): PermissionDecision => {
    if (!exposedTools.includes(tool)) return "deny";
    return current === "deny" || current === "ask" ? current : "allow";
  };
  permissions.read = allowIfExposed(permissions.read, "repository-read");
  permissions.write = allowIfExposed(permissions.write, "repository-write");
  permissions.gitWrite = allowIfExposed(permissions.gitWrite, "repository-write");
  permissions.shell = allowIfExposed(permissions.shell, "command-execute");
  permissions.network = exposedTools.includes("approved-research") ? (permissions.network === "deny" ? "deny" : "allow") : "deny";
  if (assignment.role === "Reviewer") { permissions.write = "deny"; permissions.gitWrite = "deny"; }
  return {
    ...base,
    profile: binding.profile ?? base.profile,
    logicalAgent: assignment.participantId,
    role: assignment.role,
    specializations: [assignment.specialization],
    runtimeName: runtime.id,
    runtimeAdapter: runtime.adapter,
    paseoProvider: runtime.provider ?? runtime.adapter,
    modelAlias: model.alias,
    modelId: model.id,
    modelName: model.model,
    modelProvider: model.provider,
    variant: binding.variant ?? model.variant,
    temperature: binding.temperature ?? base.temperature,
    nativeAgent: binding.nativeAgent,
    transport: binding.transport,
    outputContract: binding.outputContract ?? base.outputContract,
    args: binding.args ? [...binding.args] : [...base.args],
    // MCP/toolPack namespace separation (DETERMINISTIC): `mcps` names
    // configured MCP servers from the reviewed topology selection; the
    // assignment toolPack governs the permission projection below, never the
    // MCP namespace. Copying tool identifiers (repository-write,
    // command-execute, …) into `mcps` made launch fail closed with
    // MCP_SERVER_UNCONFIGURED for ordinary tool-using participants, since no
    // project configures an MCP server by a tool name.
    mcps: [...new Set(base.mcps ?? [])].sort(),
    skills: [...assignment.skills],
    permissions,
    runtimeCapabilities: { ...runtime.capabilities }
  };
}
async function copyTaskContext(root: string, target: string, config: HarnessProjectConfig, contract: TaskContract): Promise<void> { const relative = [`${config.sdd?.contractsDir ?? ".harness/contracts"}/${contract.task.id}.yaml`, `.harness/seals/${contract.task.id}.json`, ...Object.values(contract.source ?? {}).filter((value): value is string => Boolean(value)), contract.issue?.snapshotPath].filter((value): value is string => Boolean(value)); for (const item of [...new Set(relative)]) { try { const source = await existingRepositoryPath(root, item); const destination = repositoryPath(target, item); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.copyFile(source, destination); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } } }
function withinContractScope(candidate: string, allowed: string[]): boolean { return allowed.some((pattern) => pattern === "**" || minimatch(candidate, pattern, { dot: true }) || pathWithin(staticPrefix(candidate), staticPrefix(pattern))); }
function pathWithin(candidate: string, parent: string): boolean { return Boolean(candidate && parent) && (candidate === parent || candidate.startsWith(`${parent}/`)); }
function matchesAny(file: string, patterns: string[]): boolean { return patterns.some((pattern) => pattern === "**" || minimatch(file, pattern, { dot: true }) || pathWithin(file, staticPrefix(pattern))); }
function staticPrefix(pattern: string): string { return pattern.split(/[?*\[]/, 1)[0].replace(/\/+$/, ""); }
function failed(task: WorkUnitOutput, selection: AgentExecutionSelection, message: string, distributed = false): DelegationExecutionResult { return { task, session: { provider: selection.runtimeAdapter, model: selection.modelName, logicalAgent: selection.logicalAgent, runtime: selection.runtimeName, profile: selection.profile, exitCode: 1, stdout: "", stderr: message }, changedFiles: [], patch: "", status: "FAIL", message, distributed }; }
function aggregate(sessions: WorkerSession[], exitCode: number, message: string): WorkerSession { return { provider: "multi-worker", logicalAgent: "planner-waves", exitCode, stdout: message, stderr: exitCode ? sessions.filter((session) => session.exitCode !== 0).map((session) => session.stderr).filter(Boolean).join("\n") : "" }; }
/**
 * AEH-V2-0129: `workflow.planning.worktreeIsolation` defaults to true and is honored by per-unit
 * candidate worktrees. When it is explicitly disabled, same-workspace writers are serialized
 * deterministically (one work unit at a time) instead of running parallel writers, because
 * DELEGATED candidate assembly always captures one ChangeSet per unit.
 *
 * Unit 3 provider backpressure (DETERMINISTIC): wave fan-out never widens the
 * provider-session lease ceiling (single source:
 * `DEFAULT_OPERATION_RESOURCE_POLICY.maxConcurrentProviderSessionsPerOperation`;
 * caps unchanged). The default concurrency is `min(taskCount, lease cap)` and
 * any configured `maxWaveConcurrency` above the cap is clamped down
 * (fail-closed). Excess work waits in the bounded `mapLimit` worker queue
 * (QUEUE, never throw); operation-wide saturation QUEUES via durable
 * `waitForProviderSessionCapacity` (production caller, bounded WAIT against the
 * caller's existing deadline, terminal on exhaustion); per-workspace
 * write-write conflicts QUEUE via non-throwing `tryAcquireProviderLease`
 * (production caller below, bounded `providerLeaseQueueWaitMs` WAIT, RETRY
 * within budget, never throw-on-conflict on the wired path); residual
 * lease/rate-limit conflicts classify via `isWaveBackpressureError`
 * (narrow 429/rate-limit marker, never bare `retry-after`) and wait via
 * bounded `waveRateLimitWaitMs`/`waveQueueWaitMs` against the caller's
 * existing deadline (WAIT is not an attempt; exhausted budgets are terminal).
 * Telemetry is observation-only `harness.wave.backpressure` counter/gauge
 * attributes via existing `recordEvent` conventions.
 */
export const WAVE_CONCURRENCY_LEASE_CAP_V1 =
  DEFAULT_OPERATION_RESOURCE_POLICY.maxConcurrentProviderSessionsPerOperation;
export const WAVE_BACKPRESSURE_MAX_WAIT_MS_V1 = 30_000;
export const WAVE_BACKPRESSURE_EVENT_V1 = "harness.wave.backpressure";

export interface WaveBackpressureTelemetryV1 {
  wave: number;
  taskId: string;
  active: number;
  ceiling: number;
  queued: number;
  retryAfterMs: number;
  disposition: "QUEUE" | "PROCEED" | "CLAMPED";
  rateLimited?: boolean;
}

export function waveConcurrencyV1(planning: { worktreeIsolation?: boolean; maxWaveConcurrency?: number } | undefined, taskCount: number): number {
  if (planning?.worktreeIsolation === false) return 1;
  const requested = planning?.maxWaveConcurrency ?? taskCount;
  const boundedRequested = Number.isFinite(requested) ? Math.floor(requested) : taskCount;
  return Math.max(1, Math.min(boundedRequested, taskCount, WAVE_CONCURRENCY_LEASE_CAP_V1));
}

/**
 * Luna F1: remaining wave/operation budget threading (DETERMINISTIC, no I/O).
 *
 * The operation capacity WAIT must never start a fresh 30s budget unbounded
 * by the existing wave/operation deadline. `resolveWaveCapacityDeadlineAtMs`
 * returns `min(now + maxWaitMs, operationDeadlineAtMs)` when a finite
 * operation deadline exists, and `undefined` when none can be established
 * (never mints fresh `now+30s`). Callers treat `undefined` as no-wait budget:
 * single immediate capacity check only (headroom proceeds, saturation is
 * terminal FAIL with zero sleeps). `remainingWaveBudgetMs` returns
 * `max(0, deadline - now)`; 0 or undefined deadline means exhausted → terminal
 * FAIL with no wait (fail-closed). Deterministic clocks: callers pass `nowMs`;
 * tests pin it.
 */
export function resolveWaveCapacityDeadlineAtMs(
  nowMs: number,
  operationDeadlineAtMs?: number,
  maxWaitMs: number = WAVE_BACKPRESSURE_MAX_WAIT_MS_V1
): number | undefined {
  const safeNow = Number.isFinite(nowMs) ? Math.floor(nowMs) : 0;
  const safeMax = Number.isFinite(maxWaitMs) && maxWaitMs >= 0
    ? Math.min(WAVE_BACKPRESSURE_MAX_WAIT_MS_V1, Math.floor(maxWaitMs))
    : WAVE_BACKPRESSURE_MAX_WAIT_MS_V1;
  if (operationDeadlineAtMs === undefined || !Number.isFinite(operationDeadlineAtMs)) {
    // Fail-closed: no existing wave/operation deadline can be established, so
    // mint no fresh time. Callers do immediate-check-only (no wait).
    return undefined;
  }
  const freshDeadline = safeNow + safeMax;
  return Math.min(freshDeadline, Math.floor(operationDeadlineAtMs));
}

export function remainingWaveBudgetMs(deadlineAtMs: number | undefined, nowMs: number): number {
  if (deadlineAtMs === undefined || !Number.isFinite(deadlineAtMs) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, Math.floor(deadlineAtMs) - Math.floor(nowMs));
}

/**
 * Bounded backpressure telemetry attributes for existing `recordEvent`
 * conventions (counter: queued/active; gauge: ceiling/concurrency). Refs-only,
 * never provider content; observation only, never a gate.
 */
export function waveBackpressureAttributes(signal: WaveBackpressureTelemetryV1): Record<string, unknown> {
  return {
    wave: Math.max(0, Math.floor(signal.wave)),
    taskId: signal.taskId.slice(0, 200),
    active: Math.max(0, Math.floor(signal.active)),
    ceiling: Math.max(1, Math.floor(signal.ceiling)),
    queued: Math.max(0, Math.floor(signal.queued)),
    retryAfterMs: Math.max(0, Math.min(WAVE_BACKPRESSURE_MAX_WAIT_MS_V1, Math.floor(signal.retryAfterMs))),
    disposition: signal.disposition,
    ...(signal.rateLimited !== undefined ? { rateLimited: signal.rateLimited } : {})
  };
}

/** DETERMINISTIC classifier: true when the failure is backpressure (QUEUE/WAIT, not FAIL). Narrow marker: bare `retry-after` without a 429/rate-limit signal is never backpressure. */
export function isWaveBackpressureError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!message) return false;
  if (message.includes("RESOURCE_CEILING_EXHAUSTED") && message.includes("active provider sessions")) return true;
  if (message.includes("already leased in")) return true;
  if (message.includes("PASEO_PROVIDER_LEASE_TAKEOVER_BLOCKED")) return true;
  return /(?:\b429\b|rate[\s_\-]*limit|too many requests)/i.test(message);
}

/** Alias for wave callers: backpressure failures queue; all other failures are terminal. */
export function shouldQueueWaveWork(error: unknown): boolean {
  return isWaveBackpressureError(error);
}

/**
 * Honor a Retry-After/queue WAIT against an existing deadline budget. Never
 * extends caps: returns `min(boundedWait, remainingBudget)`, or 0 when
 * exhausted (terminal, fail-closed). A WAIT is not an attempt.
 */
export function waveRateLimitWaitMs(
  retryAfterMs: number | { retryAfterMs: number } | undefined,
  remainingBudgetMs?: number
): number {
  const raw = typeof retryAfterMs === "number" ? retryAfterMs : retryAfterMs?.retryAfterMs;
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return 0;
  const bounded = Math.min(WAVE_BACKPRESSURE_MAX_WAIT_MS_V1, Math.floor(raw));
  if (remainingBudgetMs === undefined) return bounded;
  if (!Number.isFinite(remainingBudgetMs) || remainingBudgetMs <= 0) return 0;
  return Math.min(bounded, Math.floor(remainingBudgetMs));
}

/** Bounded QUEUE wait alias (lease-conflict path shares the same budget rule as rate-limit WAIT). */
export function waveQueueWaitMs(retryAfterMs: number | undefined, remainingBudgetMs?: number): number {
  return waveRateLimitWaitMs(retryAfterMs, remainingBudgetMs);
}

/**
 * Wave-dispatch QUEUE RETRY within an existing deadline (production wired path).
 *
 * MECHANISM: DETERMINISTIC classification + bounded WAIT. Backpressure
 * (`isWaveBackpressureError`, including 429 via `parseProviderRateLimitDetail`
 * narrow marker and lease conflicts via `isProviderLeaseConflictError`) QUEUES:
 * Retry-After is honored via `waveRateLimitWaitMs` (429) or
 * `providerLeaseQueueWaitMs`/`waveQueueWaitMs` (lease QUEUED hint) against the
 * caller's existing deadline budget (never extends caps; 0 when exhausted →
 * terminal rethrow, fail-closed). A WAIT is not an attempt. Non-backpressure
 * failures rethrow immediately (FAIL). Injectable `now`/`sleep` keep fixtures
 * scripted with no network (same pattern as `waitForProviderSessionCapacity`).
 */
export interface WaveBackpressureRetryOptionsV1 {
  timeoutMs?: number;
  nowMs?: () => number;
  sleepMs?: (ms: number) => Promise<void>;
  onWait?: (waitMs: number, error: unknown) => void;
}

export async function withWaveBackpressureRetry<T>(
  action: (remainingBudgetMs: number | undefined) => Promise<T>,
  options: WaveBackpressureRetryOptionsV1 = {}
): Promise<T> {
  const nowMs = options.nowMs ?? Date.now;
  const sleepMs = options.sleepMs ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = nowMs();
  // Luna F1: never mint fresh `now+30s` when the caller has no deadline.
  // Undefined timeout means no wait budget: single attempt, backpressure is
  // terminal immediately (no implicit wait). Defined timeout bounds WAIT via
  // min(bounded, remaining); exhaustion is terminal rethrow (fail-closed).
  const deadlineAt = options.timeoutMs !== undefined ? startedAt + options.timeoutMs : undefined;
  for (;;) {
    const remaining = deadlineAt !== undefined ? deadlineAt - nowMs() : undefined;
    try {
      return await action(remaining);
    } catch (error) {
      // QUEUE classifiers (narrow 429/rate-limit, never bare retry-after):
      // - isWaveBackpressureError: wave gate (429/lease/takeover/ceiling)
      // - isProviderCapacityError: durable capacity/lease shape (operationResources)
      // - isProviderRateLimited: SDK-boundary 429 (narrow marker)
      const waveQueueable = isWaveBackpressureError(error) || isProviderCapacityError(error) || isProviderRateLimited(error, nowMs);
      if (!waveQueueable) throw error;
      // 429 path honors typed Retry-After (narrow marker guarantees real 429/rate-limit,
      // never bare retry-after); lease-conflict path uses bounded queue WAIT.
      // SDK 60s hints clamp into the wave 30s ceiling via waveRateLimitWaitMs.
      const rateDetail = parseProviderRateLimitDetail(error, nowMs);
      // No existing deadline: immediate terminal, never mint fresh wait.
      const effectiveRemaining = deadlineAt !== undefined ? deadlineAt - nowMs() : 0;
      let waitMs: number;
      if (rateDetail) {
        waitMs = waveRateLimitWaitMs(rateDetail.retryAfterMs, effectiveRemaining);
      } else if (isProviderLeaseConflictError(error)) {
        waitMs = waveQueueWaitMs(250, effectiveRemaining);
      } else {
        waitMs = waveQueueWaitMs(250, effectiveRemaining);
      }
      if (waitMs <= 0) throw error;
      options.onWait?.(waitMs, error);
      await sleepMs(waitMs);
    }
  }
}

/**
 * Intra-wave per-workspace write-lease admission (NOT shared enforcement).
 *
 * SCOPE HONESTY (Luna F2): this serializes concurrent writers *within one
 * wave in one process* via the provided in-memory supervisor. A fresh
 * `RuntimeSupervisorV1` per wave cannot see leases from other waves,
 * operations, or processes — it is blind to cross-wave/operation contention
 * by construction. Cross-wave/operation contention is enforced by the SHARED
 * durable authority: the operation-wide capacity gate
 * (`waitForProviderSessionCapacity` over `readManagedRuntimeSnapshot`, the
 * same lease store `acquireProviderLease` persists to) plus
 * `acquireWaveProviderSlotSharedOrQueue` below plus the real provider
 * lifecycle (`runWithOperationProviderLease`). Never use this alone to claim
 * shared enforcement.
 *
 * Isolated worktrees use distinct workspace keys (no contention, ACQUIRED);
 * shared-workspace waves share one key (second writer QUEUES). On QUEUED, the
 * bounded `providerLeaseQueueWaitMs` WAIT is honored against the caller's
 * existing deadline (never extends caps; exhaustion → terminal false, FAIL).
 */
export async function acquireWaveProviderSlotOrQueue(
  supervisor: RuntimeSupervisorV1,
  input: { provider: string; projectId: string; canonicalRoot: string; workspaceId: string; ownerId: string; mode?: "read" | "write" },
  options: { remainingBudgetMs?: number; sleepMs?: (ms: number) => Promise<void> } = {}
): Promise<{ acquired: boolean; retryAfterMs: number; queueDepth: number }> {
  const result = supervisor.tryAcquireProviderLease({
    provider: input.provider,
    projectId: input.projectId,
    canonicalRoot: input.canonicalRoot,
    workspaceId: input.workspaceId,
    mode: input.mode ?? "write",
    ownerId: input.ownerId
  });
  if (result.status === "ACQUIRED") return { acquired: true, retryAfterMs: 0, queueDepth: 0 };
  const queued = result as ProviderLeaseQueuedV1;
  const waitMs = providerLeaseQueueWaitMs(queued, options.remainingBudgetMs);
  if (waitMs <= 0) return { acquired: false, retryAfterMs: queued.retryAfterMs, queueDepth: queued.queueDepth };
  const sleepMs = options.sleepMs ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  await sleepMs(waitMs);
  // Single bounded WAIT then re-attempt once; exhaustion on second QUEUED is terminal.
  const second = supervisor.tryAcquireProviderLease({
    provider: input.provider,
    projectId: input.projectId,
    canonicalRoot: input.canonicalRoot,
    workspaceId: input.workspaceId,
    mode: input.mode ?? "write",
    ownerId: input.ownerId
  });
  if (second.status === "ACQUIRED") return { acquired: true, retryAfterMs: waitMs, queueDepth: queued.queueDepth };
  return { acquired: false, retryAfterMs: (second as ProviderLeaseQueuedV1).retryAfterMs, queueDepth: (second as ProviderLeaseQueuedV1).queueDepth };
}

/**
 * Shared durable per-workspace gate for wave dispatch (Luna F2+F3, fail-closed).
 *
 * MECHANISM: DETERMINISTIC atomic acquire-or-wait-or-fail via the REAL
 * `acquireProviderLease` store path (`acquireDurableWaveSlotOrQueue` over the
 * file-locked managed-runtime snapshot, same `findConflictingProviderLeases`
 * predicate as `tryAcquireProviderLease`). Check-then-proceed is deleted: the
 * previous read-only `checkDurableWaveSlotConflict` + proceed-without-acquire
 * (TOCTOU, two racers both proceeding) cannot be made atomic and is removed
 * (no dead code). ATOMICITY: in-memory `tryAcquireProviderLease` is atomic
 * within one process only; cross-wave/operation/process atomicity comes from
 * the snapshot `.lock` transact in `operationResources.ts` (reload→check→write
 * under one lock, never both proceed).
 *
 * Bounded WAIT (`min(retryAfter, remainingBudget)`) against the caller's
 * existing deadline (never mints fresh; undefined/0 budget means single
 * immediate attempt only, exhaustion → terminal false, FAIL). Unreadable
 * durability BLOCKS (acquired false, retryAfter 0, no wait). Deterministic
 * clocks via `nowMs`/`sleepMs`. Returns durable `leaseId` on ACQUIRED for
 * explicit `releaseDurableWaveSlot` (callers release in finally, best-effort).
 */
export async function acquireWaveProviderSlotSharedOrQueue(
  root: string,
  input: { provider: string; projectId: string; canonicalRoot: string; workspaceId: string; ownerId: string; mode?: "read" | "write" },
  options: {
    remainingBudgetMs?: number;
    sleepMs?: (ms: number) => Promise<void>;
    nowMs?: () => number;
  } = {}
): Promise<{ acquired: boolean; retryAfterMs: number; queueDepth: number; scope: "shared-durable"; leaseId?: string }> {
  const result = await acquireDurableWaveSlotOrQueue(root, input, {
    ...(options.remainingBudgetMs !== undefined ? { remainingBudgetMs: options.remainingBudgetMs } : {}),
    ...(options.sleepMs ? { sleepMs: options.sleepMs } : {}),
    ...(options.nowMs ? { nowMs: options.nowMs } : {}),
  });
  if (result.acquired) {
    return { acquired: true, retryAfterMs: 0, queueDepth: 0, scope: "shared-durable", leaseId: result.leaseId };
  }
  return { acquired: false, retryAfterMs: result.retryAfterMs, queueDepth: result.queueDepth, scope: "shared-durable" };
}
async function mapLimit<T, R>(values: T[], limit: number, fn: (value: T) => Promise<R>): Promise<R[]> { if (!values.length) return []; const result = new Array<R>(values.length); let cursor = 0; const workers = Array.from({ length: Math.max(1, Math.min(limit, values.length)) }, async () => { while (true) { const index = cursor++; if (index >= values.length) return; result[index] = await fn(values[index]); } }); await Promise.all(workers); return result; }
function safe(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, "-"); }
