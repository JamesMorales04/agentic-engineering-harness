import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveOperationStateRoot } from "./state.js";

/**
 * DETERMINISTIC durable stall-retry ledger (fail-closed retry path).
 *
 * Stall-retry budgets were function-local counters (`let retries = 0`), so
 * controller takeover, watchdog re-wake, or phase re-entry restarted the
 * budget with a fresh invocation and total attempts per work unit were
 * unbounded across drives. This sidecar persists per-phase attempt counts
 * under the operation state root (wakeBudget.ts ledger pattern: atomic
 * write + file lock).
 *
 * FAIL-CLOSED TAXONOMY (B1):
 * - file ABSENT → 0. The only zero-source (legitimate first run).
 * - file present but unreadable / corrupt / unparseable / schema-invalid →
 *   THROW `STALL_RETRY_LEDGER_CORRUPT`. Missing vs corrupt is distinguished
 *   by an existence check, not a catch-all: every read/parse/validate
 *   failure on a present file throws.
 * - WRITE failure → THROW `STALL_RETRY_LEDGER_WRITE_FAILED`. No
 *   degrade-to-local, no swallow at call sites: a drive that cannot prove
 *   its budget fails closed with zero attempts.
 *
 * ATOMIC DECIDE-AND-SPEND (B2): `transactStallRetrySpend` performs a single
 * locked {load, budget-check, increment, write} BEFORE acting
 * (launch/retry). Crash before transact = nothing spent; crash after =
 * count spent (safe direction). There is no increment-after-kill pattern:
 * call sites spend upfront, then act. A spent attempt that fails
 * non-stall stays spent (safe direction — never a free retry).
 *
 * Scope: stall-retry budgets only (discovery/planning/spec-manager/
 * consolidation). INVALID/schema/contract/provenance rejections are never
 * stalls and never retry — but the attempt that produced them was still
 * spent upfront. MECHANISM: DETERMINISTIC (file-backed counters, no model
 * judgment). Keying is per operation id + phase (cross-operation
 * interference is structurally impossible: distinct files per operation).
 */

export type StallRetryPhase = "discovery" | "planning" | "spec-manager" | "consolidation";

/** Max attempts total per phase per operation, across all invocations. */
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
 * Reads the persisted attempt count. ABSENT → 0; anything present-but-bad →
 * THROW. Never throws on a genuinely missing file; always throws on a
 * present file it cannot prove valid.
 */
export async function loadStallRetryStalls(
  controlRoot: string,
  operationId: string,
  phase: StallRetryPhase
): Promise<number> {
  const file = stallRetryBudgetFile(controlRoot, operationId);
  if (!(await exists(file))) return 0;
  return countOrThrow(await readAndValidate(file, operationId, "read"), phase);
}

/**
 * Atomic decide-and-spend (B2). Under a single file lock: load (fail-closed
 * taxonomy), refuse when the persisted total already reached the max
 * (`STALL_BUDGET_EXHAUSTED`, nothing written), otherwise increment + write
 * and return the new total. WRITE failure throws
 * `STALL_RETRY_LEDGER_WRITE_FAILED` (nothing is silently spent-or-not:
 * the drive fails closed before acting). Must be called BEFORE the attempt
 * it pays for — never after the kill.
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
  return withLock(file, async () => {
    const previous = await readIfPresent(file, operationId);
    const current = countOrThrow(previous, phase);
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
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw new Error(`STALL_RETRY_LEDGER_CORRUPT: cannot stat stall-retry ledger '${path.basename(file)}': ${String(error)}`, { cause: error });
  }
}

/** Present-file read + strict validation. Any failure throws CORRUPT. */
async function readAndValidate(file: string, operationId: string, _purpose: string): Promise<StallRetryBudgetV1> {
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
  return parseAndValidate(raw, file, operationId);
}

/** Locked re-read inside transact: same taxonomy (absent→empty, bad→throw). */
async function readIfPresent(file: string, operationId: string): Promise<StallRetryBudgetV1> {
  if (!(await exists(file))) return empty(operationId);
  return readAndValidate(file, operationId, "transact");
}

function parseAndValidate(raw: string, file: string, operationId: string): StallRetryBudgetV1 {
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
  for (const phase of PHASES) {
    const value = stallsRaw[phase];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || Math.floor(value) !== value) {
      throw new Error(`STALL_RETRY_LEDGER_CORRUPT: stall-retry ledger '${path.basename(file)}' is present but phase '${phase}' carries an invalid count.`);
    }
    stalls[phase] = value;
  }
  return { version: 1, operationId, stalls, updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString() };
}

function countOrThrow(budget: StallRetryBudgetV1, phase: StallRetryPhase): number {
  return budget.stalls[phase];
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
  try {
    await fs.writeFile(temp, `${JSON.stringify(budget, null, 2)}\n`);
  } catch (error) {
    throw new Error(`STALL_RETRY_LEDGER_WRITE_FAILED: cannot write stall-retry ledger '${path.basename(file)}': ${String(error)}`, { cause: error });
  }
  try {
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw new Error(`STALL_RETRY_LEDGER_WRITE_FAILED: cannot commit stall-retry ledger '${path.basename(file)}': ${String(error)}`, { cause: error });
  }
  await fs.rm(temp, { force: true }).catch(() => undefined);
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
      if (Date.now() >= deadline) throw new Error(`STALL_RETRY_LEDGER_WRITE_FAILED: timed out acquiring stall-retry budget lock for ${path.basename(file)}.`);
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
