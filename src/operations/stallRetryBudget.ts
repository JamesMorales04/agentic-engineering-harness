import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveOperationStateRoot } from "./state.js";

/**
 * DETERMINISTIC durable stall-retry ledger (E-NEW-5). Stall-retry budgets were
 * function-local counters (`let retries = 0`), so controller takeover, watchdog
 * re-wake, or phase re-entry restarted the budget with a fresh invocation and total
 * attempts per work unit were unbounded across drives. This sidecar persists
 * per-phase stall-killed attempt counts under the operation state root
 * (wakeBudget.ts ledger pattern: atomic write + file lock).
 *
 * FAIL-CLOSED contract (Luna L1/L2):
 * - Affirmative-zero (file present, valid v1, operationId matches, requested
 *   count is a finite non-negative number equal to 0) reads as 0 and may retry.
 * - UNKNOWN (ledger missing-unreadable/corrupt: any non-ENOENT read error,
 *   JSON parse failure, version/operationId mismatch, or malformed stalls
 *   shape) never reads as zero. The loader refuses with the phase's
 *   `*_STALL_BUDGET_EXHAUSTED` coded error — i.e. UNKNOWN is conservatively
 *   treated as budget EXHAUSTED. This keeps the existing exhausted-error
 *   taxonomy (classifiers already treat those codes as terminal, never
 *   stall-classified) and guarantees a new invocation cannot regain retries
 *   after ledger loss/corruption.
 * - Only ENOENT-first-ever (no ledger ever written for this operationId in
 *   this control root) may start at zero. ENOENT is distinguishable because
 *   no harness path deletes the ledger: writes are atomic (temp file + rename)
 *   under the operation state root and the file shares its directory with the
 *   operation record but is never removed by recovery, rotation, or
 *   cancellation paths (verified: no `rm`/`unlink` of `*.stall-retry.json` in
 *   src/). Hence ENOENT implies no stall has ever been durably recorded.
 *   Operator deletion outside harness paths is out of scope; the next record
 *   would recreate from empty and that residual is documented, not silently
 *   budgeted.
 * - Pre-claim (fail-closed on first-write failure): before consuming a counted
 *   retry attempt (incrementing the persisted stall count), `recordStallRetryStall`
 *   durably writes a pending-claim marker (atomic temp file + rename, same idiom
 *   as ledger writes) as a sibling `${ledgerFile}.${phase}.pending`. `loadStallRetryStalls`
 *   treats an unreconciled pending marker as EXHAUSTED (fail closed) until the
 *   attempt reconciles it: a successful ledger write supersedes the marker
 *   (ledger durable, marker deleted); a failed ledger write leaves the marker
 *   (next load refuses EXHAUSTED, never zero). This closes the first-ever stall
 *   hole where a ledger WRITE failure left no file and a later invocation read
 *   ENOENT-as-zero and regained budget. If the marker write itself fails, the
 *   attempt fails loudly with `STALL_RETRY_LEDGER_WRITE_FAILED` without consuming
 *   a retry (same as the existing write-failure path). Every production call
 *   site that consumes budget (discovery, planning, spec-manager, consolidation)
 *   claims via `claimStallRetryAttempt` BEFORE running the counted agent attempt
 *   and reconciles on outcome (`recordStallRetryStall` on stall-kill, which
 *   supersedes; `clearStallRetryClaim` on success/non-stall), so a crash after
 *   the attempt but before record leaves the durable marker instead of nothing.
 * - Stale-claim recovery (crash-orphan reconciliation): a pending marker is
 *   crash-orphaned iff `now - claimedAt > 2*deadlineMs + STALL_RETRY_STALE_MARGIN_MS`,
 *   where `deadlineMs` is the attempt's effective provider-turn deadline recorded
 *   in the marker at claim time. No live counted attempt can still be running past
 *   that bound, because every counted attempt is killed by its provider-turn deadline
 *   (`orchestration.operations.liveness.providerTurnDeadlineMs`, any positive int,
 *   default 30min; supervisor consolidation turns are further capped at 5min), so
 *   2x covers the longest possible attempt wall-clock and the margin covers harness
 *   overhead (ledger lock, trace, clock skew). Staleness is NEVER a global constant:
 *   it is derived per-marker from the configured deadline the attempt actually ran
 *   under. The loader converts a stale well-formed marker into a durable +1 (the
 *   orphaned attempt is counted, never granted free) and clears it, then enforces
 *   the budget on the durable count. Fresh markers (a live attempt may still be
 *   running) refuse EXHAUSTED; malformed/unreadable markers (including legacy markers
 *   missing attempt/deadlineMs, which cannot prove staleness) refuse EXHAUSTED and
 *   are never dropped (a corrupt marker cannot prove staleness, so fail closed).
 *   Concurrent loaders serialize the +1 under the ledger lock and re-check marker
 *   IDENTITY (attempt + claimedAt + deadlineMs + content hash) inside it — not mere
 *   existence — so a replacement claim in between is never incremented+deleted: on
 *   mismatch the lock is released and the new marker is re-evaluated from scratch
 *   (no increment, no delete).
 * - Attempt binding (cross-attempt isolation): `clearStallRetryClaim` and the
 *   record-supersede delete in `recordStallRetryStall` are bound to (phase, attempt).
 *   They delete a marker ONLY when the marker's attempt equals the caller's claimed
 *   attempt number. A mismatched marker is left alone (another live attempt owns it)
 *   with a best-effort `stall-retry.claim-mismatch` trace. Production call sites pass
 *   their 1-indexed attempt number through on every claim/clear/record.
 * - Atomic check+delete (round-8 B1-race): `clearStallRetryClaim`, the
 *   record-supersede delete, and `claimStallRetryAttempt` all serialize through the
 *   existing ledger lock (`withLock` on the operation ledger file; lock file
 *   `<ledger>.lock`). Clear/supersede perform re-read + identity comparison +
 *   unlink inside a single lock-held critical section: an in-lock first read checks
 *   ownership (attempt equals caller), an in-lock second read verifies the identical
 *   bytes are still present (replacement detection, including same-attempt
 *   re-claims with a new claimedAt), and only then is the pathname removed. A
 *   concurrent claim holding the same lock either lands before the clearer (seen on
 *   the in-lock read, left alone on mismatch) or blocks until the clearer releases
 *   (lands after, survives). Lock-free check-then-delete is forbidden: every marker
 *   read/write goes through the lock.
 *   AUDIT (round-10, Luna G1): this lock serialization suffices for the NORMAL
 *   (well-formed) paths because every harness writer of a well-formed marker
 *   holds the same ledger lock — the only `writePendingAtomic` call sites are
 *   `claimStallRetryAttempt` and the `recordStallRetryStall` pre-claim, both
 *   inside `withLock`, and every deleter (`clearStallRetryClaim`,
 *   `supersedeOwnPendingClaim`, well-formed reconcile) is likewise in-lock.
 *   No non-lock harness writer of well-formed markers exists (verified: no
 *   other src/ write to `*.pending` marker paths), so a lock-held check+delete
 *   cannot race one — kept as-is, no churn. The LEGACY path cannot assume this
 *   (pre-binding writers never took the lock; operator/manual writes are
 *   possible), so it uses the grave construction below instead of any
 *   marker-path unlink.
 * - Legacy-marker one-time migration (round-8 B3-legacy): markers predating the
 *   (phase, attempt, deadlineMs) binding fail new-format well-formedness
 *   (unparseable JSON or missing/invalid attempt/deadlineMs) but are still marker
 *   files (siblings `${ledger}.${phase}.pending`, never `*.stall-retry.json` ledger
 *   files). A legacy marker whose FILE MTIME is older than
 *   `2*CURRENT_MAX_DEADLINE + STALL_RETRY_STALE_MARGIN_MS` — where CURRENT_MAX is
 *   `stallRetryEffectiveDeadlineMs(currentConfig)` (provider-turn deadline or 30min
 *   default) or an explicit `legacyMaxDeadlineMs` override — is crash-orphaned
 *   beyond any live attempt and migrates as a durable +1 (consumed, never free)
 *   with the marker cleared. Fresh legacy (mtime within the bound) and unstatable
 *   legacy (stat fails) refuse EXHAUSTED fail-closed; the operator clears the file
 *   after investigation. ONE-TIME: `claimStallRetryAttempt` always writes new-format
 *   markers carrying attempt+deadlineMs, so post-migration no new legacy markers are
 *   created; the migration path exists only to drain pre-binding stranded files.
  * - Legacy grave take (round-10, Luna G1/G2/G3; round-11 inode binding;
  *   round-12 fd-bound decision + mtime tripwire): the migration NEVER unlinks
  *   the marker pathname. DECISION (round-12 R1: no read-then-stat gap) — bind
  *   content+identity to ONE file object: open() the marker first, then
  *   fstat(fd) + read(fd) through the same handle; hash THAT content; decide
  *   staleness/identity from THAT fstat (dev/ino/mtime). No path-based
  *   read-then-stat sequence anywhere in the decision path — a
  *   read(old)/stat(new) split mixing hash(old)/identity(new) is impossible
  *   by construction (the fd pins one generation; a rename replacement after
  *   open leaves the snapshot on the old inode and the take sweeps the new
  *   one, failing the post-take inode check). Instead, inside the ledger
  *   lock: TAKE — atomically rename the marker to an unguessable grave sibling
  *   (`<pending>.grave-<uuid>`, `crypto.randomUUID`, same directory so the
  *   rename stays on one filesystem; rename(2) is atomic). A concurrent writer
  *   landing after the take creates a NEW file at the marker path, which this
  *   path never touches again (kills G1: check-then-unlink vs non-lock writers
  *   is gone — there is no marker-path unlink). VERIFY — open the GRAVE by fd;
  *   fstat + read through the fd observe a single inode, never a mixed
  *   read/stat snapshot (kills G2); the content sha is compared against the
  *   decided fd-bound snapshot AND the grave (dev, ino) must equal the (dev,
  *   ino) captured at the decision fstat — rename preserves the inode, so a
  *   replacement slipping between decision and take fails here even with
  *   identical bytes (round-11: no hash-only reliance) — AND (round-12 R2b
  *   defense-in-depth tripwire) the grave fstat mtime must equal the decided
  *   mtime. Same-inode in-place mutation keeps (dev, ino) and may keep the
  *   hash (identical bytes) but changes mtime, so it trips here (kills R2
  *   except the honest residual below; G3 same-ms concern does not apply —
  *   mtime is a tripwire, not an identity gate: inode+hash remain the
  *   identity, mtime only adds detection).
  *   WRITER AUDIT (round-12 R2a): every harness writer of a marker uses
  *   atomic temp+rename only — the sole writers are `writePendingAtomic`
  *   (call sites: `claimStallRetryAttempt` and the `recordStallRetryStall`
  *   pre-claim, both inside `withLock`) and `writeAtomic` for the ledger;
  *   no `open+truncate+write` in place exists in src/ for `*.pending` paths
  *   (verified: no other src/ write to marker paths). Temp+rename swaps the
  *   path's inode (rename assigns a new directory entry), so a harness actor
  *   can never mutate the decided inode in place — the grave holds the old
  *   inode detached. Same-inode content change is therefore impossible for
  *   harness actors. RESIDUAL (stated honestly): a same-ms identical-bytes
  *   in-place rewrite by a non-harness fd-holder (ambient filesystem write
  *   access the harness does not grant; all harness writers take the lock +
  *   temp+rename) keeps (dev, ino, hash, mtime-tick) equal and is outside
  *   the threat model.
  *   DESTROY-or-QUARANTINE — match: durable +1, then unlink the grave (detached
  *   and unguessable, no re-check needed). Mismatch (a replace slipped between
  *   the decision snapshot and the take, or an in-place mtime change): NO
  *   increment, NO unlink, marker path untouched (it may hold someone else's
  *   live claim); the grave is parked aside under a distinct
  *   `<pending>.quarantine-<uuid>` suffix, traced best-effort
  *   (`stall-retry.legacy-quarantine`, reason `content-mismatch` /
  *   `inode-mismatch` / `mtime-mismatch` / `grave-unreadable`), and the load
  *   fails closed EXHAUSTED — the operator recovers the quarantine file
  *   (OPERATOR RECOVERY below; `aeh doctor` warns while parked files remain).
  *
  * OPERATOR RECOVERY for parked graves/quarantines (round-11, honest bounds):
  * - What they are. A `.grave-<uuid>` sibling is a crash-orphan: the process
  *   died between TAKE and DESTROY, so the detached marker copy was never
  *   unlinked. A `.quarantine-<uuid>` sibling is a parked mismatch: a
  *   replacement slipped between the legacy-migration decision and the take,
  *   so NO increment happened and the load failed closed EXHAUSTED; the parked
  *   bytes are the swept replacement (possibly someone else's live claim at
  *   the time — never silently deleted, never counted).
  * - Exact paths/globs. Both live next to the ledger, never inside it:
  *   `<stateRoot>/.harness/operations/<op>.stall-retry.json.<phase>.pending.grave-<uuid>`
  *   and `...pending.quarantine-<uuid>`. Per (operation, phase) listing:
  *   `listStallRetryQuarantineGraves(controlRoot, operationId, phase)`.
  *   Whole-root count for triage: `countStallRetryParkedFiles(root)`, wired
  *   into `aeh doctor` as the `stall-retry-quarantine` WARNING.
  * - How to inspect. The parked file is the raw marker bytes (plain JSON
  *   text): compare its content with the ledger
  *   `<stateRoot>/.harness/operations/<op>.stall-retry.json` counts and with
  *   the best-effort `stall-retry.legacy-quarantine` trace (reason + basename).
  *   For a quarantine, check whether the owning operation later proceeded
  *   (subsequent ledger counts / fresh markers) before touching the file.
  * - When deletion is safe. Parked files are evidence only: the harness never
  *   reads them back (only lists them), so deleting one changes no budget
  *   state. Delete after the investigation above concludes — for a `.grave-*`
  *   orphan once the ledger count for that phase is confirmed; for a
  *   `.quarantine-*` once the displaced claim is accounted for (reconciled
  *   later, or its operation abandoned).
  * - Accumulation bound (stated honestly). At most ONE parked file per
  *   interrupted migration: the path parks and returns immediately, never
  *   loops, and a swept marker path cannot be re-taken (nothing left to take;
  *   legacy markers are one-time — new claims are always new-format). Repeated
  *   interruptions across operations/phases DO accumulate files; nothing
  *   auto-deletes by design (fail closed on evidence) — the operator clears
  *   them via the procedure above.
 * - Write failures are coded, never swallowed: `recordStallRetryStall` throws
 *   `STALL_RETRY_LEDGER_WRITE_FAILED` (or the already-coded ledger UNKNOWN
 *   error) and callers must NOT `.catch(() => undefined)` it. A retry requires
 *   durable accounting; a failed write fails the attempt without consuming a
 *   retry. Ledger error messages deliberately avoid stall-classifier keywords
 *   (`STALLED_FIRST_ACTIVITY`, `exit 124`, `timed out`/`timeout`) so they stay
 *   terminal.
 *
 * Scope: stall-retry budgets only (discovery/planning/spec-manager/consolidation).
 * INVALID/schema/contract/provenance rejections are never stalls and never touch
 * the ledger. MECHANISM: DETERMINISTIC (file-backed counters, no model judgment).
 */

