import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  REQUIRED_METRIC_NAMES,
  flushTelemetryMetrics,
  metricsSnapshotDigest,
  readMetricSnapshots,
  recordOperationTelemetry,
  recordParticipantTelemetry,
  recordRuntimeSessionTelemetry,
  recordValidationTelemetry,
  resetTelemetryMetrics
} from "../../src/telemetry/metrics.js";
import { resolveTelemetryCorrelation, telemetryCorrelationDigest } from "../../src/telemetry/identity.js";
import { saveOperation, type OperationRecord } from "../../src/operations/state.js";
import type { HarnessProjectConfig } from "../../src/core/types.js";

const operationEnvironmentKeys = ["AEH_OPERATION_ID", "AEH_OPERATION_KIND", "AEH_OPERATION_WORKSPACE_ID", "AEH_CONTROL_ROOT", "AEH_OPERATION_STATE_REDIRECT"] as const;
let previousEnvironment: Record<string, string | undefined> = {};
const roots: string[] = [];

beforeEach(() => {
  previousEnvironment = Object.fromEntries(operationEnvironmentKeys.map((key) => [key, process.env[key]]));
  for (const key of operationEnvironmentKeys) delete process.env[key];
});

afterEach(async () => {
  resetTelemetryMetrics();
  for (const key of operationEnvironmentKeys) {
    const value = previousEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function config(): HarnessProjectConfig {
  return { version: 1, project: { name: "telemetry-metrics" }, telemetry: { enabled: true, localMetricsFile: ".harness/telemetry/metrics.ndjson" } };
}

function seedRecord(root: string, id: string): OperationRecord {
  const now = new Date(0).toISOString();
  return {
    version: 2,
    id,
    kind: "change",
    status: "QUEUED",
    phase: "queued",
    root,
    payload: { request: "candidate-bound metrics" },
    revision: 1,
    createdAt: now,
    updatedAt: now,
    lastProgressAt: now,
    supervision: { required: false, materialized: false, generations: [] },
    stages: {},
    participants: {},
    progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 }
  };
}

async function scenario(root: string, operationId: string): Promise<void> {
  process.env.AEH_OPERATION_ID = operationId;
  process.env.AEH_CONTROL_ROOT = root;
  process.env.AEH_OPERATION_STATE_REDIRECT = "0";
  const correlation = (await resolveTelemetryCorrelation(root, operationId))!;
  await recordOperationTelemetry(root, config(), correlation, { kind: "change", route: "DELEGATED", assurance: "STANDARD", status: "SUCCEEDED", durationMs: 3000, repairCount: 1, humanInterventions: 0 });
  await recordParticipantTelemetry(root, config(), correlation, { event: "launch", transport: "paseo", });
  await recordParticipantTelemetry(root, config(), correlation, { event: "result", transport: "paseo", status: "COMPLETED", durationMs: 1500 });
  await recordRuntimeSessionTelemetry(root, config(), correlation, "materialized");
  await recordRuntimeSessionTelemetry(root, config(), correlation, "reused");
  await recordRuntimeSessionTelemetry(root, config(), correlation, "rotated");
  await recordValidationTelemetry(root, config(), correlation, { status: "PASS", durationMs: 250 });
  await flushTelemetryMetrics(root);
  expect(telemetryCorrelationDigest(correlation)).toMatch(/^[a-f0-9]{64}$/);
}

async function seededRoot(operationId: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-telemetry-metrics-"));
  roots.push(root);
  await saveOperation(root, seedRecord(root, operationId));
  return root;
}

describe("local metric instruments and export", () => {
  it("exports every required operation/participant/runtime/validation instrument with correlation attributes", async () => {
    const root = await seededRoot("CHANGE-S12-METRICS");
    await scenario(root, "CHANGE-S12-METRICS");
    const snapshots = await readMetricSnapshots(root, config());
    expect(snapshots).toHaveLength(1);
    const metrics = snapshots[0]!.scopes.flatMap((scope) => scope.metrics);
    const names = metrics.map((metric) => metric.name);
    for (const required of REQUIRED_METRIC_NAMES) expect(names).toContain(required);
    const operationCount = metrics.find((metric) => metric.name === "aeh.operation.count")!;
    expect(operationCount.type).toBe("SUM");
    expect(operationCount.points[0]!.value).toBe(1);
    expect(operationCount.points[0]!.attributes["aeh.operation.status"]).toBe("SUCCEEDED");
    expect(operationCount.points[0]!.attributes["aeh.candidate.identity_digest"]).toMatch(/^[a-f0-9]{64}$/);
    const operationDuration = metrics.find((metric) => metric.name === "aeh.operation.duration")!;
    expect(operationDuration.type).toBe("HISTOGRAM");
    expect(operationDuration.points[0]!).toMatchObject({ count: 1, sum: 3000 });
    const runtime = metrics.find((metric) => metric.name === "aeh.runtime.session.count")!;
    expect(runtime.points.map((point) => point.attributes["aeh.runtime.session.event"]).sort()).toEqual(["materialized", "reused", "rotated"]);
    const validation = metrics.find((metric) => metric.name === "aeh.validation.run.count")!;
    expect(validation.points[0]!.attributes["aeh.validation.status"]).toBe("PASS");
  });

  it("produces reproducible values and digests for a fixed scenario and fixed candidate identity", async () => {
    const root = await seededRoot("CHANGE-S12-REPRO");
    await scenario(root, "CHANGE-S12-REPRO");
    const first = (await readMetricSnapshots(root, config()))[0]!;
    resetTelemetryMetrics();
    await fs.rm(path.resolve(root, ".harness/telemetry/metrics.ndjson"), { force: true });
    await scenario(root, "CHANGE-S12-REPRO");
    const second = (await readMetricSnapshots(root, config()))[0]!;
    expect(metricsSnapshotDigest(second)).toBe(metricsSnapshotDigest(first));
    expect(metricsSnapshotDigest(second)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("records nothing when no current operation identity is resolvable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-telemetry-metrics-detached-"));
    roots.push(root);
    const correlation = { version: 1 as const, operationId: "OP", candidateId: "candidate:op:r1", candidateRevision: 1, candidateSourceDigest: "a".repeat(64), candidateIdentityDigest: "b".repeat(64), operationExecutionRevision: 1, controllerEpoch: 0 };
    expect(await recordOperationTelemetry(root, config(), correlation, { kind: "change", status: "SUCCEEDED", durationMs: 1 })).toBe(true);
    await flushTelemetryMetrics(root);
    expect(await readMetricSnapshots(root, config())).toHaveLength(1);
    resetTelemetryMetrics();
    expect(await recordOperationTelemetry(root, config(), undefined as never, { kind: "change", status: "SUCCEEDED", durationMs: 1 })).toBe(false);
  });

  it("refuses to record a stale caller-supplied correlation and records the current one", async () => {
    const root = await seededRoot("CHANGE-S12-STALE");
    process.env.AEH_OPERATION_ID = "CHANGE-S12-STALE";
    process.env.AEH_CONTROL_ROOT = root;
    process.env.AEH_OPERATION_STATE_REDIRECT = "0";
    const current = (await resolveTelemetryCorrelation(root, "CHANGE-S12-STALE"))!;
    const stale = { ...current, candidateRevision: current.candidateRevision + 2, candidateIdentityDigest: "f".repeat(64) };
    expect(await recordOperationTelemetry(root, config(), stale, { kind: "change", status: "SUCCEEDED", durationMs: 10 })).toBe(false);
    expect(await readMetricSnapshots(root, config())).toHaveLength(0);
    expect(await recordOperationTelemetry(root, config(), current, { kind: "change", status: "SUCCEEDED", durationMs: 10 })).toBe(true);
    await flushTelemetryMetrics(root);
    const snapshots = await readMetricSnapshots(root, config());
    const revisions = snapshots.flatMap((snapshot) => snapshot.scopes.flatMap((scope) => scope.metrics)).flatMap((metric) => metric.points).map((point) => point.attributes["aeh.candidate.revision"]);
    expect(revisions).toContain(current.candidateRevision);
    expect(revisions).not.toContain(stale.candidateRevision);
  });
});
