import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { HarnessProjectConfig, UsageMetrics, WorkerSession } from "../core/types.js";
import { sha256Canonical, sha256Utf8 } from "../core/digest.js";
import { isTerminalOperation, loadOperation, resolveOperationStateRoot, withOperationCoordinationLock, type OperationRecordV2 } from "../operations/state.js";
import { extractUsageMetrics } from "../metrics/usage.js";
import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { readExecutionActivityEventsV1, type ExecutionActivityEventV1 } from "../operations/executionLiveness.js";

const nullableCount = z.number().int().nonnegative().nullable();
const nullableCost = z.number().finite().nonnegative().nullable();
const nullableTime = z.string().datetime().nullable();

export const providerTurnUsageObservationV2Schema = z.object({
  turnId: z.string().min(1).nullable(),
  turnIndex: z.number().int().nonnegative().nullable(),
  runtimeSessionId: z.string().min(1).nullable(),
  provider: z.string().min(1),
  at: nullableTime,
  startedAt: nullableTime.optional(),
  finishedAt: nullableTime.optional(),
  inputTokens: nullableCount,
  cachedInputTokens: nullableCount,
  outputTokens: nullableCount,
  reasoningOutputTokens: nullableCount,
  totalTokens: nullableCount,
  totalTokensBasis: z.enum(["PROVIDER_REPORTED", "INPUT_PLUS_OUTPUT", "UNKNOWN"]),
  costUsd: nullableCost,
  usageKnown: z.boolean()
}).strict();
export type ProviderTurnUsageObservationV2 = z.infer<typeof providerTurnUsageObservationV2Schema>;

export const participantUsageObservationV2Schema = z.object({
  version: z.literal(2),
  observationId: z.string().regex(/^[a-f0-9]{64}$/),
  operationId: z.string().min(1),
  candidateId: z.string().min(1),
  candidateRevision: z.number().int().positive(),
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  operationExecutionRevision: z.number().int().positive(),
  controllerEpoch: z.number().int().nonnegative(),
  participantId: z.string().min(1),
  generation: z.string().min(1).nullable(),
  role: z.string().min(1),
  phase: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1).nullable(),
  runtimeSessionId: z.string().min(1).nullable(),
  turnCount: z.number().int().nonnegative().nullable(),
  inputTokens: nullableCount,
  cachedInputTokens: nullableCount,
  outputTokens: nullableCount,
  reasoningOutputTokens: nullableCount,
  totalTokens: nullableCount,
  totalTokensBasis: z.enum(["PROVIDER_REPORTED", "INPUT_PLUS_OUTPUT", "UNKNOWN"]),
  costUsd: nullableCost,
  usageKnown: z.boolean(),
  usageSource: z.enum(["PROVIDER_TURN_EVENTS", "PASEO_AGENT_SNAPSHOT", "PASEO_ADAPTER", "AEH_TEXT_EXTRACTION", "UNKNOWN"]),
  usageCoverage: z.enum(["COMPLETE", "PARTIAL", "UNKNOWN"]),
  startedAt: nullableTime,
  lastActivityAt: nullableTime,
  finishedAt: nullableTime,
  durationMs: nullableCount,
  resultStatus: z.enum(["SUCCEEDED", "FAILED", "BLOCKED", "UNKNOWN"]),
  turnUsage: z.array(providerTurnUsageObservationV2Schema)
}).strict();
export type ParticipantUsageObservationV2 = z.infer<typeof participantUsageObservationV2Schema>;

export const toolCallObservationV2Schema = z.object({
  version: z.literal(2),
  observationId: z.string().regex(/^[a-f0-9]{64}$/),
  operationId: z.string().min(1),
  candidateId: z.string().min(1),
  candidateRevision: z.number().int().positive(),
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  operationExecutionRevision: z.number().int().positive(),
  controllerEpoch: z.number().int().nonnegative(),
  participantId: z.string().min(1),
  sessionId: z.string().min(1),
  role: z.string().min(1),
  phase: z.string().min(1),
  turnId: z.string().min(1).nullable(),
  turnIndex: z.number().int().nonnegative().nullable(),
  timelineSequence: z.number().int().nonnegative().nullable(),
  toolServer: z.string().min(1).nullable(),
  provider: z.string().min(1).nullable(),
  toolName: z.string().min(1),
  callId: z.string().min(1).nullable(),
  attemptIndex: z.number().int().positive().nullable(),
  argumentsDigest: z.string().regex(/^[a-f0-9]{64}$/),
  argumentsByteLength: z.number().int().nonnegative().nullable(),
  startedAt: nullableTime,
  finishedAt: nullableTime,
  durationMs: nullableCount,
  outcome: z.enum(["SUCCESS", "TOOL_ERROR", "PERMISSION_DENIED", "TIMEOUT", "INVALID_ARGUMENT", "UNAVAILABLE", "CANCELLED", "UNKNOWN_ERROR"]),
  resultByteLength: z.number().int().nonnegative().nullable(),
  errorFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  retryOfCallId: z.string().min(1).nullable(),
  causalStatus: z.enum(["PROVEN", "EQUIVALENT_ONLY", "UNKNOWN"])
}).strict();
export type ToolCallObservationV2 = z.infer<typeof toolCallObservationV2Schema>;

export const contextAccountingObservationV2Schema = z.object({
  version: z.literal(2),
  observationId: z.string().regex(/^[a-f0-9]{64}$/),
  operationId: z.string().min(1),
  candidateId: z.string().min(1),
  candidateRevision: z.number().int().positive(),
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  operationExecutionRevision: z.number().int().positive(),
  controllerEpoch: z.number().int().nonnegative(),
  participantId: z.string().min(1),
  generation: z.string().min(1).nullable(),
  role: z.string().min(1),
  logicalAgent: z.string().min(1),
  phase: z.string().min(1),
  runtimeSessionId: z.string().min(1).nullable(),
  envelopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  rawContextTokens: nullableCount,
  projectedContextTokens: nullableCount,
  deliveredContextTokens: nullableCount,
  retrievalRequestCount: z.number().int().nonnegative(),
  retrievalDeliveredTokens: z.number().int().nonnegative(),
  fragmentIdentities: z.array(z.object({ fragmentId: z.string().min(1), contentDigest: z.string().regex(/^[a-f0-9]{64}$/), deliveredTokens: z.number().int().nonnegative() }).strict()),
  tokenBasis: z.literal("AEH_ESTIMATOR")
}).strict();
export type ContextAccountingObservationV2 = z.infer<typeof contextAccountingObservationV2Schema>;

