import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sha256Canonical, sha256Utf8 } from "../core/digest.js";
import { resolveOperationStateRoot } from "../operations/state.js";

/**
 * Durable identity for one Paseo session bound to one operation participant.
 *
 * The binding is a deterministic identity record: it is derived from operation
 * and participant identity plus generation/digest evidence, never from display
 * titles, agent names, mtimes, or session ordering. Paseo agent and workspace
 * ids are recorded as the concrete provider identity the session was created
 * with; reuse decisions are made only by `resolveReusablePaseoSession`.
 */
export interface PaseoSessionBindingV1 {
  version: 1;
  bindingId: string;
  projectId: string;
  operationId: string;
  operationRevision: number;
  participantId: string;
  participantGeneration: number;
  participantPlanDigest?: string;
  executionBlueprintDigest?: string;
  paseoAgentId: string;
  workspaceId?: string;
  sessionGeneration: number;
  status: "ACTIVE" | "ARCHIVED" | "LOST";
  createdAt: string;
  updatedAt: string;
  bindingDigest: string;
}

export interface PaseoSessionBindingInputV1 {
  projectId: string;
  operationId: string;
  operationRevision: number;
  participantId: string;
  participantGeneration: number;
  participantPlanDigest?: string;
  executionBlueprintDigest?: string;
  paseoAgentId: string;
  workspaceId?: string;
  status?: "ACTIVE" | "ARCHIVED" | "LOST";
  now?: Date;
}

const SESSIONS_DIR = ".harness/paseo/sessions";
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const BINDING_ID_PATTERN = /^paseo-binding:[a-f0-9]{64}$/;
const BINDING_STATUS_VALUES = ["ACTIVE", "ARCHIVED", "LOST"] as const;
type BindingStatus = (typeof BINDING_STATUS_VALUES)[number];
const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

interface NormalizedBindingInput {
  projectId: string;
  operationId: string;
  operationRevision: number;
  participantId: string;
  participantGeneration: number;
  participantPlanDigest?: string;
  executionBlueprintDigest?: string;
  paseoAgentId: string;
  workspaceId?: string;
  status: BindingStatus;
  now: Date;
}

/** Create the first durable binding for a participant session. Repeating the
 * same identity with the same Paseo agent is idempotent; a different agent,
 * plan, blueprint, generation, or operation revision fails closed. Callers
 * rebind an existing participant through `rotatePaseoSessionBinding`. */
export async function bindPaseoSession(root: string, input: PaseoSessionBindingInputV1): Promise<PaseoSessionBindingV1> {
  const normalized = normalizeBindingInput(input);
  const file = bindingFile(root, normalized.operationId, normalized.participantId);
  return withBindingLock(file, async () => {
    const stored = await readStoredBinding(file, normalized.operationId, normalized.participantId);
    if (!stored) {
      const at = normalized.now.toISOString();
      const binding = createBinding(normalized, 1, at, at);
      await writeBinding(file, binding);
      return binding;
    }
    if (!paseoSessionBindingMatches(stored, {
      operationId: normalized.operationId,
      participantId: normalized.participantId,
      participantGeneration: normalized.participantGeneration,
      participantPlanDigest: normalized.participantPlanDigest,
      executionBlueprintDigest: normalized.executionBlueprintDigest,
      operationRevision: normalized.operationRevision
    })) {
      throw bindingError("PASEO_SESSION_BINDING_STALE", `stored session binding for participant '${normalized.participantId}' does not match the requested participant generation, plan digest, blueprint digest, or operation revision.`);
    }
    if (stored.paseoAgentId !== normalized.paseoAgentId) {
      throw bindingError("PASEO_SESSION_BINDING_CONFLICT", `stored session binding for participant '${normalized.participantId}' is already bound to Paseo agent '${stored.paseoAgentId}'.`);
    }
    return stored;
  });
}

/** Explicit rebind path: always writes a new binding with the next session
 * generation, preserving the original createdAt when a binding already exists. */
export async function rotatePaseoSessionBinding(root: string, input: PaseoSessionBindingInputV1): Promise<PaseoSessionBindingV1> {
  const normalized = normalizeBindingInput(input);
  const file = bindingFile(root, normalized.operationId, normalized.participantId);
  return withBindingLock(file, async () => {
    const previous = await readStoredBinding(file, normalized.operationId, normalized.participantId);
    const at = normalized.now.toISOString();
    const sessionGeneration = (previous?.sessionGeneration ?? 0) + 1;
    const binding = createBinding(normalized, sessionGeneration, previous?.createdAt ?? at, at);
    await writeBinding(file, binding);
    return binding;
  });
}

/** Load the durable binding for a participant. Missing bindings return
 * undefined; a present but unreadable or inconsistent record fails closed. */