export type StallRetryPhase = "discovery" | "planning" | "spec-manager" | "consolidation";

/** Max stall-killed attempts total per phase per operation, across all invocations. */
export const STALL_RETRY_MAX_ATTEMPTS_PER_PHASE = 2;

const PHASES: readonly StallRetryPhase[] = ["discovery", "planning", "spec-manager", "consolidation"];

export interface StallRetryBudgetV1 {
  version: 1;
  operationId: string;
  stalls: Record<StallRetryPhase, number>;
  updatedAt: string;
}

const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

export function stallRetryBudgetFile(controlRoot: string, operationId: string): string {
  return path.resolve(resolveOperationStateRoot(controlRoot), ".harness/operations", `${safeId(operationId)}.stall-retry.json`);
}

/**
 * Pending-claim marker sibling for a phase. Existence means a counted attempt
 * was claimed but not yet reconciled by a durable ledger write (unreconciled).
 * Never matches `*.stall-retry.json` globs; only created/cleared by the
 * pre-claim path (record writes, successful record deletes, load refuses).
 */
export function stallRetryPendingFile(controlRoot: string, operationId: string, phase: StallRetryPhase): string {
  return `${stallRetryBudgetFile(controlRoot, operationId)}.${phase}.pending`;
}

export interface StallRetryPendingV1 {
  version: 1;
  operationId: string;
  phase: StallRetryPhase;
  /** 1-indexed counted attempt number — ownership identity for clear/supersede binding (B1) and reconcile identity (B2). */
  attempt: number;
  claimedAt: string;
  /**
   * Effective provider-turn deadline (ms) the counted attempt runs under, recorded
   * at claim time. Staleness derives from this per-marker value, never a global
   * constant (B3): stale iff now - claimedAt > 2*deadlineMs + STALL_RETRY_STALE_MARGIN_MS.
   */
  deadlineMs: number;
}

/**
 * Harness-overhead margin for the stale formula: ledger lock, trace, clock skew.
 * Stale iff age > 2*deadlineMs + this margin. The 2x covers the longest possible
 * attempt wall-clock (provider-turn kill); the margin covers post-kill harness work.
 */
export const STALL_RETRY_STALE_MARGIN_MS = 5 * 60_000;

/** Provider default when no configured deadline is available (mirrors agentPrompt default). */
export const DEFAULT_STALL_RETRY_DEADLINE_MS = 30 * 60_000;

/**
 * Effective provider-turn deadline for a counted stall attempt: explicit attempt
 * deadline (e.g. consolidation turn timeout) wins; else the configured
 * `orchestration.operations.liveness.providerTurnDeadlineMs`; else the 30min
 * provider default. Mirrors providerTurnDeadlineMs(config, options) without options.
 */
export function stallRetryEffectiveDeadlineMs(config?: { orchestration?: { operations?: { liveness?: { providerTurnDeadlineMs?: unknown } } } }, explicitMs?: number): number {
  if (explicitMs !== undefined) {
    if (!Number.isSafeInteger(explicitMs) || (explicitMs as number) < 1) {
      throw new Error("PROVIDER_TURN_DEADLINE_INVALID: provider-turn deadline must be a positive integer in milliseconds.");
    }
    return explicitMs as number;
  }
  const configured = config?.orchestration?.operations?.liveness?.providerTurnDeadlineMs;
  if (typeof configured === "number" && Number.isSafeInteger(configured) && configured > 0) return configured;
  return DEFAULT_STALL_RETRY_DEADLINE_MS;
}

const EXHAUSTED_CODE: Record<StallRetryPhase, string> = {
  discovery: "EXPLORER_STALL_BUDGET_EXHAUSTED",
  planning: "PLANNER_STALL_BUDGET_EXHAUSTED",
  "spec-manager": "SPEC_MANAGER_STALL_BUDGET_EXHAUSTED",
  consolidation: "AEH_OPERATION_SUPERVISOR_STALL_BUDGET_EXHAUSTED",
};