export const contextRetrievalObservationV2Schema = z.object({
  version: z.literal(2),
  operationId: z.string().min(1),
  candidateId: z.string().min(1),
  candidateRevision: z.number().int().positive(),
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  operationExecutionRevision: z.number().int().positive(),
  controllerEpoch: z.number().int().nonnegative(),
  participantId: z.string().min(1),
  generation: z.string().min(1).nullable(),
  role: z.string().min(1),
  phase: z.string().min(1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  fragmentId: z.string().min(1),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  estimatedTokens: z.number().int().nonnegative(),
  repeated: z.boolean(),
  retrievedAt: z.string().datetime(),
  tokenBasis: z.literal("AEH_ESTIMATOR")
}).strict();
export type ContextRetrievalObservationV2 = z.infer<typeof contextRetrievalObservationV2Schema>;

export const operationEfficiencySummaryV2Schema = z.object({
  version: z.literal(2),
  operationId: z.string().min(1),
  terminalStatus: z.enum(["SUCCEEDED", "FAILED", "CANCELLED", "UNKNOWN"]),
  route: z.string().nullable(),
  assurance: z.string().nullable(),
  currentCandidateId: z.string().min(1).nullable(),
  currentCandidateRevision: z.number().int().positive().nullable(),
  currentCandidateDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  participants: z.number().int().nonnegative(),
  participantGenerations: z.number().int().nonnegative(),
  providerTurns: z.number().int().nonnegative().nullable(),
  budgets: z.object({
    providerTurns: z.object({
      scope: z.literal("PER_PARTICIPANT"),
      participantCount: z.number().int().nonnegative(),
      observed: nullableCount,
      initialPerParticipant: nullableCount,
      initialAggregateEquivalent: nullableCount,
      currentAllowanceAggregate: nullableCount,
      supervisorCeilingPerParticipant: nullableCount,
      supervisorCeilingAggregateEquivalent: nullableCount,
      hardCeilingPerParticipant: nullableCount,
      hardCeilingAggregateEquivalent: nullableCount,
      softThreshold: z.number().gt(0).lt(1).nullable()
    }).strict(),
    toolCalls: z.object({ observed: nullableCount, hardLimit: nullableCount }).strict(),
    tokenUsage: z.object({ observed: nullableCount, hardLimit: nullableCount, coverage: z.enum(["COMPLETE", "PARTIAL", "UNKNOWN"]) }).strict(),
    cost: z.object({ observedUsd: nullableCost, hardLimitUsd: nullableCost, coverage: z.enum(["COMPLETE", "PARTIAL", "UNKNOWN"]) }).strict(),
    recovery: z.object({ localRetries: nullableCount, localRetryLimit: nullableCount, participantRestarts: nullableCount, participantRestartLimit: nullableCount, noProgressRenewals: nullableCount, progressLeaseRenewals: nullableCount }).strict(),
    hardDeadlineAt: nullableTime
  }).strict(),
  usage: z.object({
    inputTokens: nullableCount,
    cachedInputTokens: nullableCount,
    outputTokens: nullableCount,
    reasoningOutputTokens: nullableCount,
    totalTokens: nullableCount,
    totalTokensBasis: z.enum(["PROVIDER_REPORTED", "INPUT_PLUS_OUTPUT", "UNKNOWN"]),
    costUsd: nullableCost,
    knownParticipants: z.number().int().nonnegative(),
    participantCount: z.number().int().nonnegative(),
    costKnownParticipants: z.number().int().nonnegative(),
    completeObservations: z.number().int().nonnegative(),
    partialObservations: z.number().int().nonnegative(),
    unknownObservations: z.number().int().nonnegative(),
    byParticipant: z.array(z.object({
      participantId: z.string().min(1),
      generations: z.number().int().nonnegative(),
      roles: z.array(z.string().min(1)),
      inputTokens: nullableCount,
      cachedInputTokens: nullableCount,
      outputTokens: nullableCount,
      reasoningOutputTokens: nullableCount,
      totalTokens: nullableCount,
      costUsd: nullableCost,
      usageKnown: z.boolean(),
      usageCoverage: z.enum(["COMPLETE", "PARTIAL", "UNKNOWN"])
    }).strict())
  }).strict(),
  context: z.object({
    rawContextTokens: z.number().int().nonnegative(),
    projectedContextTokens: z.number().int().nonnegative(),
    deliveredContextTokens: z.number().int().nonnegative(),
    retrievalRequestCount: z.number().int().nonnegative(),
    retrievalDeliveredTokens: z.number().int().nonnegative(),
    crossParticipantRepeatedFragmentTokens: z.number().int().nonnegative(),
    tokenBasis: z.literal("AEH_ESTIMATOR")
  }).strict(),
  tools: z.object({
    toolCalls: z.number().int().nonnegative(),
    firstAttemptSuccesses: z.number().int().nonnegative(),
    failedFirstAttempts: z.number().int().nonnegative(),
    retryCalls: z.number().int().nonnegative(),
    recoveredAfterRetry: z.number().int().nonnegative(),
    repeatedEquivalentCalls: z.number().int().nonnegative(),
    unrecoveredToolFailures: z.number().int().nonnegative(),
    unknownCausalRetries: z.number().int().nonnegative(),
    failuresByClass: z.record(z.string(), z.number().int().nonnegative()),
    retryAssociatedInputTokens: nullableCount,
    retryAssociatedOutputTokens: nullableCount,
    retryAssociatedTotalTokens: nullableCount,
    retryUsageCoverage: z.enum(["COMPLETE", "PARTIAL", "UNKNOWN"])
  }).strict(),
  activity: z.object({
    timeToFirstToolCallMs: nullableCount,
    timeToFirstMutationMs: nullableCount,
    timeSinceLastMeaningfulProgressMs: nullableCount,
    toolCallsBeforeFirstMutation: nullableCount,
    turnsBeforeFirstMutation: nullableCount,
    tokensBeforeFirstMutation: nullableCount,
    repositoryMutationCount: nullableCount,
    artifactCount: nullableCount,
    validationCount: nullableCount
  }).strict(),
  workflow: z.object({ repairRounds: z.number().int().nonnegative(), candidateRevisions: z.number().int().nonnegative(), reviewRounds: z.number().int().nonnegative(), humanInterventions: z.number().int().nonnegative().nullable() }).strict(),
  timing: z.object({ totalDurationMs: nullableCount, participantDurationMs: nullableCount, activeProviderDurationMs: nullableCount, toolWaitDurationMs: nullableCount }).strict(),
  outcome: z.object({ accepted: z.boolean().nullable(), delivered: z.boolean().nullable() }).strict(),
  generatedAt: z.string().datetime()
}).strict();
export type OperationEfficiencySummaryV2 = z.infer<typeof operationEfficiencySummaryV2Schema>;

export interface ProviderTelemetryEvidenceV2 {
  version: 2;
  source: "PROVIDER_TURN_EVENTS" | "PASEO_AGENT_SNAPSHOT" | "PASEO_ADAPTER" | "UNKNOWN";
  coverage: "COMPLETE" | "PARTIAL" | "UNKNOWN";
  turnCount: number | null;
  turns: ProviderTurnUsageObservationV2[];
  toolCalls: ProviderToolCallEvidenceV2[];
  snapshotUsage?: UsageMetrics;
}
export type ProviderToolCallEvidenceV2 = Omit<ToolCallObservationV2, "version" | "observationId" | "operationId" | "candidateId" | "candidateRevision" | "candidateDigest" | "operationExecutionRevision" | "controllerEpoch" | "participantId" | "sessionId" | "role" | "phase" | "attemptIndex" | "retryOfCallId" | "causalStatus"> & { retryOfCallId?: string | null };

const EFFICIENCY_ROOT = path.join(".harness", "telemetry", "efficiency", "operations");

export function participantUsageObservationFromSession(input: {
  operationId: string;
  participantId: string;
  role: string;
  phase: string;
  candidate: CandidateRevisionV1;
  session: WorkerSession;
  providerTelemetry?: ProviderTelemetryEvidenceV2;
  lastActivityAt?: string;
  resultStatus?: ParticipantUsageObservationV2["resultStatus"];
}): ParticipantUsageObservationV2 | undefined {
  const binding = input.session.executionBinding;
  if (!binding || binding.participantId !== input.participantId || binding.operationId !== input.operationId
    || binding.candidateRevision !== input.candidate.revision || binding.candidateDigest !== input.candidate.identityDigest) return undefined;

  const telemetry = input.providerTelemetry;
  const turns = (telemetry?.turns ?? []).map((turn) => ({ ...turn, runtimeSessionId: binding.runtime.sessionId }));
  let usageSource: ParticipantUsageObservationV2["usageSource"] = "UNKNOWN";
  let usageCoverage: ParticipantUsageObservationV2["usageCoverage"] = "UNKNOWN";
  let metrics: UsageMetrics = {};
  let totalTokensBasis: ParticipantUsageObservationV2["totalTokensBasis"] = "UNKNOWN";
  let turnCount: number | null = telemetry?.turnCount ?? null;
  if (turns.some((turn) => turn.usageKnown)) {
    usageSource = "PROVIDER_TURN_EVENTS";
    usageCoverage = telemetry?.coverage ?? "PARTIAL";
    turnCount = telemetry?.turnCount ?? new Set(turns.map((turn) => turn.turnId ?? `index:${turn.turnIndex}`)).size;
    metrics = sumTurnUsage(turns);
    const knownTotalBases = new Set(turns.filter((turn) => turn.totalTokens !== null).map((turn) => turn.totalTokensBasis));
    totalTokensBasis = knownTotalBases.size === 1 ? [...knownTotalBases][0]! : "UNKNOWN";
  } else if (telemetry?.snapshotUsage && Object.values(telemetry.snapshotUsage).some((value) => value !== undefined)) {
    usageSource = "PASEO_AGENT_SNAPSHOT";
    usageCoverage = "PARTIAL";
    metrics = { ...telemetry.snapshotUsage };
    totalTokensBasis = metrics.totalTokens !== undefined ? "PROVIDER_REPORTED" : "UNKNOWN";
  } else if (input.session.metrics && Object.values(input.session.metrics).some((value) => value !== undefined)) {
    usageSource = "PASEO_ADAPTER";
    usageCoverage = "PARTIAL";
    metrics = { ...input.session.metrics };
    totalTokensBasis = metrics.totalTokens !== undefined ? "PROVIDER_REPORTED" : "UNKNOWN";
  } else {
    const extracted = extractUsageMetrics(`${input.session.stdout}\n${input.session.stderr}`);
    if (Object.keys(extracted).length) {
      usageSource = "AEH_TEXT_EXTRACTION";
      usageCoverage = "PARTIAL";
      metrics = extracted;
      totalTokensBasis = "UNKNOWN";
    }
  }

  const startedAt = validTimestamp(input.session.startedAt);
  const lastActivityAt = validTimestamp(input.lastActivityAt);
  const finishedAt = validTimestamp(input.session.finishedAt);
  const durationMs = startedAt && finishedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) : null;
  const usageKnown = usageCoverage !== "UNKNOWN" && Object.values(metrics).some((value) => value !== undefined);
  const body = {
    version: 2 as const,
    operationId: input.operationId,
    candidateId: input.candidate.candidateId,
    candidateRevision: input.candidate.revision,
    candidateDigest: input.candidate.identityDigest,
    operationExecutionRevision: binding.operationExecutionRevision,
    controllerEpoch: binding.controllerEpoch,
    participantId: input.participantId,
    generation: binding.participantGeneration,
    role: input.role,
    phase: input.phase,
    provider: telemetry?.turns[0]?.provider ?? input.session.provider,
    model: input.session.model ?? binding.runtime.model,
    runtimeSessionId: input.session.id ?? binding.runtime.sessionId,
    turnCount,
    inputTokens: metrics.inputTokens ?? null,
    cachedInputTokens: metrics.cachedInputTokens ?? null,
    outputTokens: metrics.outputTokens ?? null,
    reasoningOutputTokens: metrics.reasoningOutputTokens ?? null,
    totalTokens: metrics.totalTokens ?? null,
    totalTokensBasis,
    costUsd: metrics.costUsd ?? null,
    usageKnown,
    usageSource,
    usageCoverage,
    startedAt,
    lastActivityAt,
    finishedAt,
    durationMs,
    resultStatus: input.resultStatus ?? (input.session.exitCode === 0 ? "SUCCEEDED" as const : "FAILED" as const),
    turnUsage: turns
  };
  return participantUsageObservationV2Schema.parse({ ...body, observationId: sha256Canonical(body) });
}

