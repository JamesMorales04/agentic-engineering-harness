import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { lock } from "proper-lockfile";
import { VERSION } from "../version.js";

export interface OperationToolDiagnosticV2 {
  version: 2;
  id: string;
  controlRootFingerprint: string;
  requestCorrelationId: string;
  occurredAt: string;
  tool: string;
  stage: "START" | "PORTFOLIO" | "OPERATION_CONTROL" | "INFORMATIONAL" | "OTHER";
  exceptionClass: string;
  messageOmitted: true;
  errorCode?: string;
  failureClass: "INPUT" | "AUTHORITY" | "LINEAGE" | "CONTROLLER" | "INTERNAL";
  stackFrames: string[];
  runtime: { aehVersion: string; nodeVersion: string; platform: string; architecture: string };
}

const storePathParts = ["aeh", "operation-tool-diagnostics", "v2"];
const maxDiagnosticBytes = 16 * 1024;
const maxDiagnostics = 100;
const maxDiagnosticAgeMs = 30 * 24 * 60 * 60 * 1000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const allowedTools = new Set([
  "aeh_operation_start_audit", "aeh_operation_start_run", "aeh_operation_start_change",
  "aeh_operation_portfolio", "aeh_operation_status", "aeh_operation_digest",
  "aeh_operation_ack", "aeh_operation_cancel", "aeh_operation_recover_participant",
  "aeh_informational_context", "aeh_informational_evidence", "aeh_context_status"
]);
const allowedExceptionClasses = new Set([
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "URIError", "EvalError",
  "AggregateError", "AbortError", "OperationMcpInputError", "SystemError"
]);
const allowedErrnoCodes = new Set(["ENOENT", "EACCES", "EEXIST", "ENOTDIR", "EISDIR", "EPERM", "EIO", "EINVAL", "ENOSPC", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "EPIPE"]);

// Node does not expose an advisory process-shared file lock. proper-lockfile is MIT licensed and
// uses an atomic lock directory; its lock path is kept descriptor-relative with realpath disabled.
const operationToolErrorCodes = [
  "OPERATION_TOOL_CALL_FAILED", "OPERATION_INPUT_INVALID", "INVALID_INTENT_DECISION",
  "OPERATION_RECOVERY_PARENT_REQUIRED", "OPERATION_RECOVERY_PARENT_NOT_LEAF", "OPERATION_RECOVERY_PARENT_NOT_FAILED",
  "OPERATION_RECOVERY_OWNER_BOUNDARY", "OPERATION_RECOVERY_OWNER_BOUNDARY_REQUIRED", "OPERATION_RECOVERY_BUDGET_EXHAUSTED",
  "OPERATION_RECOVERY_AUTHORITY_MISSING", "PROJECT_OR_OWNER_GLOBAL_BOUNDARY_STILL_WAITING", "OPERATION_OWNER_BOUNDARY_STILL_WAITING",
  "OPERATION_HARD_DEADLINE_NOT_REACHED", "OPERATION_LEAD_USER_TURN_UNAVAILABLE", "OPERATION_START_FAILED_AFTER_CREATE",
  "OPERATION_NOT_FOUND", "OPERATION_ACK_WRONG_LEAD", "AEH_OPERATION_CAPACITY",
  "AEH_OPERATION_ACK_REVISION_MISMATCH", "LEAD_RECOVERY_AUTHORITY_DENIED",
  "LEAD_RECOVERY_ACTION_INVALID", "LEAD_RECOVERY_REASON_INVALID", "LEAD_RECOVERY_EVIDENCE_REQUIRED",
  "LEAD_RECOVERY_BINDING_STALE", "LEAD_RECOVERY_EVIDENCE_STALE", "SAME_SESSION_RESUME_REJECTED",
  "SUPERVISOR_RECOVERY_STATE_STALE", "SUPERVISOR_RECOVERY_ACTION_REQUIRED", "SUPERVISOR_RECOVERY_BINDING_STALE", "SUPERVISOR_RECOVERY_EVIDENCE_REQUIRED", "SUPERVISOR_RECOVERY_EVIDENCE_STALE",
  "AEH_OPERATION_ACK_EPOCH_MISMATCH", "AEH_OPERATION_ACK_ACTOR_MISMATCH",
] as const;
type OperationToolErrorCode = typeof operationToolErrorCodes[number];
function isOperationToolErrorCode(value: string): value is OperationToolErrorCode {
  return (operationToolErrorCodes as readonly string[]).includes(value);
}