/** Fail-closed refusal: UNKNOWN ledger is treated as budget EXHAUSTED (never zero). */
function ledgerUnknownExhaustedError(phase: StallRetryPhase, operationId: string, reason: string): Error {
  return new Error(
    `${EXHAUSTED_CODE[phase]}: ${phase} ledger UNKNOWN for operation ${operationId} (${reason}); refusing retry fail-closed, budget treated as exhausted, max ${STALL_RETRY_MAX_ATTEMPTS_PER_PHASE} total across all drives.`
  );
}

/** Coded write-path failure: retry requires durable accounting. */
function ledgerWriteFailedError(phase: StallRetryPhase, operationId: string, reason: string): Error {
  return new Error(
    `STALL_RETRY_LEDGER_WRITE_FAILED: ${phase} ledger write failed for operation ${operationId} (${reason}); retry requires durable accounting, attempt failed without consuming a retry.`
  );
}

/**
 * DETERMINISTIC provider-turn stall-kill probe on the session shape alone
 * (integration reconciliation for the main-B2 / ru-INVALID coexistence).
 *
 * FAIL-CLOSED evidence rule (round-11): every direction consumes budget
 * except affirmative clean success — never grant a free retry, never regain.
 * - STALL requires STRUCTURED evidence only: typed killReason
 *   STALLED_FIRST_ACTIVITY (DEADLINE is the same structured timeout-kill
 *   family and also counts), status timeout, or exit 124. Stdout/stderr
 *   text mentions alone (timed out/timeout/stalled_first_activity) are NEVER
 *   sufficient — a clean turn merely mentioning "timeout" must not consume.
 * - CLEAN requires affirmative clean-success evidence
 *   (`isCleanSuccessfulProviderTurn`: exit 0, no killReason, success status).
 * - AMBIGUOUS terminal failure (neither stall proof nor clean proof) COUNTS
 *   the attempt (record/consume), never clears. The four non-stall branches
 *   implement this 3-way verdict: stall → record; clean → clear; else record.
 *
 * The shared stall classifiers (`isDiscoveryPlanningStallKill`,
 * `isSupervisorConsolidationStallKill`) deliberately return false for
 * INVALID/schema/contract/provenance handoff errors even when the provider
 * turn itself was stall-killed — INVALID must stay retry-terminal. Ledger
 * COUNTING is a separate question from retry-terminality: a provider turn
 * that was itself stall-killed consumed a stall kill at the provider level
 * even when the handoff error is otherwise terminal, so the non-stall
 * branches of the four call sites record it instead of clearing it. A clean
 * turn (exit 0, no kill, success status) with a terminal handoff error never
 * counted a stall and reconciles without consuming. This rule satisfies both
 * pinned contracts: main's "non-stall terminal failure still counts as spent
 * (stall-killed session)" and ru's "INVALID on a clean turn never touches
 * the ledger". MECHANISM: DETERMINISTIC (observable session fields only, no
 * model judgment).
 */
export function isStallKilledProviderTurn(session: unknown): boolean {
  if (!session || typeof session !== "object") return false;
  const shape = session as {
    exitCode?: unknown;
    killReason?: unknown;
    status?: unknown;
  };
  if (shape.killReason === "STALLED_FIRST_ACTIVITY" || shape.killReason === "DEADLINE") return true;
  if (shape.status === "timeout") return true;
  if (shape.exitCode === 124) return true;
  return false;
}

/**
 * DETERMINISTIC affirmative clean-success probe on the session shape alone.
 * Clean requires ALL of: exitCode 0, no killReason, and a success status
 * (idle/finished/completed/complete/success/succeeded/ok, case-insensitive —
 * the statuses successful provider turns settle with in-tree: materialized
 * `idle`, direct `finished`, SDK-run `idle`). Any killReason disqualifies;
 * a `timeout` status disqualifies; an unknown/missing status is NOT clean
 * proof (fail closed → ambiguous → count). Stdout/stderr text is never
 * consulted: mentions of "timeout" in output cannot dirty a clean turn.
 * MECHANISM: DETERMINISTIC (observable session fields only, no model judgment).
 */
export function isCleanSuccessfulProviderTurn(session: unknown): boolean {
  if (!session || typeof session !== "object") return false;
  const shape = session as {
    exitCode?: unknown;
    killReason?: unknown;
    status?: unknown;
  };
  if (shape.killReason !== undefined && shape.killReason !== null) return false;
  if (shape.exitCode !== 0) return false;
  if (typeof shape.status !== "string") return false;
  const normalized = shape.status.toLowerCase();
  if (normalized === "timeout") return false;
  return ["idle", "finished", "completed", "complete", "success", "succeeded", "ok"].includes(normalized);
}

function errnoCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "UNKNOWN";
}

function isValidStallCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function assertValidBudgetShape(parsed: unknown, operationId: string): asserts parsed is StallRetryBudgetV1 {
  if (!parsed || typeof parsed !== "object") throw new Error("not an object");
  const record = parsed as { version?: unknown; operationId?: unknown; stalls?: unknown };
  if (record.version !== 1) throw new Error(`unsupported version ${String(record.version)}`);
  if (record.operationId !== operationId) throw new Error("operationId mismatch");
  if (!record.stalls || typeof record.stalls !== "object") throw new Error("stalls not an object");
  const stalls = record.stalls as Record<string, unknown>;
  for (const phase of PHASES) {
    if (!isValidStallCount(stalls[phase])) throw new Error(`malformed stalls.${phase}`);
  }
}

/**
 * Total, fail-closed: affirmative-zero (file present, valid, count 0) reads as 0;
 * ENOENT-first-ever (no ledger and no pending marker ever written) reads as 0;
 * a fresh unreconciled pending-claim marker reads as EXHAUSTED (never zero); a
 * stale well-formed marker (age > 2*deadlineMs + margin, per-marker deadline)
 * is first reconciled into a durable +1 and cleared, then the durable count is
 * returned; an OLD legacy marker (unparseable/new-format-invalid, mtime older
 * than 2*current-max-deadline + margin) migrates the same way (+1, cleared,
 * one-time); every other missing-unreadable/corrupt state throws the phase's
 * EXHAUSTED coded error.
 */
export interface StallRetryLoadOptions {
  /** Current harness config for the legacy-migration bound (provider-turn deadline). */
  config?: { orchestration?: { operations?: { liveness?: { providerTurnDeadlineMs?: unknown } } } };
  /** Explicit override for the legacy-migration max deadline (ms, positive int). */
  legacyMaxDeadlineMs?: number;
  /** Override for now (ms since epoch) in tests. */
  nowMs?: number;
}

export async function loadStallRetryStalls(
  controlRoot: string,
  operationId: string,
  phase: StallRetryPhase,
  options?: StallRetryLoadOptions
): Promise<number> {
  const file = stallRetryBudgetFile(controlRoot, operationId);
  const pending = stallRetryPendingFile(controlRoot, operationId, phase);
  let markerPresent: boolean;
  try {
    await fs.stat(pending);
    markerPresent = true;
  } catch (error) {
    if (isCodedLedgerError(error)) throw error;
    if (!isMissing(error)) {
      throw ledgerUnknownExhaustedError(phase, operationId, `pending unreadable (STALL_RETRY_LEDGER_UNREADABLE: code=${errnoCode(error)})`);
    }
    markerPresent = false;
  }
  if (markerPresent) {
    // Pre-claim fail-closed: an unreconciled pending marker means a counted attempt
    // was claimed but never reconciled by a durable ledger write (first-write failure
    // or crash between claim and reconcile). A stale marker is crash-orphaned and
    // converts to a durable +1 (never free); anything else refuses EXHAUSTED.
    // Existence alone exhausts (content is diagnostic only except for proving
    // staleness); an unreadable pending check (non-ENOENT) also exhausts fail-closed.
    if (await reconcileStalePendingClaim(controlRoot, file, pending, operationId, phase, options)) {
      return readLedgerCount(file, operationId, phase);
    }
    throw ledgerUnknownExhaustedError(phase, operationId, "pending claim unreconciled");
  }
  return readLedgerCount(file, operationId, phase);
}

