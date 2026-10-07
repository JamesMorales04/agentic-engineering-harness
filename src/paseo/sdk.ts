import process from "node:process";
import { pathToFileURL } from "node:url";
import { sha256Canonical } from "../core/digest.js";
import { createPermissionStopDiagnostic } from "./permissionDiagnostic.js";
import {
  acceptedStructuredResultForAgent,
  activateStructuredResultTurn,
  activateStructuredResultTurnForAgent,
  bindStructuredResultChannel,
  loadStructuredResultChannel,
  provisionStructuredResultChannel,
  resultSinkMcpServerDefinition,
  type StructuredResultExpectation,
  type StructuredResultProvenanceV1
} from "../workers/resultGateway.js";
import { resolvePaseoSdkFromCli } from "./sdkResolve.js";
import { recordPaseoTrace } from "./trace.js";
import {
  FIRST_ACTIVITY_DEADLINE_MS,
  FIRST_ACTIVITY_POLL_MS,
  stalledFirstActivityError,
  type ProviderTurnActivityCounts,
  type ProviderTurnKillReason
} from "./firstActivityDeadline.js";

export interface PaseoSdkMcpStdioServer {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  alwaysLoad?: boolean;
  /** Metadata consumed by AEH-managed MCP proxies; native Paseo ignores it. */
  toolPolicy?: { allow?: string[]; deny?: string[] };
}

export interface PaseoSdkToolPolicy {
  preapproved: Array<{ kind: "mcp"; server: string; tool: string }>;
}

export interface PaseoSdkAgentOptions {
  /** Provider resource id requested for a frozen pre-prompt execution binding. */
  agentId?: string;
  cwd: string;
  workspaceId?: string;
  parentAgentId?: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  env?: Record<string, string>;
  title: string;
  systemPrompt?: string;
  prompt?: string;
  outputSchema?: Record<string, unknown>;
  labels?: Record<string, string>;
  mcpServers?: Record<string, PaseoSdkMcpStdioServer>;
  toolPolicy?: PaseoSdkToolPolicy;
  /** Provider-native options validated by the selected provider (for example Codex sandbox policy). */
  providerOptions?: Record<string, unknown>;
  /** Paseo provider feature values (for example `{ auto_accept: true }` for OpenCode prompts). */
  featureValues?: Record<string, unknown>;
  timeoutMs?: number;
  waitForFinish?: boolean;
  /** Frozen provider permission projection used only to classify stop diagnostics. */
  permissionScopeRoots?: string[];
}

export interface PaseoSdkPermissionStop {
  name?: string;
  scopeRelation: "OUTSIDE" | "INSIDE" | "UNKNOWN";
  requestedScopeDigest?: string;
  sessionId?: string;
  turnId?: string;
}

export interface PaseoSdkAgentResult {
  id: string;
  workspaceId?: string;
  status?: string;
  lastMessage?: string;
  error?: string;
  /** Bounded identity of the provider approval prompt that stopped the turn (AEH-V2-0116). */
  permission?: PaseoSdkPermissionStop;
  /** Deadline-vs-stall-vs-error kill reason; present only on killed turns. */
  killReason?: ProviderTurnKillReason;
  /** Bounded provider-visible activity counts; refs-only, no provider content. */
  activity?: ProviderTurnActivityCounts;
  /** Typed 429/Retry-After detail parsed at the SDK boundary only; WAIT hint, never an attempt. */
  rateLimited?: ProviderRateLimitDetailV1;
}

export interface PaseoSdkAgentRecord {
  id: string;
  title?: string;
  status?: string;
  workspaceId?: string;
  labels?: Record<string, string>;
  raw: Record<string, unknown>;
}

interface PaseoSdkTurnResult {
  status: string;
  lastMessage?: string;
  error?: string;
  final?: { pendingPermissions?: unknown } | null;
  killReason?: ProviderTurnKillReason;
  activity?: ProviderTurnActivityCounts;
}

interface PaseoSdkAgentHandle {
  readonly id: string;
  readonly workspaceId?: string | null;
  readonly status?: unknown;
  readonly pendingPermissions?: unknown;
  latest?(): Record<string, unknown> | null;
  refresh?(requestId?: string): Promise<{ agent: Record<string, unknown>; project: unknown } | null>;
  refetch?(requestId?: string): Promise<{ agent: Record<string, unknown>; project: unknown } | null>;
  send?(text: string, options?: Record<string, unknown>): Promise<void>;
  run?(text: string, options?: { timeoutMs?: number; outputSchema?: Record<string, unknown> }): Promise<PaseoSdkTurnResult>;
  waitForFinish?(timeoutMs?: number): Promise<PaseoSdkTurnResult>;
  cancel?(): Promise<void>;
  stop?(): Promise<void>;
  kill?(): Promise<void>;
  abort?(): Promise<void>;
  archive?(): Promise<{ archivedAt: string }>;
  timeline?: { refetch(options?: Record<string, unknown>): Promise<unknown> };
}

interface PaseoSdkClient {
  readonly agents: {
    create(options: Record<string, unknown>): Promise<PaseoSdkAgentHandle>;
    ref(agentId: string): PaseoSdkAgentHandle;
    list(options?: Record<string, unknown>): Promise<{
      entries: Array<{ agent: Record<string, unknown> }>;
      nextCursor?: unknown;
      nextPageToken?: unknown;
    }>;
  };
  connect(): Promise<void>;
  close(): Promise<void>;
}

interface PaseoSdkModule {
  createPaseoClient(config: { url: string; clientId?: string; password?: string }): PaseoSdkClient;
}

export class PaseoSdkUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PaseoSdkUnavailableError";
  }
}

export class PaseoSdkTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaseoSdkTimeoutError";
  }
}

/**
 * Provider backpressure detail parsed at the SDK boundary only (Unit 3).
 *
 * MECHANISM: DETERMINISTIC. Pure inspection of the settled SDK error shape:
 * numeric 429 status fields plus case-insensitive 429/rate-limit/Too Many
 * Requests text. A bare `retry-after` hint without a 429/rate-limit signal is
 * never sufficient (narrow marker). No network, no retry, no clock except for
 * HTTP-date delta (injectable `nowMs` for deterministic tests).
 * The parsed `retryAfterMs` is the bounded WAIT hint (not an attempt): callers
 * honor it via `providerRateLimitWaitMs` against their existing deadline
 * budget, never extending caps. Waits are fail-closed (capped, zero on
 * exhausted budget, terminal when the budget cannot fit the wait).
 */
export const PROVIDER_RATE_LIMIT_STATUS_V1 = 429 as const;
export const PROVIDER_RATE_LIMIT_MAX_WAIT_MS_V1 = 60_000;
export const PROVIDER_RATE_LIMIT_DEFAULT_WAIT_MS_V1 = 1_000;

export type ProviderRateLimitRetryAfterSourceV1 =
  | "retry-after-seconds"
  | "retry-after-http-date"
  | "retry-after-ms"
  | "none";

export interface ProviderRateLimitDetailV1 {
  version: 1;
  status: 429;
  /** Bounded WAIT hint in ms, already clamped to 0..PROVIDER_RATE_LIMIT_MAX_WAIT_MS_V1. */
  retryAfterMs: number;
  retryAfterSource: ProviderRateLimitRetryAfterSourceV1;
  /** Bounded provider message excerpt (refs-only, ≤500 chars); present when parsed from text. */
  message?: string;
}

export class PaseoSdkRateLimitedError extends Error {
  readonly detail: ProviderRateLimitDetailV1;
  readonly status = PROVIDER_RATE_LIMIT_STATUS_V1;
  constructor(detail: ProviderRateLimitDetailV1, message?: string) {
    super(message ?? `Provider rate limited (429); retry after ${detail.retryAfterMs}ms.`);
    this.name = "PaseoSdkRateLimitedError";
    this.detail = detail;
  }
}

/** True when the settled value carries a 429/rate-limit signature (SDK boundary only). */
export function isProviderRateLimited(error: unknown, nowMs?: () => number): boolean {
  return parseProviderRateLimitDetail(error, nowMs) !== undefined;
}

/**
 * Parse a settled SDK failure into typed rate-limit detail. Returns undefined
 * when the value carries no 429/rate-limit signature (a bare `retry-after`
 * hint alone is not a signal). Retry-After is read from
 * (in priority order): explicit `retryAfterMs`/`retryAfter` numeric fields,
 * case-insensitive `headers["retry-after"]` (seconds or HTTP-date), then
 * `Retry-After: <n>` / `retry after <n><unit>` message patterns. All waits are
 * clamped to 0..MAX; a bare 429 without a hint defaults to the bounded
 * stampede-avoidance wait (1s) so immediate retries never hammer one window.
 * `nowMs` is the injectable clock for HTTP-date deltas (defaults to Date.now).
 */
export function parseProviderRateLimitDetail(error: unknown, nowMs?: () => number): ProviderRateLimitDetailV1 | undefined {
  if (error instanceof PaseoSdkRateLimitedError) return error.detail;
  const status = readRateLimitStatus(error);
  const message = readRateLimitMessage(error);
  const headers = readRateLimitHeaders(error);
  const hasStatus = status === PROVIDER_RATE_LIMIT_STATUS_V1;
  const hasMarker = message !== undefined && RATE_LIMIT_MARKER_RE.test(message);
  if (!hasStatus && !hasMarker) return undefined;
  const parsed = readRetryAfterMs(error, headers, message, nowMs);
  const retryAfterMs = clampRateLimitWaitMs(parsed?.ms ?? PROVIDER_RATE_LIMIT_DEFAULT_WAIT_MS_V1);
  return {
    version: 1,
    status: PROVIDER_RATE_LIMIT_STATUS_V1,
    retryAfterMs,
    retryAfterSource: parsed?.source ?? "none",
    ...(message ? { message: message.slice(0, 500) } : {})
  };
}