export async function recordParticipantUsageObservation(root: string, config: HarnessProjectConfig, observation: ParticipantUsageObservationV2): Promise<boolean> {
  void config; // Local observational artifacts are retained independently of optional external exporters.
  const parsed = participantUsageObservationV2Schema.parse(observation);
  const stateRoot = resolveOperationStateRoot(root);
  return withOperationCoordinationLock(stateRoot, parsed.operationId, async () => {
    const operation = await loadOperation(stateRoot, parsed.operationId);
    if (isTerminalOperation(operation.status) || !await currentEfficiencyBindingMatches(stateRoot, parsed)) return false;
    return writeObservationOnce(stateRoot, parsed.operationId, "participants", parsed.observationId, parsed);
  });
}

export async function recordToolCallObservations(root: string, config: HarnessProjectConfig, input: {
  operationId: string; participantId: string; role: string; phase: string; candidate: CandidateRevisionV1;
  operationExecutionRevision: number; controllerEpoch: number; participantGeneration: string; sessionId: string;
  observations: ProviderTelemetryEvidenceV2["toolCalls"];
}): Promise<number> {
  void config;
  const correlated = correlateEquivalentToolCalls(input.observations);
  const complete = correlated.map((observation) => {
    const base = {
      version: 2 as const,
      operationId: input.operationId,
      candidateId: input.candidate.candidateId,
      candidateRevision: input.candidate.revision,
      candidateDigest: input.candidate.identityDigest,
      operationExecutionRevision: input.operationExecutionRevision,
      controllerEpoch: input.controllerEpoch,
      participantId: input.participantId,
      sessionId: input.sessionId,
      role: input.role,
      phase: input.phase,
      ...observation
    };
    const identity = sha256Canonical(base);
    return toolCallObservationV2Schema.parse({ ...base, observationId: identity });
  });
  let stored = 0;
  for (const observation of complete) {
    if (!await currentEfficiencyBindingMatches(root, observation)) continue;
    if (await writeObservationOnce(root, observation.operationId, "tools", observation.observationId, observation)) stored += 1;
  }
  return stored;
}

export async function recordContextAccountingObservation(root: string, config: HarnessProjectConfig, input: {
  operationId: string; participantId?: string; generation?: string; role: string; logicalAgent: string; phase: string;
  candidate: CandidateRevisionV1; operationExecutionRevision: number; controllerEpoch: number; runtimeSessionId?: string;
  envelopeDigest: string; rawContextTokens: number; projectedContextTokens: number; deliveredContextTokens: number;
  fragmentIdentities: Array<{ fragmentId: string; contentDigest: string; deliveredTokens: number }>;
}): Promise<boolean> {
  void config;
  if (!input.participantId) return false;
  const body = {
    version: 2 as const,
    operationId: input.operationId,
    candidateId: input.candidate.candidateId,
    candidateRevision: input.candidate.revision,
    candidateDigest: input.candidate.identityDigest,
    operationExecutionRevision: input.operationExecutionRevision,
    controllerEpoch: input.controllerEpoch,
    participantId: input.participantId,
    generation: input.generation ?? null,
    role: input.role,
    logicalAgent: input.logicalAgent,
    phase: input.phase,
    runtimeSessionId: input.runtimeSessionId ?? null,
    envelopeDigest: input.envelopeDigest,
    rawContextTokens: input.rawContextTokens,
    projectedContextTokens: input.projectedContextTokens,
    deliveredContextTokens: input.deliveredContextTokens,
    retrievalRequestCount: 0,
    retrievalDeliveredTokens: 0,
    fragmentIdentities: input.fragmentIdentities,
    tokenBasis: "AEH_ESTIMATOR" as const
  };
  const observation = contextAccountingObservationV2Schema.parse({ ...body, observationId: sha256Canonical(body) });
  if (!await currentEfficiencyBindingMatches(root, observation)) return false;
  return writeObservationOnce(root, observation.operationId, "context", observation.observationId, observation);
}