async function readLedgerCount(file: string, operationId: string, phase: StallRetryPhase): Promise<number> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (isMissing(error)) return 0;
    throw ledgerUnknownExhaustedError(phase, operationId, `ledger unreadable (STALL_RETRY_LEDGER_UNREADABLE: code=${errnoCode(error)})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw ledgerUnknownExhaustedError(phase, operationId, "ledger corrupt (STALL_RETRY_LEDGER_CORRUPT: invalid JSON)");
  }
  try {
    assertValidBudgetShape(parsed, operationId);
  } catch (validation) {
    throw ledgerUnknownExhaustedError(phase, operationId, `ledger corrupt (STALL_RETRY_LEDGER_CORRUPT: ${validation instanceof Error ? validation.message : "invalid shape"})`);
  }
  return Math.floor((parsed.stalls as Record<StallRetryPhase, number>)[phase]);
}

/** Atomically records one stall-killed attempt; returns the new persisted total. Throws coded on any write failure. */
export async function recordStallRetryStall(
  controlRoot: string,
  operationId: string,
  phase: StallRetryPhase,
  attempt?: number,
  deadlineMs?: number
): Promise<number> {
  const file = stallRetryBudgetFile(controlRoot, operationId);
  const pending = stallRetryPendingFile(controlRoot, operationId, phase);
  const callerAttempt = normalizeAttemptNumber(attempt ?? 1);
  const callerDeadline = normalizeDeadlineMs(deadlineMs ?? DEFAULT_STALL_RETRY_DEADLINE_MS);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Pre-claim before consuming (fail-closed on ledger-write failure). Preserve
    // the pre-attempt claim when it exists and is owned by this attempt (same
    // attempt number): keep its original claimedAt/deadlineMs so staleness stays
    // anchored at claim time. Never overwrite another attempt's live marker (B1):
    // a mismatched marker is left alone; the stall below still counts, but the
    // supersede-delete afterwards is also bound to (phase, attempt).
    // ATOMIC (B1-race): the read+conditional-write goes through the ledger lock
    // so a concurrent claim cannot slip between check and write.
    await withLock(file, async () => {
      const existing = await readPendingMarker(pending, operationId, phase);
      if (!existing) {
        await writePendingAtomic(pending, operationId, phase, callerAttempt, callerDeadline);
      }
      // else: marker exists (ours or another attempt's) — leave it; do not freshen.
    });
    let nextCount: number;
    try {
      nextCount = await withLock(file, async () => {
        const previous = await loadUnlocked(file, operationId, phase);
        // Cap enforcement (ru/ledger-cap-12 choke point): the ledger count NEVER
        // exceeds STALL_RETRY_MAX_ATTEMPTS_PER_PHASE. Load inside the same lock
        // as the would-be increment; at/over cap throw the phase EXHAUSTED
        // (fail-closed, no increment, no write). MECHANISM: DETERMINISTIC
        // (durable count comparison under lock).
        const current = Math.floor(previous.stalls[phase]);
        if (current >= STALL_RETRY_MAX_ATTEMPTS_PER_PHASE) {
          throw ledgerUnknownExhaustedError(
            phase,
            operationId,
            `budget exhausted at cap (${current}/${STALL_RETRY_MAX_ATTEMPTS_PER_PHASE})`
          );
        }
        const next: StallRetryBudgetV1 = {
          ...previous,
          stalls: { ...previous.stalls, [phase]: current + 1 },
          updatedAt: new Date().toISOString()
        };
        await writeAtomic(file, next);
        return next.stalls[phase];
      });
    } catch (error) {
      // Cap refusal must not strand this attempt's own pre-claim marker: the
      // durable count is already at cap so the next load refuses via the
      // count comparison either way, but a stranded marker would force the
      // marker-unreconciled refusal path and trip quarantine tooling. Supersede
      // ONLY the caller's own claim (B1 binding); a mismatched marker belongs
      // to another live attempt and is left alone. Best-effort, never masks
      // the EXHAUSTED refusal.
      if (error instanceof Error && error.message.startsWith(EXHAUSTED_CODE[phase])) {
        await supersedeOwnPendingClaim(controlRoot, operationId, phase, callerAttempt);
      }
      throw error;
    }
    // Supersede ONLY our own claim (B1): delete iff marker.attempt === caller.
    // Mismatched/malformed → leave alone (another live attempt owns it) + trace.
    await supersedeOwnPendingClaim(controlRoot, operationId, phase, callerAttempt);
    return nextCount;
  } catch (error) {
    if (isCodedLedgerError(error)) throw error;
    throw ledgerWriteFailedError(phase, operationId, `code=${errnoCode(error)}`);
  }
}

/**
 * Durably claims a counted retry attempt before it is consumed. Atomic temp+rename,
 * same idiom as ledger writes, serialized through the ledger lock.
 *
 * ATOMIC CHECK-AND-SET (ru/ledger-claim-cas-13, Luna round-14 race): under a SINGLE
 * ledger-lock critical section — read marker; if a marker exists AND is live (not
 * stale per the configured-deadline staleness rule) → throw the phase's
 * EXHAUSTED-coded CLAIM-CONFLICT (fail closed, no launch, no overwrite); if the
 * existing marker is stale → reconcile-as-consumed first (durable +1, never free,
 * existing stale logic incl. legacy grave take/verify/destroy-or-quarantine), then
 * write the new claim; if none → write. The loser of a concurrent claim race fails
 * closed, never launches. MECHANISM: DETERMINISTIC (file-backed marker + lock).
 *
 * Throws `STALL_RETRY_LEDGER_WRITE_FAILED` on failure without consuming a retry,
 * or the phase's `*_STALL_BUDGET_EXHAUSTED` CLAIM-CONFLICT when a live marker is
 * present (coded, terminal, never stall-classified). Callers that claim before
 * running an attempt must reconcile via `recordStallRetryStall` (stall, supersedes
 * own claim) or `clearStallRetryClaim` (success/non-stall, clears own claim); until
 * then `loadStallRetryStalls` refuses EXHAUSTED for fresh markers and reconciles
 * stale markers as a durable +1.
 * `attempt` is the 1-indexed counted attempt number (ownership identity, B1).
 * `deadlineMs` is the attempt's effective provider-turn deadline, recorded for
 * per-marker staleness (B3); callers pass their effective deadline.
 * `options` carries the legacy-migration bound (config / legacyMaxDeadlineMs /
 * nowMs); defaults mirror `loadStallRetryStalls` (30min default, no config).
 */
export async function claimStallRetryAttempt(
  controlRoot: string,
  operationId: string,
  phase: StallRetryPhase,
  attempt?: number,
  deadlineMs?: number,
  options?: StallRetryLoadOptions
): Promise<void> {
  const file = stallRetryBudgetFile(controlRoot, operationId);
  const pending = stallRetryPendingFile(controlRoot, operationId, phase);
  try {
    await fs.mkdir(path.dirname(pending), { recursive: true });
    const ownedAttempt = normalizeAttemptNumber(attempt ?? 1);
    const ownedDeadline = normalizeDeadlineMs(deadlineMs ?? DEFAULT_STALL_RETRY_DEADLINE_MS);
    const nowMs = options?.nowMs ?? Date.now();
    let quarantineToTrace: { quarantine: string; reason: string } | undefined;
    try {
      await withLock(file, async () => {
        // FD-BOUND DECISION SNAPSHOT (round-12 R1, reused for claim CAS): open()
        // first, then fstat(fd) + read(fd) through the same handle — content +
        // identity from ONE file object, never a path-based read-then-stat split.
        const snapshot = await readMarkerDecisionSnapshot(pending);
        if (!snapshot) {
          try {
            await fs.stat(pending);
          } catch (error) {
            if (isMissing(error)) {
              await writePendingAtomic(pending, operationId, phase, ownedAttempt, ownedDeadline);
              return;
            }
          }
          // Present but unreadable (open failed) → fail closed, no overwrite.
          throw ledgerUnknownExhaustedError(
            phase,
            operationId,
            `pending claim conflict (CLAIM-CONFLICT: marker unreadable, another attempt may own it, caller attempt ${ownedAttempt})`
          );
        }
        let parsed: unknown;
        let parseFailed = false;
        try {
          parsed = JSON.parse(snapshot.raw);
        } catch {
          parseFailed = true;
        }
        if (!parseFailed && isWellFormedPendingMarker(parsed, operationId, phase)) {
          if (!isStalePendingMarker(parsed, operationId, phase, nowMs)) {
            const owner = (parsed as StallRetryPendingV1).attempt;
            throw ledgerUnknownExhaustedError(
              phase,
              operationId,
              `pending claim conflict (CLAIM-CONFLICT: live marker owned by attempt ${owner}, caller attempt ${ownedAttempt})`
            );
          }
          // Stale well-formed → reconcile-as-consumed first (existing stale
          // logic: durable +1, never free), then write the new claim — but
          // only when the post-increment count is still under cap. An
          // increment-to-cap consumes the budget: fail closed with phase
          // EXHAUSTED and do NOT write the fresh claim (no launch).
          // MECHANISM: DETERMINISTIC (durable count comparison under lock).
          const previous = await loadUnlocked(file, operationId, phase);
          const reconciled = Math.floor(previous.stalls[phase]) + 1;
          const next: StallRetryBudgetV1 = {
            ...previous,
            stalls: { ...previous.stalls, [phase]: reconciled },
            updatedAt: new Date().toISOString()
          };
          await writeAtomic(file, next);
          if (reconciled >= STALL_RETRY_MAX_ATTEMPTS_PER_PHASE) {
            throw ledgerUnknownExhaustedError(
              phase,
              operationId,
              `budget exhausted by stale reconcile (${reconciled}/${STALL_RETRY_MAX_ATTEMPTS_PER_PHASE}), caller attempt ${ownedAttempt}`
            );
          }
          // Replacement guard (non-lock writers only; harness well-formed
          // writers all hold this lock): a replacement during the increment
          // must survive — fail closed without overwriting.
          let postRaw: string | undefined;
          try {
            postRaw = await fs.readFile(pending, "utf8");
          } catch {
            postRaw = undefined;
          }
          if (postRaw === undefined) {
            await writePendingAtomic(pending, operationId, phase, ownedAttempt, ownedDeadline);
            return;
          }
          if (postRaw !== snapshot.raw) {
            throw ledgerUnknownExhaustedError(
              phase,
              operationId,
              `pending claim conflict (CLAIM-CONFLICT: marker replaced during stale reconcile, caller attempt ${ownedAttempt})`
            );
          }
          await writePendingAtomic(pending, operationId, phase, ownedAttempt, ownedDeadline);
          return;
        }
        // Legacy candidate (unparseable or new-format-invalid for this
        // operation/phase, incl. foreign): fail closed unless provably old via
        // file mtime under the CURRENT max bound (existing legacy rule).
        if (!isOldLegacyMarkerByMtime(snapshot.mtimeMs, options, nowMs)) {
          throw ledgerUnknownExhaustedError(
            phase,
            operationId,
            `pending claim conflict (CLAIM-CONFLICT: live legacy/foreign marker, caller attempt ${ownedAttempt})`
          );
        }
        // Old legacy → grave take + verify (preserve quarantine/binding), then
        // +1 + destroy, then write the new claim. Mismatch → quarantine + fail
        // closed (no increment, marker path untouched, no overwrite).
        const legacyPreHash = markerContentHash(snapshot.raw);
        const legacyPreMtimeMs = snapshot.mtimeMs;
        const legacyPreDev = snapshot.dev;
        const legacyPreIno = snapshot.ino;
        const grave = `${pending}.grave-${crypto.randomUUID()}`;
        try {
          await fs.rename(pending, grave);
        } catch (error) {
          if (isMissing(error)) {
            await writePendingAtomic(pending, operationId, phase, ownedAttempt, ownedDeadline);
            return;
          }
          throw error;
        }
        let graveRaw: string | undefined;
        let graveDev = -1;
        let graveIno = -1;
        let graveMtimeMs = Number.NaN;
        try {
          const handle = await fs.open(grave, "r");
          try {
            const graveStat = await handle.stat();
            graveDev = graveStat.dev;
            graveIno = graveStat.ino;
            graveMtimeMs = graveStat.mtimeMs;
            graveRaw = await handle.readFile("utf8");
          } finally {
            await handle.close().catch(() => undefined);
          }
        } catch {
          graveRaw = undefined;
        }
        const inodeMatch = graveDev === legacyPreDev && graveIno === legacyPreIno;
        const mtimeMatch = graveMtimeMs === legacyPreMtimeMs;
        if (graveRaw === undefined || !inodeMatch || !mtimeMatch || markerContentHash(graveRaw) !== legacyPreHash) {
          const reason =
            graveRaw === undefined
              ? "grave-unreadable"
              : !inodeMatch
                ? "inode-mismatch"
                : !mtimeMatch
                  ? "mtime-mismatch"
                  : "content-mismatch";
          const quarantine = `${pending}.quarantine-${crypto.randomUUID()}`;
          await fs.rename(grave, quarantine).catch(() => undefined);
          quarantineToTrace = { quarantine, reason };
          throw ledgerUnknownExhaustedError(
            phase,
            operationId,
            `pending claim conflict (CLAIM-CONFLICT: legacy quarantine ${reason}, caller attempt ${ownedAttempt})`
          );
        }
        // +1 + destroy, then write the new claim — but only when the
        // post-increment count is still under cap. An increment-to-cap
        // consumes the budget: fail closed with phase EXHAUSTED and do NOT
        // write the fresh claim (no launch). Mirrors the stale-claim cap gate.
        // MECHANISM: DETERMINISTIC (durable count comparison under lock).
        const previous = await loadUnlocked(file, operationId, phase);
        const reconciled = Math.floor(previous.stalls[phase]) + 1;
        const next: StallRetryBudgetV1 = {
          ...previous,
          stalls: { ...previous.stalls, [phase]: reconciled },
          updatedAt: new Date().toISOString()
        };
        await writeAtomic(file, next);
        if (reconciled >= STALL_RETRY_MAX_ATTEMPTS_PER_PHASE) {
          throw ledgerUnknownExhaustedError(
            phase,
            operationId,
            `budget exhausted by legacy reconcile (${reconciled}/${STALL_RETRY_MAX_ATTEMPTS_PER_PHASE}), caller attempt ${ownedAttempt}`
          );
        }
        await fs.rm(grave, { force: true }).catch(() => undefined);
        await writePendingAtomic(pending, operationId, phase, ownedAttempt, ownedDeadline);
      });
    } finally {
      if (quarantineToTrace) {
        await traceLegacyQuarantine(
          controlRoot,
          operationId,
          phase,
          quarantineToTrace.quarantine,
          quarantineToTrace.reason
        ).catch(() => undefined);
      }
    }
  } catch (error) {
    if (isCodedLedgerError(error)) throw error;
    throw ledgerWriteFailedError(phase, operationId, `code=${errnoCode(error)}`);
  }
}

/**
 * Best-effort reconcile for success/non-stall outcomes: clears ONLY the caller's
 * own pending claim (B1). Bound to (phase, attempt): the marker is deleted iff
 * marker.attempt equals the caller's claimed attempt number. Mismatched, malformed,
 * or foreign-operation markers are left alone (another live attempt may own them)
 * with a best-effort trace. Missing marker is a no-op (already reconciled).
 * ATOMIC (B1-race): re-read + identity comparison + unlink inside a single
 * lock-held critical section; all marker access serializes on the ledger lock.
 */
export async function clearStallRetryClaim(
  controlRoot: string,
  operationId: string,
  phase: StallRetryPhase,
  attempt?: number
): Promise<void> {
  const callerAttempt = normalizeAttemptNumber(attempt ?? 1);
  const file = stallRetryBudgetFile(controlRoot, operationId);
  const pending = stallRetryPendingFile(controlRoot, operationId, phase);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    type Outcome =
      | { status: "cleared" }
      | { status: "gone" }
      | { status: "mismatch"; markerAttempt: number | undefined }
      | { status: "leave" };
    const outcome: Outcome = await withLock(file, async (): Promise<Outcome> => {
      const first = await readPendingMarker(pending, operationId, phase);
      if (!first) {
        try {
          await fs.stat(pending);
        } catch (error) {
          if (isMissing(error)) return { status: "gone" };
        }
        return { status: "leave" };
      }
      if (first.parsed.attempt !== callerAttempt) {
        return { status: "mismatch", markerAttempt: first.parsed.attempt };
      }
      // Re-read + identity comparison inside the same lock before unlink: a
      // replacement (even same-attempt re-claim with a new claimedAt) has
      // different bytes and must survive.
      let secondRaw: string;
      try {
        secondRaw = await fs.readFile(pending, "utf8");
      } catch (error) {
        if (isMissing(error)) return { status: "gone" };
        return { status: "leave" };
      }
      if (secondRaw !== first.raw) {
        let secondParsed: unknown;
        try {
          secondParsed = JSON.parse(secondRaw);
        } catch {
          return { status: "leave" };
        }
        if (!isWellFormedPendingMarker(secondParsed, operationId, phase)) return { status: "leave" };
        if ((secondParsed as StallRetryPendingV1).attempt !== callerAttempt) {
          return { status: "mismatch", markerAttempt: (secondParsed as StallRetryPendingV1).attempt };
        }
        return { status: "leave" };
      }
      await fs.rm(pending, { force: true }).catch(() => undefined);
      return { status: "cleared" };
    });
    if (outcome.status === "mismatch") {
      await traceClaimMismatch(controlRoot, operationId, phase, callerAttempt, outcome.markerAttempt, "clear-mismatch").catch(() => undefined);
    } else if (outcome.status === "leave") {
      await traceClaimMismatch(controlRoot, operationId, phase, callerAttempt, undefined, "clear-unreadable-or-foreign").catch(() => undefined);
    }
  } catch {
    // Best-effort only: lock contention or mkdir failure leaves the marker for the
    // loader/reconciler; never fail a success path on cleanup.
  }
}

function isCodedLedgerError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.startsWith("STALL_RETRY_LEDGER_WRITE_FAILED:") ||
    error.message.startsWith("EXPLORER_STALL_BUDGET_EXHAUSTED:") ||
    error.message.startsWith("PLANNER_STALL_BUDGET_EXHAUSTED:") ||
    error.message.startsWith("SPEC_MANAGER_STALL_BUDGET_EXHAUSTED:") ||
    error.message.startsWith("AEH_OPERATION_SUPERVISOR_STALL_BUDGET_EXHAUSTED:")
  );
}

async function loadUnlocked(file: string, operationId: string, phase: StallRetryPhase): Promise<StallRetryBudgetV1> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (isMissing(error)) return empty(operationId);
    throw ledgerUnknownExhaustedError(phase, operationId, `ledger unreadable (STALL_RETRY_LEDGER_UNREADABLE: code=${errnoCode(error)})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw ledgerUnknownExhaustedError(phase, operationId, "ledger corrupt (STALL_RETRY_LEDGER_CORRUPT: invalid JSON)");
  }
  try {
    assertValidBudgetShape(parsed, operationId);
  } catch (validation) {
    throw ledgerUnknownExhaustedError(phase, operationId, `ledger corrupt (STALL_RETRY_LEDGER_CORRUPT: ${validation instanceof Error ? validation.message : "invalid shape"})`);
  }
  const stalls = { ...(parsed as StallRetryBudgetV1).stalls };
  return { ...(parsed as StallRetryBudgetV1), stalls };
}