/**
 * Honor a parsed Retry-After as WAIT against an existing deadline budget.
 * Never extends caps: returns `min(boundedWait, remainingBudget)`, or 0 when
 * the detail is missing or the budget is exhausted (terminal, fail-closed).
 * A WAIT is not an attempt: callers must not increment retry counters for it.
 */
export function providerRateLimitWaitMs(
  detail: ProviderRateLimitDetailV1 | undefined,
  remainingBudgetMs?: number
): number {
  if (!detail) return 0;
  const bounded = clampRateLimitWaitMs(detail.retryAfterMs);
  if (remainingBudgetMs === undefined) return bounded;
  if (!Number.isFinite(remainingBudgetMs) || remainingBudgetMs <= 0) return 0;
  return Math.min(bounded, Math.floor(remainingBudgetMs));
}

/**
 * SDK-boundary 429/Retry-After WAIT+retry within an existing deadline.
 *
 * MECHANISM: DETERMINISTIC classification + bounded WAIT. The settled error is
 * parsed via `parseProviderRateLimitDetail` (narrow 429/rate-limit marker, never
 * bare `retry-after`); non-rate-limit failures rethrow immediately. A
 * rate-limit WAIT is honored via `providerRateLimitWaitMs` against the
 * caller's existing `timeoutMs` budget (never extends caps; `min(bounded,
 * remaining)`; 0 when exhausted → terminal `PaseoSdkRateLimitedError`).
 * A WAIT is not an attempt: retry counters must not increment for it; the
 * loop is bounded by the deadline so exhaustion is terminal fail-closed.
 * Injectable `nowMs`/`sleepMs` keep fixtures scripted with no network (same
 * pattern as `waitForProviderSessionCapacity`).
 */
export interface ProviderRateLimitRetryOptionsV1 {
  timeoutMs?: number;
  nowMs?: () => number;
  sleepMs?: (ms: number) => Promise<void>;
  onWait?: (waitMs: number, detail: ProviderRateLimitDetailV1) => void;
}

export async function withProviderRateLimitRetry<T>(
  action: (remainingBudgetMs: number | undefined) => Promise<T>,
  options: ProviderRateLimitRetryOptionsV1 = {}
): Promise<T> {
  const nowMs = options.nowMs ?? Date.now;
  const sleepMs = options.sleepMs ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = nowMs();
  const timeoutMs = options.timeoutMs;
  const deadlineAt = timeoutMs !== undefined ? startedAt + timeoutMs : undefined;
  // Luna F1: never mint fresh time when the caller has no deadline. Undefined
  // timeout means no wait budget: single attempt, 429 is terminal immediately
  // (no implicit 60s WAIT). Defined timeout bounds WAIT via min(bounded,
  // remaining); exhaustion is terminal fail-closed. MECHANISM: DETERMINISTIC.
  for (;;) {
    const now = nowMs();
    const remaining = deadlineAt !== undefined ? deadlineAt - now : undefined;
    try {
      return await action(remaining);
    } catch (error) {
      const detail = parseProviderRateLimitDetail(error, nowMs);
      if (!detail) throw error;
      const effectiveRemaining = deadlineAt !== undefined ? deadlineAt - nowMs() : 0;
      const waitMs = providerRateLimitWaitMs(detail, effectiveRemaining);
      if (waitMs <= 0) {
        if (error instanceof PaseoSdkRateLimitedError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        const typed = new PaseoSdkRateLimitedError(detail, message);
        (typed as unknown as { cause: unknown }).cause = error;
        throw typed;
      }
      options.onWait?.(waitMs, detail);
      await sleepMs(waitMs);
    }
  }
}

const RATE_LIMIT_MARKER_RE = /(?:\b429\b|rate[\s_\-]*limit|too many requests)/i;
const RETRY_AFTER_MESSAGE_RE = /retry[\s_\-]*after\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(ms|s(?:ec(?:ond)?s?)?|m(?:in(?:ute)?s?)?)?/i;

function clampRateLimitWaitMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(PROVIDER_RATE_LIMIT_MAX_WAIT_MS_V1, Math.floor(value));
}

function readRateLimitStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  for (const key of ["statusCode", "status", "code"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isSafeInteger(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  }
  const detail = record.detail;
  if (detail && typeof detail === "object") {
    const nested = (detail as Record<string, unknown>).status;
    if (typeof nested === "number" && Number.isSafeInteger(nested)) return nested;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const nested = (cause as Record<string, unknown>).status ?? (cause as Record<string, unknown>).statusCode;
    if (typeof nested === "number" && Number.isSafeInteger(nested)) return nested;
  }
  return undefined;
}

function readRateLimitMessage(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    const parts = [error.message, (error as { cause?: unknown }).cause instanceof Error ? String((error.cause as Error).message) : undefined];
    const joined = parts.filter(Boolean).join(" ").trim();
    return joined ? joined : undefined;
  }
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    for (const key of ["message", "error", "lastError"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return undefined;
}

function readRateLimitHeaders(error: unknown): Record<string, unknown> | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  const direct = record.headers;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct as Record<string, unknown>;
  const response = record.response;
  if (response && typeof response === "object" && !Array.isArray(response)) {
    const nested = (response as Record<string, unknown>).headers;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested as Record<string, unknown>;
  }
  return undefined;
}

function readRetryAfterMs(
  error: unknown,
  headers: Record<string, unknown> | undefined,
  message: string | undefined,
  nowMs?: () => number
): { ms: number; source: ProviderRateLimitRetryAfterSourceV1 } | undefined {
  const record = (error && typeof error === "object" ? error as Record<string, unknown> : undefined);
  if (record) {
    const explicitMs = record.retryAfterMs ?? record.retry_after_ms;
    if (typeof explicitMs === "number" && Number.isFinite(explicitMs)) {
      return { ms: explicitMs, source: "retry-after-ms" };
    }
    for (const key of ["retryAfter", "retry_after", "retryAfterSeconds", "retry_after_seconds"]) {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        return { ms: value * 1_000, source: "retry-after-seconds" };
      }
      if (typeof value === "string" && value.trim()) {
        const parsed = parseRetryAfterHeaderValue(value.trim(), nowMs);
        if (parsed) return parsed;
      }
    }
  }
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() !== "retry-after") continue;
      if (typeof value === "number" && Number.isFinite(value)) {
        return { ms: value * 1_000, source: "retry-after-seconds" };
      }
      if (typeof value === "string" && value.trim()) {
        const parsed = parseRetryAfterHeaderValue(value.trim(), nowMs);
        if (parsed) return parsed;
      }
    }
  }
  if (message) {
    const match = RETRY_AFTER_MESSAGE_RE.exec(message);
    if (match) {
      const amount = Number.parseFloat(match[1]!);
      if (Number.isFinite(amount) && amount >= 0) {
        const unit = (match[2] ?? "s").toLowerCase();
        const ms = unit.startsWith("ms") ? amount : unit.startsWith("m") ? amount * 60_000 : amount * 1_000;
        return { ms, source: "retry-after-seconds" };
      }
    }
  }
  return undefined;
}

export function parseRetryAfterHeaderValue(
  value: string,
  nowMs?: () => number
): { ms: number; source: ProviderRateLimitRetryAfterSourceV1 } | undefined {
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    return { ms: Number.parseFloat(value) * 1_000, source: "retry-after-seconds" };
  }
  const withUnit = /^(\d+(?:\.\d+)?)\s*(ms|s|m)$/i.exec(value);
  if (withUnit) {
    const amount = Number.parseFloat(withUnit[1]!);
    const unit = withUnit[2]!.toLowerCase();
    return { ms: unit === "ms" ? amount : unit === "m" ? amount * 60_000 : amount * 1_000, source: "retry-after-seconds" };
  }
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    const now = (nowMs ?? Date.now)();
    return { ms: Math.max(0, dateMs - now), source: "retry-after-http-date" };
  }
  return undefined;
}

export async function connectPaseoClient(
  client: { connect(): Promise<void> },
  timeoutMs = 15_000
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.connect(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new PaseoSdkTimeoutError(`Connecting to the Paseo daemon timed out after ${timeoutMs}ms.`)),
          timeoutMs
        );
      })
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PaseoSdkUnavailableError(`Unable to connect to the Paseo daemon through @getpaseo/client: ${message}`, { cause: error });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function createPaseoSdkAgent(root: string, options: PaseoSdkAgentOptions): Promise<PaseoSdkAgentResult> {
  const effective = await withStructuredResultSink(root, options, Boolean(options.prompt !== undefined && options.outputSchema));
  const result = await withPaseoClient(root, async (client) => createPaseoSdkAgentWithClient(client, effective));
  await bindStructuredResultFromOptions(root, effective, result.id);
  return projectAcceptedPaseoResult(root, result, structuredResultExpectation(effective.labels));
}

export async function materializePaseoSdkAgent(root: string, options: PaseoSdkAgentOptions): Promise<PaseoSdkAgentResult> {
  const effective = await withStructuredResultSink(root, options, false);
  const result = await withPaseoClient(root, async (client) => materializePaseoSdkAgentWithClient(client, effective));
  await bindStructuredResultFromOptions(root, effective, result.id);
  return result;
}