export async function recordContextRetrievalObservation(root: string, observation: ContextRetrievalObservationV2): Promise<boolean> {
  const parsed = contextRetrievalObservationV2Schema.parse(observation);
  if (!await currentEfficiencyBindingMatches(root, parsed)) return false;
  return writeObservationOnce(root, parsed.operationId, "retrieval", sha256Canonical(parsed), parsed);
}

export async function writeOperationEfficiencySummary(root: string, config: HarnessProjectConfig, operation: OperationRecordV2): Promise<OperationEfficiencySummaryV2 | undefined> {
  void config;
  const observations = await readOperationEfficiencyObservations(root, operation.id);
  const summary = summarizeOperationEfficiencyV2(operation, observations);
  await writeJsonAtomic(summaryFile(root, operation.id), summary);
  return summary;
}

export async function readOperationEfficiencySummary(root: string, operation: OperationRecordV2): Promise<OperationEfficiencySummaryV2 | undefined> {
  try {
    const summary = operationEfficiencySummaryV2Schema.parse(JSON.parse(await fs.readFile(summaryFile(root, operation.id), "utf8")));
    if (summary.operationId !== operation.id || summary.currentCandidateId !== (operation.candidateRevision?.candidateId ?? null)
      || summary.currentCandidateDigest !== (operation.candidateRevision?.identityDigest ?? null)) return undefined;
    return summary;
  } catch { return undefined; }
}

