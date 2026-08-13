import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveOperationStateRoot } from "./state.js";

export type DurableWakeTarget = "lead" | "supervisor";
export type DurableWakeReason = "progress" | "blocked" | "stalled" | "terminal";

export interface OperationWakeBudget {
  version: 1;
  operationId: string;
  revision: number;
  supervisorAccepted: number;
  leadAccepted: number;
  terminalLeadAccepted: number;
  updatedAt: string;
  lastAcceptedAt?: string;
}

const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

export function operationWakeBudgetFile(root: string, operationId: string): string {
  return path.resolve(resolveOperationStateRoot(root), ".harness/operations", `${safeId(operationId)}.wake.json`);
}

export async function loadOperationWakeBudget(root: string, operationId: string, revision: number): Promise<OperationWakeBudget> {
  try {
    const parsed = JSON.parse(await fs.readFile(operationWakeBudgetFile(root, operationId), "utf8")) as OperationWakeBudget;
    if (parsed.version !== 1 || parsed.operationId !== operationId || parsed.revision !== revision) return empty(operationId, revision);
    return {
      ...parsed,
      supervisorAccepted: count(parsed.supervisorAccepted),
      leadAccepted: count(parsed.leadAccepted),
      terminalLeadAccepted: count(parsed.terminalLeadAccepted)
    };
  } catch (error) {
    if (isMissing(error)) return empty(operationId, revision);
    throw error;
  }
}

export async function recordOperationWakeAccepted(
  root: string,
  operationId: string,
  revision: number,
  target: DurableWakeTarget,
  reason: DurableWakeReason
): Promise<OperationWakeBudget> {
  const file = operationWakeBudgetFile(root, operationId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  return withLock(file, async () => {
    const previous = await loadUnlocked(file, operationId, revision);
    const now = new Date().toISOString();
    const next: OperationWakeBudget = {
      ...previous,
      supervisorAccepted: previous.supervisorAccepted + (target === "supervisor" ? 1 : 0),
      leadAccepted: previous.leadAccepted + (target === "lead" ? 1 : 0),
      terminalLeadAccepted: previous.terminalLeadAccepted + (target === "lead" && reason === "terminal" ? 1 : 0),
      updatedAt: now,
      lastAcceptedAt: now
    };
    await writeAtomic(file, next);
    return next;
  });
}

async function loadUnlocked(file: string, operationId: string, revision: number): Promise<OperationWakeBudget> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as OperationWakeBudget;
    if (parsed.version !== 1 || parsed.operationId !== operationId || parsed.revision !== revision) return empty(operationId, revision);
    return {
      ...parsed,
      supervisorAccepted: count(parsed.supervisorAccepted),
      leadAccepted: count(parsed.leadAccepted),
      terminalLeadAccepted: count(parsed.terminalLeadAccepted)
    };
  } catch (error) {
    if (isMissing(error)) return empty(operationId, revision);
    throw error;
  }
}

function empty(operationId: string, revision: number): OperationWakeBudget {
  return {
    version: 1,
    operationId,
    revision,
    supervisorAccepted: 0,
    leadAccepted: 0,
    terminalLeadAccepted: 0,
    updatedAt: new Date().toISOString()
  };
}

async function writeAtomic(file: string, budget: OperationWakeBudget): Promise<void> {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(budget, null, 2)}\n`);
  try { await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }).catch(() => undefined); }
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
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring wake budget lock for ${path.basename(file)}.`);
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
function count(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0; }
function safeId(value: string): string { if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`Invalid operation id '${value}'.`); return value; }
function isMissing(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT"); }
function isAlreadyExists(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EEXIST"); }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