export async function materializePaseoSdkAgentWithClient(
  client: PaseoSdkClient,
  options: PaseoSdkAgentOptions,
  retryOptions: ProviderRateLimitRetryOptionsV1 = {}
): Promise<PaseoSdkAgentResult> {
  let lastDetail: ProviderRateLimitDetailV1 | undefined;
  const result = await withProviderRateLimitRetry(
    async (remaining) => {
      // Luna F3: remaining budget threads into the create attempt (WAIT = min,
      // terminal on exhaustion). A create is an attempt: it never runs past the
      // caller's existing deadline and never starts when the budget is exhausted.
      // MECHANISM: DETERMINISTIC. attemptTimeout = remaining ?? options.timeoutMs;
      // exhausted (<=0, non-finite when a budget exists) fails closed with no
      // create call; otherwise create races the same bounded timeout.
      const attemptTimeout = remaining ?? options.timeoutMs;
      if (attemptTimeout !== undefined && (!Number.isFinite(attemptTimeout) || attemptTimeout <= 0)) {
        throw new PaseoSdkTimeoutError(
          `Paseo agent materialize timed out after ${options.timeoutMs ?? 0}ms (budget exhausted before create; fail-closed, no attempt).`
        );
      }
      const handle = await withTimeout(
        client.agents.create(buildCreateOptions(options, false)),
        attemptTimeout,
        `Paseo agent materialize timed out after ${attemptTimeout ?? 1_800_000}ms.`
      );
      return handleResult(handle, options.permissionScopeRoots);
    },
    {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(retryOptions.nowMs ? { nowMs: retryOptions.nowMs } : {}),
      ...(retryOptions.sleepMs ? { sleepMs: retryOptions.sleepMs } : {}),
      onWait: (waitMs, detail) => {
        lastDetail = detail;
        retryOptions.onWait?.(waitMs, detail);
      }
    }
  );
  return lastDetail && !result.rateLimited ? { ...result, rateLimited: lastDetail } : result;
}

export async function createPaseoSdkAgentWithClient(
  client: PaseoSdkClient,
  options: PaseoSdkAgentOptions,
  retryOptions: ProviderRateLimitRetryOptionsV1 = {}
): Promise<PaseoSdkAgentResult> {
  let lastDetail: ProviderRateLimitDetailV1 | undefined;
  const result = await withProviderRateLimitRetry(
    async (remaining) => {
      // Same remaining-budget bound as materialize: create never outlives the
      // caller's existing deadline; exhausted budget fails closed with no attempt.
      // MECHANISM: DETERMINISTIC (same rule as materialize; caps unchanged).
      const attemptTimeout = remaining ?? options.timeoutMs;
      if (attemptTimeout !== undefined && (!Number.isFinite(attemptTimeout) || attemptTimeout <= 0)) {
        throw new PaseoSdkTimeoutError(
          `Paseo agent create timed out after ${options.timeoutMs ?? 0}ms (budget exhausted before create; fail-closed, no attempt).`
        );
      }
      const handle = await withTimeout(
        client.agents.create(buildCreateOptions(options, options.prompt !== undefined)),
        attemptTimeout,
        `Paseo agent create timed out after ${attemptTimeout ?? 1_800_000}ms.`
      );
      if (options.prompt !== undefined && options.waitForFinish !== false) {
        const effectiveTimeout = remaining ?? options.timeoutMs;
        const waited = await waitForHandle(handle, effectiveTimeout, options.permissionScopeRoots);
        if (waited.status === "timeout") await stopPaseoSdkAgentHandle(handle);
        return waited;
      }
      return handleResult(handle, options.permissionScopeRoots);
    },
    {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(retryOptions.nowMs ? { nowMs: retryOptions.nowMs } : {}),
      ...(retryOptions.sleepMs ? { sleepMs: retryOptions.sleepMs } : {}),
      onWait: (waitMs, detail) => {
        lastDetail = detail;
        retryOptions.onWait?.(waitMs, detail);
      }
    }
  );
  return lastDetail && !result.rateLimited ? { ...result, rateLimited: lastDetail } : result;
}

export async function dispatchPaseoSdkAgent(root: string, agentId: string, prompt: string, timeoutMs?: number, permissionScopeRoots?: string[]): Promise<PaseoSdkAgentResult> {
  return withPaseoClient(root, (client) => dispatchPaseoSdkAgentWithClient(client, agentId, prompt, timeoutMs, permissionScopeRoots));
}

export async function dispatchPaseoSdkAgentWithClient(
  client: PaseoSdkClient,
  agentId: string,
  prompt: string,
  timeoutMs?: number,
  permissionScopeRoots?: string[],
  activityOptions?: PaseoSdkRunActivityOptions,
  retryOptions: ProviderRateLimitRetryOptionsV1 = {}
): Promise<PaseoSdkAgentResult> {
  let lastDetail: ProviderRateLimitDetailV1 | undefined;
  const result = await withProviderRateLimitRetry(
    async (remaining) => {
      const attemptTimeout = remaining ?? timeoutMs;
      const handle = client.agents.ref(agentId);
      if (typeof handle.send === "function") {
        // A4 structural fallback (proven): `send()` is fire-and-forget — it
        // returns once the turn is accepted, before any provider-visible
        // activity could exist, so no interim-progress handle exists to watch.
        // The bound is carried by the subsequent `waitManagedPaseoAgent`
        // (first-activity watch on the wait + post-timeout stop verification
        // with quiescence), never by this dispatch result (status working,
        // no kill verdict — correctly unmarked).
        try {
          await withTimeout(handle.send(prompt), attemptTimeout, `Paseo agent ${agentId} dispatch timed out after ${attemptTimeout ?? 1_800_000}ms.`);
        } catch (error) {
          if (error instanceof PaseoSdkTimeoutError) await stopPaseoSdkAgentHandle(handle);
          throw error;
        }
        return { ...(await handleResult(handle, permissionScopeRoots)), status: statusText(handle.status) ?? "working" };
      }
      if (typeof handle.run === "function") {
        // A4: the atomic dispatch-run carries the same first-activity watch
        // as the resumed-turn run path (same stop-then-read verdicts).
        const turn = await runWithFirstActivityWatch(handle, () => handle.run!(prompt, { timeoutMs: attemptTimeout }), attemptTimeout, activityOptions);
        if (turn.status === "timeout") await stopPaseoSdkAgentHandle(handle);
        if (turn.killReason === "STALLED_FIRST_ACTIVITY") {
          return {
            id: handle.id,
            workspaceId: handle.workspaceId ?? undefined,
            status: turn.status,
            error: turn.error,
            killReason: turn.killReason,
            ...(turn.activity ? { activity: turn.activity } : {})
          };
        }
        // Late-activity stop (stop-then-read invariant): the turn still failed by
        // stop, but the post-stop read proved provider-visible content. Preserve
        // the completed turn text for forensics via turnResult while keeping the
        // correct DEADLINE classification and activity counts.
        if (turn.killReason || turn.activity) {
          const base = await turnResult(handle, turn, permissionScopeRoots);
          return {
            ...base,
            ...(turn.killReason ? { killReason: turn.killReason } : {}),
            ...(turn.activity ? { activity: turn.activity } : {})
          };
        }
        return turnResult(handle, turn, permissionScopeRoots);
      }
      throw new PaseoSdkUnavailableError("The active @getpaseo/client agent handle exposes neither send() nor run(); cannot dispatch a turn through the SDK.");
    },
    {
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(retryOptions.nowMs ? { nowMs: retryOptions.nowMs } : {}),
      ...(retryOptions.sleepMs ? { sleepMs: retryOptions.sleepMs } : {}),
      onWait: (waitMs, detail) => {
        lastDetail = detail;
        retryOptions.onWait?.(waitMs, detail);
      }
    }
  );
  return lastDetail && !result.rateLimited ? { ...result, rateLimited: lastDetail } : result;
}

export async function waitPaseoSdkAgent(root: string, agentId: string, timeoutMs?: number, permissionScopeRoots?: string[], activityOptions?: PaseoSdkRunActivityOptions): Promise<PaseoSdkAgentResult> {
  const result = await withPaseoClient(root, async (client) => {
    const handle = client.agents.ref(agentId);
    const result = await waitForHandle(handle, timeoutMs, permissionScopeRoots, activityOptions);
    if (result.status === "timeout") await stopPaseoSdkAgentHandle(handle);
    return result;
  });
  return projectAcceptedPaseoResult(root, result, { requireBoundProvenance: true, verifyCurrentCandidate: true });
}

/** Execute one resumed turn on one concrete SDK handle. Prefer the SDK's atomic
 * run() primitive so dispatch and completion observation cannot be separated by
 * an idle->running->idle race. Older SDKs fall back to send()+waitForFinish()
 * on the same handle/client. Structured output constraints accompany the turn
 * when provided. When the session has an AEH structured-result capability, the
 * accepted durable result artifact is projected back into lastMessage so legacy
 * consumers remain compatible without making transcript text lifecycle authority. */
/** First-activity bound for one atomic SDK run. Disabled when at/above the turn deadline. */
export interface PaseoSdkRunActivityOptions {
  firstActivityMs?: number;
  pollMs?: number;
}

export async function runPaseoSdkAgent(
  root: string,
  agentId: string,
  prompt: string,
  timeoutMs?: number,
  outputSchema?: Record<string, unknown>,
  phase?: string,
  permissionScopeRoots?: string[],
  activityOptions?: PaseoSdkRunActivityOptions
): Promise<PaseoSdkAgentResult> {
  if (outputSchema) await activateStructuredResultTurnForAgent(root, agentId, phase);
  const result = await withPaseoClient(root, async (client) =>
    runPaseoSdkAgentWithClient(client, agentId, prompt, timeoutMs, outputSchema, permissionScopeRoots, activityOptions)
  );
  let projected = await projectAcceptedPaseoResult(root, result, { requireBoundProvenance: true, verifyCurrentCandidate: true });
  if (!projected.lastMessage?.trim()) {
    // Some provider handles do not expose the completed turn text on the run handle; the
    // canonical agent timeline still carries the assistant message and is the deterministic
    // fallback for non-participant (assessor) turns that have no durable structured-result sink.
    let timelineError: string | undefined;
    const timeline = await inspectPaseoSdkAgentTimeline(root, agentId).catch((error) => {
      timelineError = error instanceof Error ? error.message : String(error);
      return undefined;
    });
    if (timelineError) await recordPaseoTrace(root, "timeline.refetch.failed", { agentId, error: timelineError, direction: "tail" }).catch(() => undefined);
    const recovered = timeline?.length ? extractLastAssistantText(timeline) : undefined;
    if (recovered) projected = { ...projected, lastMessage: recovered };
  }
  return projected;
}