const trustedErrors = new WeakMap<object, { code: string; relatedOperationId?: string }>();
export function createTrustedOperationToolError(code: string, message: string, cause?: unknown, relatedOperationId?: string): Error {
  if (!isOperationToolErrorCode(code)) throw new Error("Unsupported internal operation error code.");
  const error = new Error(`${code}: ${message}`, cause === undefined ? undefined : { cause });
  trustedErrors.set(error, { code, ...(relatedOperationId ? { relatedOperationId } : {}) });
  return error;
}
export function markTrustedOperationToolError<T extends Error>(error: T, code: string): T {
  if (!isOperationToolErrorCode(code)) throw new Error("Unsupported internal operation error code.");
  trustedErrors.set(error, { code });
  return error;
}

export function allowlistedOperationToolErrorCode(value: unknown): string | undefined {
  return typeof value === "object" && value !== null ? trustedErrors.get(value)?.code : undefined;
}

export function trustedOperationToolErrorRelatedId(value: unknown): string | undefined {
  return typeof value === "object" && value !== null ? trustedErrors.get(value)?.relatedOperationId : undefined;
}

export interface PersistOperationToolDiagnosticV2Input {
  root: string;
  requestCorrelationId: string;
  tool: string;
  error: unknown;
}

export async function persistOperationToolDiagnosticV2(input: PersistOperationToolDiagnosticV2Input): Promise<string> {
  if (process.platform !== "linux" || typeof process.getuid !== "function" || !fsConstants.O_DIRECTORY || !fsConstants.O_NOFOLLOW) {
    throw new Error("Private operation diagnostics are unsupported on this platform.");
  }
  const controlRootFingerprint = await fingerprintControlRoot(input.root);
  const directory = await openStoreDirectory(true);
  const directoryPath = descriptorPath(directory);
  const id = randomUUID();
  const filePath = path.join(directoryPath, `${id}.json`);
  const record = makeDiagnosticRecord(input, id, controlRootFingerprint);
  const serialized = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > maxDiagnosticBytes) {
    await directory.close();
    throw new Error("Operation diagnostic exceeded its size bound.");
  }
  const parsedRecord = parseDiagnostic(serialized);
  if (!parsedRecord || parsedRecord.id !== id || parsedRecord.controlRootFingerprint !== controlRootFingerprint) {
    await directory.close();
    throw new Error("Operation diagnostic failed its schema validation.");
  }

  let lockCompromised = false;
  let fileCreated = false;
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lock(directoryPath, {
      realpath: false,
      lockfilePath: path.join(directoryPath, ".retention-lock"),
      stale: 30_000,
      update: 10_000,
      retries: { retries: 160, factor: 1, minTimeout: 20, maxTimeout: 50, randomize: true },
      onCompromised: () => { lockCompromised = true; }
    });
    await pruneDiagnostics(directoryPath, maxDiagnostics - 1, Date.now());
    await writePrivateRecord(filePath, serialized);
    fileCreated = true;
    if (lockCompromised) throw new Error("Operation diagnostic retention lock was compromised.");
  } catch (error) {
    if (fileCreated) await fs.unlink(filePath).catch(() => undefined);
    throw error;
  } finally {
    try { await release?.(); }
    finally { await directory.close(); }
  }
  return `aeh-diagnostic:v2/${id}`;
}

