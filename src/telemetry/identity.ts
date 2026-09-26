import crypto from "node:crypto";
import { currentOperationContext, loadOperation, type OperationParticipantRecord, type OperationRecordV2 } from "../operations/state.js";
import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { getBuildIdentity } from "../build/identity.js";

/**
 * Telemetry identity is observation-only. Every trace event, span, metric
 * point, and eval run that belongs to a governed operation carries the current
 * candidate/execution identity so joins are stable and stale attribution is
 * detectable. This module grants no authority and mutates no product state.
 */
export const TELEMETRY_CORRELATION_VERSION = 1;

export interface TelemetryCorrelationV1 {
  version: typeof TELEMETRY_CORRELATION_VERSION;
  operationId: string;
  candidateId: string;
  candidateRevision: number;
  candidateSourceDigest: string;
  candidateIdentityDigest: string;
  operationExecutionRevision: number;
  controllerEpoch: number;
  policyDigest?: string;
  participantId?: string;
  participantGeneration?: string;
  participantRole?: string;
  runtimeName?: string;
  runtimeSessionId?: string;
  buildReleaseId?: string;
  buildDigest?: string;
}

export interface TelemetryCorrelationInput {
  operationId: string;
  candidate: Pick<CandidateRevisionV1, "candidateId" | "revision" | "sourceDigest" | "identityDigest">;
  operationExecutionRevision: number;
  controllerEpoch: number;
  policyDigest?: string;
  participantId?: string;
  participantGeneration?: string;
  participantRole?: string;
  runtimeName?: string;
  runtimeSessionId?: string;
  buildReleaseId?: string;
  buildDigest?: string;
}

export interface TelemetryIdentityMismatch {
  key: string;
  expected: string | number | undefined;
  actual: string | number | undefined;
}

/** Explicit marker recorded when supplied identity does not match current durable truth. */
export interface TelemetryIdentityViolationV1 {
  version: 1;
  kind: "TELEMETRY_IDENTITY_MISMATCH" | "TELEMETRY_IDENTITY_UNRESOLVED";
  suppliedDigest: string;
  currentDigest?: string;
  mismatches: TelemetryIdentityMismatch[];
}

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
} as const;

/** Build a validated correlation value. Missing required identity fails closed. */
export function buildTelemetryCorrelationV1(input: TelemetryCorrelationInput): TelemetryCorrelationV1 {
  if (!input.operationId.trim()) throw new Error("TELEMETRY_IDENTITY_INVALID: operationId is required.");
  if (!input.candidate.candidateId.trim()) throw new Error("TELEMETRY_IDENTITY_INVALID: candidateId is required.");
  if (!Number.isSafeInteger(input.candidate.revision) || input.candidate.revision < 1) throw new Error("TELEMETRY_IDENTITY_INVALID: candidate revision must be a positive safe integer.");
  if (!/^[a-f0-9]{64}$/.test(input.candidate.sourceDigest)) throw new Error("TELEMETRY_IDENTITY_INVALID: candidate source digest must be a lowercase SHA-256 digest.");
  if (!/^[a-f0-9]{64}$/.test(input.candidate.identityDigest)) throw new Error("TELEMETRY_IDENTITY_INVALID: candidate identity digest must be a lowercase SHA-256 digest.");
  if (!Number.isSafeInteger(input.operationExecutionRevision) || input.operationExecutionRevision < 1) throw new Error("TELEMETRY_IDENTITY_INVALID: operationExecutionRevision must be a positive safe integer.");
  if (!Number.isSafeInteger(input.controllerEpoch) || input.controllerEpoch < 0) throw new Error("TELEMETRY_IDENTITY_INVALID: controllerEpoch must be a non-negative safe integer.");
  if (input.policyDigest !== undefined && !/^[a-f0-9]{64}$/.test(input.policyDigest)) throw new Error("TELEMETRY_IDENTITY_INVALID: policy digest must be a lowercase SHA-256 digest.");
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
export function deriveTelemetryCorrelation(record: OperationRecordV2, options: { participantId?: string } = {}): TelemetryCorrelationV1 | undefined {
  const candidate = record.candidateRevision;
  const executionRevision = record.operationExecutionRevision;
  if (!candidate || !Number.isSafeInteger(executionRevision) || (executionRevision as number) < 1) return undefined;
  const participantId = options.participantId?.trim() || undefined;
  const participant = participantId ? record.participants?.[participantId] : undefined;
  const binding = participant?.executionBinding;
  const build = getBuildIdentity();
  return buildTelemetryCorrelationV1({
    operationId: record.id,
    candidate,
    operationExecutionRevision: executionRevision as number,
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
export async function resolveTelemetryCorrelation(root: string, operationId?: string, participantId?: string): Promise<TelemetryCorrelationV1 | undefined> {
  const id = operationId?.trim() || currentOperationContext().id;
  if (!id) return undefined;
  try {
    return deriveTelemetryCorrelation(await loadOperation(root, id), { participantId });
  } catch {
    return undefined;
  }
}

/**
 * Compare supplied telemetry identity against current durable truth. The
 * returned violation is observation-only data; it never mutates operation
 * state and cannot grant or remove authority.
 */
export function detectTelemetryIdentityViolation(current: TelemetryCorrelationV1 | undefined, supplied: TelemetryCorrelationV1): TelemetryIdentityViolationV1 | undefined {
  const suppliedDigest = telemetryCorrelationDigest(supplied);
  if (!current) return { version: 1, kind: "TELEMETRY_IDENTITY_UNRESOLVED", suppliedDigest, mismatches: [] };
  const check = verifyTelemetryCorrelation(current, supplied);
  if (check.ok) return undefined;
  return { version: 1, kind: "TELEMETRY_IDENTITY_MISMATCH", suppliedDigest, currentDigest: telemetryCorrelationDigest(current), mismatches: check.mismatches };
}

/** Canonical JSON body over defined correlation fields, sorted by key. */
export function telemetryCorrelationCanonicalBody(correlation: TelemetryCorrelationV1): Record<string, string | number> {
  const body: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(correlation)) {
    if (value === undefined || key === "version") continue;
    body[key] = typeof value === "number" ? value : String(value);
  }
  return Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b)));
}