export async function runPaseoSdkAgentWithClient(
  client: PaseoSdkClient,
  agentId: string,
  prompt: string,
  timeoutMs?: number,
  outputSchema?: Record<string, unknown>,
  permissionScopeRoots?: string[],
  activityOptions?: PaseoSdkRunActivityOptions,
  retryOptions: ProviderRateLimitRetryOptionsV1 = {}
): Promise<PaseoSdkAgentResult> {
  let lastDetail: ProviderRateLimitDetailV1 | undefined;
  const result = await withProviderRateLimitRetry(
    async (remaining) => {
      const attemptTimeout = remaining ?? timeoutMs;
      const handle = client.agents.ref(agentId);
      if (typeof handle.run === "function") {
        const turn = await runWithFirstActivityWatch(handle, () => handle.run!(prompt, { timeoutMs: attemptTimeout, ...(outputSchema ? { outputSchema } : {}) }), attemptTimeout, activityOptions);
        if (turn.status === "timeout") await stopPaseoSdkAgentHandle(handle);
        if (turn.killReason === "STALLED_FIRST_ACTIVITY") {
          return {
            id: handle.id,
            workspaceId: handle.workspaceId ?? undefined,
            status: turn.status,
            error: turn.error,
            killReason: turn.killReason,
            ...(turn.activity ? { activity: turn.activity } : {})
          };
        }
        // Late-activity stop (stop-then-read invariant): the turn still failed by
        // stop, but the post-stop read proved provider-visible content. Preserve
        // the completed turn text for forensics via turnResult while keeping the
        // correct DEADLINE classification and activity counts.
        if (turn.killReason || turn.activity) {
          const base = await turnResult(handle, turn, permissionScopeRoots);
          return {
            ...base,
            ...(turn.killReason ? { killReason: turn.killReason } : {}),
            ...(turn.activity ? { activity: turn.activity } : {})
          };
        }
        return turnResult(handle, turn, permissionScopeRoots);
      }
      if (typeof handle.send === "function") {
        await withTimeout(handle.send(prompt, outputSchema ? { outputSchema } : undefined), attemptTimeout, `Paseo agent ${agentId} turn dispatch timed out after ${attemptTimeout ?? 1_800_000}ms.`).catch(async (error) => {
          if (error instanceof PaseoSdkTimeoutError) await stopPaseoSdkAgentHandle(handle);
          throw error;
        });
        const waited = await waitForHandle(handle, attemptTimeout, permissionScopeRoots, activityOptions);
        if (waited.status === "timeout") await stopPaseoSdkAgentHandle(handle);
        return waited;
      }
      throw new PaseoSdkUnavailableError("The active @getpaseo/client agent handle exposes neither run() nor send(); cannot execute an atomic resumed turn through the SDK.");
    },
    {
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(retryOptions.nowMs ? { nowMs: retryOptions.nowMs } : {}),
      ...(retryOptions.sleepMs ? { sleepMs: retryOptions.sleepMs } : {}),
      onWait: (waitMs, detail) => {
        lastDetail = detail;
        retryOptions.onWait?.(waitMs, detail);
      }
    }
  );
  return lastDetail && !result.rateLimited ? { ...result, rateLimited: lastDetail } : result;
}

export async function archivePaseoSdkAgent(root: string, agentId: string): Promise<void> {
  return withPaseoClient(root, async (client) => {
    const handle = client.agents.ref(agentId);
    if (typeof handle.archive !== "function") throw new PaseoSdkUnavailableError("The active @getpaseo/client agent handle does not expose archive().");
    await handle.archive();
  });
}

export async function inspectPaseoSdkAgent(root: string, agentId: string): Promise<PaseoSdkAgentRecord | undefined> {
  return withPaseoClient(root, async (client) => {
    const raw = await refreshHandle(client.agents.ref(agentId));
    return raw ? normalizeRecord(raw) : undefined;
  });
}

export async function inspectPaseoSdkAgentTimeline(root: string, agentId: string): Promise<unknown[] | undefined> {
  return withPaseoClient(root, async (client) => {
    const handle = client.agents.ref(agentId);
    if (!handle.timeline || typeof handle.timeline.refetch !== "function") return undefined;
    const result = await handle.timeline.refetch({ direction: "tail", limit: 100 });
    return extractTimelineEntries(result);
  });
}

export async function probePaseoSdkAgent(root: string, agentId: string): Promise<boolean> {
  return Boolean(await inspectPaseoSdkAgent(root, agentId));
}

/**
 * Safety bound for SDK agent-listing pagination. Pages are consumed until the
 * server stops returning a continuation cursor; the cap only fires on a
 * pathological server that mints fresh cursors forever (fail-closed, keep
 * what was listed). Single-page servers behave exactly as before.
 */
export const MAX_PASEO_SDK_AGENT_LIST_PAGES_V1 = 50;

/**
 * Honest result of SDK agent-listing pagination. `exhausted` is true ONLY
 * when the server cursor is genuinely exhausted (a page arrived with no fresh
 * continuation cursor). Hitting the 50-page safety cap or observing a
 * repeated cursor yields `exhausted: false` with the stop reason recorded, so
 * callers doing gone-proof work (e.g. ledger pruning) can fail closed instead
 * of treating a possibly-partial accumulation as complete.
 * MECHANISM: DETERMINISTIC.
 */
export interface PaseoSdkAgentListingV1 {
  agents: PaseoSdkAgentRecord[];
  exhausted: boolean;
  /** Pages consumed (bounded by MAX_PASEO_SDK_AGENT_LIST_PAGES_V1). */
  pages: number;
  stopReason: "exhausted" | "page-cap" | "repeated-cursor";
}

export async function listPaseoSdkAgents(root: string, labels: Record<string, string> = {}): Promise<PaseoSdkAgentListingV1> {
  return withPaseoClient(root, (client) => listPaseoSdkAgentsWithClient(client, labels));
}

/**
 * List agents matching `labels` across server pages (bounded loop; the cursor
 * is opaque pass-through). MECHANISM: DETERMINISTIC. The listing stops at the
 * first page without a fresh non-empty string cursor (`exhausted: true`); a
 * repeated cursor or the page cap stops early with `exhausted: false`.
 */
