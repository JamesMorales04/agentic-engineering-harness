import crypto from "node:crypto";
import { currentOperationContext, loadOperation } from "../operations/state.js";
import { getBuildIdentity } from "../build/identity.js";
/**
 * Telemetry identity is observation-only. Every trace event, span, metric
 * point, and eval run that belongs to a governed operation carries the current
 * candidate/execution identity so joins are stable and stale attribution is
 * detectable. This module grants no authority and mutates no product state.
 */
export const TELEMETRY_CORRELATION_VERSION = 1;
const DOMAIN = "aeh.telemetry.correlation.v1";
/** Canonical flattened attribute keys used by every telemetry signal. */
export const TELEMETRY_CORRELATION_KEYS = {
    version: "aeh.telemetry.correlation.version",
    digest: "aeh.telemetry.correlation.digest",
    operationId: "aeh.operation.id",
    candidateId: "aeh.candidate.id",
    candidateRevision: "aeh.candidate.revision",
    candidateSourceDigest: "aeh.candidate.source_digest",
    candidateIdentityDigest: "aeh.candidate.identity_digest",
    operationExecutionRevision: "aeh.execution.revision",
    policyDigest: "aeh.policy.digest",
    controllerEpoch: "aeh.controller.epoch",
    participantId: "aeh.participant.id",
    participantGeneration: "aeh.participant.generation",
    participantRole: "aeh.participant.role",
    runtimeName: "aeh.runtime.name",
    runtimeSessionId: "aeh.runtime.session.id",
    buildReleaseId: "aeh.build.release.id",
    buildDigest: "aeh.build.digest"
};
/** Build a validated correlation value. Missing required identity fails closed. */
export function buildTelemetryCorrelationV1(input) {
    if (!input.operationId.trim())
        throw new Error("TELEMETRY_IDENTITY_INVALID: operationId is required.");
    if (!input.candidate.candidateId.trim())
        throw new Error("TELEMETRY_IDENTITY_INVALID: candidateId is required.");
    if (!Number.isSafeInteger(input.candidate.revision) || input.candidate.revision < 1)
        throw new Error("TELEMETRY_IDENTITY_INVALID: candidate revision must be a positive safe integer.");
    if (!/^[a-f0-9]{64}$/.test(input.candidate.sourceDigest))
        throw new Error("TELEMETRY_IDENTITY_INVALID: candidate source digest must be a lowercase SHA-256 digest.");
    if (!/^[a-f0-9]{64}$/.test(input.candidate.identityDigest))
        throw new Error("TELEMETRY_IDENTITY_INVALID: candidate identity digest must be a lowercase SHA-256 digest.");
    if (!Number.isSafeInteger(input.operationExecutionRevision) || input.operationExecutionRevision < 1)
        throw new Error("TELEMETRY_IDENTITY_INVALID: operationExecutionRevision must be a positive safe integer.");
    if (!Number.isSafeInteger(input.controllerEpoch) || input.controllerEpoch < 0)
        throw new Error("TELEMETRY_IDENTITY_INVALID: controllerEpoch must be a non-negative safe integer.");
    if (input.policyDigest !== undefined && !/^[a-f0-9]{64}$/.test(input.policyDigest))
        throw new Error("TELEMETRY_IDENTITY_INVALID: policy digest must be a lowercase SHA-256 digest.");
    return {
        version: TELEMETRY_CORRELATION_VERSION,
        operationId: input.operationId,
        candidateId: input.candidate.candidateId,
        candidateRevision: input.candidate.revision,
        candidateSourceDigest: input.candidate.sourceDigest,
        candidateIdentityDigest: input.candidate.identityDigest,
        operationExecutionRevision: input.operationExecutionRevision,
        controllerEpoch: input.controllerEpoch,
        policyDigest: input.policyDigest,
        participantId: input.participantId,
        participantGeneration: input.participantGeneration,
        participantRole: input.participantRole,
        runtimeName: input.runtimeName,
        runtimeSessionId: input.runtimeSessionId,
        buildReleaseId: input.buildReleaseId,
        buildDigest: input.buildDigest
    };
}
/**
 * Derive the current telemetry correlation from durable operation state.
 * Returns undefined when the record has no current candidate or no execution
 * revision; identity is never invented.
 */
export function deriveTelemetryCorrelation(record, options = {}) {
    const candidate = record.candidateRevision;
    const executionRevision = record.operationExecutionRevision;
    if (!candidate || !Number.isSafeInteger(executionRevision) || executionRevision < 1)
        return undefined;
    const participantId = options.participantId?.trim() || undefined;
    const participant = participantId ? record.participants?.[participantId] : undefined;
    const binding = participant?.executionBinding;
    const build = getBuildIdentity();
    return buildTelemetryCorrelationV1({
        operationId: record.id,
        candidate,
        operationExecutionRevision: executionRevision,
        controllerEpoch: record.controller?.epoch ?? 0,
        policyDigest: record.resolvedOperationPolicy?.digest,
        participantId,
        participantGeneration: binding?.participantGeneration ?? (participant ? participant.parentSupervisorGeneration?.toString() : undefined),
        participantRole: participant?.role ?? participant?.logicalAgent,
        runtimeName: binding?.runtime.runtimeId,
        runtimeSessionId: binding?.runtime.sessionId,
        buildReleaseId: build.releaseId,
        buildDigest: build.buildDigest
    });
}
/** Resolve the current durable operation identity for a telemetry emission point. */
export async function resolveTelemetryCorrelation(root, operationId, participantId) {
    const id = operationId?.trim() || currentOperationContext().id;
    if (!id)
        return undefined;
    try {
        return deriveTelemetryCorrelation(await loadOperation(root, id), { participantId });
    }
    catch {
        return undefined;
    }
}
/**
 * Compare supplied telemetry identity against current durable truth. The
 * returned violation is observation-only data; it never mutates operation
 * state and cannot grant or remove authority.
 */
