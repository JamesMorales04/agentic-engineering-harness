import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sha256Canonical, sha256Utf8 } from "../core/digest.js";
import { resolveOperationStateRoot } from "../operations/state.js";

export type PaseoSessionBindingStatusV1 = "ACTIVE" | "ARCHIVED" | "LOST";

/**
 * Complete deterministic identity for one Paseo session bound to one operation
 * participant at one execution revision.
 *
 * Every field is required and compared exactly: operation execution revision,
 * project, participant and participant generation, candidate revision and
 * digest, frozen ExecutionBlueprint, frozen resolved operation policy,
 * ContextManifest, PromptManifest, and controller epoch. There are no optional
 * or wildcard expectations: a missing or different value is never reusable.
 * The identity is derived only from frozen execution evidence, never from
 * display titles, agent names, mtimes, or session ordering.
 */
export interface PaseoSessionBindingIdentityV1 {
  projectId: string;
  operationId: string;
  operationExecutionRevision: number;
  participantId: string;
  participantGeneration: string;
  candidateRevision: number;
  candidateDigest: string;
  executionBlueprintDigest: string;
  operationPolicyDigest: string;
  contextManifestDigest: string;
  promptManifestDigest: string;
  controllerEpoch: number;
}

/**
 * Durable binding record for one Paseo session. `paseoAgentId` is the actual
 * Paseo agent/session id returned by launch and is required record integrity
 * evidence; `sessionGeneration`, `status`, and timestamps describe the record
 * lifecycle. The record is immutable identity evidence and grants no tools,
 * authority, mutation, or capabilities. Reuse decisions are made only by
 * `resolveReusablePaseoSession`.
 */
export interface PaseoSessionBindingV1 extends PaseoSessionBindingIdentityV1 {
  version: 1;
  bindingId: string;
  paseoAgentId: string;
  sessionGeneration: number;
  status: PaseoSessionBindingStatusV1;
  createdAt: string;
  updatedAt: string;
  bindingDigest: string;
}

export interface PaseoSessionBindingInputV1 extends PaseoSessionBindingIdentityV1 {
  paseoAgentId: string;
  status?: PaseoSessionBindingStatusV1;
  now?: Date;
}

const SESSIONS_DIR = ".harness/paseo/sessions";
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const BINDING_ID_PATTERN = /^paseo-binding:[a-f0-9]{64}$/;
const BINDING_STATUS_VALUES = ["ACTIVE", "ARCHIVED", "LOST"] as const;
const IDENTITY_FIELDS = [
  "projectId",
  "operationId",
  "operationExecutionRevision",
  "participantId",
  "participantGeneration",
  "candidateRevision",
  "candidateDigest",
  "executionBlueprintDigest",
  "operationPolicyDigest",
  "contextManifestDigest",
  "promptManifestDigest",
  "controllerEpoch"
] as const satisfies readonly (keyof PaseoSessionBindingIdentityV1)[];
const BINDING_FIELDS: ReadonlySet<string> = new Set<string>([
  "version",
  "bindingId",
  ...IDENTITY_FIELDS,
  "paseoAgentId",
  "sessionGeneration",
  "status",
  "createdAt",
  "updatedAt",
  "bindingDigest"
]);
type BindingStatus = (typeof BINDING_STATUS_VALUES)[number];
const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

interface NormalizedBindingInput {
  identity: PaseoSessionBindingIdentityV1;
  paseoAgentId: string;
  status: BindingStatus;
  now: Date;
}

/** Create the first durable binding for a participant session. Repeating the
 * same complete identity with the same actual Paseo agent is idempotent; any
 * identity change fails closed as stale, and a different actual agent fails
 * closed as a conflict. Callers rebind an existing participant only through
 * `rotatePaseoSessionBinding`. */