export async function resolveOperationToolDiagnosticV2(root: string, reference: string): Promise<OperationToolDiagnosticV2 | undefined> {
  const match = /^aeh-diagnostic:v2\/([0-9a-f-]{36})$/.exec(reference);
  if (!match || process.platform !== "linux" || typeof process.getuid !== "function" || !fsConstants.O_DIRECTORY || !fsConstants.O_NOFOLLOW) return undefined;
  const id = match[1]!;
  if (!uuidPattern.test(id)) return undefined;
  let directory: FileHandle | undefined;
  try {
    const controlRootFingerprint = await fingerprintControlRoot(root);
    directory = await openStoreDirectory(false);
    const filePath = path.join(descriptorPath(directory), `${id}.json`);
    const file = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > maxDiagnosticBytes || Date.now() - stat.mtimeMs > maxDiagnosticAgeMs) return undefined;
      const record = parseDiagnostic(await file.readFile("utf8"));
      if (!record || record.id !== id || record.controlRootFingerprint !== controlRootFingerprint) return undefined;
      return record;
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

function makeDiagnosticRecord(input: PersistOperationToolDiagnosticV2Input, id: string, controlRootFingerprint: string): OperationToolDiagnosticV2 {
  const safeTool = allowedTools.has(input.tool) ? input.tool : "unknown-operation-tool";
  const error = input.error;
  const trustedCode = allowlistedOperationToolErrorCode(error);
  const candidateErrno = error && typeof error === "object" && "code" in error ? safeString(() => (error as { code?: unknown }).code) : "";
  const errorCode = trustedCode ?? (allowedErrnoCodes.has(candidateErrno) ? candidateErrno : undefined);
  const rawName = error instanceof Error ? safeString(() => error.name) : "Error";
  const exceptionClass = trustedCode && allowedExceptionClasses.has(rawName) ? rawName : "Error";
  const stage = safeTool.startsWith("aeh_operation_start_") ? "START" : safeTool === "aeh_operation_portfolio" ? "PORTFOLIO" : safeTool.startsWith("aeh_operation_") ? "OPERATION_CONTROL" : safeTool.startsWith("aeh_informational_") ? "INFORMATIONAL" : "OTHER";
  const failureClass = diagnosticFailureClass(trustedCode);
  return {
    version: 2,
    id,
    controlRootFingerprint,
    requestCorrelationId: input.requestCorrelationId.slice(0, 200),
    occurredAt: new Date().toISOString(),
    tool: safeTool,
    stage,
    exceptionClass,
    messageOmitted: true,
    ...(errorCode ? { errorCode } : {}),
    failureClass,
    stackFrames: [],
    runtime: { aehVersion: VERSION, nodeVersion: process.version, platform: process.platform, architecture: process.arch }
  };
}

const diagnosticFailureClasses: Record<OperationToolErrorCode, OperationToolDiagnosticV2["failureClass"]> = {
  OPERATION_TOOL_CALL_FAILED: "INTERNAL", OPERATION_INPUT_INVALID: "INPUT", INVALID_INTENT_DECISION: "INPUT",
  OPERATION_RECOVERY_PARENT_REQUIRED: "LINEAGE", OPERATION_RECOVERY_PARENT_NOT_LEAF: "LINEAGE", OPERATION_RECOVERY_PARENT_NOT_FAILED: "LINEAGE",
  OPERATION_RECOVERY_OWNER_BOUNDARY: "AUTHORITY", OPERATION_RECOVERY_OWNER_BOUNDARY_REQUIRED: "AUTHORITY", OPERATION_RECOVERY_BUDGET_EXHAUSTED: "AUTHORITY",
  OPERATION_RECOVERY_AUTHORITY_MISSING: "AUTHORITY", PROJECT_OR_OWNER_GLOBAL_BOUNDARY_STILL_WAITING: "AUTHORITY", OPERATION_OWNER_BOUNDARY_STILL_WAITING: "AUTHORITY",
  OPERATION_HARD_DEADLINE_NOT_REACHED: "CONTROLLER", OPERATION_LEAD_USER_TURN_UNAVAILABLE: "CONTROLLER", OPERATION_START_FAILED_AFTER_CREATE: "CONTROLLER",
  OPERATION_NOT_FOUND: "CONTROLLER", OPERATION_ACK_WRONG_LEAD: "AUTHORITY", AEH_OPERATION_CAPACITY: "CONTROLLER",
  AEH_OPERATION_ACK_REVISION_MISMATCH: "CONTROLLER", LEAD_RECOVERY_AUTHORITY_DENIED: "AUTHORITY",
  LEAD_RECOVERY_ACTION_INVALID: "INPUT", LEAD_RECOVERY_REASON_INVALID: "INPUT", LEAD_RECOVERY_EVIDENCE_REQUIRED: "INPUT",
  LEAD_RECOVERY_BINDING_STALE: "CONTROLLER", LEAD_RECOVERY_EVIDENCE_STALE: "CONTROLLER", SAME_SESSION_RESUME_REJECTED: "CONTROLLER",
  SUPERVISOR_RECOVERY_STATE_STALE: "CONTROLLER", SUPERVISOR_RECOVERY_ACTION_REQUIRED: "INPUT", SUPERVISOR_RECOVERY_BINDING_STALE: "CONTROLLER", SUPERVISOR_RECOVERY_EVIDENCE_REQUIRED: "INPUT", SUPERVISOR_RECOVERY_EVIDENCE_STALE: "CONTROLLER",
  AEH_OPERATION_ACK_EPOCH_MISMATCH: "CONTROLLER", AEH_OPERATION_ACK_ACTOR_MISMATCH: "AUTHORITY"
};
function diagnosticFailureClass(code: string | undefined): OperationToolDiagnosticV2["failureClass"] {
  return code && isOperationToolErrorCode(code) ? diagnosticFailureClasses[code] : "INTERNAL";
}

function safeString(read: () => unknown): string {
  try { const value = read(); return typeof value === "string" ? value : ""; }
  catch { return ""; }
}

async function fingerprintControlRoot(root: string): Promise<string> {
  const canonicalRoot = await fs.realpath(path.resolve(root));
  return createHash("sha256").update(canonicalRoot).digest("hex");
}

function stateHomePath(): string {
  const configured = process.env.XDG_STATE_HOME?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error("XDG_STATE_HOME must be absolute.");
    return path.resolve(configured);
  }
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support");
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData || !path.isAbsolute(localAppData)) throw new Error("No private per-user state directory is configured.");
    return path.resolve(localAppData, "AEH", "State");
  }
  return path.join(os.homedir(), ".local", "state");
}