function empty(operationId: string): StallRetryBudgetV1 {
  return {
    version: 1,
    operationId,
    stalls: { discovery: 0, planning: 0, "spec-manager": 0, consolidation: 0 },
    updatedAt: new Date().toISOString()
  };
}

async function writeAtomic(file: string, budget: StallRetryBudgetV1): Promise<void> {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(budget, null, 2)}\n`);
  try { await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }).catch(() => undefined); }
}

async function writePendingAtomic(pending: string, operationId: string, phase: StallRetryPhase, attempt: number, deadlineMs: number): Promise<void> {
  const marker: StallRetryPendingV1 = { version: 1, operationId, phase, attempt, claimedAt: new Date().toISOString(), deadlineMs };
  const temp = `${pending}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(marker, null, 2)}\n`);
  try { await fs.rename(temp, pending); }
  finally { await fs.rm(temp, { force: true }).catch(() => undefined); }
}

function normalizeAttemptNumber(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function normalizeDeadlineMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("PROVIDER_TURN_DEADLINE_INVALID: provider-turn deadline must be a positive integer in milliseconds.");
  }
  return value;
}

interface PendingMarkerRead { raw: string; parsed: StallRetryPendingV1; hash: string; }

/** Best-effort read of a well-formed marker for this operation/phase; undefined when missing/malformed/foreign. */
async function readPendingMarker(pending: string, operationId: string, phase: StallRetryPhase): Promise<PendingMarkerRead | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(pending, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isWellFormedPendingMarker(parsed, operationId, phase)) return undefined;
  return { raw, parsed, hash: markerContentHash(raw) };
}

/** Legacy helper: best-effort read of an existing marker's attempt number (same operation/phase only). */
async function readPendingAttempt(pending: string, operationId: string, phase: StallRetryPhase): Promise<number | undefined> {
  const marker = await readPendingMarker(pending, operationId, phase);
  return marker?.parsed.attempt;
}

function isWellFormedPendingMarker(marker: unknown, operationId: string, phase: StallRetryPhase): marker is StallRetryPendingV1 {
  if (!marker || typeof marker !== "object") return false;
  const candidate = marker as { version?: unknown; operationId?: unknown; phase?: unknown; attempt?: unknown; claimedAt?: unknown; deadlineMs?: unknown };
  if (candidate.version !== 1) return false;
  if (candidate.operationId !== operationId) return false;
  if (candidate.phase !== phase) return false;
  if (typeof candidate.attempt !== "number" || !Number.isInteger(candidate.attempt) || candidate.attempt <= 0) return false;
  if (typeof candidate.claimedAt !== "string" || !Number.isFinite(Date.parse(candidate.claimedAt))) return false;
  if (typeof candidate.deadlineMs !== "number" || !Number.isSafeInteger(candidate.deadlineMs) || candidate.deadlineMs < 1) return false;
  return true;
}

function markerContentHash(raw: string): string {
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * FD-bound decision snapshot (round-12 R1): bind content+identity to ONE
 * file object. open() the marker first, then fstat(fd) + read(fd) through
 * the same handle; the caller hashes THAT content and decides
 * staleness/identity from THAT fstat (dev/ino/mtime). A rename replacement
 * after open leaves this snapshot on the old inode (fd pins the generation)
 * while the later take sweeps the new one, so the post-take inode check
 * fails. No path-based read-then-stat sequence anywhere in the decision
 * path. Returns undefined when the marker is missing/unreadable (fail
 * closed); never throws.
 */
async function readMarkerDecisionSnapshot(
  pending: string,
): Promise<{ raw: string; dev: number; ino: number; mtimeMs: number } | undefined> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(pending, "r");
  } catch {
    return undefined;
  }
  try {
    const stat = await handle.stat();
    const raw = await handle.readFile("utf8");
    return { raw, dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Supersede-delete bound to (phase, attempt): only the caller's own claim is removed.
 * ATOMIC (B1-race): re-read + identity comparison + unlink inside a single
 * lock-held critical section; all marker access serializes on the ledger lock.
 * Best-effort: never throws (lock contention leaves the marker for the
 * loader/reconciler).
 */
async function supersedeOwnPendingClaim(controlRoot: string, operationId: string, phase: StallRetryPhase, callerAttempt: number): Promise<void> {
  const file = stallRetryBudgetFile(controlRoot, operationId);
  const pending = stallRetryPendingFile(controlRoot, operationId, phase);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    type Outcome =
      | { status: "cleared" }
      | { status: "gone" }
      | { status: "mismatch"; markerAttempt: number | undefined }
      | { status: "leave" };
    const outcome: Outcome = await withLock(file, async (): Promise<Outcome> => {
      const first = await readPendingMarker(pending, operationId, phase);
      if (!first) {
        try {
          await fs.stat(pending);
        } catch (error) {
          if (isMissing(error)) return { status: "gone" };
        }
        return { status: "leave" };
      }
      if (first.parsed.attempt !== callerAttempt) {
        return { status: "mismatch", markerAttempt: first.parsed.attempt };
      }
      let secondRaw: string;
      try {
        secondRaw = await fs.readFile(pending, "utf8");
      } catch (error) {
        if (isMissing(error)) return { status: "gone" };
        return { status: "leave" };
      }
      if (secondRaw !== first.raw) {
        let secondParsed: unknown;
        try {
          secondParsed = JSON.parse(secondRaw);
        } catch {
          return { status: "leave" };
        }
        if (!isWellFormedPendingMarker(secondParsed, operationId, phase)) return { status: "leave" };
        if ((secondParsed as StallRetryPendingV1).attempt !== callerAttempt) {
          return { status: "mismatch", markerAttempt: (secondParsed as StallRetryPendingV1).attempt };
        }
        return { status: "leave" };
      }
      await fs.rm(pending, { force: true }).catch(() => undefined);
      return { status: "cleared" };
    });
    if (outcome.status === "mismatch") {
      await traceClaimMismatch(controlRoot, operationId, phase, callerAttempt, outcome.markerAttempt, "supersede-mismatch").catch(() => undefined);
    } else if (outcome.status === "leave") {
      await traceClaimMismatch(controlRoot, operationId, phase, callerAttempt, undefined, "supersede-unreadable-or-foreign").catch(() => undefined);
    }
  } catch {
    // Best-effort only; the durable +1 already landed in recordStallRetryStall.
  }
}

async function traceLegacyQuarantine(controlRoot: string, operationId: string, phase: StallRetryPhase, quarantine: string, reason: string): Promise<void> {
  try {
    const { recordPaseoTrace } = await import("../paseo/trace.js");
    await recordPaseoTrace(controlRoot, "stall-retry.legacy-quarantine", {
      operationId,
      phase,
      quarantine: path.basename(quarantine),
      reason,
    });
  } catch {
    // Best-effort only; quarantine safety (park-aside + fail-closed) never depends on trace landing.
  }
}

/**
 * Debug listing (round-10 grave): sibling `.grave-<uuid>` / `.quarantine-<uuid>`
 * files parked by interrupted legacy migrations. At most one per interrupted
 * migration (the path parks and returns, never loops); operator-swept via the
 * OPERATOR RECOVERY header procedure — no auto-delete by design. Missing
 * directory reads as empty.
 */
export async function listStallRetryQuarantineGraves(
  controlRoot: string,
  operationId: string,
  phase: StallRetryPhase,
): Promise<string[]> {
  const pending = stallRetryPendingFile(controlRoot, operationId, phase);
  const base = path.basename(pending);
  let entries: string[];
  try {
    entries = await fs.readdir(path.dirname(pending));
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.startsWith(`${base}.grave-`) || entry.startsWith(`${base}.quarantine-`))
    .sort();
}

export interface StallRetryParkedFiles {
  graves: string[];
  quarantines: string[];
}

/**
 * Whole-root triage count (round-11 G2 discoverability): every parked
 * `.pending.grave-<uuid>` / `.pending.quarantine-<uuid>` sibling under the
 * operations state dir, as relative basenames. Wired into `aeh doctor` as the
 * non-required `stall-retry-quarantine` WARNING. Missing directory reads as
 * empty; never throws.
 */
export async function countStallRetryParkedFiles(root: string): Promise<StallRetryParkedFiles> {
  const dir = path.resolve(resolveOperationStateRoot(root), ".harness/operations");
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return { graves: [], quarantines: [] };
  }
  return {
    graves: entries.filter((entry) => entry.includes(".pending.grave-")).sort(),
    quarantines: entries.filter((entry) => entry.includes(".pending.quarantine-")).sort(),
  };
}

async function traceClaimMismatch(controlRoot: string, operationId: string, phase: StallRetryPhase, callerAttempt: number, markerAttempt: number | undefined, reason: string): Promise<void> {
  try {
    const { recordPaseoTrace } = await import("../paseo/trace.js");
    await recordPaseoTrace(controlRoot, "stall-retry.claim-mismatch", {
      operationId,
      phase,
      callerAttempt,
      markerAttempt: markerAttempt ?? null,
      reason,
    });
  } catch {
    // Best-effort only; binding safety (leave-alone) never depends on trace landing.
  }
}

/**
 * Staleness proof (B3): well-formed marker for this operation/phase whose age
 * exceeds its own configured-deadline bound. Formula: stale iff
 * `now - claimedAt > 2*deadlineMs + STALL_RETRY_STALE_MARGIN_MS`. Legacy markers
 * missing a valid attempt/deadlineMs cannot prove staleness this way — they use
 * the file-mtime migration bound below, never this path. Never a global constant.
 */
function isStalePendingMarker(marker: unknown, operationId: string, phase: StallRetryPhase, nowMs: number = Date.now()): boolean {
  if (!isWellFormedPendingMarker(marker, operationId, phase)) return false;
  const claimedMs = Date.parse((marker as StallRetryPendingV1).claimedAt);
  if (!Number.isFinite(claimedMs)) return false;
  const threshold = 2 * (marker as StallRetryPendingV1).deadlineMs + STALL_RETRY_STALE_MARGIN_MS;
  return nowMs - claimedMs > threshold;
}

/**
 * Legacy-migration bound (round-8 B3-legacy, one-time): a marker file that exists
 * but fails new-format well-formedness (unparseable JSON or missing/invalid
 * attempt/deadlineMs) migrates iff its FILE MTIME is older than
 * `2*CURRENT_MAX_DEADLINE + STALL_RETRY_STALE_MARGIN_MS`, where CURRENT_MAX is the
 * current max configured stall deadline (provider-turn deadline from config, or
 * 30min default, or an explicit override). No live attempt can still be running
 * past that bound; a fresh legacy file may still belong to a live pre-binding
 * attempt and must fail closed until it ages out. Unstatable → fail closed.
 */
export function stallRetryLegacyMaxDeadlineMs(options?: StallRetryLoadOptions): number {
  if (options?.legacyMaxDeadlineMs !== undefined) {
    return normalizeDeadlineMs(options.legacyMaxDeadlineMs);
  }
  if (options?.config) {
    return stallRetryEffectiveDeadlineMs(options.config);
  }
  return DEFAULT_STALL_RETRY_DEADLINE_MS;
}

export function stallRetryLegacyMigrationThresholdMs(options?: StallRetryLoadOptions): number {
  return 2 * stallRetryLegacyMaxDeadlineMs(options) + STALL_RETRY_STALE_MARGIN_MS;
}

function isOldLegacyMarkerByMtime(mtimeMs: number, options?: StallRetryLoadOptions, nowMs?: number): boolean {
  const now = nowMs ?? options?.nowMs ?? Date.now();
  if (!Number.isFinite(mtimeMs)) return false;
  return now - mtimeMs > stallRetryLegacyMigrationThresholdMs(options);
}

/**
 * Crash-orphan reconciliation (B2+B3) plus one-time legacy migration (B3-legacy):
 * converts a stale well-formed marker — or an OLD legacy marker (unparseable or
 * new-format-invalid with file mtime older than 2*current-max-deadline + margin)
 * — into a durable +1 (the orphaned attempt is counted, never granted free) and
 * clears it. Returns true when reconciled (caller then reads the durable count);
 * false for anything else (fresh well-formed, fresh legacy, unstatable legacy,
 * malformed/unreadable marker, corrupt ledger, lock contention, write failure)
 * so the caller stays fail-closed EXHAUSTED.
 *
 * Identity rule (B2): the pre-lock snapshot captures (attempt + claimedAt +
 * deadlineMs + content hash). In-lock, reconcile ONLY if the identical marker is
 * still present. If replaced → release the lock and re-evaluate from scratch (no
 * increment, no delete); a fresh replacement refuses, a stale replacement is
 * reconciled on the next iteration (bounded retries, then fail-closed). A missing
 * marker in-lock means a concurrent reconciler already counted → return true so
 * the caller reads the durable count (loser skips its increment).
 * The marker is only cleared after the durable write lands and only when the
 * identical bytes are still present (conditional delete); a replacement during the
 * increment is left alone and the caller stays fail-closed (already incremented,
 * but a live replacement must not be ignored).
 *
  * Legacy rule (round-10 grave + round-11 inode binding + round-12 fd-bound
  * decision + mtime tripwire, one-time): the decided snapshot is fd-bound —
  * open() the marker first, then fstat(fd) + read(fd) through the same
  * handle; the decided content hash is the hash of THAT read and the decided
  * (dev, ino, mtime) is THAT fstat (no path-based read-then-stat anywhere
  * in the decision path). In-lock, TAKE the marker to an unguessable grave
  * sibling via atomic rename, VERIFY the grave through an fd (single inode)
  * against the decided hash AND the decided (dev, ino) AND the decided mtime
  * tripwire, then DESTROY it after the durable +1 — or QUARANTINE it aside
  * (distinct `.quarantine-<uuid>` suffix, best-effort trace) with NO
  * increment on mismatch, leaving the marker path untouched and failing
  * closed. Fresh / unstatable legacy never migrates (operator clears).
  */
async function reconcileStalePendingClaim(
  controlRoot: string,
  file: string,
  pending: string,
  operationId: string,
  phase: StallRetryPhase,
  options?: StallRetryLoadOptions
): Promise<boolean> {
  for (let iteration = 0; iteration < 3; iteration += 1) {
    // FD-BOUND DECISION SNAPSHOT (round-12 R1): content+identity from ONE
    // file object — open() first, then fstat(fd) + read(fd) through the same
    // handle. The hash below is the hash of THAT read; staleness/identity
    // derive from THAT fstat. No path-based read-then-stat anywhere in this
    // decision path, so a replacement between two path calls cannot split
    // hash(old)/identity(new).
    const snapshot = await readMarkerDecisionSnapshot(pending);
    if (!snapshot) return false;
    const preRaw = snapshot.raw;
    const preDev = snapshot.dev;
    const preIno = snapshot.ino;
    const preMtimeMs = snapshot.mtimeMs;
    let preParsed: unknown;
    let preParseFailed = false;
    try {
      preParsed = JSON.parse(preRaw);
    } catch {
      preParseFailed = true;
    }
    if (!preParseFailed && isStalePendingMarker(preParsed, operationId, phase)) {
      const wellFormed = preParsed as StallRetryPendingV1;
      const preIdentity = {
        attempt: wellFormed.attempt,
        claimedAt: wellFormed.claimedAt,
        deadlineMs: wellFormed.deadlineMs,
        hash: markerContentHash(preRaw),
        raw: preRaw,
      };
      type LockOutcome =
        | { status: "reconciled" }
        | { status: "gone" }
        | { status: "replaced" }
        | { status: "fresh-or-malformed" }
        | { status: "replaced-during-increment" };
      let outcome: LockOutcome;
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        outcome = await withLock(file, async (): Promise<LockOutcome> => {
          let curRaw: string;
          try {
            curRaw = await fs.readFile(pending, "utf8");
          } catch (error) {
            if (isMissing(error)) return { status: "gone" };
            throw error;
          }
          let curParsed: unknown;
          try {
            curParsed = JSON.parse(curRaw);
          } catch {
            return { status: "fresh-or-malformed" };
          }
          if (
            !isWellFormedPendingMarker(curParsed, operationId, phase) ||
            (curParsed as StallRetryPendingV1).attempt !== preIdentity.attempt ||
            (curParsed as StallRetryPendingV1).claimedAt !== preIdentity.claimedAt ||
            (curParsed as StallRetryPendingV1).deadlineMs !== preIdentity.deadlineMs ||
            markerContentHash(curRaw) !== preIdentity.hash
          ) {
            return { status: "replaced" };
          }
          if (!isStalePendingMarker(curParsed, operationId, phase)) return { status: "fresh-or-malformed" };
          const previous = await loadUnlocked(file, operationId, phase);
          const next: StallRetryBudgetV1 = {
            ...previous,
            stalls: { ...previous.stalls, [phase]: Math.floor(previous.stalls[phase]) + 1 },
            updatedAt: new Date().toISOString()
          };
          await writeAtomic(file, next);
          // Conditional delete: only remove the identical bytes; a concurrent
          // replacement claim (which ignores the ledger lock) must survive.
          let postRaw: string | undefined;
          try {
            postRaw = await fs.readFile(pending, "utf8");
          } catch {
            return { status: "reconciled" };
          }
          if (postRaw !== preIdentity.raw) return { status: "replaced-during-increment" };
          await fs.rm(pending, { force: true }).catch(() => undefined);
          return { status: "reconciled" };
        });
      } catch {
        return false;
      }
      if (outcome.status === "reconciled" || outcome.status === "gone") return true;
      if (outcome.status === "replaced") continue;
      return false;
    }
    // Not a stale well-formed marker: fresh well-formed → fail closed (never legacy).
    if (!preParseFailed && isWellFormedPendingMarker(preParsed, operationId, phase)) return false;
    // Legacy candidate (unparseable or new-format-invalid, but a marker file):
    // migrate iff file mtime proves crash-orphanhood under the CURRENT max bound.
    // Decided identity (round-12 fd-bound): content hash is the hash of THAT
    // fd-read; (dev, ino, mtime) are THAT fstat — one file object, never a
    // path-based read-then-stat split. Rename preserves the inode, so any
    // rename replacement landing after the snapshot carries a different
    // inode and fails the post-take verify even with identical bytes; any
    // same-inode in-place mutation keeps the inode but trips the mtime
    // tripwire below.
    if (!isOldLegacyMarkerByMtime(preMtimeMs, options)) return false;
    // Decided snapshot: hash(THAT content) plus decided (dev, ino) plus
    // decided mtime tripwire. Mtime serves the age decision above AND the
    // post-take tripwire (round-12 R2b); inode+hash remain the identity.
    const legacyPreHash = markerContentHash(preRaw);
    const legacyPreMtimeMs = preMtimeMs;
    type LegacyOutcome =
      | { status: "reconciled" }
      | { status: "gone" }
      | { status: "quarantined"; quarantine: string; reason: string };
    let legacyOutcome: LegacyOutcome;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      legacyOutcome = await withLock(file, async (): Promise<LegacyOutcome> => {
        // TAKE (kills G1): atomically detach the marker to an unguessable
        // grave sibling in the same directory (same filesystem — rename
        // requirement). From here on the marker path is never touched: a
        // concurrent writer creates a NEW file there and survives untouched.
        // Missing marker in-lock means a concurrent reconciler already counted
        // (only a reconciler removes legacy markers now) → return true so the
        // caller reads the durable count (loser skips its increment).
        const grave = `${pending}.grave-${crypto.randomUUID()}`;
        try {
          await fs.rename(pending, grave);
        } catch (error) {
          if (isMissing(error)) return { status: "gone" };
          throw error;
        }
        // VERIFY (round-11 inode binding + round-12 R2b mtime tripwire): open
        // the GRAVE by fd; fstat + read through the fd observe a single
        // inode — a read/stat pair on the live path can never mix generations
        // — the content sha is compared against the decided fd-bound snapshot
        // AND the grave (dev, ino) must equal the decided inode AND the grave
        // fstat mtime must equal the decided mtime. Rename preserves the
        // inode, so a rename replace slipping between the decision snapshot
        // and the take lands a different inode in the grave and fails here
        // even with identical bytes. A same-inode in-place rewrite keeps
        // (dev, ino) and may keep the hash (identical bytes) but changes
        // mtime, so it trips the mtime check. Harness actors cannot do this
        // (R2a audit: temp+rename-only swaps the inode), so a trip means a
        // non-harness fd-holder mutated the decided inode in place.
        let graveRaw: string | undefined;
        let graveDev = -1;
        let graveIno = -1;
        let graveMtimeMs = Number.NaN;
        try {
          const handle = await fs.open(grave, "r");
          try {
            const graveStat = await handle.stat();
            graveDev = graveStat.dev;
            graveIno = graveStat.ino;
            graveMtimeMs = graveStat.mtimeMs;
            graveRaw = await handle.readFile("utf8");
          } finally {
            await handle.close().catch(() => undefined);
          }
        } catch {
          graveRaw = undefined;
        }
        // MISMATCH (a replace slipped between the decision snapshot and the
        // take, a same-inode in-place mtime change, or the grave is
        // unreadable): NO increment, NO unlink, marker path untouched (it may
        // hold someone else's live claim). Park the grave aside under a
        // distinct `.quarantine-<uuid>` suffix (same directory) and fail
        // closed — the operator recovers the quarantine file (see the
        // OPERATOR RECOVERY header section; `aeh doctor` warns while parked
        // files remain).
        const inodeMatch = graveDev === preDev && graveIno === preIno;
        const mtimeMatch = graveMtimeMs === legacyPreMtimeMs;
        if (graveRaw === undefined || !inodeMatch || !mtimeMatch || markerContentHash(graveRaw) !== legacyPreHash) {
          const reason =
            graveRaw === undefined
              ? "grave-unreadable"
              : !inodeMatch
                ? "inode-mismatch"
                : !mtimeMatch
                  ? "mtime-mismatch"
                  : "content-mismatch";
          const quarantine = `${pending}.quarantine-${crypto.randomUUID()}`;
          await fs.rename(grave, quarantine).catch(() => undefined);
          return { status: "quarantined", quarantine, reason };
        }
        const previous = await loadUnlocked(file, operationId, phase);
        const next: StallRetryBudgetV1 = {
          ...previous,
          stalls: { ...previous.stalls, [phase]: Math.floor(previous.stalls[phase]) + 1 },
          updatedAt: new Date().toISOString()
        };
        await writeAtomic(file, next);
        // DESTROY: the grave is detached and unguessable — no live writer can
        // address it — so unlinking needs no re-check.
        await fs.rm(grave, { force: true }).catch(() => undefined);
        return { status: "reconciled" };
      });
    } catch {
      return false;
    }
    if (legacyOutcome.status === "reconciled" || legacyOutcome.status === "gone") return true;
    await traceLegacyQuarantine(
      controlRoot,
      operationId,
      phase,
      legacyOutcome.quarantine,
      legacyOutcome.reason,
    ).catch(() => undefined);
    return false;
  }
  return false;
}

async function withLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(lock, "wx");
      try {
        await handle.writeFile(`${process.pid}\n`);
        return await action();
      } finally {
        await handle.close().catch(() => undefined);
        await fs.rm(lock, { force: true }).catch(() => undefined);
      }
    } catch (error) {
      if (handle) throw error;
      if (!isAlreadyExists(error)) throw error;
      if (await canRecoverLock(lock)) {
        await fs.rm(lock, { force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Failed to acquire stall-retry budget lock for ${path.basename(file)} (lock contention).`);
      await delay(LOCK_RETRY_MS);
    }
  }
}

