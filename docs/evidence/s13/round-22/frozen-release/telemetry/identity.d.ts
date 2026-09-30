import { type OperationParticipantRecord, type OperationRecordV2 } from "../operations/state.js";
import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";
/**
 * Telemetry identity is observation-only. Every trace event, span, metric
 * point, and eval run that belongs to a governed operation carries the current
 * candidate/execution identity so joins are stable and stale attribution is
 * detectable. This module grants no authority and mutates no product state.
 */
export declare const TELEMETRY_CORRELATION_VERSION = 1;
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
/** Canonical flattened attribute keys used by every telemetry signal. */
export declare const TELEMETRY_CORRELATION_KEYS: {
    readonly version: "aeh.telemetry.correlation.version";
    readonly digest: "aeh.telemetry.correlation.digest";
    readonly operationId: "aeh.operation.id";
    readonly candidateId: "aeh.candidate.id";
    readonly candidateRevision: "aeh.candidate.revision";
    readonly candidateSourceDigest: "aeh.candidate.source_digest";
    readonly candidateIdentityDigest: "aeh.candidate.identity_digest";
    readonly operationExecutionRevision: "aeh.execution.revision";
    readonly policyDigest: "aeh.policy.digest";
    readonly controllerEpoch: "aeh.controller.epoch";
    readonly participantId: "aeh.participant.id";
    readonly participantGeneration: "aeh.participant.generation";
    readonly participantRole: "aeh.participant.role";
    readonly runtimeName: "aeh.runtime.name";
    readonly runtimeSessionId: "aeh.runtime.session.id";
    readonly buildReleaseId: "aeh.build.release.id";
    readonly buildDigest: "aeh.build.digest";
};
/** Build a validated correlation value. Missing required identity fails closed. */
export declare function buildTelemetryCorrelationV1(input: TelemetryCorrelationInput): TelemetryCorrelationV1;
/**
 * Derive the current telemetry correlation from durable operation state.
 * Returns undefined when the record has no current candidate or no execution
 * revision; identity is never invented.
 */
export declare function deriveTelemetryCorrelation(record: OperationRecordV2, options?: {
    participantId?: string;
}): TelemetryCorrelationV1 | undefined;
/** Resolve the current durable operation identity for a telemetry emission point. */
export declare function resolveTelemetryCorrelation(root: string, operationId?: string, participantId?: string): Promise<TelemetryCorrelationV1 | undefined>;
/**
 * Compare supplied telemetry identity against current durable truth. The
 * returned violation is observation-only data; it never mutates operation
 * state and cannot grant or remove authority.
 */
export declare function detectTelemetryIdentityViolation(current: TelemetryCorrelationV1 | undefined, supplied: TelemetryCorrelationV1): TelemetryIdentityViolationV1 | undefined;
/** Canonical JSON body over defined correlation fields, sorted by key. */
export declare function telemetryCorrelationCanonicalBody(correlation: TelemetryCorrelationV1): Record<string, string | number>;
/** Domain-separated digest binding every identity field of the correlation. */
export declare function telemetryCorrelationDigest(correlation: TelemetryCorrelationV1): string;
/** Flatten a correlation into canonical telemetry attribute keys. */
export declare function telemetryCorrelationAttributes(correlation: TelemetryCorrelationV1): Record<string, string | number>;
/**
 * Compare an observed/supplied correlation against the current durable
 * correlation. Every present expected key must match exactly; a missing or
 * different value is a mismatch. Stale candidate, revision, execution,
 * policy, epoch, participant, and session attribution are all detectable.
 */
export declare function verifyTelemetryCorrelation(actual: TelemetryCorrelationV1 | undefined, expected: TelemetryCorrelationV1): {
    ok: boolean;
    mismatches: TelemetryIdentityMismatch[];
};
/** Participant identity projection for tests and non-operation surfaces. */
export declare function participantCorrelationKey(participant: OperationParticipantRecord): {
    participantGeneration?: string;
    runtimeName?: string;
    runtimeSessionId?: string;
};
