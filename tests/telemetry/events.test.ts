import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTelemetryEvents, recordEvent } from "../../src/telemetry/events.js";
import { resolveTelemetryCorrelation, telemetryCorrelationDigest, verifyTelemetryCorrelation } from "../../src/telemetry/identity.js";
import { resetTracing } from "../../src/telemetry/tracing.js";
import { loadOperation, saveOperation, type OperationRecord } from "../../src/operations/state.js";
import type { HarnessProjectConfig } from "../../src/core/types.js";

const operationEnvironmentKeys = ["AEH_OPERATION_ID", "AEH_OPERATION_KIND", "AEH_OPERATION_WORKSPACE_ID", "AEH_CONTROL_ROOT", "AEH_OPERATION_STATE_REDIRECT"] as const;
let previousEnvironment: Record<string, string | undefined> = {};
const roots: string[] = [];

beforeEach(() => {
  previousEnvironment = Object.fromEntries(operationEnvironmentKeys.map((key) => [key, process.env[key]]));
  for (const key of operationEnvironmentKeys) delete process.env[key];
});

afterEach(async () => {
  resetTracing();
  for (const key of operationEnvironmentKeys) {
    const value = previousEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function config(): HarnessProjectConfig {
  return { version: 1, project: { name: "telemetry-events" }, telemetry: { enabled: true, localEventsFile: ".harness/telemetry/events.ndjson" } };
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
    payload: { request: "candidate-bound telemetry events" },
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

async function seededOperation(id = "CHANGE-S12-EVENTS"): Promise<{ root: string; operationId: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-telemetry-events-"));
  roots.push(root);
  await saveOperation(root, seedRecord(root, id));
  process.env.AEH_OPERATION_ID = id;
  process.env.AEH_CONTROL_ROOT = root;
  process.env.AEH_OPERATION_STATE_REDIRECT = "0";
  return { root, operationId: id };
}

describe("candidate/execution-bound telemetry events", () => {
  it("binds every event to the current candidate/execution identity and records a stable digest", async () => {
    const { root, operationId } = await seededOperation();
    const record = await loadOperation(root, operationId);
    await recordEvent(root, config(), "harness.run.start", { taskId: "T-1", route: "DIRECT" });
    await recordEvent(root, config(), "harness.verify.finish", { taskId: "T-1", status: "PASS" });

    const events = await readTelemetryEvents(root);
    expect(events).toHaveLength(2);
    const current = events[0]!.identity!;
    expect(current).toMatchObject({
      operationId,
      candidateId: record.candidateRevision!.candidateId,
      candidateRevision: record.candidateRevision!.revision,
      candidateIdentityDigest: record.candidateRevision!.identityDigest,
      operationExecutionRevision: record.operationExecutionRevision
    });
    expect(events[1]!.identityDigest).toBe(telemetryCorrelationDigest(current));
    expect(verifyTelemetryCorrelation(events[1]!.identity, current).ok).toBe(true);
    expect(events[1]!.identityViolation).toBeUndefined();
    expect(events[0]!.traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(events[1]!.traceId).toBe(events[0]!.traceId);
  });

  it("marks a stale/wrong-candidate supplied identity instead of silently re-attributing it", async () => {
    const { root, operationId } = await seededOperation();
    const current = (await resolveTelemetryCorrelation(root, operationId))!;
    const stale = { ...current, candidateRevision: current.candidateRevision + 3, candidateIdentityDigest: "9".repeat(64) };
    await recordEvent(root, config(), "harness.agent.result", { taskId: "T-1", status: "PASS" }, stale);
    const [event] = await readTelemetryEvents(root);
    expect(event?.identityViolation?.kind).toBe("TELEMETRY_IDENTITY_MISMATCH");
    expect(event?.identityViolation?.suppliedDigest).toBe(telemetryCorrelationDigest(stale));
    expect(event?.identityDigest).toBe(telemetryCorrelationDigest(current));
    expect(event?.identity).toMatchObject({ candidateRevision: current.candidateRevision, candidateIdentityDigest: current.candidateIdentityDigest });
    expect(event?.identityViolation?.mismatches.map((mismatch) => mismatch.key)).toEqual(expect.arrayContaining(["candidateRevision", "candidateIdentityDigest"]));
  });

  it("marks supplied identity as unresolved when no durable operation identity exists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-telemetry-events-unresolved-"));
    roots.push(root);
    const supplied = {
      version: 1 as const,
      operationId: "CHANGE-MISSING",
      candidateId: "candidate:missing:r1",
      candidateRevision: 1,
      candidateSourceDigest: "a".repeat(64),
      candidateIdentityDigest: "b".repeat(64),
      operationExecutionRevision: 1,
      controllerEpoch: 0
    };
    process.env.AEH_OPERATION_ID = "CHANGE-MISSING";
    process.env.AEH_CONTROL_ROOT = root;
    process.env.AEH_OPERATION_STATE_REDIRECT = "0";
    await recordEvent(root, config(), "harness.agent.result", { taskId: "T-1" }, supplied);
    const [event] = await readTelemetryEvents(root);
    expect(event?.identity).toBeUndefined();
    expect(event?.identityDigest).toBeUndefined();
    expect(event?.identityViolation?.kind).toBe("TELEMETRY_IDENTITY_UNRESOLVED");
    expect(event?.identityViolation?.suppliedDigest).toBe(telemetryCorrelationDigest(supplied));
  });

  it("writes no observation when telemetry is disabled", async () => {
    const { root } = await seededOperation("CHANGE-S12-DISABLED");
    await recordEvent(root, { ...config(), telemetry: { enabled: false } }, "harness.run.start", { taskId: "T-1" });
    expect(await readTelemetryEvents(root)).toEqual([]);
  });
});