export function summarizeOperationEfficiencyV2(operation: OperationRecordV2, observations: {
  participants: ParticipantUsageObservationV2[]; tools: ToolCallObservationV2[]; context: ContextAccountingObservationV2[]; retrieval: ContextRetrievalObservationV2[]; activity?: ExecutionActivityEventV1[];
}, generatedAt = new Date().toISOString()): OperationEfficiencySummaryV2 {
  const participants = deduplicateParticipantUsage(observations.participants.filter((item) => item.operationId === operation.id));
  const tools = observations.tools.filter((item) => item.operationId === operation.id);
  const contexts = observations.context.filter((item) => item.operationId === operation.id);
  const retrievals = observations.retrieval.filter((item) => item.operationId === operation.id);
  const sumField = (items: readonly Record<string, unknown>[], key: string): number | null => {
    const known = items.map((item) => item[key]).filter((value): value is number => typeof value === "number");
    return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
  };
  const operationParticipants = Object.values(operation.participants ?? {});
  const boundOperationParticipants = operationParticipants.filter((item) => item.executionBinding);
  const boundOperationAgents = (operation.agents ?? []).filter((item) => item.executionBinding);
  const expectedUsageIdentities = [
    ...boundOperationParticipants.map((item) => ({ participantId: item.id, generation: item.executionBinding!.participantGeneration })),
    ...boundOperationAgents.map((item) => ({ participantId: item.id, generation: item.executionBinding!.participantGeneration }))
  ];
  const operationParticipantIds = new Set(expectedUsageIdentities.map((item) => item.participantId));
  const observedParticipantIds = new Set(participants.map((item) => item.participantId));
  const knownParticipants = new Set(participants.filter((item) => item.usageKnown).map((item) => item.participantId)).size;
  const costKnownParticipants = new Set(participants.filter((item) => item.costUsd !== null).map((item) => item.participantId)).size;
  const totalParticipants = new Set([...operationParticipantIds, ...observedParticipantIds]).size;
  const usageComplete = totalParticipants > 0 && (expectedUsageIdentities.length === 0
    ? participants.length > 0 && participants.every((item) => item.usageKnown && item.usageCoverage === "COMPLETE")
    : expectedUsageIdentities.every((identity) => {
    const observation = participants.find((item) => item.participantId === identity.participantId && item.generation === identity.generation);
    return Boolean(observation?.usageKnown && observation.usageCoverage === "COMPLETE");
  }));
  const tokenBases = new Set(participants.filter((item) => item.totalTokens !== null).map((item) => item.totalTokensBasis));
  const totalTokenBasis = tokenBases.size === 1 ? [...tokenBases][0]! : "UNKNOWN" as const;
  const providerBudgetParticipants = operationParticipants.filter((item) => item.role !== "Operation Supervisor" && item.logicalAgent !== "supervisor");
  const providerTurnParticipantIds = new Set([
    ...providerBudgetParticipants.map((item) => item.id),
    ...participants.filter((item) => item.role !== "Operation Supervisor" && item.role !== "Lead/Director").map((item) => item.participantId)
  ]);
  const participantLiveness = providerBudgetParticipants.map((item) => item.executionLiveness).filter((item): item is NonNullable<typeof item> => Boolean(item));
  const livenessCoverageComplete = providerBudgetParticipants.length > 0 && participantLiveness.length === providerBudgetParticipants.length;
  const toolCallAccountingComplete = providerBudgetParticipants.length === 0 || livenessCoverageComplete;
  const distinctGenerations = new Set([
    ...participants.flatMap((item) => item.generation ? [`${item.participantId}:${item.generation}`] : []),
    ...operationParticipants.flatMap((item) => item.executionBinding ? [`${item.id}:${item.executionBinding.participantGeneration}`] : []),
    ...boundOperationAgents.map((item) => `${item.id}:${item.executionBinding!.participantGeneration}`)
  ]).size;
  const providerTurns = livenessCoverageComplete
    ? participantLiveness.reduce((sum, item) => sum + item.providerTurns, 0)
    : participants.length > 0 && participants.every((item) => item.turnCount !== null)
      ? participants.reduce((sum, item) => sum + (item.turnCount ?? 0), 0)
      : null;
  const repeatedFragmentTokens = repeatedCrossParticipantFragmentTokens(contexts, retrievals);
  const firstAttemptSuccesses = tools.filter((item) => item.attemptIndex === 1 && item.outcome === "SUCCESS").length;
  const failedFirstAttempts = tools.filter((item) => item.attemptIndex === 1 && item.outcome !== "SUCCESS").length;
  const retryCalls = tools.filter((item) => item.retryOfCallId !== null && item.causalStatus === "PROVEN").length;
  const recoveredAfterRetry = tools.filter((item) => item.attemptIndex === 1 && item.outcome !== "SUCCESS" && retrySequenceRecovered(item, tools)).length;
  const failureClasses = new Map<string, number>();
  for (const tool of tools) if (tool.outcome !== "SUCCESS") failureClasses.set(tool.outcome, (failureClasses.get(tool.outcome) ?? 0) + 1);
  const retryTurnIds = retryAssociatedTurnIds(tools);
  const usageByTurn = new Map<string, ProviderTurnUsageObservationV2>();
  for (const participant of participants) for (const turn of participant.turnUsage) {
    if (turn.runtimeSessionId && turn.turnId) usageByTurn.set(`${turn.runtimeSessionId}\0${turn.turnId}`, turn);
  }
  const retryTurnUsage = [...retryTurnIds].flatMap((key) => usageByTurn.has(key) ? [usageByTurn.get(key)!] : []);
  const retryUsageCoverage = retryTurnIds.size === 0 ? "UNKNOWN" as const : retryTurnUsage.length === retryTurnIds.size
    && retryTurnUsage.every((turn) => turn.inputTokens !== null && turn.outputTokens !== null && turn.totalTokens !== null)
    ? "COMPLETE" as const : "PARTIAL" as const;
  const durationMs = operation.startedAt && operation.finishedAt ? Math.max(0, Date.parse(operation.finishedAt) - Date.parse(operation.startedAt)) : null;
  const economic = operation.resolvedOperationPolicy?.economicEnvelope;
  const livenessPolicy = operation.resolvedOperationPolicy?.executionLiveness;
  const observedTokenTotal = participants.length > 0 && participants.every((item) => item.usageKnown && item.totalTokens !== null) ? participants.reduce((sum, item) => sum + (item.totalTokens ?? 0), 0) : null;
  const observedCostTotal = usageComplete && participants.length > 0 && participants.every((item) => item.usageCoverage === "COMPLETE" && item.costUsd !== null) ? participants.reduce((sum, item) => sum + (item.costUsd ?? 0), 0) : null;
  const restartPolicyLimit = livenessPolicy && economic ? Math.min(livenessPolicy.maxParticipantRestarts, economic.maxParticipantRestarts) : livenessPolicy?.maxParticipantRestarts ?? economic?.maxParticipantRestarts ?? null;
  const retryPolicyLimit = livenessPolicy && economic ? Math.min(livenessPolicy.maxLocalRetriesPerFailure, economic.maxLocalRetries) : livenessPolicy?.maxLocalRetriesPerFailure ?? economic?.maxLocalRetries ?? null;
  const aggregateProviderTurnLimit = (perParticipant: number | undefined): number | null => {
    if (perParticipant === undefined) return null;
    const aggregate = perParticipant * providerTurnParticipantIds.size;
    return Number.isSafeInteger(aggregate) ? aggregate : null;
  };
  const executionActivity = observations.activity ?? [];
  const activityAt = (kind: ExecutionActivityEventV1["kind"]): number | undefined => executionActivity.filter((item) => item.kind === kind).map((item) => Date.parse(item.observedAt)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  const firstToolAt = Math.min(...[
    ...participantLiveness.map((item) => item.firstToolCallAt ? Date.parse(item.firstToolCallAt) : Number.POSITIVE_INFINITY),
    activityAt("TOOL_CALL_STARTED") ?? Number.POSITIVE_INFINITY
  ]);
  const firstMutationAt = Math.min(...[
    ...participantLiveness.map((item) => item.firstMutationAt ? Date.parse(item.firstMutationAt) : Number.POSITIVE_INFINITY),
    activityAt("SOURCE_MUTATION") ?? Number.POSITIVE_INFINITY
  ]);
  const lastMeaningfulProgressAt = Math.max(
    ...participantLiveness.map((item) => item.lastMeaningfulProgressAt ? Date.parse(item.lastMeaningfulProgressAt) : Number.NEGATIVE_INFINITY),
    ...executionActivity.filter((item) => item.level === "HIGH" || item.level === "MEDIUM").map((item) => Date.parse(item.observedAt)),
    Number.NEGATIVE_INFINITY
  );
  const timeOrigin = operation.startedAt ? Date.parse(operation.startedAt) : Number.NaN;
  const timeEnd = operation.finishedAt ? Date.parse(operation.finishedAt) : Date.parse(generatedAt);
  const mutationParticipants = participantLiveness.filter((item) => item.firstMutationAt);
  const turnsBeforeMutation = mutationParticipants.length && mutationParticipants.every((item) => item.turnsBeforeFirstMutation !== null)
    ? mutationParticipants.reduce((sum, item) => sum + (item.turnsBeforeFirstMutation ?? 0), 0) : null;
  const tokensBeforeMutation = mutationParticipants.length ? sumTokensBeforeMutation(participants, operation) : null;
  const allToolDurationsKnown = tools.length > 0 && tools.every((item) => item.startedAt !== null && item.finishedAt !== null && item.durationMs !== null);
  const activeProviderDurationMs = usageComplete ? sumTurnActiveDuration(participants) : null;
  const toolWaitDurationMs = allToolDurationsKnown ? unionDuration(tools.flatMap((item) => item.startedAt && item.finishedAt ? [[Date.parse(item.startedAt), Date.parse(item.finishedAt)] as [number, number]] : [])) : null;
  const resultRecord = operation.result && typeof operation.result === "object" ? operation.result as Record<string, unknown> : undefined;
  const acceptanceValue = resultRecord?.acceptanceOracle;
  const acceptanceDisposition = acceptanceValue && typeof acceptanceValue === "object" ? (acceptanceValue as Record<string, unknown>).disposition : undefined;
  const deliveryValue = resultRecord?.delivery;
  const deliveryStatus = deliveryValue && typeof deliveryValue === "object" ? (deliveryValue as Record<string, unknown>).status : undefined;
  const summary = {
    version: 2 as const,
    operationId: operation.id,
    terminalStatus: operation.status === "SUCCEEDED" || operation.status === "FAILED" || operation.status === "CANCELLED" ? operation.status : "UNKNOWN" as const,
    route: operation.intent?.route ?? null,
    assurance: operation.intent?.assurance ?? null,
    currentCandidateId: operation.candidateRevision?.candidateId ?? null,
    currentCandidateRevision: operation.candidateRevision?.revision ?? null,
    currentCandidateDigest: operation.candidateRevision?.identityDigest ?? null,
    participants: totalParticipants,
    participantGenerations: distinctGenerations,
    providerTurns,
    budgets: {
      providerTurns: {
        scope: "PER_PARTICIPANT" as const,
        participantCount: providerTurnParticipantIds.size,
        observed: livenessCoverageComplete ? participantLiveness.reduce((sum, item) => sum + item.providerTurns, 0) : null,
        initialPerParticipant: economic?.initialProviderTurns ?? null,
        initialAggregateEquivalent: aggregateProviderTurnLimit(economic?.initialProviderTurns),
        currentAllowanceAggregate: livenessCoverageComplete ? participantLiveness.reduce((sum, item) => sum + item.currentProviderTurnBudget, 0) : null,
        supervisorCeilingPerParticipant: economic?.supervisorProviderTurns ?? null,
        supervisorCeilingAggregateEquivalent: aggregateProviderTurnLimit(economic?.supervisorProviderTurns),
        hardCeilingPerParticipant: economic?.hardProviderTurns ?? null,
        hardCeilingAggregateEquivalent: aggregateProviderTurnLimit(economic?.hardProviderTurns),
        softThreshold: economic?.softThreshold ?? null
      },
      toolCalls: { observed: toolCallAccountingComplete ? participantLiveness.reduce((sum, item) => sum + item.toolCallCount, 0) : null, hardLimit: economic?.hardToolCalls ?? null },
      tokenUsage: { observed: observedTokenTotal, hardLimit: economic?.hardTotalTokens ?? null, coverage: observedTokenTotal === null ? "UNKNOWN" as const : usageComplete && participants.every((item) => item.totalTokens !== null) ? "COMPLETE" as const : "PARTIAL" as const },
      cost: { observedUsd: observedCostTotal, hardLimitUsd: economic?.hardCostUsd ?? null, coverage: observedCostTotal === null ? "UNKNOWN" as const : "COMPLETE" as const },
      recovery: {
        localRetries: livenessCoverageComplete ? participantLiveness.reduce((sum, item) => sum + item.localRetryCount, 0) : null,
        localRetryLimit: retryPolicyLimit,
        participantRestarts: livenessCoverageComplete ? participantLiveness.reduce((sum, item) => sum + item.participantRestarts, 0) : null,
        participantRestartLimit: restartPolicyLimit,
        noProgressRenewals: livenessCoverageComplete ? participantLiveness.reduce((sum, item) => sum + item.noProgressRenewals, 0) : null,
        progressLeaseRenewals: livenessCoverageComplete ? participantLiveness.reduce((sum, item) => sum + (item.progressLease?.renewalCount ?? 0), 0) : null
      },
      hardDeadlineAt: economic?.hardDeadlineAt ?? operation.origin?.rootHardDeadlineAt ?? null
    },
    usage: {
      inputTokens: sumField(participants, "inputTokens"),
      cachedInputTokens: sumField(participants, "cachedInputTokens"),
      outputTokens: sumField(participants, "outputTokens"),
      reasoningOutputTokens: sumField(participants, "reasoningOutputTokens"),
      totalTokens: sumField(participants, "totalTokens"),
      totalTokensBasis: totalTokenBasis,
      costUsd: usageComplete && participants.every((item) => item.costUsd !== null) ? sumField(participants, "costUsd") : null,
      knownParticipants,
      participantCount: totalParticipants,
      costKnownParticipants,
      completeObservations: participants.filter((item) => item.usageCoverage === "COMPLETE").length,
      partialObservations: participants.filter((item) => item.usageCoverage === "PARTIAL").length,
      unknownObservations: participants.filter((item) => item.usageCoverage === "UNKNOWN").length + Math.max(0, totalParticipants - observedParticipantIds.size),
      byParticipant: participantUsageById(participants)
    },
    context: {
      rawContextTokens: contexts.reduce((sum, item) => sum + (item.rawContextTokens ?? 0), 0),
      projectedContextTokens: contexts.reduce((sum, item) => sum + (item.projectedContextTokens ?? 0), 0),
      deliveredContextTokens: contexts.reduce((sum, item) => sum + (item.deliveredContextTokens ?? 0), 0),
      retrievalRequestCount: contexts.reduce((sum, item) => sum + item.retrievalRequestCount, 0) + new Set(retrievals.map((item) => item.requestId)).size,
      retrievalDeliveredTokens: contexts.reduce((sum, item) => sum + item.retrievalDeliveredTokens, 0) + retrievals.reduce((sum, item) => sum + item.estimatedTokens, 0),
      crossParticipantRepeatedFragmentTokens: repeatedFragmentTokens,
      tokenBasis: "AEH_ESTIMATOR" as const
    },
    tools: {
      toolCalls: tools.length,
      firstAttemptSuccesses,
      failedFirstAttempts,
      retryCalls,
      recoveredAfterRetry,
      repeatedEquivalentCalls: tools.filter((item) => item.attemptIndex !== null && item.attemptIndex > 1 && item.causalStatus === "EQUIVALENT_ONLY").length,
      unrecoveredToolFailures: tools.filter((item) => item.attemptIndex === 1 && item.outcome !== "SUCCESS" && !retrySequenceRecovered(item, tools)).length,
      unknownCausalRetries: tools.filter((item) => item.causalStatus === "UNKNOWN" && item.attemptIndex !== null && item.attemptIndex > 1).length,
      failuresByClass: Object.fromEntries([...failureClasses.entries()].sort(([a], [b]) => a.localeCompare(b))),
      retryAssociatedInputTokens: retryUsageCoverage === "UNKNOWN" ? null : sumField(retryTurnUsage, "inputTokens"),
      retryAssociatedOutputTokens: retryUsageCoverage === "UNKNOWN" ? null : sumField(retryTurnUsage, "outputTokens"),
      retryAssociatedTotalTokens: retryUsageCoverage === "UNKNOWN" ? null : sumField(retryTurnUsage, "totalTokens"),
      retryUsageCoverage
    },
    workflow: {
      repairRounds: new Set(participants.filter((item) => item.role === "Repairer").map((item) => `${item.participantId}:${item.generation}`)).size,
      candidateRevisions: candidateRevisionCount(operation, [...participants.map((item) => item.candidateRevision), ...contexts.map((item) => item.candidateRevision), ...tools.map((item) => item.candidateRevision)]),
      reviewRounds: new Set(participants.filter((item) => item.role === "Reviewer").map((item) => `${item.participantId}:${item.generation}`)).size,
      humanInterventions: null
    },
    activity: {
      timeToFirstToolCallMs: Number.isFinite(firstToolAt) && Number.isFinite(timeOrigin) ? Math.max(0, firstToolAt - timeOrigin) : null,
      timeToFirstMutationMs: Number.isFinite(firstMutationAt) && Number.isFinite(timeOrigin) ? Math.max(0, firstMutationAt - timeOrigin) : null,
      timeSinceLastMeaningfulProgressMs: Number.isFinite(lastMeaningfulProgressAt) ? Math.max(0, timeEnd - lastMeaningfulProgressAt) : null,
      toolCallsBeforeFirstMutation: participantLiveness.reduce((sum, item) => sum + item.toolCallsBeforeFirstMutation, 0),
      turnsBeforeFirstMutation: turnsBeforeMutation,
      tokensBeforeFirstMutation: tokensBeforeMutation,
      repositoryMutationCount: participantLiveness.reduce((sum, item) => sum + item.repositoryMutationCount, 0),
      artifactCount: participantLiveness.reduce((sum, item) => sum + item.artifactCount, 0),
      validationCount: participantLiveness.reduce((sum, item) => sum + item.validationCount, 0)
    },
    timing: {
      totalDurationMs: durationMs,
      participantDurationMs: observedParticipantIds.size === totalParticipants && totalParticipants > 0 && participants.every((item) => item.durationMs !== null) ? participants.reduce((sum, item) => sum + (item.durationMs ?? 0), 0) : null,
      activeProviderDurationMs,
      toolWaitDurationMs
    },
    outcome: {
      accepted: typeof acceptanceDisposition === "string" ? acceptanceDisposition === "ACCEPTED" : null,
      delivered: typeof deliveryStatus === "string" ? ["FINALIZED", "HANDOFF_ONLY", "NO_CHANGES"].includes(deliveryStatus) : null
    },
    generatedAt
  };
  return operationEfficiencySummaryV2Schema.parse(summary);
}

function sumTokensBeforeMutation(participants: ParticipantUsageObservationV2[], operation: OperationRecordV2): number | null {
  const mutationParticipants = Object.values(operation.participants).filter((participant) => participant.executionLiveness?.firstMutationAt);
  if (!mutationParticipants.length) return null;
  let total = 0;
  for (const participant of mutationParticipants) {
    const binding = participant.executionBinding;
    if (!binding) return null;
    const observation = participants.find((item) => item.participantId === participant.id && item.generation === binding.participantGeneration);
    if (!observation || observation.usageCoverage === "UNKNOWN") return null;
    const mutationAt = Date.parse(participant.executionLiveness!.firstMutationAt!);
    const priorTurns = observation.turnUsage.filter((turn) => turn.at && Date.parse(turn.at) <= mutationAt);
    if (priorTurns.some((turn) => turn.totalTokens === null)) return null;
    total += priorTurns.reduce((sum, turn) => sum + (turn.totalTokens ?? 0), 0);
  }
  return total;
}

function sumTurnActiveDuration(participants: ParticipantUsageObservationV2[]): number | null {
  const turns = participants.flatMap((item) => item.turnUsage);
  if (!turns.length || turns.some((turn) => !turn.startedAt || !turn.finishedAt || !Number.isFinite(Date.parse(turn.startedAt)) || !Number.isFinite(Date.parse(turn.finishedAt)))) return null;
  return turns.reduce((sum, turn) => sum + Math.max(0, Date.parse(turn.finishedAt!) - Date.parse(turn.startedAt!)), 0);
}

function unionDuration(intervals: Array<[number, number]>): number {
  const sorted = intervals.filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end >= start).sort(([a], [b]) => a - b);
  if (!sorted.length) return 0;
  let total = 0;
  let [start, end] = sorted[0]!;
  for (const [nextStart, nextEnd] of sorted.slice(1)) {
    if (nextStart <= end) end = Math.max(end, nextEnd);
    else { total += end - start; start = nextStart; end = nextEnd; }
  }
  return total + end - start;
}

