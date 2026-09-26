import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTelemetryEvents, recordEvent } from "../../src/telemetry/events.js";
import { TELEMETRY_CORRELATION_KEYS } from "../../src/telemetry/identity.js";
import { resetTracing } from "../../src/telemetry/tracing.js";
import { saveOperation, type OperationRecord } from "../../src/operations/state.js";
import type { HarnessProjectConfig } from "../../src/core/types.js";
import { startOtlpReceiver, type OtlpReceiver } from "../helpers/otlpReceiver.js";

const operationEnvironmentKeys = ["AEH_OPERATION_ID", "AEH_OPERATION_KIND", "AEH_OPERATION_WORKSPACE_ID", "AEH_CONTROL_ROOT", "AEH_OPERATION_STATE_REDIRECT"] as const;
let previousEnvironment: Record<string, string | undefined> = {};
const roots: string[] = [];
const receivers: OtlpReceiver[] = [];

beforeEach(() => {
  previousEnvironment = Object.fromEntries(operationEnvironmentKeys.map((key) => [key, process.env[key]]));
  for (const key of operationEnvironmentKeys) delete process.env[key];
});

afterEach(async () => {
  resetTracing();
  await Promise.all(receivers.splice(0).map((receiver) => receiver.close()));
  for (const key of operationEnvironmentKeys) {
    const value = previousEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function seedRecord(root: string, id: string): OperationRecord {
  const now = new Date(0).toISOString();
  return {
    version: 2,
    id,
    kind: "change",
    status: "QUEUED",
    phase: "queued",
    root,
    payload: { request: "local OTLP export verification" },
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

describe("local OTLP export lane", () => {
  it("exports real OTLP/HTTP JSON spans to a loopback receiver with identity and trace correlation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-otlp-export-"));
    roots.push(root);
    const operationId = "CHANGE-S12-OTLP";
    await saveOperation(root, seedRecord(root, operationId));
    process.env.AEH_OPERATION_ID = operationId;
    process.env.AEH_CONTROL_ROOT = root;
    process.env.AEH_OPERATION_STATE_REDIRECT = "0";

    const receiver = await startOtlpReceiver();
    receivers.push(receiver);
    const config: HarnessProjectConfig = {
      version: 1,
      project: { name: "otlp-export" },
      telemetry: { enabled: true, exporter: "otlp-http-json", endpoint: receiver.endpoint, serviceName: "aeh-s12-otlp" }
    };

    await recordEvent(root, config, "harness.run.start", { taskId: "T-OTLP", route: "DIRECT" });
    await recordEvent(root, config, "harness.verify.finish", { taskId: "T-OTLP", status: "PASS" });
    await recordEvent(root, config, "harness.run.finish", { taskId: "T-OTLP", status: "PASS" });

    expect(receiver.requests.length).toBeGreaterThan(0);
    for (const request of receiver.requests) {
      expect(request.method).toBe("POST");
      expect(request.path).toBe("/v1/traces");
      expect(request.contentType).toContain("application/json");
    }
    const resourceAttributes = receiver.resourceAttributes()[0]!;
    expect(resourceAttributes["service.name"]).toBe("aeh-s12-otlp");
    expect(resourceAttributes["aeh.build.release.id"]).toBeDefined();
    expect(resourceAttributes["aeh.build.git.sha"]).toBeDefined();

    const spans = receiver.spans();
    const operationSpan = spans.find((span) => span.name === "aeh.operation");
    const verifySpan = spans.find((span) => span.name === "harness.verify.finish");
    const finishSpan = spans.find((span) => span.name === "harness.run.finish");
    expect(operationSpan).toBeDefined();
    expect(verifySpan).toBeDefined();
    expect(finishSpan).toBeDefined();
    expect(verifySpan!.traceId).toBe(operationSpan!.traceId);
    expect(finishSpan!.traceId).toBe(operationSpan!.traceId);
    expect(verifySpan!.parentSpanId).toBeDefined();
    expect(verifySpan!.attributes[TELEMETRY_CORRELATION_KEYS.operationId]).toBe(operationId);
    expect(verifySpan!.attributes[TELEMETRY_CORRELATION_KEYS.candidateIdentityDigest]).toMatch(/^[a-f0-9]{64}$/);
    expect(verifySpan!.attributes[TELEMETRY_CORRELATION_KEYS.candidateRevision]).toBe(1);
    expect(verifySpan!.attributes[TELEMETRY_CORRELATION_KEYS.operationExecutionRevision]).toBe(1);
    expect(verifySpan!.attributes[TELEMETRY_CORRELATION_KEYS.controllerEpoch]).toBe(0);

    const events = await readTelemetryEvents(root);
    const ndjsonVerify = events.find((event) => event.name === "harness.verify.finish")!;
    expect(verifySpan!.attributes[TELEMETRY_CORRELATION_KEYS.digest]).toBe(ndjsonVerify.identityDigest);
    expect(verifySpan!.attributes[TELEMETRY_CORRELATION_KEYS.candidateIdentityDigest]).toBe(ndjsonVerify.identity!.candidateIdentityDigest);
    expect(finishSpan!.attributes[TELEMETRY_CORRELATION_KEYS.digest]).toBe(ndjsonVerify.identityDigest);
  });
});
