import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sha256Canonical, sha256Utf8 } from "../core/digest.js";
import { resolveOperationStateRoot } from "../operations/state.js";
import { resolveTelemetryCorrelation } from "../telemetry/identity.js";
import { recordRuntimeSessionTelemetry } from "../telemetry/metrics.js";
const SESSIONS_DIR = ".harness/paseo/sessions";
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const BINDING_ID_PATTERN = /^paseo-binding:[a-f0-9]{64}$/;
const BINDING_STATUS_VALUES = ["ACTIVE", "ARCHIVED", "LOST"];
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
];
const BINDING_FIELDS = new Set([
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
const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;
/** Create the first durable binding for a participant session. Repeating the
 * same complete identity with the same actual Paseo agent is idempotent; any
 * identity change fails closed as stale, and a different actual agent fails
 * closed as a conflict. Callers rebind an existing participant only through
 * `rotatePaseoSessionBinding`. */
export async function bindPaseoSession(root, input) {
    const normalized = normalizeBindingInput(input);
    const file = bindingFile(root, normalized.identity.operationId, normalized.identity.participantId);
    return withBindingLock(file, async () => {
        const stored = await readStoredBinding(file, normalized.identity.operationId, normalized.identity.participantId);
        if (!stored) {
            const at = normalized.now.toISOString();
            const binding = createBinding(normalized, 1, at, at);
            await writeBinding(file, binding);
            await recordSessionTelemetry(root, normalized, "materialized");
            return binding;
        }
        if (!paseoSessionBindingMatches(stored, normalized.identity)) {
            throw bindingError("PASEO_SESSION_BINDING_STALE", `stored session binding for participant '${normalized.identity.participantId}' does not match the requested operation execution revision, participant generation, candidate, blueprint, policy, context, prompt, or controller epoch.`);
        }
        if (stored.paseoAgentId !== normalized.paseoAgentId) {
            throw bindingError("PASEO_SESSION_BINDING_CONFLICT", `stored session binding for participant '${normalized.identity.participantId}' is already bound to Paseo agent '${stored.paseoAgentId}'.`);
        }
        await recordSessionTelemetry(root, normalized, "reused");
        return stored;
    });
}
/** Observation-only runtime session metric bound to current durable identity. */
async function recordSessionTelemetry(root, normalized, event) {
    const correlation = await resolveTelemetryCorrelation(root, normalized.identity.operationId, normalized.identity.participantId);
    if (correlation)
        await recordRuntimeSessionTelemetry(root, undefined, correlation, event);
}
/** Explicit rebind path: always writes a new binding with the next session
 * generation and the complete requested identity, preserving the original
 * createdAt when a binding already exists. */
export async function rotatePaseoSessionBinding(root, input) {
    const normalized = normalizeBindingInput(input);
    const file = bindingFile(root, normalized.identity.operationId, normalized.identity.participantId);
    return withBindingLock(file, async () => {
        const previous = await readStoredBinding(file, normalized.identity.operationId, normalized.identity.participantId);
        const at = normalized.now.toISOString();
        const sessionGeneration = (previous?.sessionGeneration ?? 0) + 1;
        const binding = createBinding(normalized, sessionGeneration, previous?.createdAt ?? at, at);
        await writeBinding(file, binding);
        await recordSessionTelemetry(root, normalized, "rotated");
        return binding;
    });
}
/** Load the durable binding for a participant. Missing bindings return
 * undefined; a present but unreadable, incomplete, or inconsistent record
 * fails closed. */
export async function loadPaseoSessionBinding(root, operationId, participantId) {
    const operation = requiredText(operationId, "operationId");
    const participant = requiredText(participantId, "participantId");
    return readStoredBinding(bindingFile(root, operation, participant), operation, participant);
}
export function assertPaseoSessionBinding(value) {
    const problem = paseoSessionBindingProblem(value);
    if (problem)
        throw bindingError("PASEO_SESSION_BINDING_CORRUPT", problem);
}
/** Deterministic full-identity comparison. Every identity field must be
 * present in the expectation and equal to the durable record; the durable
 * record itself must be integrity-valid. Missing, malformed, or different
 * expectations never match, and no field acts as a wildcard. */
export function paseoSessionBindingMatches(binding, expected) {
    if (paseoSessionBindingProblem(binding) !== undefined)
        return false;
    if (paseoSessionBindingIdentityProblem(expected) !== undefined)
        return false;
    return IDENTITY_FIELDS.every((field) => binding[field] === expected[field]);
}
/** Runtime reuse decision: only an ACTIVE, integrity-valid binding whose
 * complete identity matches exactly may be reused. This function never
 * throws; anything unproven is not reusable. */
export function resolveReusablePaseoSession(binding, expected) {
    if (!binding || binding.status !== "ACTIVE")
        return undefined;
    return paseoSessionBindingMatches(binding, expected) ? binding : undefined;
}
function bindingIdFor(operationId, participantId, sessionGeneration) {
    return `paseo-binding:${sha256Canonical({ operationId, participantId, sessionGeneration })}`;
}
function createBinding(input, sessionGeneration, createdAt, updatedAt) {
    const identity = {
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
function paseoSessionBindingIdentityProblem(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return "binding identity must be an object.";
    const identity = value;
    for (const field of ["projectId", "operationId", "participantId", "participantGeneration"]) {
        if (typeof identity[field] !== "string" || identity[field].trim().length === 0)
            return `binding.${field} must be a non-empty string.`;
    }
    for (const field of ["operationExecutionRevision", "candidateRevision"]) {
        if (!Number.isSafeInteger(identity[field]) || identity[field] < 1)
            return `binding.${field} must be a positive integer.`;
    }
    for (const field of ["candidateDigest", "executionBlueprintDigest", "operationPolicyDigest", "contextManifestDigest", "promptManifestDigest"]) {
        if (typeof identity[field] !== "string" || !DIGEST_PATTERN.test(identity[field]))
            return `binding.${field} must be a lowercase SHA-256 digest.`;
    }
    if (!Number.isSafeInteger(identity.controllerEpoch) || identity.controllerEpoch < 0)
        return "binding.controllerEpoch must be a non-negative integer.";
    return undefined;
}
function paseoSessionBindingProblem(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return "binding must be an object.";
    const binding = value;
    const unsupported = Object.keys(binding).filter((field) => !BINDING_FIELDS.has(field));
    if (unsupported.length)
        return `binding contains unsupported field(s): ${unsupported.sort().join(", ")}.`;
    if (binding.version !== 1)
        return "binding.version must be 1.";
    if (typeof binding.bindingId !== "string" || !BINDING_ID_PATTERN.test(binding.bindingId))
        return "binding.bindingId must be a 'paseo-binding:<digest>' identity.";
    const identityProblem = paseoSessionBindingIdentityProblem(binding);
    if (identityProblem)
        return identityProblem;
    if (typeof binding.paseoAgentId !== "string" || binding.paseoAgentId.trim().length === 0 || binding.paseoAgentId.trim().startsWith("launch:"))
        return "binding.paseoAgentId must be the actual Paseo agent/session id.";
    if (!Number.isSafeInteger(binding.sessionGeneration) || binding.sessionGeneration < 1)
        return "binding.sessionGeneration must be a positive integer.";
    if (typeof binding.status !== "string" || !BINDING_STATUS_VALUES.includes(binding.status))
        return "binding.status must be ACTIVE, ARCHIVED, or LOST.";
    if (!isInstant(binding.createdAt))
        return "binding.createdAt must be a valid instant.";
    if (!isInstant(binding.updatedAt))
        return "binding.updatedAt must be a valid instant.";
    if (typeof binding.bindingDigest !== "string" || !DIGEST_PATTERN.test(binding.bindingDigest))
        return "binding.bindingDigest must be a lowercase SHA-256 digest.";
    const { bindingDigest: _bindingDigest, ...identity } = binding;
    if (_bindingDigest !== sha256Canonical(identity))
        return "binding.bindingDigest does not match the binding identity.";
    if (binding.bindingId !== bindingIdFor(binding.operationId, binding.participantId, binding.sessionGeneration))
        return "binding.bindingId does not match the binding identity.";
    return undefined;
}
async function readStoredBinding(file, operationId, participantId) {
    let raw;
    try {
        raw = await fs.readFile(file, "utf8");
    }
    catch (error) {
        if (isNotFound(error))
            return undefined;
        throw error;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw bindingError("PASEO_SESSION_BINDING_CORRUPT", `persisted binding ${path.basename(file)} is not valid JSON.`);
    }
    const problem = paseoSessionBindingProblem(parsed);
    if (problem)
        throw bindingError("PASEO_SESSION_BINDING_CORRUPT", `persisted binding ${path.basename(file)} is invalid: ${problem}`);
    const binding = parsed;
    if (binding.operationId !== operationId || binding.participantId !== participantId)
        throw bindingError("PASEO_SESSION_BINDING_CORRUPT", `persisted binding ${path.basename(file)} does not match its storage path.`);
    return binding;
}
async function writeBinding(file, binding) {
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(binding, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
        await fs.rename(temp, file);
    }
    finally {
        await fs.rm(temp, { force: true }).catch(() => undefined);
    }
}
function bindingFile(root, operationId, participantId) {
    return path.join(resolveOperationStateRoot(root), SESSIONS_DIR, safeSegment(operationId), `${safeSegment(participantId)}.json`);
}
function safeSegment(value) {
    const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return `${normalized || "binding"}-${sha256Utf8(value.trim()).slice(0, 16)}`;
}
function normalizeBindingInput(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
        throw bindingError("PASEO_SESSION_BINDING_INVALID", "binding input must be an object.");
    const now = input.now ?? new Date();
    if (!(now instanceof Date) || Number.isNaN(now.getTime()))
        throw bindingError("PASEO_SESSION_BINDING_INVALID", "binding input now must be a valid instant.");
    const status = input.status ?? "ACTIVE";
    if (!BINDING_STATUS_VALUES.includes(status))
        throw bindingError("PASEO_SESSION_BINDING_INVALID", `binding input status '${String(status)}' is not ACTIVE, ARCHIVED, or LOST.`);
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
        status: status,
        now
    };
}
function requiredText(value, field) {
    if (typeof value !== "string" || value.trim().length === 0)
        throw bindingError("PASEO_SESSION_BINDING_INVALID", `Paseo session binding ${field} must be a non-empty string.`);
    return value.trim();
}
function requiredInteger(value, field, minimum) {
    if (!Number.isSafeInteger(value) || value < minimum)
        throw bindingError("PASEO_SESSION_BINDING_INVALID", `Paseo session binding ${field} must be an integer of at least ${minimum}.`);
    return value;
}
function requiredDigest(value, field) {
    if (typeof value !== "string" || !DIGEST_PATTERN.test(value))
        throw bindingError("PASEO_SESSION_BINDING_INVALID", `Paseo session binding ${field} must be a lowercase SHA-256 digest.`);
    return value;
}
function requiredAgentId(value) {
    if (typeof value !== "string" || value.trim().length === 0 || value.trim().startsWith("launch:"))
        throw bindingError("PASEO_SESSION_BINDING_INVALID", "Paseo session binding paseoAgentId must be the actual Paseo agent/session id returned by launch.");
    return value.trim();
}
function isInstant(value) {
    return typeof value === "string" && value.trim().length > 0 && !Number.isNaN(new Date(value).getTime());
}
async function withBindingLock(file, action) {
    const lock = `${file}.lock`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
        let handle;
        try {
            handle = await fs.open(lock, "wx");
            try {
                await handle.writeFile(`${process.pid}\n`);
                return await action();
            }
            finally {
                await handle.close().catch(() => undefined);
                await fs.rm(lock, { force: true }).catch(() => undefined);
            }
        }
        catch (error) {
            if (handle) {
                await handle.close().catch(() => undefined);
                await fs.rm(lock, { force: true }).catch(() => undefined);
                throw error;
            }
            if (!isAlreadyExists(error))
                throw error;
            if (await canRecoverLock(lock)) {
                await fs.rm(lock, { force: true }).catch(() => undefined);
                continue;
            }
            if (Date.now() >= deadline)
                throw new Error(`Timed out acquiring Paseo session binding lock for ${path.basename(file)}.`);
            await delay(LOCK_RETRY_MS);
        }
    }
}
async function canRecoverLock(lock) {
    try {
        const [rawPid, stat] = await Promise.all([fs.readFile(lock, "utf8").catch(() => ""), fs.stat(lock)]);
        const ownerPid = Number.parseInt(rawPid.trim(), 10);
        if (Number.isInteger(ownerPid) && ownerPid > 0 && !processAlive(ownerPid))
            return true;
        return Date.now() - stat.mtimeMs > STALE_LOCK_MS;
    }
    catch {
        return true;
    }
}
function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function bindingError(code, message) {
    return new Error(`${code}: ${message}`);
}
function isAlreadyExists(error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}
function isNotFound(error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=sessionBinding.js.map