export async function bindPaseoSession(root: string, input: PaseoSessionBindingInputV1): Promise<PaseoSessionBindingV1> {
  const normalized = normalizeBindingInput(input);
  const file = bindingFile(root, normalized.identity.operationId, normalized.identity.participantId);
  return withBindingLock(file, async () => {
    const stored = await readStoredBinding(file, normalized.identity.operationId, normalized.identity.participantId);
    if (!stored) {
      const at = normalized.now.toISOString();
      const binding = createBinding(normalized, 1, at, at);
      await writeBinding(file, binding);
      return binding;
    }
    if (!paseoSessionBindingMatches(stored, normalized.identity)) {
      throw bindingError("PASEO_SESSION_BINDING_STALE", `stored session binding for participant '${normalized.identity.participantId}' does not match the requested operation execution revision, participant generation, candidate, blueprint, policy, context, prompt, or controller epoch.`);
    }
    if (stored.paseoAgentId !== normalized.paseoAgentId) {
      throw bindingError("PASEO_SESSION_BINDING_CONFLICT", `stored session binding for participant '${normalized.identity.participantId}' is already bound to Paseo agent '${stored.paseoAgentId}'.`);
    }
    return stored;
  });
}

/** Explicit rebind path: always writes a new binding with the next session
 * generation and the complete requested identity, preserving the original
 * createdAt when a binding already exists. */
export async function rotatePaseoSessionBinding(root: string, input: PaseoSessionBindingInputV1): Promise<PaseoSessionBindingV1> {
  const normalized = normalizeBindingInput(input);
  const file = bindingFile(root, normalized.identity.operationId, normalized.identity.participantId);
  return withBindingLock(file, async () => {
    const previous = await readStoredBinding(file, normalized.identity.operationId, normalized.identity.participantId);
    const at = normalized.now.toISOString();
    const sessionGeneration = (previous?.sessionGeneration ?? 0) + 1;
    const binding = createBinding(normalized, sessionGeneration, previous?.createdAt ?? at, at);
    await writeBinding(file, binding);
    return binding;
  });
}

/** Load the durable binding for a participant. Missing bindings return
 * undefined; a present but unreadable, incomplete, or inconsistent record
 * fails closed. */
export async function loadPaseoSessionBinding(root: string, operationId: string, participantId: string): Promise<PaseoSessionBindingV1 | undefined> {
  const operation = requiredText(operationId, "operationId");
  const participant = requiredText(participantId, "participantId");
  return readStoredBinding(bindingFile(root, operation, participant), operation, participant);
}

export function assertPaseoSessionBinding(value: unknown): asserts value is PaseoSessionBindingV1 {
  const problem = paseoSessionBindingProblem(value);
  if (problem) throw bindingError("PASEO_SESSION_BINDING_CORRUPT", problem);
}

/** Deterministic full-identity comparison. Every identity field must be
 * present in the expectation and equal to the durable record; the durable
 * record itself must be integrity-valid. Missing, malformed, or different
 * expectations never match, and no field acts as a wildcard. */
export function paseoSessionBindingMatches(binding: PaseoSessionBindingV1, expected: PaseoSessionBindingIdentityV1): boolean {
  if (paseoSessionBindingProblem(binding) !== undefined) return false;
  if (paseoSessionBindingIdentityProblem(expected) !== undefined) return false;
  return IDENTITY_FIELDS.every((field) => binding[field] === expected[field]);
}

/** Runtime reuse decision: only an ACTIVE, integrity-valid binding whose
 * complete identity matches exactly may be reused. This function never
 * throws; anything unproven is not reusable. */
export function resolveReusablePaseoSession(
  binding: PaseoSessionBindingV1 | undefined,
  expected: PaseoSessionBindingIdentityV1
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
    bindingId: bindingIdFor(input.identity.operationId, input.identity.participantId, sessionGeneration),
    ...input.identity,
    paseoAgentId: input.paseoAgentId,
    sessionGeneration,
    status: input.status,
    createdAt,
    updatedAt
  };
  return { ...identity, bindingDigest: sha256Canonical(identity) };
}

