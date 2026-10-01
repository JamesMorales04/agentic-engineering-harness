import { z } from "zod";
import { sha256Canonical } from "../core/digest.js";
import type { ProviderTelemetryEvidenceV1, ProviderTurnUsageObservationV1 } from "./efficiency.js";

const toolCallItemSchema = z.object({
  type: z.literal("tool_call"),
  status: z.enum(["running", "completed", "failed", "canceled"]),
  callId: z.string().min(1).nullable().optional(),
  name: z.string().min(1),
  detail: z.unknown(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  error: z.unknown().nullable()
}).passthrough();

const canonicalEntrySchema = z.object({
  provider: z.string().min(1),
  item: z.unknown(),
  turnId: z.string().optional(),
  timestamp: z.string().datetime(),
  seqStart: z.number().int().nonnegative(),
  seqEnd: z.number().int().nonnegative(),
  collapsed: z.array(z.string()).optional()
}).passthrough();

const usageSchema = z.object({
  inputTokens: z.number().finite().nonnegative().optional(),
  cachedInputTokens: z.number().finite().nonnegative().optional(),
  outputTokens: z.number().finite().nonnegative().optional(),
  totalCostUsd: z.number().finite().nonnegative().optional(),
  contextWindowMaxTokens: z.number().finite().nonnegative().optional(),
  contextWindowUsedTokens: z.number().finite().nonnegative().optional()
}).passthrough();

export interface PaseoTimelineEventEnvelopeV1 {
  agentId?: string;
  event?: Record<string, unknown>;
  receivedAt?: string;
}

export interface PaseoTimelineCaptureV1 {
  evidence: ProviderTelemetryEvidenceV1;
  snapshotContext?: { usedTokens?: number; limitTokens?: number };
  completeness: "COMPLETE" | "PARTIAL" | "UNKNOWN";
}

/** Normalize the typed Paseo timeline contract; raw details never leave this function. */
export function capturePaseoTimelineV1(input: {
  liveEvents: readonly PaseoTimelineEventEnvelopeV1[];
  liveEventsTruncated?: boolean;
  timelinePayload?: unknown;
  snapshotUsage?: unknown;
  subscriptionReady: boolean;
}): PaseoTimelineCaptureV1 {
  const turnStarted: Array<{ turnId: string | null; provider: string; at: string | null; sequence: number }> = [];
  const completed = new Map<string, { turnId: string | null; turnIndex: number | null; provider: string; at: string | null; usage: Record<string, unknown> }>();
  const toolEvents: Array<{ provider: string; turnId: string | null; timestamp: string; sequence: number; item: z.infer<typeof toolCallItemSchema> }> = [];
  let liveCallsHaveIds = true;

  for (let index = 0; index < input.liveEvents.length; index += 1) {
    const envelope = input.liveEvents[index]!;
    const event = envelope.event;
    if (!event || typeof event.type !== "string") continue;
    const provider = typeof event.provider === "string" ? event.provider : "unknown";
    const turnId = typeof event.turnId === "string" && event.turnId ? event.turnId : null;
    const timestamp = typeof event.timestamp === "string" && Number.isFinite(Date.parse(event.timestamp)) ? new Date(event.timestamp).toISOString() : validTime(envelope.receivedAt);
    if (event.type === "turn_started") turnStarted.push({ turnId, provider, at: timestamp, sequence: turnStarted.length });
    if (event.type === "turn_completed") {
      const usage = usageSchema.safeParse(event.usage);
      completed.set(turnId ?? `no-turn-id:${timestamp ?? index}`, { turnId, turnIndex: indexOfTurn(turnStarted, turnId), provider, at: timestamp, usage: usage.success ? usage.data : {} });
    }
    if (event.type === "timeline" && event.item && typeof event.item === "object") {
      const item = toolCallItemSchema.safeParse(event.item);
      if (item.success) {
        if (!item.data.callId) liveCallsHaveIds = false;
        toolEvents.push({ provider, turnId, timestamp: timestamp ?? "", sequence: index, item: item.data });
      }
    }
  }

  const payload = asRecord(input.timelinePayload);
  const entries = Array.isArray(payload?.entries) ? payload.entries : undefined;
  let canonicalComplete = liveCallsHaveIds && input.liveEventsTruncated !== true && Boolean(payload && payload.projection === "canonical" && payload.gap === false && payload.reset === false && payload.staleCursor === false && payload.hasOlder === false);
  if (entries) {
    for (let index = 0; index < entries.length; index += 1) {
      const parsed = canonicalEntrySchema.safeParse(entries[index]);
      if (!parsed.success) { canonicalComplete = false; continue; }
      if (parsed.data.collapsed?.length) canonicalComplete = false;
      const item = toolCallItemSchema.safeParse(parsed.data.item);
      if (!item.success) continue;
      if (!item.data.callId) canonicalComplete = false;
      toolEvents.push({ provider: parsed.data.provider, turnId: parsed.data.turnId ?? null, timestamp: parsed.data.timestamp, sequence: parsed.data.seqStart + index, item: item.data });
    }
  } else canonicalComplete = false;

  const turnsById = new Map<string, number>();
  for (let index = 0; index < turnStarted.length; index += 1) {
    const turn = turnStarted[index]!;
    if (turn.turnId) turnsById.set(turn.turnId, index);
  }
  const turnUsage = [...completed.values()].sort((a, b) => (a.turnIndex ?? Number.MAX_SAFE_INTEGER) - (b.turnIndex ?? Number.MAX_SAFE_INTEGER)).map((item) => {
    const usage = usageSchema.safeParse(item.usage);
    const value = usage.success ? usage.data : {};
    const inputTokens = finiteMetric(value.inputTokens);
    const outputTokens = finiteMetric(value.outputTokens);
    const totalTokens = inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null;
    return {
      turnId: item.turnId,
      turnIndex: item.turnIndex,
      runtimeSessionId: null,
      provider: item.provider,
      at: item.at,
      inputTokens,
      cachedInputTokens: finiteMetric(value.cachedInputTokens),
      outputTokens,
      reasoningOutputTokens: null,
      totalTokens,
      totalTokensBasis: totalTokens === null ? "UNKNOWN" as const : "INPUT_PLUS_OUTPUT" as const,
      costUsd: finiteMetric(value.totalCostUsd),
      usageKnown: inputTokens !== null || outputTokens !== null || finiteMetric(value.totalCostUsd) !== null
    } satisfies ProviderTurnUsageObservationV1;
  });
  const toolCalls = normalizeToolCalls(toolEvents, turnsById);
  const snapshot = usageSchema.safeParse(input.snapshotUsage);
  const snapshotUsage = snapshot.success ? {
    ...(finiteMetric(snapshot.data.inputTokens) !== null ? { inputTokens: finiteMetric(snapshot.data.inputTokens)! } : {}),
    ...(finiteMetric(snapshot.data.cachedInputTokens) !== null ? { cachedInputTokens: finiteMetric(snapshot.data.cachedInputTokens)! } : {}),
    ...(finiteMetric(snapshot.data.outputTokens) !== null ? { outputTokens: finiteMetric(snapshot.data.outputTokens)! } : {}),
    ...(finiteMetric(snapshot.data.totalCostUsd) !== null ? { costUsd: finiteMetric(snapshot.data.totalCostUsd)! } : {})
  } : undefined;
  const snapshotContext = snapshot.success && (snapshot.data.contextWindowUsedTokens !== undefined || snapshot.data.contextWindowMaxTokens !== undefined)
    ? { usedTokens: finiteMetric(snapshot.data.contextWindowUsedTokens) ?? undefined, limitTokens: finiteMetric(snapshot.data.contextWindowMaxTokens) ?? undefined }
    : undefined;
  const startedTurnIds = new Set(turnStarted.map((item) => item.turnId).filter((value): value is string => Boolean(value)));
  const completedTurnIds = new Set([...completed.values()].map((item) => item.turnId).filter((value): value is string => Boolean(value)));
  const turnEventsComplete = input.subscriptionReady
    && input.liveEventsTruncated !== true
    && turnStarted.length > 0
    && startedTurnIds.size === turnStarted.length
    && startedTurnIds.size === completedTurnIds.size
    && [...startedTurnIds].every((turnId) => completedTurnIds.has(turnId))
    && turnUsage.every((item) => item.usageKnown);
  const completeness = turnEventsComplete && canonicalComplete ? "COMPLETE" : (turnStarted.length || toolEvents.length || snapshotUsage ? "PARTIAL" : "UNKNOWN");
  const source = turnUsage.length ? "PROVIDER_TURN_EVENTS" : snapshotUsage ? "PASEO_AGENT_SNAPSHOT" : "UNKNOWN";
  return {
    evidence: {
      source,
      coverage: completeness,
      turnCount: Math.max(turnStarted.length, turnUsage.length) || null,
      turns: turnUsage.map((turn) => ({ ...turn, runtimeSessionId: null })),
      toolCalls,
      ...(snapshotUsage ? { snapshotUsage } : {})
    },
    ...(snapshotContext ? { snapshotContext } : {}),
    completeness
  };
}

function normalizeToolCalls(events: Array<{ provider: string; turnId: string | null; timestamp: string; sequence: number; item: z.infer<typeof toolCallItemSchema> }>, turns: Map<string, number>): ProviderTelemetryCaptureToolCall[] {
  const calls = new Map<string, Array<(typeof events)[number]>>();
  const unbound: Array<(typeof events)[number]> = [];
  for (const event of events) {
    if (!event.item.callId) { unbound.push(event); continue; }
    const key = event.item.callId;
    const group = calls.get(key) ?? [];
    group.push(event);
    calls.set(key, group);
  }
  const output: ProviderTelemetryCaptureToolCall[] = [];
  for (const group of calls.values()) {
    const ordered = [...group].sort((a, b) => a.sequence - b.sequence);
    const first = ordered[0]!;
    const final = [...ordered].reverse().find((item) => item.item.status !== "running") ?? ordered.at(-1)!;
    output.push(observationForToolCall(first, final, ordered.find((item) => item.item.status === "running"), first.turnId ? turns.get(first.turnId) ?? null : null));
  }
  const unboundDeduplicated = new Map<string, (typeof unbound)[number]>();
  for (const event of unbound) {
    if (event.item.status === "running") {
      const hasTerminal = unbound.some((candidate) => candidate.turnId === event.turnId && candidate.sequence > event.sequence
        && candidate.item.status !== "running" && unboundCallArgumentsKey(candidate) === unboundCallArgumentsKey(event));
      if (hasTerminal) continue;
    }
    const identity = unboundCallIdentity(event);
    if (!unboundDeduplicated.has(identity)) unboundDeduplicated.set(identity, event);
  }
  for (const event of unboundDeduplicated.values()) {
    const outputItem = observationForToolCall(event, event, undefined, event.turnId ? turns.get(event.turnId) ?? null : null);
    output.push({ ...outputItem, callId: null, startedAt: null, durationMs: null });
  }
  return output.sort((a, b) => (a.timelineSequence ?? Number.MAX_SAFE_INTEGER) - (b.timelineSequence ?? Number.MAX_SAFE_INTEGER));
}

function observationForToolCall(first: { provider: string; turnId: string | null; timestamp: string; sequence: number; item: z.infer<typeof toolCallItemSchema> }, final: { provider: string; turnId: string | null; timestamp: string; sequence: number; item: z.infer<typeof toolCallItemSchema> }, started: { timestamp: string } | undefined, turnIndex: number | null): ProviderTelemetryCaptureToolCall {
  const normalizedArguments = normalizedToolArguments(first.item.detail);
  const errorFingerprint = final.item.status === "failed" ? sha256Canonical(fingerprintError(final.item.error)) : null;
  return {
    turnId: first.turnId,
    turnIndex,
    timelineSequence: first.sequence,
    toolServer: metadataText(first.item.metadata, ["server", "serverName", "mcpServer", "toolServer"]),
    provider: first.provider === "unknown" ? null : first.provider,
    toolName: first.item.name,
    callId: first.item.callId ?? null,
    argumentsDigest: sha256Canonical(normalizedArguments),
    argumentsByteLength: Buffer.byteLength(JSON.stringify(normalizedArguments), "utf8"),
    startedAt: started?.timestamp ?? null,
    finishedAt: final.item.status === "running" ? null : final.timestamp,
    durationMs: durationBetween(started?.timestamp, final.item.status === "running" ? undefined : final.timestamp),
    outcome: toolOutcome(final.item.status, final.item.error),
    resultByteLength: resultByteLength(final.item.detail, final.item.error),
    errorFingerprint
  };
}

function unboundCallArgumentsKey(event: { provider: string; turnId: string | null; item: z.infer<typeof toolCallItemSchema> }): string {
  return sha256Canonical({ provider: event.provider, turnId: event.turnId, toolName: event.item.name, args: normalizedToolArguments(event.item.detail) });
}

function unboundCallIdentity(event: { provider: string; turnId: string | null; timestamp: string; item: z.infer<typeof toolCallItemSchema> }): string {
  return sha256Canonical({ call: unboundCallArgumentsKey(event), timestamp: event.timestamp, status: event.item.status, error: fingerprintError(event.item.error) });
}

export type ProviderTelemetryCaptureToolCall = ProviderTelemetryEvidenceV1["toolCalls"][number];

function normalizedToolArguments(detail: unknown): unknown {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return { detailType: typeof detail };
  const record = detail as Record<string, unknown>;
  switch (record.type) {
    case "shell": return { type: "shell", command: record.command, cwd: record.cwd };
    case "read": return { type: "read", filePath: record.filePath, offset: record.offset, limit: record.limit };
    case "edit": return { type: "edit", filePath: record.filePath, oldString: record.oldString, newString: record.newString, unifiedDiff: record.unifiedDiff };
    case "write": return { type: "write" };
    case "plain_text": return { type: "plain_text", label: record.label, text: record.text, icon: record.icon };
    case "plan": return { type: "plan", text: record.text };
    case "unknown": return { type: "unknown", input: record.input };
    default: return { type: typeof record.type === "string" ? record.type : "untyped", value: record };
  }
}

function resultByteLength(detail: unknown, error: unknown): number | null {
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const output = (detail as Record<string, unknown>).output;
    if (typeof output === "string") return Buffer.byteLength(output, "utf8");
    if (output !== undefined) return Buffer.byteLength(JSON.stringify(output), "utf8");
  }
  return error === null || error === undefined ? null : Buffer.byteLength(JSON.stringify(error), "utf8");
}

