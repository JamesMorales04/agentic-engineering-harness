import type { HarnessProjectConfig } from "../core/types.js";
import { type TelemetryCorrelationV1, type TelemetryIdentityViolationV1 } from "./identity.js";
/** Local observation record. It carries no authority and is never read by a gate. */
export interface TelemetryEventRecordV1 {
    at: string;
    name: string;
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    status: "OK" | "ERROR";
    attributes: Record<string, unknown>;
    identity?: TelemetryCorrelationV1;
    identityDigest?: string;
    identityViolation?: TelemetryIdentityViolationV1;
}
/**
 * Record one bounded lifecycle event. When a durable operation context is
 * resolvable, the event is bound to the current candidate/execution identity.
 * A caller-supplied identity that does not match current durable truth is
 * marked with an explicit violation instead of being silently re-attributed.
 */
export declare function recordEvent(root: string, config: HarnessProjectConfig, name: string, attributes: Record<string, unknown>, identity?: TelemetryCorrelationV1): Promise<void>;
/** Read local telemetry events for deterministic verification. */
export declare function readTelemetryEvents(root: string, config?: HarnessProjectConfig): Promise<TelemetryEventRecordV1[]>;
export declare function resetOperationTrace(operationId?: string): void;
