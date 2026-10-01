import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskContract, WorkerSession } from "../src/core/types.js";
import { sha256Canonical, sha256Utf8 } from "../src/core/digest.js";
import { evaluateObjectiveCompletionV1 } from "../src/architecture/objectiveCompletion.js";
import { compileExecutionBinding, compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { bindOperationParticipantExecution, bindResolvedOperationPolicy, claimControllerEpoch, currentControllerEpoch, loadOperation, saveOperation, type OperationRecord } from "../src/operations/state.js";
import { authorizeToolAction, controllerActorId, type ToolActionRequestV1 } from "../src/security/toolActionGate.js";
import {
  correlateEquivalentToolCalls,
  participantUsageObservationFromSession,
  readOperationEfficiencyObservations,
  recordParticipantUsageObservation,
  recordToolCallObservations,
  recordContextAccountingObservation,
  readOperationEfficiencySummary,
  summarizeOperationEfficiencyV1,
  writeOperationEfficiencySummary,
  type ProviderTelemetryEvidenceV1,
  contextRetrievalObservationV1Schema,
  toolCallObservationV1Schema
} from "../src/telemetry/efficiency.js";
import { capturePaseoTimelineV1 } from "../src/telemetry/paseoTimeline.js";
import type { HarnessProjectConfig } from "../src/core/types.js";

const roots: string[] = [];
const operationEnv = ["AEH_OPERATION_ID", "AEH_OPERATION_KIND", "AEH_CONTROL_ROOT", "AEH_OPERATION_STATE_REDIRECT", "AEH_CONTROLLER_EPOCH", "AEH_CONTROLLER_TOKEN"] as const;
const previousEnv = Object.fromEntries(operationEnv.map((key) => [key, process.env[key]]));

afterEach(async () => {
  for (const key of operationEnv) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const config: HarnessProjectConfig = { version: 1, project: { name: "efficiency-test" }, telemetry: { enabled: true, exporter: "none" } };

async function fixture(id = "CHANGE-EFFICIENCY-1", participantIds: string[] = []): Promise<{ root: string; operationId: string; candidate: NonNullable<Awaited<ReturnType<typeof loadOperation>>["candidateRevision"]> }> {
  for (const key of operationEnv) delete process.env[key];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-efficiency-"));
  roots.push(root);
  const now = new Date(0).toISOString();
  const record: OperationRecord = {
    version: 2,
    id,
    kind: "change",
    status: "RUNNING",
    phase: "executing",
    root,
    payload: { taskId: `TASK-${id}` },
    revision: 1,
    createdAt: now,
    updatedAt: now,
    lastProgressAt: now,
    intent: { classification: "CHANGE", route: "DIRECT", assurance: "STANDARD" },
    supervision: { required: false, materialized: false, generations: [] },
    stages: {},
    participants: Object.fromEntries(participantIds.map((participantId) => [participantId, { id: participantId, role: "Implementer", logicalAgent: "implementer", phase: "implementation", status: "REGISTERED" as const, registeredAt: now }])),
    progress: { expected: 0, registered: participantIds.length, running: 0, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 },
    controller: { epoch: 0, ownerId: "controller:none", claimedAt: now },
    operationExecutionRevision: 1
  };
  await saveOperation(root, record);
  return { root, operationId: id, candidate: (await loadOperation(root, id)).candidateRevision! };
}

function contextObservation(input: {
  operationId: string;
  participantId: string;
  candidate: NonNullable<Awaited<ReturnType<typeof loadOperation>>["candidateRevision"]>;
  envelopeDigest?: string;
  fragmentId?: string;
  contentDigest?: string;
  deliveredTokens?: number;
  controllerEpoch?: number;
}) {
  return {
    operationId: input.operationId,
    participantId: input.participantId,
    role: "Implementer",
    logicalAgent: "implementer",
    phase: "implementation",
    candidate: input.candidate,
    operationExecutionRevision: 1,
    controllerEpoch: input.controllerEpoch ?? 0,
    envelopeDigest: input.envelopeDigest ?? sha256Canonical("envelope"),
    rawContextTokens: 100,
    projectedContextTokens: 50,
    deliveredContextTokens: 20,
    fragmentIdentities: [{
      fragmentId: input.fragmentId ?? "task-fragment",
      contentDigest: input.contentDigest ?? sha256Canonical("fragment"),
      deliveredTokens: input.deliveredTokens ?? 10
    }]
  };
}

function boundSession(input: {
  operationId: string;
  candidate: NonNullable<Awaited<ReturnType<typeof loadOperation>>["candidateRevision"]>;
  participantId: string;
  sessionId: string;
  binding?: WorkerSession["executionBinding"];
}): WorkerSession {
  const binding = input.binding ?? {
    version: 2 as const,
    operationId: input.operationId,
    operationExecutionRevision: 1,
    candidateRevision: input.candidate.revision,
    candidateDigest: input.candidate.identityDigest,
    controllerEpoch: 0,
    executionBlueprintDigest: "a".repeat(64),
    operationPolicyDigest: "b".repeat(64),
    participantId: input.participantId,
    participantGeneration: `generation:${input.participantId}`,
    roleInvocationPolicyDigest: "c".repeat(64),
    skillManifestDigest: "d".repeat(64),
    runtime: { runtimeId: "paseo", provider: "openai", modelId: "openai/test", model: "test-model", sessionId: input.sessionId },
    contextManifestDigest: "e".repeat(64),
    promptManifestDigest: "f".repeat(64),
    outputContract: "implementer",
    leaseIdentities: [],
    digest: "1".repeat(64)
  };
  return {
    id: input.sessionId,
    operationId: input.operationId,
    participantId: input.participantId,
    provider: "openai",
    model: "test-model",
    logicalAgent: "implementer",
    runtime: "paseo",
    phase: "implementation",
    exitCode: 0,
    stdout: "",
    stderr: "",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:03.000Z",
    executionBinding: binding
  };
}

function toolCall(input: Partial<ProviderTelemetryEvidenceV1["toolCalls"][number]> & Pick<ProviderTelemetryEvidenceV1["toolCalls"][number], "callId" | "turnId" | "timelineSequence" | "argumentsDigest" | "toolName" | "outcome">): ProviderTelemetryEvidenceV1["toolCalls"][number] {
  return {
    turnIndex: 0,
    toolServer: "mcp-test",
    provider: "openai",
    argumentsByteLength: 24,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1000,
    resultByteLength: null,
    errorFingerprint: null,
    ...input
  };
}

function timelineEntry(item: Record<string, unknown>, sequence: number, turnId = "turn-1") {
  return { provider: "openai", item, turnId, timestamp: `2026-01-01T00:00:0${sequence}.000Z`, seqStart: sequence, seqEnd: sequence, sourceSeqRanges: [], collapsed: [] };
}

describe("Efficiency telemetry V2", () => {
  it("uses provider turn usage and keeps unsupported token fields unknown", async () => {
    const { root, operationId, candidate } = await fixture();
    const participantId = "participant:usage";
    const telemetry: ProviderTelemetryEvidenceV1 = {
      source: "PROVIDER_TURN_EVENTS",
      coverage: "COMPLETE",
      turnCount: 2,
      turns: [
        { turnId: "turn-1", turnIndex: 0, runtimeSessionId: null, provider: "openai", at: "2026-01-01T00:00:01.000Z", inputTokens: 100, cachedInputTokens: 20, outputTokens: 30, reasoningOutputTokens: null, totalTokens: 130, totalTokensBasis: "INPUT_PLUS_OUTPUT", costUsd: 0.01, usageKnown: true },
        { turnId: "turn-2", turnIndex: 1, runtimeSessionId: null, provider: "openai", at: "2026-01-01T00:00:02.000Z", inputTokens: 50, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: null, totalTokens: 60, totalTokensBasis: "INPUT_PLUS_OUTPUT", costUsd: 0.02, usageKnown: true }
      ],
      toolCalls: []
    };
    const observation = participantUsageObservationFromSession({ operationId, participantId, role: "Implementer", phase: "implementation", candidate, session: boundSession({ operationId, participantId, sessionId: "session:usage", candidate }), providerTelemetry: telemetry });
    expect(observation).toMatchObject({ usageKnown: true, usageCoverage: "COMPLETE", turnCount: 2, inputTokens: 150, cachedInputTokens: 20, outputTokens: 40, reasoningOutputTokens: null, totalTokens: 190, totalTokensBasis: "INPUT_PLUS_OUTPUT", costUsd: 0.03, runtimeSessionId: "session:usage" });
    const toolCalls = correlateEquivalentToolCalls([
      toolCall({ callId: "tool-failed", turnId: "turn-1", turnIndex: 0, timelineSequence: 10, argumentsDigest: sha256Canonical({ path: "same" }), toolName: "read_file", outcome: "TOOL_ERROR" }),
      toolCall({ callId: "tool-retry", turnId: "turn-1", turnIndex: 0, timelineSequence: 11, argumentsDigest: sha256Canonical({ path: "same" }), toolName: "read_file", outcome: "SUCCESS" })
    ]).map((item) => toolCallObservationV1Schema.parse({
      version: 1,
      observationId: sha256Canonical(item),
      operationId,
      candidateId: candidate.candidateId,
      candidateRevision: candidate.revision,
      candidateDigest: candidate.identityDigest,
      operationExecutionRevision: 1,
      controllerEpoch: 0,
      participantId,
      sessionId: "session:usage",
      role: "Implementer",
      phase: "implementation",
      ...item
    }));
    const operation = await loadOperation(root, operationId);
    const summary = summarizeOperationEfficiencyV1({ ...operation, status: "SUCCEEDED", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:03.000Z", result: { status: "PASS", acceptanceOracle: { disposition: "ACCEPTED" }, delivery: { status: "FINALIZED" } } }, { participants: observation ? [observation] : [], tools: toolCalls, context: [], retrieval: [] });
    expect(summary.tools).toMatchObject({ retryCalls: 1, recoveredAfterRetry: 1, retryAssociatedInputTokens: 100, retryAssociatedOutputTokens: 30, retryAssociatedTotalTokens: 130, retryUsageCoverage: "COMPLETE" });
    expect(summary.outcome).toEqual({ accepted: true, delivered: true });
  });

  it("deduplicates repeated provider turn history and cumulative snapshots per runtime session", async () => {
    const { root, operationId, candidate } = await fixture("CHANGE-EFFICIENCY-CUMULATIVE");
    const participantId = "participant:cumulative";
    const session = boundSession({ operationId, participantId, sessionId: "session:cumulative", candidate });
    const turn = (turnId: string, inputTokens: number, outputTokens: number, at: string): ProviderTelemetryEvidenceV1["turns"][number] => ({
      turnId, turnIndex: Number(turnId.slice(-1)) - 1, runtimeSessionId: null, provider: "openai", at,
      inputTokens, cachedInputTokens: 0, outputTokens, reasoningOutputTokens: null, totalTokens: inputTokens + outputTokens,
      totalTokensBasis: "INPUT_PLUS_OUTPUT", costUsd: null, usageKnown: true
    });
    const first = participantUsageObservationFromSession({
      operationId, participantId, role: "Implementer", phase: "implementation", candidate, session,
      providerTelemetry: { source: "PROVIDER_TURN_EVENTS", coverage: "PARTIAL", turnCount: 1, turns: [turn("turn-1", 100, 20, "2026-01-01T00:00:01.000Z")], toolCalls: [] }
    })!;
    const replayedHistory = participantUsageObservationFromSession({
      operationId, participantId, role: "Implementer", phase: "implementation", candidate, session,
      providerTelemetry: { source: "PROVIDER_TURN_EVENTS", coverage: "PARTIAL", turnCount: 2, turns: [turn("turn-1", 100, 20, "2026-01-01T00:00:01.000Z"), turn("turn-2", 50, 10, "2026-01-01T00:00:02.000Z")], toolCalls: [] }
    })!;
    const priorSnapshot = participantUsageObservationFromSession({
      operationId, participantId, role: "Implementer", phase: "implementation", candidate,
      session: { ...session, finishedAt: "2026-01-01T00:00:04.000Z" },
      providerTelemetry: { source: "PASEO_AGENT_SNAPSHOT", coverage: "PARTIAL", turnCount: 2, turns: [], toolCalls: [], snapshotUsage: { inputTokens: 150, outputTokens: 30, totalTokens: 180 } }
    })!;
    const latestSnapshot = participantUsageObservationFromSession({
      operationId, participantId, role: "Implementer", phase: "implementation", candidate,
      session: { ...session, finishedAt: "2026-01-01T00:00:05.000Z" },
      providerTelemetry: { source: "PASEO_AGENT_SNAPSHOT", coverage: "PARTIAL", turnCount: 3, turns: [], toolCalls: [], snapshotUsage: { inputTokens: 225, outputTokens: 45, totalTokens: 270 } }
    })!;
    const operation = await loadOperation(root, operationId);
    const eventSummary = summarizeOperationEfficiencyV1({ ...operation, status: "SUCCEEDED" }, {
      participants: [first, replayedHistory], tools: [], context: [], retrieval: []
    });
    expect(eventSummary.usage).toMatchObject({ inputTokens: 150, outputTokens: 30, totalTokens: 180, partialObservations: 1, participantCount: 1 });
    expect(eventSummary.providerTurns).toBe(2);
    const snapshotSummary = summarizeOperationEfficiencyV1({ ...operation, status: "SUCCEEDED" }, {
      participants: [priorSnapshot, latestSnapshot], tools: [], context: [], retrieval: []
    });
    expect(snapshotSummary.usage).toMatchObject({ inputTokens: 225, outputTokens: 45, totalTokens: 270, partialObservations: 1, participantCount: 1 });
    expect(snapshotSummary.usage.byParticipant).toEqual([expect.objectContaining({ participantId, inputTokens: 225, outputTokens: 45, totalTokens: 270, usageCoverage: "PARTIAL" })]);
    expect(snapshotSummary.providerTurns).toBe(3);
  });

  it("keeps unknown provider usage unknown instead of estimating from context", async () => {
    const { operationId, candidate } = await fixture("CHANGE-EFFICIENCY-UNKNOWN");
    const participantId = "participant:unknown";
    const observation = participantUsageObservationFromSession({ operationId, participantId, role: "Planner", phase: "planning", candidate, session: boundSession({ operationId, participantId, sessionId: "session:unknown", candidate }), providerTelemetry: { source: "UNKNOWN", coverage: "UNKNOWN", turnCount: null, turns: [], toolCalls: [] } });
    expect(observation).toMatchObject({ usageKnown: false, usageSource: "UNKNOWN", inputTokens: null, totalTokens: null, costUsd: null, turnCount: null });
  });

  it("falls back to structured session usage when per-turn events contain no usage", async () => {
    const { operationId, candidate } = await fixture("CHANGE-EFFICIENCY-SNAPSHOT-FALLBACK");
    const participantId = "participant:snapshot-fallback";
    const observation = participantUsageObservationFromSession({
      operationId, participantId, role: "Planner", phase: "planning", candidate,
      session: boundSession({ operationId, participantId, sessionId: "session:snapshot-fallback", candidate }),
      providerTelemetry: {
        source: "PROVIDER_TURN_EVENTS",
        coverage: "PARTIAL",
        turnCount: 1,
        turns: [{ turnId: "turn-empty", turnIndex: 0, runtimeSessionId: null, provider: "openai", at: "2026-01-01T00:00:01.000Z", inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningOutputTokens: null, totalTokens: null, totalTokensBasis: "UNKNOWN", costUsd: null, usageKnown: false }],
        toolCalls: [],
        snapshotUsage: { inputTokens: 80, cachedInputTokens: 20, outputTokens: 10, totalTokens: 90, costUsd: 0.02 }
      }
    });
    expect(observation).toMatchObject({ usageKnown: true, usageSource: "PASEO_AGENT_SNAPSHOT", usageCoverage: "PARTIAL", inputTokens: 80, outputTokens: 10, totalTokens: 90, totalTokensBasis: "PROVIDER_REPORTED" });
  });

  it("writes one participant usage observation idempotently and never double-counts replay", async () => {
    const { root, operationId, candidate } = await fixture("CHANGE-EFFICIENCY-DEDUP", ["participant:dedup"]);
    const participantId = "participant:dedup";
    const claimed = await claimControllerEpoch(root, operationId, "controller:efficiency-usage-test");
    const policy = compileResolvedOperationPolicy({
      projectId: candidate.projectId!, operationId, operationExecutionRevision: claimed.operationExecutionRevision!, candidateRevision: candidate.revision, candidateDigest: candidate.identityDigest,
      controllerEpoch: currentControllerEpoch(claimed), intent: "usage observation test", route: "DIRECT", minimumAssurance: "STANDARD", policyVersions: {}, policyDigests: {},
      validationPolicy: {}, reviewPolicy: {}, deliveryPolicy: { allowedActions: [] }, knowledgePolicy: {}, contextPolicy: {}, allowedExternalEffects: [], humanDecisionRequirements: []
    });
    await bindResolvedOperationPolicy(root, operationId, policy);
    const binding = compileExecutionBinding({
      operationId, operationExecutionRevision: claimed.operationExecutionRevision!, candidateRevision: candidate.revision, candidateDigest: candidate.identityDigest,
      controllerEpoch: currentControllerEpoch(claimed), executionBlueprintDigest: "a".repeat(64), operationPolicyDigest: policy.digest,
      participantId, participantGeneration: "generation:dedup", roleInvocationPolicyDigest: "b".repeat(64), skillManifestDigest: "c".repeat(64),
      runtime: { runtimeId: "paseo", provider: "openai", modelId: "openai/test", model: "test-model", sessionId: "session:dedup" },
      contextManifestDigest: "d".repeat(64), promptManifestDigest: "e".repeat(64), outputContract: "implementer", leaseIdentities: []
    });
    await bindOperationParticipantExecution(root, operationId, { participantId, logicalAgent: "implementer", role: "Implementer", binding });
    const session = boundSession({ operationId, participantId, sessionId: "session:dedup", candidate, binding });
    const observation = participantUsageObservationFromSession({
      operationId,
      participantId,
      role: "Implementer",
      phase: "implementation",
      candidate,
      session,
      providerTelemetry: {
        source: "PROVIDER_TURN_EVENTS",
        coverage: "COMPLETE",
        turnCount: 1,
        turns: [{ turnId: "turn-dedup", turnIndex: 0, runtimeSessionId: null, provider: "openai", at: "2026-01-01T00:00:02.000Z", inputTokens: 5, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: null, totalTokens: 8, totalTokensBasis: "INPUT_PLUS_OUTPUT", costUsd: 0.001, usageKnown: true }],
        toolCalls: []
      }
    })!;

    expect(await recordParticipantUsageObservation(root, config, observation)).toBe(true);
    expect(await recordParticipantUsageObservation(root, config, observation)).toBe(true);
    const toolEvidence = capturePaseoTimelineV1({
      liveEvents: [],
      subscriptionReady: false,
      timelinePayload: {
        projection: "canonical", gap: false, reset: false, staleCursor: false, hasOlder: false,
        entries: [timelineEntry({ type: "tool_call", status: "completed", callId: "call-safe", name: "shell", detail: { type: "shell", command: "echo PRIVATE_ARGUMENT", output: "PRIVATE_RESULT", exitCode: 0 }, metadata: { server: "local-shell" }, error: null }, 1)]
      }
    });
    const toolInput = {
      operationId,
      participantId,
      role: "Implementer",
      phase: "implementation",
      candidate,
      operationExecutionRevision: 1,
      controllerEpoch: currentControllerEpoch(claimed),
      participantGeneration: session.executionBinding!.participantGeneration,
      sessionId: session.id!,
      observations: toolEvidence.evidence.toolCalls
    };
    expect(await recordToolCallObservations(root, config, toolInput)).toBe(1);
    expect(await recordToolCallObservations(root, config, toolInput)).toBe(1);
    const observations = await readOperationEfficiencyObservations(root, operationId);
    expect(observations.participants).toHaveLength(1);
    expect(observations.tools).toHaveLength(1);
    expect(JSON.stringify(observations.tools)).not.toContain("PRIVATE_ARGUMENT");
    expect(JSON.stringify(observations.tools)).not.toContain("PRIVATE_RESULT");
    expect(summarizeOperationEfficiencyV1(await loadOperation(root, operationId), observations)).toMatchObject({
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8, knownParticipants: 1, participantCount: 1 },
      tools: { toolCalls: 1, firstAttemptSuccesses: 1 }
    });
    const terminal = { ...await loadOperation(root, operationId), status: "SUCCEEDED" as const, finishedAt: "2026-01-01T00:01:00.000Z", result: { status: "PASS", acceptanceOracle: { disposition: "ACCEPTED" }, delivery: { status: "FINALIZED" } } };
    const persistedSummary = await writeOperationEfficiencySummary(root, config, terminal);
    expect(persistedSummary).toMatchObject({ terminalStatus: "SUCCEEDED", outcome: { accepted: true, delivered: true } });
    expect(await readOperationEfficiencySummary(root, terminal)).toEqual(persistedSummary);
  });

  it("captures canonical Paseo tool calls without persisting sensitive arguments or results", () => {
    const evidence = capturePaseoTimelineV1({
      liveEvents: [],
      subscriptionReady: false,
      timelinePayload: {
        projection: "canonical", gap: false, reset: false, staleCursor: false, hasOlder: false,
        entries: [timelineEntry({ type: "tool_call", status: "completed", callId: "call-secret", name: "shell", detail: { type: "shell", command: "echo PRIVATE_TOKEN", cwd: "/tmp", output: "PRIVATE_OUTPUT", exitCode: 0 }, metadata: { server: "local-shell" }, error: null }, 1)]
      }
    });
    const serialized = JSON.stringify(evidence);
    expect(evidence.evidence.toolCalls).toHaveLength(1);
    expect(evidence.evidence.toolCalls[0]).toMatchObject({ callId: "call-secret", toolName: "shell", toolServer: "local-shell", outcome: "SUCCESS" });
    expect(evidence.evidence.toolCalls[0]?.argumentsDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.evidence.toolCalls[0]?.argumentsByteLength).toBeGreaterThan(0);
    expect(evidence.evidence.toolCalls[0]?.resultByteLength).toBe(Buffer.byteLength("PRIVATE_OUTPUT"));
    expect(serialized).not.toContain("PRIVATE_TOKEN");
    expect(serialized).not.toContain("PRIVATE_OUTPUT");
  });

  it("maps structured tool errors and leaves missing terminal events as unknown", () => {
    const evidence = capturePaseoTimelineV1({
      liveEvents: [],
      subscriptionReady: false,
      timelinePayload: {
        projection: "canonical", gap: false, reset: false, staleCursor: false, hasOlder: false,
        entries: [
          timelineEntry({ type: "tool_call", status: "failed", callId: "permission", name: "mcp__github__write", detail: { type: "unknown", input: { issue: "private" }, output: "not persisted" }, metadata: {}, error: { code: "permission_denied", message: "private error" } }, 1),
          timelineEntry({ type: "tool_call", status: "running", callId: "unfinished", name: "mcp__context7__search", detail: { type: "plain_text", text: "private query" }, metadata: {}, error: null }, 2),
          timelineEntry({ type: "tool_call", status: "failed", callId: "unknown-error", name: "mcp__context7__fetch", detail: { type: "unknown", input: { id: "private" } }, metadata: {}, error: { code: "provider_specific_failure", message: "private error" } }, 3)
        ]
      }
    });
    expect(evidence.evidence.toolCalls.map((item) => item.outcome)).toEqual(["PERMISSION_DENIED", "UNKNOWN_ERROR", "TOOL_ERROR"]);
    expect(JSON.stringify(evidence)).not.toContain("private query");
    expect(JSON.stringify(evidence)).not.toContain("private error");
  });

  it("retains calls without provider call ids as unknown and does not infer retries", () => {
    const evidence = capturePaseoTimelineV1({
      liveEvents: [],
      subscriptionReady: false,
      timelinePayload: {
        projection: "canonical", gap: false, reset: false, staleCursor: false, hasOlder: false,
        entries: [timelineEntry({ type: "tool_call", status: "completed", name: "read_file", detail: { type: "read", filePath: "src/a.ts" }, metadata: {}, error: null }, 1)]
      }
    });
    expect(evidence.evidence.toolCalls).toMatchObject([{ callId: null, outcome: "SUCCESS" }]);
    expect(correlateEquivalentToolCalls(evidence.evidence.toolCalls)).toMatchObject([{ callId: null, attemptIndex: null, retryOfCallId: null, causalStatus: "UNKNOWN" }]);
    expect(evidence.completeness).toBe("PARTIAL");
  });

  it("links a same-turn failed equivalent call to a successful retry and separates other turns", () => {
    const digest = sha256Canonical({ path: "src/file.ts" });
    const correlated = correlateEquivalentToolCalls([
      toolCall({ callId: "fail-1", turnId: "turn-1", timelineSequence: 1, argumentsDigest: digest, toolName: "read_file", outcome: "TOOL_ERROR" }),
      toolCall({ callId: "success-2", turnId: "turn-1", timelineSequence: 2, argumentsDigest: digest, toolName: "read_file", outcome: "SUCCESS" }),
      toolCall({ callId: "legitimate-next-turn", turnId: "turn-2", turnIndex: 1, timelineSequence: 3, argumentsDigest: digest, toolName: "read_file", outcome: "SUCCESS" })
    ]);
    expect(correlated.map((item) => ({ attemptIndex: item.attemptIndex, retryOfCallId: item.retryOfCallId, causalStatus: item.causalStatus }))).toEqual([
      { attemptIndex: 1, retryOfCallId: null, causalStatus: "PROVEN" },
      { attemptIndex: 2, retryOfCallId: "fail-1", causalStatus: "PROVEN" },
      { attemptIndex: 1, retryOfCallId: null, causalStatus: "PROVEN" }
    ]);
    const withoutTurnIdentity = correlateEquivalentToolCalls([
      toolCall({ callId: "a", turnId: null, timelineSequence: 1, argumentsDigest: digest, toolName: "read_file", outcome: "TOOL_ERROR" }),
      toolCall({ callId: "b", turnId: null, timelineSequence: 2, argumentsDigest: digest, toolName: "read_file", outcome: "SUCCESS" })
    ]);
    expect(withoutTurnIdentity[1]).toMatchObject({ attemptIndex: 2, retryOfCallId: null, causalStatus: "UNKNOWN" });
  });

  it("counts a recovered retry chain once and leaves unrelated calls outside the chain", async () => {
    const { root, operationId, candidate } = await fixture("CHANGE-EFFICIENCY-RETRY-CHAIN");
    const digest = sha256Canonical({ path: "same" });
    const correlated = correlateEquivalentToolCalls([
      toolCall({ callId: "chain-fail-1", turnId: "turn-chain", timelineSequence: 1, argumentsDigest: digest, toolName: "read_file", outcome: "TOOL_ERROR" }),
      toolCall({ callId: "chain-fail-2", turnId: "turn-chain", timelineSequence: 2, argumentsDigest: digest, toolName: "read_file", outcome: "TIMEOUT" }),
      toolCall({ callId: "chain-success", turnId: "turn-chain", timelineSequence: 3, argumentsDigest: digest, toolName: "read_file", outcome: "SUCCESS" }),
      toolCall({ callId: "other-turn", turnId: "turn-other", turnIndex: 1, timelineSequence: 4, argumentsDigest: digest, toolName: "read_file", outcome: "SUCCESS" })
    ]);
    const tools = correlated.map((item) => toolCallObservationV1Schema.parse({
      version: 1, observationId: sha256Canonical(item), operationId, candidateId: candidate.candidateId,
      candidateRevision: candidate.revision, candidateDigest: candidate.identityDigest, operationExecutionRevision: 1,
      controllerEpoch: 0, participantId: "participant:retry-chain", sessionId: "session:retry-chain", role: "Implementer",
      phase: "implementation", ...item
    }));
    const operation = await loadOperation(root, operationId);
    const summary = summarizeOperationEfficiencyV1({ ...operation, status: "FAILED" }, { participants: [], tools, context: [], retrieval: [] });
    expect(summary.tools).toMatchObject({ toolCalls: 4, firstAttemptSuccesses: 1, failedFirstAttempts: 1, retryCalls: 2, recoveredAfterRetry: 1, repeatedEquivalentCalls: 2, unrecoveredToolFailures: 0 });
  });

  it("deduplicates context observations, derives cross-participant fragment reuse, and rejects stale correlation", async () => {
    const { root, operationId, candidate } = await fixture("CHANGE-EFFICIENCY-CONTEXT", ["participant:a", "participant:b"]);
    const digest = sha256Utf8("fragment body, not stored in the efficiency record");
    const first = contextObservation({ operationId, participantId: "participant:a", candidate, contentDigest: digest, deliveredTokens: 12 });
    const second = contextObservation({ operationId, participantId: "participant:b", candidate, envelopeDigest: sha256Canonical("review envelope"), contentDigest: digest, deliveredTokens: 12 });
    const before = await loadOperation(root, operationId);
    expect(before.candidateRevision).toEqual(candidate);
    expect(before.operationExecutionRevision).toBe(1);
    expect(before.controller?.epoch ?? 0).toBe(0);
    expect(Object.keys(before.participants)).toEqual(expect.arrayContaining(["participant:a", "participant:b"]));
    expect(await recordContextAccountingObservation(root, config, first)).toBe(true);
    expect(await recordContextAccountingObservation(root, config, first)).toBe(true);
    expect(await recordContextAccountingObservation(root, config, second)).toBe(true);
    const observations = await readOperationEfficiencyObservations(root, operationId);
    expect(observations.context).toHaveLength(2);
    const retrieval = (participantId: string, requestId: string, fragmentId: string, contentDigest: string, estimatedTokens: number) => contextRetrievalObservationV1Schema.parse({
      version: 1, operationId, candidateId: candidate.candidateId, candidateRevision: candidate.revision, candidateDigest: candidate.identityDigest,
      operationExecutionRevision: 1, controllerEpoch: 0, participantId, generation: null, role: "Implementer", phase: "implementation",
      sessionId: `session:${participantId}`, requestId, fragmentId, contentDigest, estimatedTokens, repeated: false,
      retrievedAt: "2026-01-01T00:00:05.000Z", tokenBasis: "AEH_ESTIMATOR"
    });
    const withRetrieval = { ...observations, retrieval: [
      retrieval("participant:a", "request:a", "retrieved-fragment", digest, 9),
      retrieval("participant:b", "request:b", "retrieved-fragment", digest, 9),
      retrieval("participant:b", "request:b", "another-fragment", sha256Utf8("different fragment"), 4)
    ] };
    const summary = summarizeOperationEfficiencyV1({ ...before, status: "SUCCEEDED", finishedAt: "2026-01-01T00:01:00.000Z" }, withRetrieval);
    expect(summary.context).toMatchObject({ rawContextTokens: 200, projectedContextTokens: 100, deliveredContextTokens: 40, retrievalRequestCount: 2, retrievalDeliveredTokens: 22, crossParticipantRepeatedFragmentTokens: 21, tokenBasis: "AEH_ESTIMATOR" });
    expect(JSON.stringify(observations)).not.toContain("fragment body");

    const stale = { ...contextObservation({ operationId, participantId: "participant:a", candidate, envelopeDigest: sha256Canonical("stale"), contentDigest: digest }), candidate: { ...candidate, candidateId: `${candidate.candidateId}:stale`, identityDigest: "f".repeat(64) } };
    expect(await recordContextAccountingObservation(root, config, stale)).toBe(false);
    expect((await loadOperation(root, operationId)).candidateRevision).toEqual(before.candidateRevision);
  });

  it("keeps efficiency observations outside ObjectiveCompletion and operation policy state", async () => {
    const { root, operationId, candidate } = await fixture("CHANGE-EFFICIENCY-OBSERVATIONAL", ["participant:read-only-observer"]);
    const participantId = "participant:read-only-observer";
    const claimed = await claimControllerEpoch(root, operationId, "controller:efficiency-test");
    process.env.AEH_OPERATION_ID = operationId;
    process.env.AEH_CONTROL_ROOT = root;
    process.env.AEH_OPERATION_STATE_REDIRECT = "0";
    const policy = compileResolvedOperationPolicy({
      projectId: candidate.projectId!,
      operationId,
      operationExecutionRevision: claimed.operationExecutionRevision!,
      candidateRevision: candidate.revision,
      candidateDigest: candidate.identityDigest,
      controllerEpoch: currentControllerEpoch(claimed),
      intent: "observational boundary test",
      route: "DIRECT",
      minimumAssurance: "STANDARD",
      policyVersions: {},
      policyDigests: {},
      validationPolicy: {},
      reviewPolicy: {},
      deliveryPolicy: { githubEnabled: false, allowedActions: [], allowedExternalEffects: [] },
      knowledgePolicy: {},
      contextPolicy: {},
      allowedExternalEffects: [],
      humanDecisionRequirements: []
    });
    await bindResolvedOperationPolicy(root, operationId, policy);
    const before = await loadOperation(root, operationId);
    const objective = {
      version: 1 as const,
      identity: { operationId, candidate, policyDigest: policy.digest, operationExecutionRevision: 1, controllerEpoch: currentControllerEpoch(before) },
      workspaceCandidate: candidate,
      workGraph: { requiredWorkUnitIds: ["unit-1"], accountedWorkUnitIds: [] },
      validation: { requiredAssertionIds: ["assertion-1"], evidence: [] },
      review: { requiredAssertionIds: [], evidence: [] },
      acceptance: { disposition: "REJECTED" as const, requiredAssertionIds: ["assertion-1"], coveredAssertionIds: [], identity: { operationId, candidate, policyDigest: policy.digest, operationExecutionRevision: 1, controllerEpoch: currentControllerEpoch(before) } },
      certification: { required: false },
      delivery: { required: false, disposition: "NOT_REQUIRED" as const },
      findings: [],
      participants: [],
      terminalIdentity: { operationId, candidate, policyDigest: policy.digest, operationExecutionRevision: 1, controllerEpoch: currentControllerEpoch(before) }
    };
    const beforeDecision = evaluateObjectiveCompletionV1(objective);
    const pushRequest: ToolActionRequestV1 = {
      root,
      operationId,
      participantId: controllerActorId(operationId),
      candidate,
      actionKey: "delivery:observational-test:push",
      action: "git.push",
      payload: { remote: "origin", ref: "feature/observational-test", expectedCommit: "a".repeat(40) },
      authority: { kind: "controller-authority", operationId, controllerEpoch: currentControllerEpoch(before) }
    };
    await expect(authorizeToolAction(pushRequest)).rejects.toThrow("TOOL_ACTION_POLICY_DENIED");
    const observation = contextObservation({ operationId, participantId, candidate, controllerEpoch: currentControllerEpoch(before) });
    expect(await recordContextAccountingObservation(root, config, observation)).toBe(true);
    const after = await loadOperation(root, operationId);
    expect(after.intent).toEqual(before.intent);
    expect(after.resolvedOperationPolicy?.digest).toBe(before.resolvedOperationPolicy?.digest);
    expect(after.candidateRevision).toEqual(before.candidateRevision);
    expect(evaluateObjectiveCompletionV1(objective)).toEqual(beforeDecision);
    await expect(authorizeToolAction(pushRequest)).rejects.toThrow("TOOL_ACTION_POLICY_DENIED");
  });
});