function paseoSessionBindingIdentityProblem(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "binding identity must be an object.";
  const identity = value as Record<string, unknown>;
  for (const field of ["projectId", "operationId", "participantId", "participantGeneration"]) {
    if (typeof identity[field] !== "string" || (identity[field] as string).trim().length === 0) return `binding.${field} must be a non-empty string.`;
  }
  for (const field of ["operationExecutionRevision", "candidateRevision"]) {
    if (!Number.isSafeInteger(identity[field]) || (identity[field] as number) < 1) return `binding.${field} must be a positive integer.`;
  }
  for (const field of ["candidateDigest", "executionBlueprintDigest", "operationPolicyDigest", "contextManifestDigest", "promptManifestDigest"]) {
    if (typeof identity[field] !== "string" || !DIGEST_PATTERN.test(identity[field] as string)) return `binding.${field} must be a lowercase SHA-256 digest.`;
  }
  if (!Number.isSafeInteger(identity.controllerEpoch) || (identity.controllerEpoch as number) < 0) return "binding.controllerEpoch must be a non-negative integer.";
  return undefined;
}

function paseoSessionBindingProblem(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "binding must be an object.";
  const binding = value as Record<string, unknown>;
  const unsupported = Object.keys(binding).filter((field) => !BINDING_FIELDS.has(field));
  if (unsupported.length) return `binding contains unsupported field(s): ${unsupported.sort().join(", ")}.`;
  if (binding.version !== 1) return "binding.version must be 1.";
  if (typeof binding.bindingId !== "string" || !BINDING_ID_PATTERN.test(binding.bindingId)) return "binding.bindingId must be a 'paseo-binding:<digest>' identity.";
  const identityProblem = paseoSessionBindingIdentityProblem(binding);
  if (identityProblem) return identityProblem;
  if (typeof binding.paseoAgentId !== "string" || binding.paseoAgentId.trim().length === 0 || binding.paseoAgentId.trim().startsWith("launch:")) return "binding.paseoAgentId must be the actual Paseo agent/session id.";
  if (!Number.isSafeInteger(binding.sessionGeneration) || (binding.sessionGeneration as number) < 1) return "binding.sessionGeneration must be a positive integer.";
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
    identity: {
      projectId: requiredText(input.projectId, "projectId"),
      operationId: requiredText(input.operationId, "operationId"),
      operationExecutionRevision: requiredInteger(input.operationExecutionRevision, "operationExecutionRevision", 1),
      participantId: requiredText(input.participantId, "participantId"),
      participantGeneration: requiredText(input.participantGeneration, "participantGeneration"),
      candidateRevision: requiredInteger(input.candidateRevision, "candidateRevision", 1),
      candidateDigest: requiredDigest(input.candidateDigest, "candidateDigest"),
      executionBlueprintDigest: requiredDigest(input.executionBlueprintDigest, "executionBlueprintDigest"),
      operationPolicyDigest: requiredDigest(input.operationPolicyDigest, "operationPolicyDigest"),
      contextManifestDigest: requiredDigest(input.contextManifestDigest, "contextManifestDigest"),
      promptManifestDigest: requiredDigest(input.promptManifestDigest, "promptManifestDigest"),
      controllerEpoch: requiredInteger(input.controllerEpoch, "controllerEpoch", 0)
    },
    paseoAgentId: requiredAgentId(input.paseoAgentId),
    status: status as BindingStatus,
    now
  };
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw bindingError("PASEO_SESSION_BINDING_INVALID", `Paseo session binding ${field} must be a non-empty string.`);
  return value.trim();
}

function requiredInteger(value: unknown, field: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw bindingError("PASEO_SESSION_BINDING_INVALID", `Paseo session binding ${field} must be an integer of at least ${minimum}.`);
  return value as number;
}

function requiredDigest(value: unknown, field: string): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) throw bindingError("PASEO_SESSION_BINDING_INVALID", `Paseo session binding ${field} must be a lowercase SHA-256 digest.`);
  return value;
}

function requiredAgentId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().startsWith("launch:")) throw bindingError("PASEO_SESSION_BINDING_INVALID", "Paseo session binding paseoAgentId must be the actual Paseo agent/session id returned by launch.");
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
