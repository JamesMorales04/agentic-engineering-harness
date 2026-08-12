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

export function operationFile(root: string, operationId: string): string {
  return path.resolve(root, OPERATIONS_DIR, `${safeId(operationId)}.json`);
}

export async function loadOperation(root: string, operationId: string): Promise<OperationRecord> {
  return JSON.parse(await fs.readFile(operationFile(root, operationId), "utf8")) as OperationRecord;
}

export async function saveOperation(root: string, record: OperationRecord): Promise<void> {
  const file = operationFile(root, record.id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`);
  await fs.rename(temp, file);
}

export async function patchOperation(root: string, operationId: string, patch: Partial<OperationRecord>): Promise<OperationRecord> {
  const current = await loadOperation(root, operationId);
  const next: OperationRecord = { ...current, ...patch, id: current.id, kind: current.kind, version: 1, updatedAt: new Date().toISOString() };
  await saveOperation(root, next);
  return next;
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

function safeId(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`Invalid operation id '${value}'.`);
  return value;
}
