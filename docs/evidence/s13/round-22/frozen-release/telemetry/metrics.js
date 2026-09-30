import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { AggregationTemporality, DataPointType, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { resolveTelemetryCorrelation, telemetryCorrelationAttributes, verifyTelemetryCorrelation } from "./identity.js";
/**
 * Deterministic local metric lane. Instruments are real OpenTelemetry
 * counters/histograms; the exporter serializes canonical snapshots to local
 * NDJSON so a fixed scenario produces reproducible values with no hosted
 * credential. Metrics are observations only: no gate consumes them.
 */
export const METRICS_SNAPSHOT_VERSION = 1;
export const LOCAL_METRICS_FILE = ".harness/telemetry/metrics.ndjson";
export const OPERATION_METRIC_NAMES = ["aeh.operation.count", "aeh.operation.duration"];
export const PARTICIPANT_METRIC_NAMES = ["aeh.participant.launch.count", "aeh.participant.result.count", "aeh.participant.turn.duration"];
export const RUNTIME_METRIC_NAMES = ["aeh.runtime.session.count"];
export const VALIDATION_METRIC_NAMES = ["aeh.validation.run.count", "aeh.validation.duration"];
export const REQUIRED_METRIC_NAMES = [...OPERATION_METRIC_NAMES, ...PARTICIPANT_METRIC_NAMES, ...RUNTIME_METRIC_NAMES, ...VALIDATION_METRIC_NAMES];
const pipelines = new Map();
const MANUAL_EXPORT_INTERVAL_MS = 2_147_483_647;
export function ensureTelemetryMetrics(root, config) {
    const key = path.resolve(root);
    const existing = pipelines.get(key);
    if (existing)
        return existing;
    const file = path.resolve(key, config?.telemetry?.localMetricsFile ?? LOCAL_METRICS_FILE);
    const exporter = new LocalMetricsExporter(file);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: MANUAL_EXPORT_INTERVAL_MS, exportTimeoutMillis: 30_000 });
    const provider = new MeterProvider({ readers: [reader] });
    const meter = provider.getMeter("agentic-engineering-harness-metrics", "1");
    const pipeline = {
        file,
        provider,
        reader,
        exporter,
        instruments: {
            operationCount: meter.createCounter("aeh.operation.count", { description: "Governed operations that reached a terminal observation.", unit: "{operation}" }),
            operationDuration: meter.createHistogram("aeh.operation.duration", { description: "Wall-clock duration of a governed operation.", unit: "ms" }),
            participantLaunchCount: meter.createCounter("aeh.participant.launch.count", { description: "Participant generations materialized for execution.", unit: "{launch}" }),
            participantResultCount: meter.createCounter("aeh.participant.result.count", { description: "Participant results observed by outcome.", unit: "{result}" }),
            participantTurnDuration: meter.createHistogram("aeh.participant.turn.duration", { description: "Wall-clock duration of a participant turn.", unit: "ms" }),
            runtimeSessionCount: meter.createCounter("aeh.runtime.session.count", { description: "Runtime session materialization, reuse, and rotation events.", unit: "{session}" }),
            validationRunCount: meter.createCounter("aeh.validation.run.count", { description: "Validation runs by observed status.", unit: "{run}" }),
            validationDuration: meter.createHistogram("aeh.validation.duration", { description: "Wall-clock duration of a validation run.", unit: "ms" })
        }
    };
    pipelines.set(key, pipeline);
    return pipeline;
}
/**
 * Metric observations verify a caller-supplied correlation against current
 * durable operation truth before recording. A mismatch records nothing, so a
 * stale correlation cannot be silently attributed. A detached observation with
 * no resolvable durable operation keeps the supplied identity and is documented
 * as unverified (see OBSERVABILITY.md).
 */
