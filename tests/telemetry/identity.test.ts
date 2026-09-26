import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TELEMETRY_CORRELATION_KEYS,
  buildTelemetryCorrelationV1,
  deriveTelemetryCorrelation,
  telemetryCorrelationAttributes,
  telemetryCorrelationDigest,
  verifyTelemetryCorrelation
} from "../../src/telemetry/identity.js";
import { claimControllerEpoch, loadOperation, saveOperation, type OperationRecord } from "../../src/operations/state.js";

const operationEnvironmentKeys = ["AEH_OPERATION_ID", "AEH_OPERATION_KIND", "AEH_OPERATION_WORKSPACE_ID", "AEH_CONTROL_ROOT", "AEH_OPERATION_STATE_REDIRECT"] as const;
let previousEnvironment: Record<string, string | undefined> = {};
const roots: string[] = [];

beforeEach(() => {
  previousEnvironment = Object.fromEntries(operationEnvironmentKeys.map((key) => [key, process.env[key]]));
  for (const key of operationEnvironmentKeys) delete process.env[key];
});

afterEach(async () => {
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
    payload: { request: "telemetry identity contract" },
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

async function seededOperation(id = "CHANGE-S12-IDENTITY"): Promise<{ root: string; operationId: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-telemetry-identity-"));
  roots.push(root);
  await saveOperation(root, seedRecord(root, id));
  return { root, operationId: id };
}

describe("telemetry correlation identity", () => {
  it("derives the current candidate/execution identity from durable operation state", async () => {
    const { root, operationId } = await seededOperation();
    const record = await loadOperation(root, operationId);
    const correlation = deriveTelemetryCorrelation(record);
    expect(correlation).toBeDefined();
    expect(correlation).toMatchObject({
      version: 1,
      operationId,
      candidateId: `candidate:${operationId}:r1`,
      candidateRevision: 1,
      candidateIdentityDigest: record.candidateRevision?.identityDigest,
      candidateSourceDigest: record.candidateRevision?.sourceDigest,
      operationExecutionRevision: 1,
      controllerEpoch: 0
    });
    expect(correlation?.policyDigest).toBeUndefined();

    const attributes = telemetryCorrelationAttributes(correlation!);
    expect(attributes[TELEMETRY_CORRELATION_KEYS.candidateIdentityDigest]).toBe(record.candidateRevision?.identityDigest);
    expect(attributes[TELEMETRY_CORRELATION_KEYS.digest]).toBe(telemetryCorrelationDigest(correlation!));
  });

  it("fails closed on incomplete identity input and never invents candidate fields", () => {
    const candidate = { candidateId: "candidate:x:r1", revision: 1, sourceDigest: "a".repeat(64), identityDigest: "b".repeat(64) };
    const base = { operationId: "OP-1", candidate, operationExecutionRevision: 1, controllerEpoch: 0 };
    expect(() => buildTelemetryCorrelationV1({ ...base, candidate: { ...candidate, identityDigest: "not-a-digest" } })).toThrow("TELEMETRY_IDENTITY_INVALID");
    expect(() => buildTelemetryCorrelationV1({ ...base, operationId: " " })).toThrow("TELEMETRY_IDENTITY_INVALID");
    expect(() => buildTelemetryCorrelationV1({ ...base, controllerEpoch: -1 })).toThrow("TELEMETRY_IDENTITY_INVALID");
    expect(() => buildTelemetryCorrelationV1({ ...base, policyDigest: "ABC" })).toThrow("TELEMETRY_IDENTITY_INVALID");
  });

  it("produces stable digests with candidate separation", async () => {
    const { root, operationId } = await seededOperation();
    const record = await loadOperation(root, operationId);
    const first = deriveTelemetryCorrelation(record)!;
    const second = deriveTelemetryCorrelation(await loadOperation(root, operationId))!;
    expect(telemetryCorrelationDigest(first)).toBe(telemetryCorrelationDigest(second));

    const advanced = buildTelemetryCorrelationV1({
      operationId: first.operationId,
      candidate: { candidateId: "candidate:next:r2", revision: 2, sourceDigest: "c".repeat(64), identityDigest: "d".repeat(64) },
      operationExecutionRevision: first.operationExecutionRevision,
      controllerEpoch: first.controllerEpoch,
      policyDigest: first.policyDigest
    });
    expect(telemetryCorrelationDigest(advanced)).not.toBe(telemetryCorrelationDigest(first));
  });

  it("detects stale candidate, revision, policy, epoch, participant, and session attribution", async () => {
    const { root, operationId } = await seededOperation();
    const record = await loadOperation(root, operationId);
    const oldCorrelation = deriveTelemetryCorrelation(record)!;
    const advanced = await claimControllerEpoch(root, operationId, `controller:test:${operationId}`, { pid: process.pid });
    const currentCorrelation = deriveTelemetryCorrelation(advanced)!;
    expect(currentCorrelation.controllerEpoch).toBeGreaterThan(oldCorrelation.controllerEpoch);

    const stale = verifyTelemetryCorrelation(currentCorrelation, oldCorrelation);
    expect(stale.ok).toBe(false);
    expect(stale.mismatches.map((mismatch) => mismatch.key)).toContain("controllerEpoch");

    const candidateDrift = verifyTelemetryCorrelation({ ...currentCorrelation, candidateIdentityDigest: "e".repeat(64) }, currentCorrelation);
    expect(candidateDrift.ok).toBe(false);
    expect(candidateDrift.mismatches).toEqual([{ key: "candidateIdentityDigest", expected: currentCorrelation.candidateIdentityDigest, actual: "e".repeat(64) }]);

    const missing = verifyTelemetryCorrelation(undefined, currentCorrelation);
    expect(missing.ok).toBe(false);
    expect(missing.mismatches[0]?.actual).toBeUndefined();
  });

  it("projects optional participant and runtime session identity when the binding exists", async () => {
    const { root, operationId } = await seededOperation("CHANGE-S12-PARTICIPANT");
    const record = await loadOperation(root, operationId);
    const withParticipant = {
      ...record,
      participants: {
        "participant:one": {
          id: "participant:one",
          role: "Implementer",
          logicalAgent: "implementer-1",
          status: "RUNNING" as const,
          registeredAt: new Date(0).toISOString(),
          executionBinding: {
            version: 2 as const,
            operationId,
            operationExecutionRevision: 1,
            candidateRevision: 1,
            candidateDigest: record.candidateRevision!.identityDigest,
            controllerEpoch: 0,
            executionBlueprintDigest: "1".repeat(64),
            operationPolicyDigest: "2".repeat(64),
            participantId: "participant:one",
            participantGeneration: "generation:3",
            roleInvocationPolicyDigest: "3".repeat(64),
            skillManifestDigest: "4".repeat(64),
            runtime: { runtimeId: "opencode", provider: "opencode", modelId: "model", model: "model", sessionId: "session:abc" },
            contextManifestDigest: "5".repeat(64),
            promptManifestDigest: "6".repeat(64),
            outputContract: "structured-result",
            leaseIdentities: [],
            digest: "7".repeat(64)
          }
        }
      }
    };
    const correlation = deriveTelemetryCorrelation(withParticipant, { participantId: "participant:one" })!;
    expect(correlation).toMatchObject({
      participantId: "participant:one",
      participantGeneration: "generation:3",
      participantRole: "Implementer",
      runtimeName: "opencode",
      runtimeSessionId: "session:abc"
    });
    const attributes = telemetryCorrelationAttributes(correlation);
    expect(attributes[TELEMETRY_CORRELATION_KEYS.runtimeSessionId]).toBe("session:abc");
    expect(attributes[TELEMETRY_CORRELATION_KEYS.participantGeneration]).toBe("generation:3");
  });
});