async function canRecoverLock(lock: string): Promise<boolean> {
  try {
    const [rawPid, stat] = await Promise.all([fs.readFile(lock, "utf8").catch(() => ""), fs.stat(lock)]);
    const ownerPid = Number.parseInt(rawPid.trim(), 10);
    if (Number.isInteger(ownerPid) && ownerPid > 0 && !processAlive(ownerPid)) return true;
    return Date.now() - stat.mtimeMs > STALE_LOCK_MS;
  } catch {
    return true;
  }
}

function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
function safeId(value: string): string { if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`Invalid operation id '${value}'.`); return value; }
function isMissing(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT"); }
function isAlreadyExists(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EEXIST"); }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

/**
 * Atomic decide-and-spend (main fail-closed line, preserved verbatim as an
 * exported API for per-operation spend accounting and direct ledger tests).
 *
 * Under a single file lock: load (fail-closed taxonomy below), refuse when
 * the persisted total already reached the max (`STALL_BUDGET_EXHAUSTED`,
 * nothing written), otherwise increment + write and return the new total.
 * WRITE failure throws `STALL_RETRY_LEDGER_WRITE_FAILED`. Must be called
 * BEFORE the attempt it pays for — never after the kill.
 *
 * INTEGRATION NOTE: the four production call sites (discovery / planning /
 * spec-manager / consolidation) use the pre-claim + reconcile protocol
 * (`claimStallRetryAttempt` before the counted attempt,
 * `recordStallRetryStall` on stall-kill, `clearStallRetryClaim` on
 * success/clean non-stall) instead of this spend. An unconditional
 * upfront spend is incompatible with the pinned "clean attempt consumes
 * nothing" contract (ru claim-sites/success suites), while the pre-claim
 * marker provides the same crash-safety spend-before-attempt guarantees:
 * crash before claim = nothing claimed; crash after = marker fails closed
 * EXHAUSTED (safe direction, never a free retry). This function remains
 * available for direct spend accounting and keeps its exact main-line
 * semantics (every call spends, non-stall outcomes stay spent).
 */
export async function transactStallRetrySpend(
  controlRoot: string,
  operationId: string,
  phase: StallRetryPhase
): Promise<number> {
  const file = stallRetryBudgetFile(controlRoot, operationId);
  await fs.mkdir(path.dirname(file), { recursive: true }).catch((error) => {
    throw new Error(`STALL_RETRY_LEDGER_WRITE_FAILED: cannot create stall-retry ledger directory for operation '${operationId}': ${String(error)}`, { cause: error });
  });
  try {
    return await withLock(file, async () => {
      const previous = await readTransactBudget(file, operationId);
      const current = transactCountOrThrow(previous, phase);
      if (current >= STALL_RETRY_MAX_ATTEMPTS_PER_PHASE) {
        throw new Error(`STALL_BUDGET_EXHAUSTED: ${phase} already consumed ${current} attempt(s) for operation ${operationId}; max ${STALL_RETRY_MAX_ATTEMPTS_PER_PHASE} total across all drives. Same-session resume only; fresh attempts refused.`);
      }
      const next: StallRetryBudgetV1 = {
        version: 1,
        operationId,
        stalls: { ...previous.stalls, [phase]: current + 1 },
        updatedAt: new Date().toISOString()
      };
      await writeAtomic(file, next);
      return next.stalls[phase];
    });
  } catch (error) {
    if (isTransactCodedError(error)) throw error;
    throw new Error(`STALL_RETRY_LEDGER_WRITE_FAILED: cannot commit stall-retry ledger '${path.basename(file)}': ${String(error)}`, { cause: error });
  }
}

function isTransactCodedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.startsWith("STALL_RETRY_LEDGER_WRITE_FAILED:") ||
    error.message.startsWith("STALL_RETRY_LEDGER_CORRUPT:") ||
    error.message.startsWith("STALL_BUDGET_EXHAUSTED:")
  );
}