export async function readOperationEfficiencyObservations(root: string, operationId: string): Promise<{
  participants: ParticipantUsageObservationV2[]; tools: ToolCallObservationV2[]; context: ContextAccountingObservationV2[]; retrieval: ContextRetrievalObservationV2[]; activity: ExecutionActivityEventV1[];
}> {
  const directory = operationDirectory(root, operationId);
  const [participants, tools, context, retrieval] = await Promise.all([
    readObservationDirectory(directory, "participants", participantUsageObservationV2Schema),
    readObservationDirectory(directory, "tools", toolCallObservationV2Schema),
    readObservationDirectory(directory, "context", contextAccountingObservationV2Schema),
    readObservationDirectory(directory, "retrieval", contextRetrievalObservationV2Schema)
  ]);
  const activity = await readExecutionActivityEventsV1(root, operationId);
  return { participants, tools, context, retrieval, activity };
}

async function currentEfficiencyBindingMatches(root: string, observation: {
  operationId: string; participantId: string; candidateId: string; candidateRevision: number; candidateDigest: string;
  operationExecutionRevision: number; controllerEpoch: number; generation?: string | null; runtimeSessionId?: string | null; sessionId?: string;
}): Promise<boolean> {
  try {
    const operation = await loadOperation(resolveOperationStateRoot(root), observation.operationId);
  const candidate = operation.candidateRevision;
    const participant = operation.participants?.[observation.participantId];
    const agent = operation.agents?.find((item) => item.id === observation.participantId || item.id === observation.runtimeSessionId || item.id === observation.sessionId);
    const binding = participant?.executionBinding ?? agent?.executionBinding;
    if (!candidate || candidate.candidateId !== observation.candidateId || candidate.revision !== observation.candidateRevision || candidate.identityDigest !== observation.candidateDigest
      || operation.operationExecutionRevision !== observation.operationExecutionRevision || (operation.controller?.epoch ?? 0) !== observation.controllerEpoch || !participant && !agent) return false;
    if (!binding) return !observation.generation && !(observation.runtimeSessionId ?? observation.sessionId);
    if (observation.generation && binding.participantGeneration !== observation.generation) return false;
    const expectedSession = observation.runtimeSessionId ?? observation.sessionId;
    if (expectedSession && binding.runtime.sessionId !== expectedSession) return false;
    return binding.operationExecutionRevision === observation.operationExecutionRevision
      && binding.candidateRevision === observation.candidateRevision
      && binding.candidateDigest === observation.candidateDigest
      && binding.controllerEpoch === observation.controllerEpoch;
  } catch { return false; }
}