/** Domain-separated digest binding every identity field of the correlation. */
export function telemetryCorrelationDigest(correlation: TelemetryCorrelationV1): string {
  const payload = JSON.stringify({ domain: DOMAIN, version: correlation.version, body: telemetryCorrelationCanonicalBody(correlation) });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

/** Flatten a correlation into canonical telemetry attribute keys. */
export function telemetryCorrelationAttributes(correlation: TelemetryCorrelationV1): Record<string, string | number> {
  const attributes: Record<string, string | number> = {
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
  if (correlation.policyDigest) attributes[TELEMETRY_CORRELATION_KEYS.policyDigest] = correlation.policyDigest;
  if (correlation.participantId) attributes[TELEMETRY_CORRELATION_KEYS.participantId] = correlation.participantId;
  if (correlation.participantGeneration) attributes[TELEMETRY_CORRELATION_KEYS.participantGeneration] = correlation.participantGeneration;
  if (correlation.participantRole) attributes[TELEMETRY_CORRELATION_KEYS.participantRole] = correlation.participantRole;
  if (correlation.runtimeName) attributes[TELEMETRY_CORRELATION_KEYS.runtimeName] = correlation.runtimeName;
  if (correlation.runtimeSessionId) attributes[TELEMETRY_CORRELATION_KEYS.runtimeSessionId] = correlation.runtimeSessionId;
  if (correlation.buildReleaseId) attributes[TELEMETRY_CORRELATION_KEYS.buildReleaseId] = correlation.buildReleaseId;
  if (correlation.buildDigest) attributes[TELEMETRY_CORRELATION_KEYS.buildDigest] = correlation.buildDigest;
  return attributes;
}

/**
 * Compare an observed/supplied correlation against the current durable
 * correlation. Every present expected key must match exactly; a missing or
 * different value is a mismatch. Stale candidate, revision, execution,
 * policy, epoch, participant, and session attribution are all detectable.
 */
export function verifyTelemetryCorrelation(actual: TelemetryCorrelationV1 | undefined, expected: TelemetryCorrelationV1): { ok: boolean; mismatches: TelemetryIdentityMismatch[] } {
  if (!actual) return { ok: false, mismatches: [{ key: TELEMETRY_CORRELATION_KEYS.digest, expected: telemetryCorrelationDigest(expected), actual: undefined }] };
  const mismatches: TelemetryIdentityMismatch[] = [];
  const keys = Object.keys(expected) as Array<keyof TelemetryCorrelationV1>;
  for (const key of keys) {
    const expectedValue = expected[key] as string | number | undefined;
    if (expectedValue === undefined) continue;
    const actualValue = actual[key] as string | number | undefined;
    if (actualValue !== expectedValue) mismatches.push({ key, expected: expectedValue, actual: actualValue });
  }
  return { ok: mismatches.length === 0, mismatches };
}

/** Participant identity projection for tests and non-operation surfaces. */
export function participantCorrelationKey(participant: OperationParticipantRecord): { participantGeneration?: string; runtimeName?: string; runtimeSessionId?: string } {
  return {
    participantGeneration: participant.executionBinding?.participantGeneration,
    runtimeName: participant.executionBinding?.runtime.runtimeId,
    runtimeSessionId: participant.executionBinding?.runtime.sessionId
  };
}