async function openStoreDirectory(create: boolean): Promise<FileHandle> {
  const directoryFlags = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
  let current = await fs.open(path.parse(path.resolve("/")).root, directoryFlags);
  const uid = process.getuid!();
  const components = [...stateHomePath().split(path.sep).filter(Boolean), ...storePathParts];
  try {
    for (let index = 0; index < components.length; index += 1) {
      const childPath = path.join(descriptorPath(current), components[index]!);
      let created = false;
      if (create) {
        try { await fs.mkdir(childPath, { mode: 0o700 }); created = true; }
        catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
      }
      const next = await fs.open(childPath, directoryFlags);
      const stat = await next.stat();
      if (!stat.isDirectory()) { await next.close(); throw new Error("Operation diagnostic store component is not a directory."); }
      const isStoreDirectory = index === components.length - 1;
      if (isStoreDirectory && (stat.uid !== uid || (stat.mode & 0o777) !== 0o700)) {
        await next.close();
        throw new Error("Operation diagnostic store must be owned by this user and have mode 0700.");
      }
      if (created && isStoreDirectory && (stat.mode & 0o777) !== 0o700) {
        await next.close();
        throw new Error("New operation diagnostic store did not receive mode 0700.");
      }
      await current.close();
      current = next;
    }
    return current;
  } catch (error) {
    await current.close().catch(() => undefined);
    throw error;
  }
}

function descriptorPath(directory: FileHandle): string {
  return `/proc/self/fd/${directory.fd}`;
}

async function writePrivateRecord(filePath: string, serialized: string): Promise<void> {
  const handle = await fs.open(filePath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  let success = false;
  try {
    await handle.chmod(0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o600 || stat.size > maxDiagnosticBytes) {
      throw new Error("Operation diagnostic record failed private file checks.");
    }
    success = true;
  } finally {
    await handle.close();
    if (!success) await fs.unlink(filePath).catch(() => undefined);
  }
}

async function pruneDiagnostics(directoryPath: string, maxRecords: number, now: number): Promise<void> {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const files: Array<{ name: string; modifiedAt: number }> = [];
  for (const entry of entries) {
    if (!uuidPattern.test(entry.name.replace(/\.json$/, "")) || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(directoryPath, entry.name);
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o600 || stat.size > maxDiagnosticBytes) {
      await fs.unlink(filePath);
      continue;
    }
    if (now - stat.mtimeMs > maxDiagnosticAgeMs) {
      await fs.unlink(filePath);
      continue;
    }
    files.push({ name: entry.name, modifiedAt: stat.mtimeMs });
  }
  files.sort((left, right) => right.modifiedAt - left.modifiedAt || right.name.localeCompare(left.name));
  await Promise.all(files.slice(maxRecords).map(({ name }) => fs.unlink(path.join(directoryPath, name))));
}

function parseDiagnostic(text: string): OperationToolDiagnosticV2 | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Partial<OperationToolDiagnosticV2>;
    const keys = Object.keys(value);
    const expectedKeys = ["version", "id", "controlRootFingerprint", "requestCorrelationId", "occurredAt", "tool", "stage", "exceptionClass", "messageOmitted", "errorCode", "failureClass", "stackFrames", "runtime"];
    if (keys.some((key) => !expectedKeys.includes(key)) || expectedKeys.filter((key) => key !== "errorCode").some((key) => !keys.includes(key))) return undefined;
    if (record.version !== 2 || typeof record.id !== "string" || !uuidPattern.test(record.id)
      || typeof record.controlRootFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(record.controlRootFingerprint)
      || typeof record.requestCorrelationId !== "string" || record.requestCorrelationId.length > 200
      || typeof record.occurredAt !== "string" || !Number.isFinite(Date.parse(record.occurredAt))
      || typeof record.tool !== "string" || !allowedTools.has(record.tool)
      || typeof record.exceptionClass !== "string" || !allowedExceptionClasses.has(record.exceptionClass)
      || record.messageOmitted !== true
      || (record.errorCode !== undefined && !isPersistableDiagnosticCode(record.errorCode))
      || !Array.isArray(record.stackFrames) || record.stackFrames.length > 32
      || !record.stackFrames.every((frame) => typeof frame === "string" && frame.length <= 256)
      || !record.runtime || typeof record.runtime !== "object"
      || typeof record.runtime.aehVersion !== "string" || typeof record.runtime.nodeVersion !== "string"
      || typeof record.runtime.platform !== "string" || typeof record.runtime.architecture !== "string") return undefined;
    return record as OperationToolDiagnosticV2;
  } catch {
    return undefined;
  }
}

function isPersistableDiagnosticCode(value: string): boolean {
  return isOperationToolErrorCode(value) || allowedErrnoCodes.has(value);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}