function fingerprintError(error: unknown): unknown {
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const record = error as Record<string, unknown>;
    return { code: record.code ?? null, name: record.name ?? null, type: record.type ?? null, messageDigest: typeof record.message === "string" ? sha256Canonical(record.message) : null };
  }
  return { type: typeof error, messageDigest: typeof error === "string" ? sha256Canonical(error) : null };
}

function toolOutcome(status: string, error: unknown): ProviderTelemetryEvidenceV1["toolCalls"][number]["outcome"] {
  if (status === "completed") return "SUCCESS";
  if (status === "canceled") return "CANCELLED";
  if (status === "running") return "UNKNOWN_ERROR";
  const code = structuredErrorCode(error);
  if (["permission_denied", "tool_permission_denied", "not_authorized"].includes(code)) return "PERMISSION_DENIED";
  if (["timeout", "timed_out", "etimedout"].includes(code)) return "TIMEOUT";
  if (["invalid_argument", "invalid_args", "validation_error"].includes(code)) return "INVALID_ARGUMENT";
  if (["unavailable", "service_unavailable", "econnrefused"].includes(code)) return "UNAVAILABLE";
  return error === null || error === undefined ? "UNKNOWN_ERROR" : "TOOL_ERROR";
}

function structuredErrorCode(error: unknown): string {
  if (!error || typeof error !== "object" || Array.isArray(error)) return "";
  const record = error as Record<string, unknown>;
  const value = record.code ?? record.name ?? record.type;
  return typeof value === "string" ? value.toLowerCase() : "";
}

function metadataText(metadata: Record<string, unknown> | undefined, keys: string[]): string | null {
  if (!metadata) return null;
  for (const key of keys) if (typeof metadata[key] === "string" && metadata[key]) return (metadata[key] as string).slice(0, 200);
  return null;
}

function durationBetween(start?: string, finish?: string): number | null {
  if (!start || !finish) return null;
  const duration = Date.parse(finish) - Date.parse(start);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}


function validTime(value?: string): string | null { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null; }
function finiteMetric(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
function asRecord(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function indexOfTurn(turns: Array<{ turnId: string | null; sequence: number }>, turnId: string | null): number | null { return turnId ? turns.find((turn) => turn.turnId === turnId)?.sequence ?? null : null; }