export async function loadPaseoSessionBinding(root: string, operationId: string, participantId: string): Promise<PaseoSessionBindingV1 | undefined> {
  const operation = requiredText(operationId, "operationId");
  const participant = requiredText(participantId, "participantId");
  return readStoredBinding(bindingFile(root, operation, participant), operation, participant);
}

export function assertPaseoSessionBinding(value: unknown): asserts value is PaseoSessionBindingV1 {
  const problem = paseoSessionBindingProblem(value);
  if (problem) throw bindingError("PASEO_SESSION_BINDING_CORRUPT", problem);
}

/** Deterministic identity/digest comparison. Display strings are never
 * compared; omitted optional expectations act as wildcards, while provided
 * digests, generation, and operation revision must match exactly. */
export function paseoSessionBindingMatches(
  binding: PaseoSessionBindingV1,
  expected: Pick<PaseoSessionBindingInputV1, "operationId" | "participantId" | "participantGeneration" | "participantPlanDigest" | "executionBlueprintDigest"> & { operationRevision?: number }
): boolean {
  if (paseoSessionBindingProblem(binding) !== undefined) return false;
  if (!expected || typeof expected !== "object") return false;
  if (binding.operationId !== expected.operationId) return false;
  if (binding.participantId !== expected.participantId) return false;
  if (binding.participantGeneration !== expected.participantGeneration) return false;
  if (expected.operationRevision !== undefined && binding.operationRevision !== expected.operationRevision) return false;
  if (expected.participantPlanDigest !== undefined && binding.participantPlanDigest !== expected.participantPlanDigest) return false;
  if (expected.executionBlueprintDigest !== undefined && binding.executionBlueprintDigest !== expected.executionBlueprintDigest) return false;
  return true;
}

/** Runtime reuse decision: only an ACTIVE binding whose identity matches may
 * be reused. This function never throws; anything unproven is not reusable. */
export function resolveReusablePaseoSession(
  binding: PaseoSessionBindingV1 | undefined,
  expected: Parameters<typeof paseoSessionBindingMatches>[1]
): PaseoSessionBindingV1 | undefined {
  if (!binding || binding.status !== "ACTIVE") return undefined;
  return paseoSessionBindingMatches(binding, expected) ? binding : undefined;
}

function bindingIdFor(operationId: string, participantId: string, sessionGeneration: number): string {
  return `paseo-binding:${sha256Canonical({ operationId, participantId, sessionGeneration })}`;
}

function createBinding(input: NormalizedBindingInput, sessionGeneration: number, createdAt: string, updatedAt: string): PaseoSessionBindingV1 {
  const identity: Omit<PaseoSessionBindingV1, "bindingDigest"> = {
    version: 1,
    bindingId: bindingIdFor(input.operationId, input.participantId, sessionGeneration),
    projectId: input.projectId,
    operationId: input.operationId,
    operationRevision: input.operationRevision,
    participantId: input.participantId,
    participantGeneration: input.participantGeneration,
    ...(input.participantPlanDigest ? { participantPlanDigest: input.participantPlanDigest } : {}),
    ...(input.executionBlueprintDigest ? { executionBlueprintDigest: input.executionBlueprintDigest } : {}),
    paseoAgentId: input.paseoAgentId,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    sessionGeneration,
    status: input.status,
    createdAt,
    updatedAt
  };
  return { ...identity, bindingDigest: sha256Canonical(identity) };
}

function paseoSessionBindingProblem(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "binding must be an object.";
  const binding = value as Record<string, unknown>;
  if (binding.version !== 1) return "binding.version must be 1.";
  if (typeof binding.bindingId !== "string" || !BINDING_ID_PATTERN.test(binding.bindingId)) return "binding.bindingId must be a 'paseo-binding:<digest>' identity.";
  for (const field of ["projectId", "operationId", "participantId", "paseoAgentId"]) {
    if (typeof binding[field] !== "string" || (binding[field] as string).trim().length === 0) return `binding.${field} must be a non-empty string.`;
  }
  for (const field of ["operationRevision", "participantGeneration", "sessionGeneration"]) {
    if (!Number.isSafeInteger(binding[field]) || (binding[field] as number) < 0) return `binding.${field} must be a non-negative integer.`;
  }
  for (const field of ["participantPlanDigest", "executionBlueprintDigest"]) {
    const digest = binding[field];
    if (digest !== undefined && (typeof digest !== "string" || !DIGEST_PATTERN.test(digest))) return `binding.${field} must be a lowercase SHA-256 digest when present.`;
  }
  if (binding.workspaceId !== undefined && (typeof binding.workspaceId !== "string" || binding.workspaceId.trim().length === 0)) return "binding.workspaceId must be a non-empty string when present.";
  if (typeof binding.status !== "string" || !(BINDING_STATUS_VALUES as readonly string[]).includes(binding.status)) return "binding.status must be ACTIVE, ARCHIVED, or LOST.";
  if (!isInstant(binding.createdAt)) return "binding.createdAt must be a valid instant.";
  if (!isInstant(binding.updatedAt)) return "binding.updatedAt must be a valid instant.";
  if (typeof binding.bindingDigest !== "string" || !DIGEST_PATTERN.test(binding.bindingDigest)) return "binding.bindingDigest must be a lowercase SHA-256 digest.";
  const { bindingDigest: _bindingDigest, ...identity } = binding;
  if (_bindingDigest !== sha256Canonical(identity)) return "binding.bindingDigest does not match the binding identity.";
  if (binding.bindingId !== bindingIdFor(binding.operationId as string, binding.participantId as string, binding.sessionGeneration as number)) return "binding.bindingId does not match the binding identity.";
  return undefined;
}

