import { type Counter, type Histogram } from "@opentelemetry/api";
import { AggregationTemporality, MeterProvider, PeriodicExportingMetricReader, type PushMetricExporter, type ResourceMetrics } from "@opentelemetry/sdk-metrics";
import type { HarnessProjectConfig } from "../core/types.js";
import { type TelemetryCorrelationV1 } from "./identity.js";
/**
 * Deterministic local metric lane. Instruments are real OpenTelemetry
 * counters/histograms; the exporter serializes canonical snapshots to local
 * NDJSON so a fixed scenario produces reproducible values with no hosted
 * credential. Metrics are observations only: no gate consumes them.
 */
export declare const METRICS_SNAPSHOT_VERSION = 1;
export declare const LOCAL_METRICS_FILE = ".harness/telemetry/metrics.ndjson";
export interface MetricPointV1 {
    attributes: Record<string, string | number | boolean>;
    value?: number;
    count?: number;
    sum?: number;
    min?: number;
    max?: number;
    boundaries?: number[];
    bucketCounts?: number[];
}
export interface MetricRecordV1 {
    name: string;
    description: string;
    unit: string;
    type: "SUM" | "GAUGE" | "HISTOGRAM" | "EXPONENTIAL_HISTOGRAM";
    monotonic?: boolean;
    points: MetricPointV1[];
}
export interface MetricsSnapshotV1 {
    version: typeof METRICS_SNAPSHOT_VERSION;
    exportedAt: string;
    sequence: number;
    resource: Record<string, string | number | boolean>;
    scopes: Array<{
        name: string;
        version?: string;
        metrics: MetricRecordV1[];
    }>;
}
export interface OperationTelemetrySignalV1 {
    kind: string;
    status: string;
    route?: string;
    assurance?: string;
    durationMs: number;
    repairCount?: number;
    humanInterventions?: number;
}
export interface ParticipantTelemetrySignalV1 {
    event: "launch" | "result";
    transport?: string;
    status?: string;
    durationMs?: number;
}
export interface ValidationTelemetrySignalV1 {
    status: string;
    durationMs: number;
}
export type RuntimeSessionTelemetryEventV1 = "materialized" | "reused" | "rotated";
export declare const OPERATION_METRIC_NAMES: readonly ["aeh.operation.count", "aeh.operation.duration"];
export declare const PARTICIPANT_METRIC_NAMES: readonly ["aeh.participant.launch.count", "aeh.participant.result.count", "aeh.participant.turn.duration"];
export declare const RUNTIME_METRIC_NAMES: readonly ["aeh.runtime.session.count"];
export declare const VALIDATION_METRIC_NAMES: readonly ["aeh.validation.run.count", "aeh.validation.duration"];
export declare const REQUIRED_METRIC_NAMES: readonly ["aeh.operation.count", "aeh.operation.duration", "aeh.participant.launch.count", "aeh.participant.result.count", "aeh.participant.turn.duration", "aeh.runtime.session.count", "aeh.validation.run.count", "aeh.validation.duration"];
interface MetricsPipeline {
    file: string;
    provider: MeterProvider;
    reader: PeriodicExportingMetricReader;
    exporter: LocalMetricsExporter;
    instruments: {
        operationCount: Counter;
        operationDuration: Histogram;
        participantLaunchCount: Counter;
        participantResultCount: Counter;
        participantTurnDuration: Histogram;
        runtimeSessionCount: Counter;
        validationRunCount: Counter;
        validationDuration: Histogram;
    };
}
export declare function ensureTelemetryMetrics(root: string, config?: HarnessProjectConfig): MetricsPipeline;
export declare function recordOperationTelemetry(root: string, config: HarnessProjectConfig | undefined, correlation: TelemetryCorrelationV1, signal: OperationTelemetrySignalV1): Promise<boolean>;
export declare function recordParticipantTelemetry(root: string, config: HarnessProjectConfig | undefined, correlation: TelemetryCorrelationV1, signal: ParticipantTelemetrySignalV1): Promise<boolean>;
export declare function recordRuntimeSessionTelemetry(root: string, config: HarnessProjectConfig | undefined, correlation: TelemetryCorrelationV1, event: RuntimeSessionTelemetryEventV1): Promise<boolean>;
export declare function recordValidationTelemetry(root: string, config: HarnessProjectConfig | undefined, correlation: TelemetryCorrelationV1, signal: ValidationTelemetrySignalV1): Promise<boolean>;
/** Force-flush local metric snapshots. Deterministic: no timer is required. */
export declare function flushTelemetryMetrics(root?: string): Promise<void>;
export declare function resetTelemetryMetrics(): void;
/** Read local metric snapshots for deterministic verification. */
export declare function readMetricSnapshots(root: string, config?: HarnessProjectConfig): Promise<MetricsSnapshotV1[]>;
/** Digest of canonical metric values, excluding export time and sequence. */
export declare function metricsSnapshotDigest(snapshot: MetricsSnapshotV1): string;
declare class LocalMetricsExporter implements PushMetricExporter {
    private readonly file;
    private sequence;
    constructor(file: string);
    export(resourceMetrics: ResourceMetrics, resultCallback: (result: {
        code: number;
        error?: Error;
    }) => void): void;
    forceFlush(): Promise<void>;
    shutdown(): Promise<void>;
    selectAggregationTemporality(): AggregationTemporality;
}
export declare function serializeResourceMetrics(resourceMetrics: ResourceMetrics, sequence: number, at: Date): MetricsSnapshotV1;
export {};