async function transactExists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw new Error(`STALL_RETRY_LEDGER_CORRUPT: cannot stat stall-retry ledger '${path.basename(file)}': ${String(error)}`, { cause: error });
  }
}

/** Present-file read + strict validation for the transact path. Any failure throws CORRUPT. */
async function readTransactBudget(file: string, operationId: string): Promise<StallRetryBudgetV1> {
  if (!(await transactExists(file))) return empty(operationId);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      // Deleted between the existence check and the read: absent at read
      // time reads as zero (the only benign race; the file is now absent).
      return empty(operationId);
    }
    throw new Error(`STALL_RETRY_LEDGER_CORRUPT: stall-retry ledger '${path.basename(file)}' is present but unreadable: ${String(error)}`, { cause: error });
  }
  return parseTransactBudget(raw, file, operationId);
}

const TRANSACT_PHASES: readonly StallRetryPhase[] = ["discovery", "planning", "spec-manager", "consolidation"];

function parseTransactBudget(raw: string, file: string, operationId: string): StallRetryBudgetV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`STALL_RETRY_LEDGER_CORRUPT: stall-retry ledger '${path.basename(file)}' is present but unparseable: ${String(error)}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`STALL_RETRY_LEDGER_CORRUPT: stall-retry ledger '${path.basename(file)}' is present but has no valid budget object.`);
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1 || record.operationId !== operationId) {
    throw new Error(`STALL_RETRY_LEDGER_CORRUPT: stall-retry ledger '${path.basename(file)}' is present but schema-invalid (version/operation mismatch).`);
  }
  const stallsRaw = record.stalls as Record<string, unknown> | undefined;
  if (!stallsRaw || typeof stallsRaw !== "object" || Array.isArray(stallsRaw)) {
    throw new Error(`STALL_RETRY_LEDGER_CORRUPT: stall-retry ledger '${path.basename(file)}' is present but has no valid stalls record.`);
  }
  const stalls = { ...empty(operationId).stalls };
  for (const phase of TRANSACT_PHASES) {
    const value = stallsRaw[phase];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || Math.floor(value) !== value) {
      throw new Error(`STALL_RETRY_LEDGER_CORRUPT: stall-retry ledger '${path.basename(file)}' is present but phase '${phase}' carries an invalid count.`);
    }
    stalls[phase] = value;
  }
  return { version: 1, operationId, stalls, updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString() };
}

function transactCountOrThrow(budget: StallRetryBudgetV1, phase: StallRetryPhase): number {
  return budget.stalls[phase];
}