async function correlationMatchesCurrent(root, correlation) {
    const current = await resolveTelemetryCorrelation(root, correlation.operationId, correlation.participantId);
    if (!current)
        return true;
    return verifyTelemetryCorrelation(current, correlation).ok;
}
export async function recordOperationTelemetry(root, config, correlation, signal) {
    if (!correlation)
        return false;
    if (!(await correlationMatchesCurrent(root, correlation)))
        return false;
    const pipeline = ensureTelemetryMetrics(root, config);
    const attributes = signalAttributes(correlation, {
        "aeh.operation.kind": signal.kind,
        "aeh.operation.status": signal.status,
        "aeh.operation.route": signal.route,
        "aeh.operation.assurance": signal.assurance,
        "aeh.operation.repairs": signal.repairCount,
        "aeh.operation.human_interventions": signal.humanInterventions
    });
    pipeline.instruments.operationCount.add(1, attributes);
    pipeline.instruments.operationDuration.record(Math.max(0, signal.durationMs), attributes);
    return true;
}
export async function recordParticipantTelemetry(root, config, correlation, signal) {
    if (!correlation)
        return false;
    if (!(await correlationMatchesCurrent(root, correlation)))
        return false;
    const pipeline = ensureTelemetryMetrics(root, config);
    const attributes = signalAttributes(correlation, {
        "aeh.runtime.transport": signal.transport,
        "aeh.participant.result.status": signal.status
    });
    if (signal.event === "launch")
        pipeline.instruments.participantLaunchCount.add(1, attributes);
    else
        pipeline.instruments.participantResultCount.add(1, attributes);
    if (signal.durationMs !== undefined && Number.isFinite(signal.durationMs))
        pipeline.instruments.participantTurnDuration.record(Math.max(0, signal.durationMs), attributes);
    return true;
}
export async function recordRuntimeSessionTelemetry(root, config, correlation, event) {
    if (!correlation)
        return false;
    if (!(await correlationMatchesCurrent(root, correlation)))
        return false;
    const pipeline = ensureTelemetryMetrics(root, config);
    pipeline.instruments.runtimeSessionCount.add(1, signalAttributes(correlation, { "aeh.runtime.session.event": event }));
    return true;
}
export async function recordValidationTelemetry(root, config, correlation, signal) {
    if (!correlation)
        return false;
    if (!(await correlationMatchesCurrent(root, correlation)))
        return false;
    const pipeline = ensureTelemetryMetrics(root, config);
    const attributes = signalAttributes(correlation, { "aeh.validation.status": signal.status });
    pipeline.instruments.validationRunCount.add(1, attributes);
    pipeline.instruments.validationDuration.record(Math.max(0, signal.durationMs), attributes);
    return true;
}
/** Force-flush local metric snapshots. Deterministic: no timer is required. */
export async function flushTelemetryMetrics(root) {
    const selected = root ? [pipelines.get(path.resolve(root))].filter((pipeline) => Boolean(pipeline)) : [...pipelines.values()];
    await Promise.all(selected.map((pipeline) => pipeline.provider.forceFlush()));
}
export function resetTelemetryMetrics() {
    for (const pipeline of pipelines.values())
        void pipeline.provider.shutdown();
    pipelines.clear();
}
/** Read local metric snapshots for deterministic verification. */
export async function readMetricSnapshots(root, config) {
    const file = path.resolve(root, config?.telemetry?.localMetricsFile ?? LOCAL_METRICS_FILE);
    try {
        const raw = await fs.readFile(file, "utf8");
        return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    }
    catch {
        return [];
    }
}
/** Digest of canonical metric values, excluding export time and sequence. */
export function metricsSnapshotDigest(snapshot) {
    const canonical = JSON.stringify({ version: snapshot.version, resource: snapshot.resource, scopes: snapshot.scopes });
    return crypto.createHash("sha256").update(`aeh.telemetry.metrics.v1\n${canonical}`).digest("hex");
}
function signalAttributes(correlation, extra) {
    const attributes = { ...telemetryCorrelationAttributes(correlation) };
    for (const [key, value] of Object.entries(extra)) {
        if (value === undefined)
            continue;
        if (typeof value === "number" && !Number.isFinite(value))
            continue;
        attributes[key] = value;
    }
    return attributes;
}
class LocalMetricsExporter {
    file;
    sequence = 0;
    constructor(file) {
        this.file = file;
    }
    export(resourceMetrics, resultCallback) {
        let snapshot;
        try {
            snapshot = serializeResourceMetrics(resourceMetrics, ++this.sequence, new Date());
        }
        catch (error) {
            resultCallback({ code: 1, error: error instanceof Error ? error : new Error(String(error)) });
            return;
        }
        void fs.mkdir(path.dirname(this.file), { recursive: true })
            .then(() => fs.appendFile(this.file, `${JSON.stringify(snapshot)}\n`))
            .then(() => resultCallback({ code: 0 }), (error) => resultCallback({ code: 1, error: error instanceof Error ? error : new Error(String(error)) }));
    }
    forceFlush() { return Promise.resolve(); }
    shutdown() { return Promise.resolve(); }
    selectAggregationTemporality() { return AggregationTemporality.CUMULATIVE; }
}
export function serializeResourceMetrics(resourceMetrics, sequence, at) {
    const resource = canonicalAttributes(resourceMetrics.resource?.attributes ?? {});
    const scopes = [...(resourceMetrics.scopeMetrics ?? [])].map((scope) => ({
        name: scope.scope.name,
        ...(scope.scope.version ? { version: scope.scope.version } : {}),
        metrics: [...scope.metrics].map(serializeMetric).sort((a, b) => a.name.localeCompare(b.name))
    })).sort((a, b) => a.name.localeCompare(b.name));
    return { version: METRICS_SNAPSHOT_VERSION, exportedAt: at.toISOString(), sequence, resource, scopes };
}
function serializeMetric(metric) {
    const base = { name: metric.descriptor.name, description: metric.descriptor.description, unit: metric.descriptor.unit };
    if (metric.dataPointType === DataPointType.SUM) {
        return { ...base, type: "SUM", monotonic: metric.isMonotonic, points: metric.dataPoints.map(serializeNumberPoint).sort(comparePoints) };
    }
    if (metric.dataPointType === DataPointType.GAUGE) {
        return { ...base, type: "GAUGE", points: metric.dataPoints.map(serializeNumberPoint).sort(comparePoints) };
    }
    if (metric.dataPointType === DataPointType.HISTOGRAM) {
        return {
            ...base,
            type: "HISTOGRAM",
            points: metric.dataPoints.map((point) => ({
                attributes: canonicalAttributes(point.attributes),
                count: point.value.count,
                ...(point.value.sum !== undefined ? { sum: point.value.sum } : {}),
                ...(point.value.min !== undefined ? { min: point.value.min } : {}),
                ...(point.value.max !== undefined ? { max: point.value.max } : {}),
                boundaries: [...point.value.buckets.boundaries],
                bucketCounts: [...point.value.buckets.counts]
            })).sort(comparePoints)
        };
    }
    return { ...base, type: "EXPONENTIAL_HISTOGRAM", points: [] };
}
function serializeNumberPoint(point) {
    return { attributes: canonicalAttributes(point.attributes), value: point.value };
}
function comparePoints(a, b) {
    return JSON.stringify(a.attributes).localeCompare(JSON.stringify(b.attributes));
}
function canonicalAttributes(attributes) {
    const result = {};
    for (const key of Object.keys(attributes).sort()) {
        const value = attributes[key];
        if (value === undefined || value === null)
            continue;
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
            result[key] = value;
        else if (Array.isArray(value))
            result[key] = value.map(String).join(",");
    }
    return result;
}
//# sourceMappingURL=metrics.js.map