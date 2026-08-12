import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type OperationKind = "audit" | "run";
export type OperationStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export interface AuditOperationPayload {
  request: string;
  files?: string[];
  domains?: string[];
  risk?: "low" | "medium" | "high";
  reviewers?: string[];
}

export interface RunOperationPayload {
  taskId: string;
  profile?: string;
}

export type OperationPayload = AuditOperationPayload | RunOperationPayload;

export interface OperationRecord {
  version: 1;
  id: string;
  kind: OperationKind;
  status: OperationStatus;
  phase: string;
  root: string;
  payload: OperationPayload;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  pid?: number;
  workspaceId?: string;
  workspaceWarning?: string;
  cleanupWarnings?: string[];
  result?: Record<string, unknown>;
  error?: string;
}

const OPERATIONS_DIR = ".harness/operations";
const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 30_000;

export function operationFile(root: string, operationId: string): string {
  return path.resolve(root, OPERATIONS_DIR, `${safeId(operationId)}.json`);
}

export async function loadOperation(root: string, operationId: string): Promise<OperationRecord> {
  return JSON.parse(await fs.readFile(operationFile(root, operationId), "utf8")) as OperationRecord;
}

export async function saveOperation(root: string, record: OperationRecord): Promise<void> {
  const file = operationFile(root, record.id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await withOperationLock(file, async () => writeRecord(file, record));
}

export async function patchOperation(root: string, operationId: string, patch: Partial<OperationRecord>): Promise<OperationRecord> {
  const file = operationFile(root, operationId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  return withOperationLock(file, async () => {
    const current = JSON.parse(await fs.readFile(file, "utf8")) as OperationRecord;
    const guardedPatch = guardTerminalTransition(current, patch);
    const next: OperationRecord = { ...current, ...guardedPatch, id: current.id, kind: current.kind, version: 1, updatedAt: new Date().toISOString() };
    await writeRecord(file, next);
    return next;
  });
}

export function currentOperationContext(): { id?: string; kind?: string; workspaceId?: string } {
  return {
    id: process.env.AEH_OPERATION_ID?.trim() || undefined,
    kind: process.env.AEH_OPERATION_KIND?.trim() || undefined,
    workspaceId: process.env.AEH_OPERATION_WORKSPACE_ID?.trim() || undefined
  };
}

export async function updateCurrentOperationPhase(root: string, phase: string): Promise<void> {
  const operationId = currentOperationContext().id;
  if (!operationId) return;
  try { await patchOperation(root, operationId, { phase }); }
  catch { /* direct/non-controller execution has no operation state to update */ }
}

async function writeRecord(file: string, record: OperationRecord): Promise<void> {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`);
  try { await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }).catch(() => undefined); }
}

async function withOperationLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(lock, "wx");
      await handle.writeFile(`${process.pid}\n`);
      try { return await action(); }
      finally {
        await handle.close().catch(() => undefined);
        await fs.rm(lock, { force: true }).catch(() => undefined);
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (!isAlreadyExists(error)) throw error;
      if (await canRecoverLock(lock)) {
        await fs.rm(lock, { force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring operation state lock for ${path.basename(file)}.`);
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
  } catch { return true; }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !/ESRCH/.test(String(error)); }
}

function guardTerminalTransition(current: OperationRecord, patch: Partial<OperationRecord>): Partial<OperationRecord> {
  if (!isTerminal(current.status)) return patch;
  const guarded = { ...patch, status: current.status, finishedAt: current.finishedAt ?? patch.finishedAt };
  if (patch.status !== current.status) guarded.phase = current.phase;
  return guarded;
}

function isTerminal(status: OperationStatus): boolean { return status === "SUCCEEDED" || status === "FAILED" || status === "CANCELLED"; }
function isAlreadyExists(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EEXIST"); }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

function safeId(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`Invalid operation id '${value}'.`);
  return value;
}