function sumTurnUsage(turns: ProviderTurnUsageObservationV2[]): UsageMetrics {
  const result: UsageMetrics = {};
  const sum = (field: keyof Pick<ProviderTurnUsageObservationV2, "inputTokens" | "cachedInputTokens" | "outputTokens" | "reasoningOutputTokens" | "totalTokens" | "costUsd">): number | undefined => {
    const values = turns.map((turn) => turn[field]).filter((value): value is number => typeof value === "number");
    return values.length ? values.reduce((total, value) => total + value, 0) : undefined;
  };
  result.inputTokens = sum("inputTokens");
  result.cachedInputTokens = sum("cachedInputTokens");
  result.outputTokens = sum("outputTokens");
  result.reasoningOutputTokens = sum("reasoningOutputTokens");
  result.totalTokens = sum("totalTokens");
  result.costUsd = sum("costUsd");
  if (result.totalTokens === undefined && result.inputTokens !== undefined && result.outputTokens !== undefined) result.totalTokens = result.inputTokens + result.outputTokens;
  return result;
}

function repeatedCrossParticipantFragmentTokens(contexts: ContextAccountingObservationV2[], retrievals: ContextRetrievalObservationV2[]): number {
  const recipients = new Map<string, Map<string, number>>();
  const add = (participantId: string, fragmentId: string, contentDigest: string, deliveredTokens: number): void => {
    const key = `${fragmentId}\0${contentDigest}`;
    const participants = recipients.get(key) ?? new Map<string, number>();
    participants.set(participantId, Math.max(participants.get(participantId) ?? 0, deliveredTokens));
    recipients.set(key, participants);
  };
  for (const observation of contexts) {
    for (const fragment of observation.fragmentIdentities) add(observation.participantId, fragment.fragmentId, fragment.contentDigest, fragment.deliveredTokens);
  }
  for (const observation of retrievals) add(observation.participantId, observation.fragmentId, observation.contentDigest, observation.estimatedTokens);
  let repeated = 0;
  for (const participants of recipients.values()) {
    const sorted = [...participants.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [, tokens] of sorted.slice(1)) repeated += tokens;
  }
  return repeated;
}

function retryAssociatedTurnIds(tools: ToolCallObservationV2[]): Set<string> {
  return new Set(tools.filter((item) => item.retryOfCallId !== null && item.causalStatus === "PROVEN" && item.turnId)
    .map((item) => `${item.sessionId}\0${item.turnId}`));
}

function retrySequenceRecovered(first: ToolCallObservationV2, tools: ToolCallObservationV2[]): boolean {
  if (!first.callId) return false;
  const visited = new Set<string>();
  const pending = [first.callId];
  while (pending.length) {
    const priorCallId = pending.shift()!;
    if (visited.has(priorCallId)) continue;
    visited.add(priorCallId);
    for (const retry of tools.filter((item) => item.retryOfCallId === priorCallId && item.causalStatus === "PROVEN")) {
      if (retry.outcome === "SUCCESS") return true;
      if (retry.callId) pending.push(retry.callId);
    }
  }
  return false;
}

function deduplicateParticipantUsage(observations: ParticipantUsageObservationV2[]): ParticipantUsageObservationV2[] {
  const groups = new Map<string, ParticipantUsageObservationV2[]>();
  for (const item of observations) {
    const key = [item.participantId, item.generation ?? "", item.runtimeSessionId ?? "", item.provider, item.model ?? ""].join("\0");
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const latest = [...group].sort((a, b) => (b.finishedAt ?? b.startedAt ?? "").localeCompare(a.finishedAt ?? a.startedAt ?? "") || a.observationId.localeCompare(b.observationId))[0]!;
    if (group.length === 1) return latest;
    if (!group.every((item) => item.usageSource === "PROVIDER_TURN_EVENTS") || group.some((item) => item.turnUsage.some((turn) => !turn.turnId))) {
      // Snapshot and adapter totals can be cumulative. Keep only the latest value and
      // make the loss of interval detail explicit instead of summing a snapshot twice.
      return { ...latest, usageCoverage: "PARTIAL", totalTokensBasis: latest.totalTokensBasis };
    }
    const turns = new Map<string, ProviderTurnUsageObservationV2>();
    for (const item of group) for (const turn of item.turnUsage) {
      const prior = turns.get(turn.turnId!);
      if (!prior || (turn.at ?? "") > (prior.at ?? "")) turns.set(turn.turnId!, turn);
    }
    const uniqueTurns = [...turns.values()].sort((a, b) => (a.turnIndex ?? Number.MAX_SAFE_INTEGER) - (b.turnIndex ?? Number.MAX_SAFE_INTEGER) || (a.at ?? "").localeCompare(b.at ?? ""));
    const metrics = sumTurnUsage(uniqueTurns);
    const reportedTurnCounts = group.map((item) => item.turnCount).filter((value): value is number => value !== null);
    const observedTurnCount = reportedTurnCounts.length ? Math.max(...reportedTurnCounts) : uniqueTurns.length || null;
    const completeCapture = group.some((item) => item.usageCoverage === "COMPLETE" && item.turnCount === uniqueTurns.length);
    const totalTokenBases = new Set(uniqueTurns.filter((turn) => turn.totalTokens !== null).map((turn) => turn.totalTokensBasis));
    const totalTokensBasis = totalTokenBases.size === 1 ? [...totalTokenBases][0]!
      : "UNKNOWN" as const;
    const startedAt = group.map((item) => item.startedAt).filter((value): value is string => value !== null).sort()[0] ?? null;
    const finishedAt = group.map((item) => item.finishedAt).filter((value): value is string => value !== null).sort().at(-1) ?? null;
    return {
      ...latest,
      turnCount: observedTurnCount,
      inputTokens: metrics.inputTokens ?? null,
      cachedInputTokens: metrics.cachedInputTokens ?? null,
      outputTokens: metrics.outputTokens ?? null,
      reasoningOutputTokens: metrics.reasoningOutputTokens ?? null,
      totalTokens: metrics.totalTokens ?? null,
      totalTokensBasis,
      costUsd: metrics.costUsd ?? null,
      usageKnown: Object.values(metrics).some((value) => value !== undefined),
      usageCoverage: completeCapture && uniqueTurns.every((turn) => turn.usageKnown) ? "COMPLETE" : "PARTIAL",
      startedAt,
      finishedAt,
      durationMs: Math.max(...group.map((item) => item.durationMs ?? 0)) || null,
      turnUsage: uniqueTurns
    };
  });
}