async function readStoredBinding(file: string, operationId: string, participantId: string): Promise<PaseoSessionBindingV1 | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw bindingError("PASEO_SESSION_BINDING_CORRUPT", `persisted binding ${path.basename(file)} is not valid JSON.`);
  }
  const problem = paseoSessionBindingProblem(parsed);
  if (problem) throw bindingError("PASEO_SESSION_BINDING_CORRUPT", `persisted binding ${path.basename(file)} is invalid: ${problem}`);
  const binding = parsed as PaseoSessionBindingV1;
  if (binding.operationId !== operationId || binding.participantId !== participantId) throw bindingError("PASEO_SESSION_BINDING_CORRUPT", `persisted binding ${path.basename(file)} does not match its storage path.`);
  return binding;
}

async function writeBinding(file: string, binding: PaseoSessionBindingV1): Promise<void> {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(binding, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

function bindingFile(root: string, operationId: string, participantId: string): string {
  return path.join(resolveOperationStateRoot(root), SESSIONS_DIR, safeSegment(operationId), `${safeSegment(participantId)}.json`);
}

function safeSegment(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${normalized || "binding"}-${sha256Utf8(value.trim()).slice(0, 16)}`;
}

function normalizeBindingInput(input: PaseoSessionBindingInputV1): NormalizedBindingInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bindingError("PASEO_SESSION_BINDING_INVALID", "binding input must be an object.");
  const now = input.now ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw bindingError("PASEO_SESSION_BINDING_INVALID", "binding input now must be a valid instant.");
  const status = input.status ?? "ACTIVE";
  if (!(BINDING_STATUS_VALUES as readonly string[]).includes(status)) throw bindingError("PASEO_SESSION_BINDING_INVALID", `binding input status '${String(status)}' is not ACTIVE, ARCHIVED, or LOST.`);
  return {
    projectId: requiredText(input.projectId, "projectId"),
    operationId: requiredText(input.operationId, "operationId"),
    operationRevision: requiredInteger(input.operationRevision, "operationRevision"),
    participantId: requiredText(input.participantId, "participantId"),
    participantGeneration: requiredInteger(input.participantGeneration, "participantGeneration"),
    participantPlanDigest: optionalDigest(input.participantPlanDigest, "participantPlanDigest"),
    executionBlueprintDigest: optionalDigest(input.executionBlueprintDigest, "executionBlueprintDigest"),
    paseoAgentId: requiredText(input.paseoAgentId, "paseoAgentId"),
    workspaceId: optionalText(input.workspaceId, "workspaceId"),
    status: status as BindingStatus,
    now
  };
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw bindingError("PASEO_SESSION_BINDING_INVALID", `Paseo session binding ${field} must be a non-empty string.`);
  return value.trim();
}

function requiredInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw bindingError("PASEO_SESSION_BINDING_INVALID", `Paseo session binding ${field} must be a non-negative integer.`);
  return value as number;
}

function optionalDigest(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) throw bindingError("PASEO_SESSION_BINDING_INVALID", `Paseo session binding ${field} must be a lowercase SHA-256 digest when provided.`);
  return value;
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) throw bindingError("PASEO_SESSION_BINDING_INVALID", `Paseo session binding ${field} must be a non-empty string when provided.`);
  return value.trim();
}

function isInstant(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !Number.isNaN(new Date(value).getTime());
}

async function withBindingLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  await fs.mkdir(path.dirname(file), { recursive: true });
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
      if (handle) {
        await handle.close().catch(() => undefined);
        await fs.rm(lock, { force: true }).catch(() => undefined);
        throw error;
      }
      if (!isAlreadyExists(error)) throw error;
      if (await canRecoverLock(lock)) {
        await fs.rm(lock, { force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring Paseo session binding lock for ${path.basename(file)}.`);
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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function bindingError(code: string, message: string): Error {
  return new Error(`${code}: ${message}`);
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EEXIST");
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