export function detectTelemetryIdentityViolation(current, supplied) {
    const suppliedDigest = telemetryCorrelationDigest(supplied);
    if (!current)
        return { version: 1, kind: "TELEMETRY_IDENTITY_UNRESOLVED", suppliedDigest, mismatches: [] };
    const check = verifyTelemetryCorrelation(current, supplied);
    if (check.ok)
        return undefined;
    return { version: 1, kind: "TELEMETRY_IDENTITY_MISMATCH", suppliedDigest, currentDigest: telemetryCorrelationDigest(current), mismatches: check.mismatches };
}
/** Canonical JSON body over defined correlation fields, sorted by key. */
export function telemetryCorrelationCanonicalBody(correlation) {
    const body = {};
    for (const [key, value] of Object.entries(correlation)) {
        if (value === undefined || key === "version")
            continue;
        body[key] = typeof value === "number" ? value : String(value);
    }
    return Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b)));
}
/** Domain-separated digest binding every identity field of the correlation. */
export function telemetryCorrelationDigest(correlation) {
    const payload = JSON.stringify({ domain: DOMAIN, version: correlation.version, body: telemetryCorrelationCanonicalBody(correlation) });
    return crypto.createHash("sha256").update(payload).digest("hex");
}
/** Flatten a correlation into canonical telemetry attribute keys. */
export function telemetryCorrelationAttributes(correlation) {
    const attributes = {
        [TELEMETRY_CORRELATION_KEYS.version]: correlation.version,
        [TELEMETRY_CORRELATION_KEYS.digest]: telemetryCorrelationDigest(correlation),
        [TELEMETRY_CORRELATION_KEYS.operationId]: correlation.operationId,
        [TELEMETRY_CORRELATION_KEYS.candidateId]: correlation.candidateId,
        [TELEMETRY_CORRELATION_KEYS.candidateRevision]: correlation.candidateRevision,
        [TELEMETRY_CORRELATION_KEYS.candidateSourceDigest]: correlation.candidateSourceDigest,
        [TELEMETRY_CORRELATION_KEYS.candidateIdentityDigest]: correlation.candidateIdentityDigest,
        [TELEMETRY_CORRELATION_KEYS.operationExecutionRevision]: correlation.operationExecutionRevision,
        [TELEMETRY_CORRELATION_KEYS.controllerEpoch]: correlation.controllerEpoch
    };
    if (correlation.policyDigest)
        attributes[TELEMETRY_CORRELATION_KEYS.policyDigest] = correlation.policyDigest;
    if (correlation.participantId)
        attributes[TELEMETRY_CORRELATION_KEYS.participantId] = correlation.participantId;
    if (correlation.participantGeneration)
        attributes[TELEMETRY_CORRELATION_KEYS.participantGeneration] = correlation.participantGeneration;
    if (correlation.participantRole)
        attributes[TELEMETRY_CORRELATION_KEYS.participantRole] = correlation.participantRole;
    if (correlation.runtimeName)
        attributes[TELEMETRY_CORRELATION_KEYS.runtimeName] = correlation.runtimeName;
    if (correlation.runtimeSessionId)
        attributes[TELEMETRY_CORRELATION_KEYS.runtimeSessionId] = correlation.runtimeSessionId;
    if (correlation.buildReleaseId)
        attributes[TELEMETRY_CORRELATION_KEYS.buildReleaseId] = correlation.buildReleaseId;
    if (correlation.buildDigest)
        attributes[TELEMETRY_CORRELATION_KEYS.buildDigest] = correlation.buildDigest;
    return attributes;
}
/**
 * Compare an observed/supplied correlation against the current durable
 * correlation. Every present expected key must match exactly; a missing or
 * different value is a mismatch. Stale candidate, revision, execution,
 * policy, epoch, participant, and session attribution are all detectable.
 */
export function verifyTelemetryCorrelation(actual, expected) {
    if (!actual)
        return { ok: false, mismatches: [{ key: TELEMETRY_CORRELATION_KEYS.digest, expected: telemetryCorrelationDigest(expected), actual: undefined }] };
    const mismatches = [];
    const keys = Object.keys(expected);
    for (const key of keys) {
        const expectedValue = expected[key];
        if (expectedValue === undefined)
            continue;
        const actualValue = actual[key];
        if (actualValue !== expectedValue)
            mismatches.push({ key, expected: expectedValue, actual: actualValue });
    }
    return { ok: mismatches.length === 0, mismatches };
}
/** Participant identity projection for tests and non-operation surfaces. */
export function participantCorrelationKey(participant) {
    return {
        participantGeneration: participant.executionBinding?.participantGeneration,
        runtimeName: participant.executionBinding?.runtime.runtimeId,
        runtimeSessionId: participant.executionBinding?.runtime.sessionId
    };
}
//# sourceMappingURL=identity.js.map