export async function listPaseoSdkAgentsWithClient(
  client: PaseoSdkClient,
  labels: Record<string, string> = {}
): Promise<PaseoSdkAgentListingV1> {
  const filter: Record<string, unknown> = { includeArchived: false };
  if (Object.keys(labels).length) filter.labels = labels;
  if (typeof client.agents.list !== "function") throw new PaseoSdkUnavailableError("The active @getpaseo/client does not expose agents.list().");
  const out: PaseoSdkAgentRecord[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  let stopReason: PaseoSdkAgentListingV1["stopReason"] = "page-cap";
  let pages = 0;
  for (let page = 0; page < MAX_PASEO_SDK_AGENT_LIST_PAGES_V1; page += 1) {
    const response = await client.agents.list(cursor ? { filter, cursor } : { filter });
    pages += 1;
    for (const entry of response.entries) {
      const record = normalizeRecord(entry.agent);
      if (labelsMatch(record.labels, labels)) out.push(record);
    }
    const next = listContinuationCursor(response);
    if (!next) {
      stopReason = "exhausted";
      break;
    }
    if (seenCursors.has(next)) {
      stopReason = "repeated-cursor";
      break;
    }
    seenCursors.add(next);
    cursor = next;
  }
  return { agents: out, exhausted: stopReason === "exhausted", pages, stopReason };
}

function listContinuationCursor(response: { nextCursor?: unknown; nextPageToken?: unknown }): string | undefined {
  for (const key of ["nextCursor", "nextPageToken"] as const) {
    const value = response[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

async function withStructuredResultSink(root: string, options: PaseoSdkAgentOptions, activateInitialTurn: boolean): Promise<PaseoSdkAgentOptions> {
  const contract = options.labels?.["aeh.output.contract"]?.trim();
  const operationId = options.labels?.["aeh.operation"]?.trim();
  const logicalAgent = options.labels?.["aeh.role"]?.trim();
  if (!contract || !operationId || !logicalAgent) return options;
  const operationRevision = Number(options.labels?.["aeh.operation.revision"]);
  const supervisorGeneration = Number(options.labels?.["aeh.supervisor.generation"]);
  const taskId = options.labels?.["aeh.task"]?.trim();
  const role = options.labels?.["aeh.canonical.role"]?.trim();
  const rawBinding = options.labels?.["aeh.execution.binding"];
  if (!rawBinding) {
    const pendingChannelId = options.labels?.["aeh.result.channel"]?.trim();
    if (options.labels?.["aeh.execution.binding.phase"] !== "PENDING_SESSION" || !pendingChannelId) {
      throw new Error("EXECUTION_BINDING_REQUIRED: Paseo structured-result launch must carry a complete versioned binding or an inert pending-session channel.");
    }
    const pending = await loadStructuredResultChannel(root, operationId, pendingChannelId);
    if (pending.operationId !== operationId || pending.logicalAgent !== logicalAgent || pending.role !== role || pending.taskId !== taskId || pending.contract !== contract || pending.provenance.status !== "UNSUPPORTED" || pending.agentId || pending.activeTurn || !options.mcpServers?.["aeh-result"] || !options.toolPolicy?.preapproved.some((item) => item.kind === "mcp" && item.server === "aeh-result" && item.tool === "aeh_submit_result")) {
      throw new Error("AEH_RESULT_PROVENANCE: pending Paseo result channel is not inert or does not match the launch contract.");
    }
    return options;
  }
  const provenance = parseStructuredResultProvenance(options.labels?.["aeh.result.provenance"], {
    operationId,
    logicalAgent,
    role,
    taskId,
    contract
  });
  if (!rawBinding || !provenance.executionBinding || rawBinding !== JSON.stringify(provenance.executionBinding) || options.labels?.["aeh.execution.binding.digest"] !== provenance.executionBinding.digest) throw new Error("EXECUTION_BINDING_REQUIRED: Paseo structured-result launch must carry the complete versioned binding in its launch labels.");
  const channel = await provisionStructuredResultChannel(root, {
    operationId,
    logicalAgent,
    role,
    taskId,
    contract,
    operationRevision: Number.isInteger(operationRevision) ? operationRevision : undefined,
    supervisorGeneration: Number.isInteger(supervisorGeneration) ? supervisorGeneration : undefined,
    provenance
  });
  if (activateInitialTurn) await activateStructuredResultTurn(root, operationId, channel.channelId, options.labels?.["aeh.operation.phase"]);
  const server = "aeh-result";
  const preapproved = [
    ...(options.toolPolicy?.preapproved ?? []).filter((item) => !(item.kind === "mcp" && item.server === server && item.tool === "aeh_submit_result")),
    { kind: "mcp" as const, server, tool: "aeh_submit_result" }
  ];
  return {
    ...options,
    labels: { ...options.labels, "aeh.result.channel": channel.channelId },
    mcpServers: { ...(options.mcpServers ?? {}), [server]: resultSinkMcpServerDefinition(root, operationId, channel.channelId) },
    toolPolicy: { preapproved }
  };
}

async function bindStructuredResultFromOptions(root: string, options: PaseoSdkAgentOptions, agentId: string): Promise<void> {
  const operationId = options.labels?.["aeh.operation"]?.trim();
  const channelId = options.labels?.["aeh.result.channel"]?.trim();
  if (!operationId || !channelId) return;
  await bindStructuredResultChannel(root, operationId, channelId, agentId);
}

async function projectAcceptedPaseoResult(root: string, result: PaseoSdkAgentResult, expected: StructuredResultExpectation = { requireBoundProvenance: true, verifyCurrentCandidate: true }): Promise<PaseoSdkAgentResult> {
  const accepted = await acceptedStructuredResultForAgent(root, result.id, expected).catch(() => undefined);
  return accepted ? { ...result, lastMessage: JSON.stringify(accepted.payload) } : result;
}

function parseStructuredResultProvenance(
  raw: string | undefined,
  identity: { operationId: string; logicalAgent: string; role?: string; taskId?: string; contract: string }
): StructuredResultProvenanceV1 {
  if (raw) {
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch { throw new Error("AEH_RESULT_PROVENANCE: Paseo launch provenance label is not valid JSON."); }
    const provenance = value as StructuredResultProvenanceV1;
    if (!provenance || provenance.version !== 1 || provenance.operationId !== identity.operationId || provenance.logicalAgent !== identity.logicalAgent || provenance.role !== identity.role || provenance.taskId !== identity.taskId || provenance.outputContract !== identity.contract) {
      throw new Error("AEH_RESULT_PROVENANCE: Paseo launch provenance label does not match operation/participant/task/contract labels.");
    }
    return provenance;
  }
  throw new Error("EXECUTION_BINDING_REQUIRED: Paseo structured-result launches must propagate a complete versioned StructuredResultProvenance before session creation.");
}

function structuredResultExpectation(labels: Record<string, string> | undefined): StructuredResultExpectation {
  const operationId = labels?.["aeh.operation"];
  const logicalAgent = labels?.["aeh.role"];
  const raw = labels?.["aeh.result.provenance"];
  if (!operationId || !logicalAgent || !raw) return { requireBoundProvenance: true, verifyCurrentCandidate: true };
  return {
    operationId,
    logicalAgent,
    role: labels?.["aeh.canonical.role"],
    taskId: labels?.["aeh.task"],
    contract: labels?.["aeh.output.contract"],
    provenance: parseStructuredResultProvenance(raw, { operationId, logicalAgent, role: labels?.["aeh.canonical.role"], taskId: labels?.["aeh.task"], contract: labels?.["aeh.output.contract"] ?? "" }),
    requireBoundProvenance: true,
    verifyCurrentCandidate: true
  };
}

async function withPaseoClient<T>(root: string, action: (client: PaseoSdkClient) => Promise<T>): Promise<T> {
  const sdk = await loadPaseoSdk(root);
  const client = sdk.createPaseoClient({
    url: process.env.PASEO_DAEMON_URL?.trim() || "ws://127.0.0.1:6767/ws",
    clientId: `aeh-${process.pid}`,
    password: process.env.PASEO_DAEMON_PASSWORD?.trim() || undefined
  });
  try {
    await connectPaseoClient(client);
    return await action(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function loadPaseoSdk(root: string): Promise<PaseoSdkModule> {
  const bundled = await resolvePaseoSdkFromCli(root);
  if (bundled.resolved) {
    try {
      const sdk = (await import(pathToFileURL(bundled.resolved).href)) as unknown as PaseoSdkModule;
      if (typeof sdk.createPaseoClient === "function") return sdk;
    } catch (error) { bundled.diagnostics.push(`bundled import: ${String(error)}`); }
  }
  const packageName = "@getpaseo/client";
  let directError: unknown;
  try {
    const direct = (await import(packageName)) as unknown as PaseoSdkModule;
    if (typeof direct.createPaseoClient === "function") return direct;
  } catch (error) { directError = error; }
  const detail = bundled.diagnostics.length ? ` Resolution diagnostics: ${bundled.diagnostics.join("; ")}.` : "";
  throw new PaseoSdkUnavailableError(`@getpaseo/client could not be resolved from the active Paseo CLI installation or directly.${detail}${directError ? ` Direct import: ${String(directError)}` : ""}`, { cause: directError });
}

function buildCreateOptions(options: PaseoSdkAgentOptions, includePrompt: boolean): Record<string, unknown> {
  const config: Record<string, unknown> = { provider: providerModelForSdk(options.provider, options.model) };
  if (options.modeId) config.modeId = options.modeId;
  if (options.thinkingOptionId) config.thinkingOptionId = options.thinkingOptionId;
  if (options.systemPrompt) config.systemPrompt = options.systemPrompt;
  if (options.mcpServers && Object.keys(options.mcpServers).length) config.mcpServers = options.mcpServers;
  if (options.toolPolicy?.preapproved.length) config.toolPolicy = options.toolPolicy;
  if (options.providerOptions && Object.keys(options.providerOptions).length) config.options = options.providerOptions;
  if (options.featureValues && Object.keys(options.featureValues).length) config.featureValues = options.featureValues;

  const createOptions: Record<string, unknown> = { config, title: options.title, cwd: options.cwd };
  if (options.agentId) createOptions.agentId = options.agentId;
  if (options.env && Object.keys(options.env).length) createOptions.env = options.env;
  if (options.workspaceId) createOptions.workspaceId = options.workspaceId;
  if (options.parentAgentId) createOptions.parent = options.parentAgentId;
  if (includePrompt && options.prompt !== undefined) createOptions.initialPrompt = options.prompt;
  if (options.outputSchema) createOptions.outputSchema = options.outputSchema;
  if (options.labels && Object.keys(options.labels).length) createOptions.labels = options.labels;
  return createOptions;
}

/**
 * First-activity stall bound for the subscription-less wait fallbacks
 * (DETERMINISTIC, same contract as runWithFirstActivityWatch).
 *
 * `waitForHandle` covers two opaque waits: `waitForFinish()` on newer SDKs
 * and a bare status poll on older ones. Neither exposes interim progress, so
 * without a stall bound a zero-activity hang wastes the full turn deadline
 * and settles as a bare DEADLINE with no activity counts. With the bound
 * armed (`firstActivityMs < timeoutMs`), timeline/snapshot growth is polled
 * while the wait is in flight; zero content for the bound settles as
 * STALLED_FIRST_ACTIVITY with activity counts via the same stop-then-read
 * ordering invariant (stop FIRST, then the authoritative post-stop read, so
 * late activity still wins as DEADLINE with counts). Completed terminal
 * turns never stall even with zero activity. The hard turn deadline is unchanged.
 *
 * BASELINE-FAILURE CONTRACT: when baseline capture throws, pre-fallback
 * activity is unobserved, so a zero-activity baseline is synthesized at
 * fallback entry and the bound applies from entry — the stall deadline stays
 * armed on every fallback wait. SYNTHETIC-BASELINE MODE IS DEADLINE-ONLY:
 * a synthesized baseline proves nothing about pre-entry content, so any
 * content observed after entry may pre-date entry and `observed` must NOT
 * suppress the stall verdict — timer expiry always settles
 * STALLED_FIRST_ACTIVITY with zero (unprovable) counts. Monitor
 * (poll/final-read) errors fail closed: failed reads never count as
 * activity and a failed final read keeps the STALLED verdict with zero
 * counts.
  */
async function waitForHandle(
  handle: PaseoSdkAgentHandle,
  timeoutMs = 1_800_000,
  permissionScopeRoots?: string[],
  activityOptions?: PaseoSdkRunActivityOptions
): Promise<PaseoSdkAgentResult> {
  const firstActivityMs = activityOptions?.firstActivityMs ?? FIRST_ACTIVITY_DEADLINE_MS;
  const pollMs = Math.max(1, activityOptions?.pollMs ?? FIRST_ACTIVITY_POLL_MS);
  const stallArmed = firstActivityMs < timeoutMs;
  if (typeof handle.waitForFinish === "function") {
    if (!stallArmed) {
      const turn = await handle.waitForFinish(timeoutMs);
      return turnResult(handle, turn, permissionScopeRoots);
    }
    return waitForFinishWithFirstActivityWatch(handle, timeoutMs, firstActivityMs, pollMs, permissionScopeRoots);
  }
  const deadline = Date.now() + timeoutMs;
  const stallAt = stallArmed ? Date.now() + firstActivityMs : Number.POSITIVE_INFINITY;
  const captured = stallArmed ? await captureRunActivityBaseline(handle).catch(() => undefined) : undefined;
  // Baseline capture can throw (sync-throwing refetch, malformed timeline):
  // pre-fallback activity is then unobserved, so synthesize a zero-activity
  // baseline at fallback entry and keep the stall deadline armed from entry.
  // Synthetic mode is deadline-ONLY: the empty baseline proves nothing about
  // pre-entry content, so later growth may pre-date entry and `observed` must
  // not suppress the stall verdict (progress unprovable).
  const baseline = stallArmed ? (captured ?? syntheticZeroActivityBaseline()) : undefined;
  const synthetic = stallArmed && captured === undefined;
  let observed = false;
  let lastActivity: RunActivityBaseline | undefined;
  let lastActivityCheck = 0;
  for (;;) {
    const raw = await refreshHandle(handle);
    const status = statusText(raw?.status ?? handle.status);
    if (isTerminalStatus(status)) {
      const timeline = handle.timeline && typeof handle.timeline.refetch === "function"
        ? await handle.timeline.refetch({ direction: "tail", limit: 50 }).catch(() => undefined)
        : undefined;
      const permission = await permissionStopDiagnostic(raw?.pendingPermissions ?? handle.pendingPermissions, handle.id, permissionScopeRoots);
      return {
        id: handle.id,
        workspaceId: handle.workspaceId ?? stringField(raw ?? {}, ["workspaceId", "workspace_id"]),
        status,
        lastMessage: stringField(raw ?? {}, ["lastMessage", "last_message"]) ?? extractLastAssistantText(timeline),
        error: stringField(raw ?? {}, ["error", "lastError", "last_error"]),
        ...(permission ? { permission } : {})
      };
    }
    const now = Date.now();
    if (baseline && now - lastActivityCheck >= pollMs) {
      lastActivityCheck = now;
      const current = await captureRunActivityBaseline(handle).catch(() => undefined);
      if (current) {
        lastActivity = current;
        if (runActivityHasGrown(baseline, current)) observed = true;
      }
    }
    if (baseline && now >= stallAt && (synthetic || !observed)) {
      return stallVerdictAfterStop(handle, baseline, firstActivityMs, timeoutMs, synthetic);
    }
    if (Date.now() >= deadline) {
      if (baseline && observed && !synthetic && lastActivity) {
        // The turn showed provider-visible activity but still hit the hard
        // deadline: regular DEADLINE with counts, never STALLED.
        const activity: ProviderTurnActivityCounts = {
          updatesObserved: 0,
          toolEvents: countNewRunToolKeys(baseline, lastActivity),
          assistantDelta:
            (lastActivity.assistantText !== undefined && lastActivity.assistantText !== baseline.assistantText) ||
            (lastActivity.lastMessage !== undefined && lastActivity.lastMessage !== baseline.lastMessage)
        };
        return {
          id: handle.id,
          workspaceId: handle.workspaceId ?? undefined,
          status: "timeout",
          error: `Timed out after ${timeoutMs}ms with provider-visible activity (updates=0 toolEvents=${activity.toolEvents} assistantDelta=${activity.assistantDelta}); turn stopped and existing retry budgets apply.`,
          killReason: "DEADLINE",
          activity
        };
      }
      return { id: handle.id, workspaceId: handle.workspaceId ?? undefined, status: "timeout", error: `Timed out after ${timeoutMs}ms.` };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Race one opaque `waitForFinish()` against the first-activity bound.
 *
 * BASELINE-FAILURE CONTRACT: when baseline capture throws, pre-fallback
 * activity is unobserved, so a zero-activity baseline is synthesized at
 * fallback entry and the bound applies from entry — the stall deadline stays
 * armed. SYNTHETIC-BASELINE MODE IS DEADLINE-ONLY: a synthesized baseline
 * proves nothing about pre-entry content, so `observed` must NOT defer to
 * the provider wait — timer expiry always settles STALLED_FIRST_ACTIVITY
 * with zero (unprovable) counts. Monitor (poll/final-read) errors fail
 * closed: failed reads never count as activity and a failed final read keeps
 * the STALLED verdict.
  */
async function waitForFinishWithFirstActivityWatch(
  handle: PaseoSdkAgentHandle,
  timeoutMs: number,
  firstActivityMs: number,
  pollMs: number,
  permissionScopeRoots?: string[]
): Promise<PaseoSdkAgentResult> {
  const captured = await captureRunActivityBaseline(handle).catch(() => undefined);
  // Synthetic mode is deadline-ONLY (see waitForHandle): the empty baseline
  // proves nothing about pre-entry content, so `observed` must not defer to
  // the provider wait — timer expiry always stalls (progress unprovable).
  const synthetic = captured === undefined;
  const baseline = captured ?? syntheticZeroActivityBaseline();
  let observed = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const stopTimers = (): void => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = undefined;
  };
  const waitPromise = handle.waitForFinish!(timeoutMs);
  try {
    pollTimer = setInterval(() => {
      void captureRunActivityBaseline(handle).then((current) => {
        if (runActivityHasGrown(baseline, current)) {
          observed = true;
          if (pollTimer) clearInterval(pollTimer);
          pollTimer = undefined;
        }
      }).catch(() => undefined);
    }, pollMs);
    const outcome = await Promise.race([
      waitPromise.then(
        (turn) => ({ kind: "wait" as const, turn }),
        (error) => ({ kind: "waitError" as const, error })
      ),
      new Promise<{ kind: "stall" }>((resolve) => {
        stallTimer = setTimeout(() => resolve({ kind: "stall" }), firstActivityMs);
      })
    ]);
    stopTimers();
    if (outcome.kind === "wait") return turnResult(handle, outcome.turn, permissionScopeRoots);
    if (outcome.kind === "waitError") throw outcome.error;
    if (observed && !synthetic) return waitPromise.then((turn) => turnResult(handle, turn, permissionScopeRoots));
    const stalled = await stallVerdictAfterStop(handle, baseline, firstActivityMs, timeoutMs, synthetic);
    void waitPromise.then(() => undefined, () => undefined);
    return stalled;
  } catch (error) {
    stopTimers();
    throw error;
  }
}

/**
 * Stop-then-read stall verdict shared by the sdk-wait fallbacks. The handle
 * is stopped FIRST to freeze the turn; only then is the timeline/snapshot
 * re-read, so the post-stop read is authoritative: still-empty reads settle
 * as STALLED_FIRST_ACTIVITY, while late content settles as a regular
 * DEADLINE with counts (same shapes as runWithFirstActivityWatch so
  * downstream classification is identical).
 *
 * SYNTHETIC-BASELINE MODE IS DEADLINE-ONLY: when `synthetic` is true the
 * baseline was synthesized after a capture failure, so the empty baseline
 * proves nothing about pre-entry content — any post-stop content may pre-date
 * fallback entry and progress is unprovable. The verdict is therefore always
 * STALLED_FIRST_ACTIVITY with zero counts, never DEADLINE, even if the final
 * read shows content. This is fail-closed: crediting unprovable growth as
 * genuine progress would let a zero-activity hang ride the full turn deadline
 * as a bare DEADLINE with no actionable stall signal.
 */
async function stallVerdictAfterStop(
  handle: PaseoSdkAgentHandle,
  baseline: RunActivityBaseline,
  firstActivityMs: number,
  timeoutMs: number,
  synthetic = false
): Promise<PaseoSdkAgentResult> {
  await stopPaseoSdkAgentHandle(handle).catch(() => undefined);
  if (synthetic) {
    // Deadline-ONLY: progress unprovable, so the stall stands with zero
    // counts without consulting the final read (any content may pre-date
    // fallback entry). The handle was still stopped above to freeze the turn.
    const unprovable: ProviderTurnActivityCounts = {
      updatesObserved: 0,
      toolEvents: 0,
      assistantDelta: false
    };
    return {
      id: handle.id,
      workspaceId: handle.workspaceId ?? undefined,
      status: "timeout",
      error: stalledFirstActivityError(firstActivityMs, timeoutMs, unprovable),
      killReason: "STALLED_FIRST_ACTIVITY",
      activity: unprovable
    };
  }
  const final = await captureRunActivityBaseline(handle).catch(() => undefined);
  if (final && runActivityHasGrown(baseline, final)) {
    const lateCounts: ProviderTurnActivityCounts = {
      updatesObserved: 0,
      toolEvents: countNewRunToolKeys(baseline, final),
      assistantDelta:
        (final.assistantText !== undefined && final.assistantText !== baseline.assistantText) ||
        (final.lastMessage !== undefined && final.lastMessage !== baseline.lastMessage)
    };
    return {
      id: handle.id,
      workspaceId: handle.workspaceId ?? undefined,
      status: "timeout",
      error:
        `Provider turn stopped at the first-activity bound after ${firstActivityMs}ms ` +
        `with late provider-visible activity (turn deadline ${timeoutMs}ms retained; ` +
        `updates=0 toolEvents=${lateCounts.toolEvents} assistantDelta=${lateCounts.assistantDelta}); ` +
        `turn stopped and existing retry budgets apply.`,
      killReason: "DEADLINE",
      activity: lateCounts
    };
  }
  const counts: ProviderTurnActivityCounts = {
    updatesObserved: 0,
    toolEvents: final ? countNewRunToolKeys(baseline, final) : 0,
    assistantDelta: false
  };
  return {
    id: handle.id,
    workspaceId: handle.workspaceId ?? undefined,
    status: "timeout",
    error: stalledFirstActivityError(firstActivityMs, timeoutMs, counts),
    killReason: "STALLED_FIRST_ACTIVITY",
    activity: counts
  };
}

async function stopPaseoSdkAgentHandle(handle: PaseoSdkAgentHandle): Promise<void> {
  for (const method of [handle.cancel, handle.stop, handle.kill, handle.abort]) {
    if (typeof method !== "function") continue;
    await method.call(handle);
    return;
  }
}

/**
 * Race one opaque atomic SDK run against the first-activity deadline.
 *
 * DETERMINISTIC mechanism: the SDK `run()` primitive exposes no interim
 * progress, so the controller polls the canonical timeline (tool-call
 * entries) and the agent snapshot (new assistant text) for provider-visible
 * content. Any tool call or stream output wins the race and the run settles
 * normally; zero content for `firstActivityMs` settles as a stall kill that
 * reuses the existing timeout contract (status timeout, downstream exit
 * 124) with the explicit STALLED_FIRST_ACTIVITY reason. Poll failures are
 * best-effort and never fail the turn; the hard turn deadline is unchanged.
 *
 * ORDERING INVARIANT (stop-then-read): the stall verdict is always made on a
 * post-stop authoritative read. When the bound fires with no observed
 * activity, the handle is stopped FIRST — freezing the provider turn so no
 * new activity can appear — and only then is the timeline/snapshot
 * re-read. A stopped-then-read cannot gain new activity, so the post-stop
 * read is authoritative: if it shows qualifying content, the turn still
 * failed (it was stopped) but is classified as a regular DEADLINE timeout
 * with activity counts and flows through `turnResult` so content is preserved
 * for forensics, never as STALLED_FIRST_ACTIVITY. If the post-stop read is
 * still empty, the stall kill stands.
 *
 * GROWTH TRACKING (saturation-free): activity is compared as monotonic set
 * growth against the fixed pre-run baseline — new tool-call keys (callId or
 * content digest), a higher content sequence id, or new assistant/snapshot
 * text. A fixed tail window is only the fetch size; the comparison never
 * saturates: 21+ tool calls still show new keys versus baseline, and an
 * empty-timeline flood carries no new keys and never resets observed state.
 */
async function runWithFirstActivityWatch(
  handle: PaseoSdkAgentHandle,
  run: () => Promise<PaseoSdkTurnResult>,
  timeoutMs: number | undefined,
  options: PaseoSdkRunActivityOptions | undefined
): Promise<PaseoSdkTurnResult> {
  const effectiveTimeout = timeoutMs ?? 1_800_000;
  const firstActivityMs = options?.firstActivityMs ?? FIRST_ACTIVITY_DEADLINE_MS;
  const pollMs = Math.max(1, options?.pollMs ?? FIRST_ACTIVITY_POLL_MS);
  if (!(firstActivityMs < effectiveTimeout)) return run();
  const baseline = await captureRunActivityBaseline(handle);
  let observed = false;
  const hasGrown = (current: RunActivityBaseline): boolean =>
    runActivityHasGrown(baseline, current);
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const stopPolling = (): void => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = undefined;
  };
  // The run is in flight for the whole race; polling only observes it and
  // never interferes. A final stop-then-read at the bound (see invariant
  // above) closes the poll-cadence window so late activity always wins over
  // the stall classification.
  const runPromise = run();
  try {
    pollTimer = setInterval(() => {
      void captureRunActivityBaseline(handle).then((current) => {
        if (hasGrown(current)) {
          observed = true;
          if (pollTimer) clearInterval(pollTimer);
          pollTimer = undefined;
        }
      }).catch(() => undefined);
    }, pollMs);
    const outcome = await Promise.race([
      runPromise.then(
        (turn) => ({ kind: "run" as const, turn }),
        (error) => ({ kind: "runError" as const, error })
      ),
      new Promise<{ kind: "stall" }>((resolve) => {
        stallTimer = setTimeout(() => resolve({ kind: "stall" }), firstActivityMs);
      })
    ]);
    stopPolling();
    if (outcome.kind === "run") return outcome.turn;
    if (outcome.kind === "runError") throw outcome.error;
    if (observed) return runPromise;
    // Bound fired with no observed activity: stop FIRST to freeze the turn,
    // then take the authoritative post-stop read (ordering invariant).
    await stopPaseoSdkAgentHandle(handle).catch(() => undefined);
    void runPromise.then(() => undefined, () => undefined);
    const final = await captureRunActivityBaseline(handle).catch(() => undefined);
    if (final && hasGrown(final)) {
      // Late content arrived before the stop took effect. The turn still
      // failed (it was stopped) but it is NOT a stall: report a regular
      // DEADLINE timeout with activity so downstream `turnResult` preserves
      // the content for forensics instead of recording zero activity.
      const lateCounts: ProviderTurnActivityCounts = {
        updatesObserved: 0,
        toolEvents: countNewRunToolKeys(baseline, final),
        assistantDelta:
          (final.assistantText !== undefined && final.assistantText !== baseline.assistantText) ||
          (final.lastMessage !== undefined && final.lastMessage !== baseline.lastMessage)
      };
      return {
        status: "timeout",
        error:
          `Provider turn stopped at the first-activity bound after ${firstActivityMs}ms ` +
          `with late provider-visible activity (turn deadline ${effectiveTimeout}ms retained; ` +
          `updates=0 toolEvents=${lateCounts.toolEvents} assistantDelta=${lateCounts.assistantDelta}); ` +
          `turn stopped and existing retry budgets apply.`,
        killReason: "DEADLINE",
        activity: lateCounts
      };
    }
    const counts: ProviderTurnActivityCounts = {
      updatesObserved: 0,
      toolEvents: final ? countNewRunToolKeys(baseline, final) : 0,
      assistantDelta: false
    };
    return {
      status: "timeout",
      error: stalledFirstActivityError(firstActivityMs, effectiveTimeout, counts),
      killReason: "STALLED_FIRST_ACTIVITY",
      activity: counts
    };
  } catch (error) {
    stopPolling();
    throw error;
  }
}

interface RunActivityBaseline {
  /** Sorted unique content keys for tool-call entries in the fetched tail. */
  toolKeys: string[];
  /** Highest content sequence id observed (canonical seqStart/seqEnd), if any. */
  maxContentSeq?: number;
  assistantText?: string;
  lastMessage?: string;
  observed: boolean;
}

/**
 * Zero-activity baseline synthesized at fallback entry when baseline capture
 * throws. Pre-fallback activity is unobserved by construction, so the stall
 * bound applies from entry as deadline-ONLY: `runActivityHasGrown` may still
 * report growth versus this empty baseline, but callers must NOT treat that
 * growth as proven turn progress — it may pre-date entry — and the stall
 * verdict always settles STALLED_FIRST_ACTIVITY with zero counts. Monitor
 * errors fail closed (never observed, stall stands with zero counts on a
 * failed final read).
 */
function syntheticZeroActivityBaseline(): RunActivityBaseline {
  return { toolKeys: [], observed: false };
}

/**
 * Monotonic growth test: true when `current` carries provider-visible content
 * absent from the fixed pre-run `baseline`. Set-difference on tool keys plus
 * sequence/text comparison never saturates no matter how many tool calls the
 * tail window holds, and an empty flood (no new keys/text) is never growth.
 */
export function runActivityHasGrown(baseline: RunActivityBaseline, current: RunActivityBaseline): boolean {
  const known = new Set(baseline.toolKeys);
  for (const key of current.toolKeys) {
    if (!known.has(key)) return true;
  }
  if (
    current.maxContentSeq !== undefined &&
    baseline.maxContentSeq !== undefined &&
    current.maxContentSeq > baseline.maxContentSeq
  ) {
    return true;
  }
  if (current.maxContentSeq !== undefined && baseline.maxContentSeq === undefined && current.toolKeys.length > 0 && baseline.toolKeys.length === 0) {
    return true;
  }
  if (current.assistantText !== undefined && current.assistantText !== baseline.assistantText) return true;
  if (current.lastMessage !== undefined && current.lastMessage !== baseline.lastMessage) return true;
  return false;
}

/** Turn-scoped new tool events: keys in `current` absent from `baseline`. */
export function countNewRunToolKeys(baseline: RunActivityBaseline, current: RunActivityBaseline): number {
  const known = new Set(baseline.toolKeys);
  let count = 0;
  for (const key of current.toolKeys) {
    if (!known.has(key)) count += 1;
  }
  return count;
}

async function captureRunActivityBaseline(handle: PaseoSdkAgentHandle): Promise<RunActivityBaseline> {
  const timeline = handle.timeline && typeof handle.timeline.refetch === "function"
    ? await handle.timeline.refetch({ direction: "tail", limit: 20 }).catch(() => undefined)
    : undefined;
  const entries = extractTimelineEntries(timeline);
  const toolKeys = extractRunToolKeys(entries);
  let assistantText: string | undefined;
  for (const entry of entries) {
    const text = assistantEntryText(entry);
    if (text !== undefined) assistantText = text;
  }
  const raw = await refreshHandle(handle).catch(() => undefined);
  const lastMessage = raw ? stringField(raw, ["lastMessage", "last_message"]) : undefined;
  const maxContentSeq = maxRunContentSeq(entries);
  return {
    toolKeys,
    ...(maxContentSeq !== undefined ? { maxContentSeq } : {}),
    ...(assistantText !== undefined ? { assistantText } : {}),
    ...(lastMessage !== undefined ? { lastMessage } : {}),
    observed: toolKeys.length > 0 || assistantText !== undefined || lastMessage !== undefined
  };
}

/**
 * Saturation-free content keys for one timeline tail. Each tool-call entry
 * contributes a stable identity (callId when present, otherwise a bounded
 * content digest), so set-difference against the pre-run baseline detects new
 * activity no matter how many entries the fixed tail window holds.
 */
export function extractRunToolKeys(entries: unknown[]): string[] {
  const keys = new Set<string>();
  for (const entry of entries) {
    const key = runToolCallKey(entry);
    if (key !== undefined) keys.add(key);
  }
  return [...keys].sort();
}

function runToolCallKey(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const record = entry as Record<string, unknown>;
  const item =
    record.item && typeof record.item === "object" && !Array.isArray(record.item)
      ? (record.item as Record<string, unknown>)
      : record;
  if (String(item.type ?? item.kind ?? "") !== "tool_call") return undefined;
  const callId = typeof item.callId === "string" && item.callId ? item.callId : typeof record.callId === "string" && record.callId ? (record.callId as string) : undefined;
  if (callId) return `id:${callId}`;
  const name = typeof item.name === "string" && item.name ? item.name : "unknown-tool";
  const status = typeof item.status === "string" && item.status ? item.status : "unknown-status";
  return `digest:${sha256Canonical({ name, status, detail: item.detail ?? null }).slice(0, 32)}`;
}

/** Highest content sequence id among tool/assistant entries, if the shape carries one. */
function maxRunContentSeq(entries: unknown[]): number | undefined {
  let max: number | undefined;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const item =
      record.item && typeof record.item === "object" && !Array.isArray(record.item)
        ? (record.item as Record<string, unknown>)
        : record;
    const isTool = String(item.type ?? item.kind ?? "") === "tool_call";
    const isAssistant = assistantEntryText(entry) !== undefined;
    if (!isTool && !isAssistant) continue;
    for (const source of [record, item]) {
      for (const key of ["seqEnd", "seqStart", "sequence", "seq"]) {
        const value = source[key];
        if (typeof value === "number" && Number.isFinite(value)) {
          if (max === undefined || value > max) max = value;
        }
      }
    }
  }
  return max;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs = 1_800_000, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new PaseoSdkTimeoutError(message)), timeoutMs);
        timer.unref();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function turnResult(handle: PaseoSdkAgentHandle, turn: PaseoSdkTurnResult, permissionScopeRoots?: string[]): Promise<PaseoSdkAgentResult> {
  const permission = await permissionStopDiagnostic(turn.final?.pendingPermissions ?? handle.pendingPermissions, handle.id, permissionScopeRoots);
  if (turn.lastMessage) {
    return {
      id: handle.id,
      workspaceId: handle.workspaceId ?? undefined,
      status: turn.status,
      lastMessage: turn.lastMessage,
      error: turn.error,
      ...(permission ? { permission } : {}),
      // The stall watch classifies kills on the turn; dropping killReason/
      // activity here would downgrade STALLED_FIRST_ACTIVITY to bare DEADLINE
      // downstream (fromSdk defaults timeout kills to DEADLINE).
      ...(turn.killReason ? { killReason: turn.killReason } : {}),
      ...(turn.activity ? { activity: turn.activity } : {})
    };
  }
  const raw = await refreshHandle(handle).catch(() => undefined);
  const timeline = handle.timeline && typeof handle.timeline.refetch === "function"
    ? await handle.timeline.refetch({ direction: "tail", limit: 50 }).catch(() => undefined)
    : undefined;
  const observedPermission = permission ?? await permissionStopDiagnostic(raw?.pendingPermissions, handle.id, permissionScopeRoots);
  return {
    id: handle.id,
    workspaceId: handle.workspaceId ?? stringField(raw ?? {}, ["workspaceId", "workspace_id"]),
    status: turn.status || statusText(raw?.status ?? handle.status),
    lastMessage:
      stringField(raw ?? {}, ["lastMessage", "last_message"]) ??
      extractLastAssistantText(timeline),
    error: turn.error ?? stringField(raw ?? {}, ["error", "lastError", "last_error"]),
    ...(observedPermission ? { permission: observedPermission } : {}),
    ...(turn.killReason ? { killReason: turn.killReason } : {}),
    ...(turn.activity ? { activity: turn.activity } : {})
  };
}

export async function permissionStopDiagnostic(value: unknown, sessionId?: string, permissionScopeRoots?: string[]): Promise<PaseoSdkPermissionStop | undefined> {
  const entries = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const name = boundedString(record.name ?? record.permission);
    const input = record.input && typeof record.input === "object" ? record.input as Record<string, unknown> : undefined;
    const patterns = boundedStringArray(input?.patterns);
    if (name || patterns?.length) {
      return createPermissionStopDiagnostic(name, patterns, permissionScopeRoots, sessionId, typeof record.id === "string" ? record.id : `${sessionId ?? "session"}:pending`);
    }
  }
  return undefined;
}

function boundedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 200) : undefined;
}

function boundedStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 8).map((item) => item.slice(0, 300));
  return strings.length ? strings : undefined;
}

async function refreshHandle(handle: PaseoSdkAgentHandle): Promise<Record<string, unknown> | undefined> {
  if (typeof handle.refetch === "function") return (await handle.refetch())?.agent;
  if (typeof handle.refresh === "function") return (await handle.refresh())?.agent;
  return handle.latest?.() ?? undefined;
}

async function handleResult(handle: PaseoSdkAgentHandle, permissionScopeRoots?: string[]): Promise<PaseoSdkAgentResult> {
  const raw = handle.latest?.() ?? undefined;
  const permission = await permissionStopDiagnostic(raw?.pendingPermissions ?? handle.pendingPermissions, handle.id, permissionScopeRoots);
  return {
    id: handle.id,
    workspaceId: handle.workspaceId ?? stringField(raw ?? {}, ["workspaceId", "workspace_id"]),
    status: statusText(raw?.status ?? handle.status),
    ...(permission ? { permission } : {})
  };
}

function providerModelForSdk(provider: string, model?: string): string {
  const normalizedProvider = provider.trim();
  if (!normalizedProvider) throw new Error("Paseo SDK requires a provider.");
  const separator = normalizedProvider.indexOf("/");
  if (separator < 0) {
    const explicitModel = model?.trim();
    if (!explicitModel) throw new Error("Paseo SDK requires a provider/model value.");
    return `${normalizedProvider}/${explicitModel}`;
  }
  const providerId = normalizedProvider.slice(0, separator).trim();
  const embeddedModel = normalizedProvider.slice(separator + 1).trim();
  if (!providerId || !embeddedModel) throw new Error(`Invalid Paseo provider/model value '${provider}'. Expected '<provider>/<model>'.`);
  const explicitModel = model?.trim();
  if (explicitModel && explicitModel !== embeddedModel) throw new Error(`Conflicting Paseo models: provider value '${provider}' embeds '${embeddedModel}' but explicit model is '${explicitModel}'.`);
  return `${providerId}/${embeddedModel}`;
}

function normalizeRecord(raw: Record<string, unknown>): PaseoSdkAgentRecord {
  const id = stringField(raw, ["id", "agentId", "agent_id"]);
  if (!id) throw new Error("Paseo SDK returned an agent without an id.");
  return { id, title: stringField(raw, ["title", "name"]), status: statusText(raw.status), workspaceId: stringField(raw, ["workspaceId", "workspace_id"]), labels: recordOfStrings(raw.labels), raw };
}

/**
 * Select the canonical last assistant message from a timeline payload. Only the
 * assistant entry's own top-level text/content is accepted; nested tool-call
 * payloads, reasoning traces and user messages never become completion text.
 * Schema validation remains the authority for any structured payload.
 */
function extractLastAssistantText(value: unknown): string | undefined {
  let found: string | undefined;
  for (const entry of extractTimelineEntries(value)) {
    const text = assistantEntryText(entry);
    if (text !== undefined) found = text;
  }
  return found;
}

function assistantEntryText(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const record = entry as Record<string, unknown>;
  const item = record.item && typeof record.item === "object" && !Array.isArray(record.item) ? record.item as Record<string, unknown> : record;
  const role = String(item.role ?? record.role ?? "").toLowerCase();
  const type = String(item.type ?? item.kind ?? record.type ?? record.kind ?? "").toLowerCase();
  const assistant = role === "assistant" || role.endsWith("/assistant") || type === "assistant_message" || type === "assistant-message" || type === "assistant";
  if (!assistant) return undefined;
  return messageText(item) ?? messageText(record);
}

function messageText(record: Record<string, unknown>): string | undefined {
  for (const key of ["text", "message", "lastMessage"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  const content = record.content;
  if (typeof content === "string" && content.trim()) return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => typeof part === "string" ? part : (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string" ? (part as Record<string, unknown>).text as string : undefined))
      .filter((part): part is string => typeof part === "string" && part.trim().length > 0);
    if (parts.length) return parts.join("\n");
  }
  return undefined;
}

function labelsMatch(actual: Record<string, string> | undefined, expected: Record<string, string>): boolean {
  return Object.entries(expected).every(([key, value]) => actual?.[key] === value);
}
function isTerminalStatus(value?: string): boolean {
  return value === "idle" || value === "finished" || value === "completed" || value === "failed" || value === "error" || value === "timeout" || value === "cancelled";
}
function stringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) if (typeof record[key] === "string" && record[key]) return record[key] as string;
  return undefined;
}
function recordOfStrings(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) if (typeof item === "string") result[key] = item;
  return Object.keys(result).length ? result : undefined;
}
function statusText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const nested = (value as Record<string, unknown>).status;
    if (typeof nested === "string") return nested;
  }
  return undefined;
}

function extractTimelineEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of ["entries", "items", "events", "messages"]) if (Array.isArray(record[key])) return record[key] as unknown[];
  return [];
}