function participantUsageById(participants: ParticipantUsageObservationV2[]): Array<{
  participantId: string; generations: number; roles: string[]; inputTokens: number | null; cachedInputTokens: number | null;
  outputTokens: number | null; reasoningOutputTokens: number | null; totalTokens: number | null; costUsd: number | null;
  usageKnown: boolean; usageCoverage: "COMPLETE" | "PARTIAL" | "UNKNOWN";
}> {
  const groups = new Map<string, ParticipantUsageObservationV2[]>();
  for (const item of participants) {
    const group = groups.get(item.participantId) ?? [];
    group.push(item);
    groups.set(item.participantId, group);
  }
  const sum = (items: ParticipantUsageObservationV2[], field: "inputTokens" | "cachedInputTokens" | "outputTokens" | "reasoningOutputTokens" | "totalTokens"): number | null => {
    const known = items.map((item) => item[field]).filter((value): value is number => value !== null);
    return known.length ? known.reduce((total, value) => total + value, 0) : null;
  };
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([participantId, items]) => ({
    participantId,
    generations: new Set(items.map((item) => item.generation).filter((value): value is string => value !== null)).size,
    roles: [...new Set(items.map((item) => item.role))].sort(),
    inputTokens: sum(items, "inputTokens"),
    cachedInputTokens: sum(items, "cachedInputTokens"),
    outputTokens: sum(items, "outputTokens"),
    reasoningOutputTokens: sum(items, "reasoningOutputTokens"),
    totalTokens: sum(items, "totalTokens"),
    costUsd: items.length > 0 && items.every((item) => item.usageKnown && item.usageCoverage === "COMPLETE" && item.costUsd !== null) ? items.reduce((total, item) => total + (item.costUsd ?? 0), 0) : null,
    usageKnown: items.some((item) => item.usageKnown),
    usageCoverage: items.every((item) => item.usageCoverage === "UNKNOWN") ? "UNKNOWN" as const : items.every((item) => item.usageKnown && item.usageCoverage === "COMPLETE") ? "COMPLETE" as const : "PARTIAL" as const
  }));
}

export function correlateEquivalentToolCalls(observations: ProviderTelemetryEvidenceV2["toolCalls"]): Array<Omit<ProviderTelemetryEvidenceV2["toolCalls"][number], "retryOfCallId"> & { attemptIndex: number | null; retryOfCallId: string | null; causalStatus: "PROVEN" | "EQUIVALENT_ONLY" | "UNKNOWN" }> {
  const ordered = [...observations].sort((a, b) => (a.timelineSequence ?? Number.MAX_SAFE_INTEGER) - (b.timelineSequence ?? Number.MAX_SAFE_INTEGER) || (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
  const groups = new Map<string, number[]>();
  for (let index = 0; index < ordered.length; index += 1) {
    const item = ordered[index]!;
    if (!item.callId) continue;
    const identity = [item.toolServer ?? "", item.provider ?? "", item.toolName, item.argumentsDigest].join("\0");
    const key = item.turnId ? `${identity}\0turn:${item.turnId}` : `${identity}\0unknown-turn`;
    const group = groups.get(key) ?? [];
    group.push(index);
    groups.set(key, group);
  }
  return ordered.map((item, index) => {
    if (!item.callId) return { ...item, attemptIndex: null, retryOfCallId: null, causalStatus: "UNKNOWN" as const };
    const identity = [item.toolServer ?? "", item.provider ?? "", item.toolName, item.argumentsDigest].join("\0");
    const key = item.turnId ? `${identity}\0turn:${item.turnId}` : `${identity}\0unknown-turn`;
    const group = groups.get(key) ?? [];
    const position = group.indexOf(index);
    const prior = position > 0 ? ordered[group[position - 1]!] : undefined;
    const attemptIndex = position + 1;
    const explicitPrior = item.retryOfCallId ? observations.find((candidate) => candidate.callId === item.retryOfCallId) : undefined;
    const explicitRetryProven = Boolean(explicitPrior && explicitPrior.outcome !== "SUCCESS" && explicitPrior.outcome !== "CANCELLED" && explicitPrior.toolName === item.toolName && explicitPrior.argumentsDigest === item.argumentsDigest);
    const equivalentPrior = prior && prior.outcome !== "SUCCESS" && prior.outcome !== "CANCELLED";
    const retryOfCallId = explicitRetryProven ? item.retryOfCallId! : null;
    const causalStatus = explicitRetryProven ? "PROVEN" as const : !item.turnId && group.length > 1 || item.retryOfCallId ? "UNKNOWN" as const : equivalentPrior || position > 0 ? "EQUIVALENT_ONLY" as const : "UNKNOWN" as const;
    return { ...item, attemptIndex, retryOfCallId, causalStatus };
  });
}

function candidateRevisionCount(operation: OperationRecordV2, revisions: number[]): number {
  const values = new Set(revisions);
  if (operation.candidateRevision) values.add(operation.candidateRevision.revision);
  for (const receipt of Object.values(operation.candidateAssemblyReceipts ?? {})) {
    const revision = (receipt as unknown as { candidate?: { revision?: unknown } }).candidate?.revision;
    if (typeof revision === "number" && Number.isSafeInteger(revision)) values.add(revision);
  }
  return values.size;
}

async function writeObservationOnce(root: string, operationId: string, kind: string, observationId: string, value: unknown): Promise<boolean> {
  const directory = path.join(operationDirectory(root, operationId), kind);
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `${observationId}.json`);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const handle = await fs.open(file, "wx");
    try { await handle.writeFile(serialized); } finally { await handle.close(); }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
    try { return sha256Utf8(await fs.readFile(file, "utf8")) === sha256Utf8(serialized); }
    catch { return false; }
  }
}

async function readObservationDirectory<T>(directory: string, kind: string, schema: z.ZodType<T>): Promise<T[]> {
  const folder = path.join(directory, kind);
  const files = await fs.readdir(folder).catch(() => []);
  const observations: T[] = [];
  for (const name of files.filter((item) => item.endsWith(".json")).sort()) {
    try { observations.push(schema.parse(JSON.parse(await fs.readFile(path.join(folder, name), "utf8")))); }
    catch { /* malformed local observations do not affect deterministic operation state */ }
  }
  return observations;
}

function operationDirectory(root: string, operationId: string): string {
  return path.join(resolveOperationStateRoot(root), EFFICIENCY_ROOT, sha256Utf8(operationId));
}

function summaryFile(root: string, operationId: string): string {
  return path.join(operationDirectory(root, operationId), "summary.json");
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, file);
}

function validTimestamp(value?: string): string | null {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}
