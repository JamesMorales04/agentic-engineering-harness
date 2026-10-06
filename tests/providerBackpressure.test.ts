import { describe, expect, it } from "vitest";
import {
  PROVIDER_RATE_LIMIT_DEFAULT_WAIT_MS_V1,
  PROVIDER_RATE_LIMIT_MAX_WAIT_MS_V1,
  isProviderRateLimited,
  parseProviderRateLimitDetail,
  parseRetryAfterHeaderValue,
  providerRateLimitWaitMs,
  withProviderRateLimitRetry,
  type ProviderRateLimitDetailV1,
} from "../src/paseo/sdk.js";
import {
  WAVE_BACKPRESSURE_EVENT_V1,
  WAVE_BACKPRESSURE_MAX_WAIT_MS_V1,
  WAVE_CONCURRENCY_LEASE_CAP_V1,
  acquireWaveProviderSlotOrQueue,
  isWaveBackpressureError,
  shouldQueueWaveWork,
  waveBackpressureAttributes,
  waveConcurrencyV1,
  waveQueueWaitMs,
  waveRateLimitWaitMs,
  withWaveBackpressureRetry,
} from "../src/agents/waveExecutor.js";
import {
  DEFAULT_OPERATION_RESOURCE_POLICY,
  PROVIDER_BACKPRESSURE_EVENT_V1,
  PROVIDER_BACKPRESSURE_MAX_WAIT_MS_V1,
  checkProviderSessionBackpressure,
  isProviderCapacityError,
  providerBackpressureAttributes,
  waitForProviderSessionCapacity,
} from "../src/runtime/operationResources.js";
import {
  PROVIDER_LEASE_QUEUE_MAX_WAIT_MS_V1,
  RuntimeSupervisorV1,
  isProviderLeaseConflictError,
  providerLeaseBackpressureSignal,
  providerLeaseQueueWaitMs,
} from "../src/runtime/supervisorV2.js";
import { isStalledFirstActivityText } from "../src/paseo/firstActivityDeadline.js";

/**
 * Unit 3 "provider backpressure" fixtures (no network).
 * D1: 429/Retry-After parsed at SDK boundary; Retry-After honored as WAIT
 *     (not an attempt) against existing budgets, never extending caps.
 * D2: wave fan-out capped at lease ceiling; lease conflicts QUEUE (not throw)
 *     with counter/gauge backpressure telemetry via existing conventions.
 * D7: scripted 429/Retry-After + stall-marker + lease-conflict fixtures.
 * Fail-closed: caps unchanged, waits bounded, exhausted budgets terminal.
 */

function rateLimitError(message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), extra);
}

describe("provider backpressure (Unit 3)", () => {
  describe("D1: SDK-boundary 429/Retry-After parse (DETERMINISTIC, no network)", () => {
    it("parses numeric 429 status with Retry-After seconds header into typed detail", () => {
      const detail = parseProviderRateLimitDetail(
        rateLimitError("provider failed with 429 Too Many Requests", {
          statusCode: 429,
          headers: { "retry-after": "2" },
        }),
      );
      expect(detail).toMatchObject({ version: 1, status: 429, retryAfterMs: 2000, retryAfterSource: "retry-after-seconds" });
    });

    it("parses bare 429 without hint into the bounded stampede-avoidance default", () => {
      const detail = parseProviderRateLimitDetail(rateLimitError("429 Too Many Requests", { statusCode: 429 }));
      expect(detail?.status).toBe(429);
      expect(detail?.retryAfterMs).toBe(PROVIDER_RATE_LIMIT_DEFAULT_WAIT_MS_V1);
      expect(detail?.retryAfterSource).toBe("none");
    });

    it("parses rate-limit text without numeric status and Retry-After message patterns", () => {
      const fromText = parseProviderRateLimitDetail(new Error("provider rate_limit exceeded, retry-after: 3"));
      expect(fromText?.status).toBe(429);
      expect(fromText?.retryAfterMs).toBe(3000);
      const explicitMs = parseProviderRateLimitDetail(
        Object.assign(new Error("rate limited"), { retryAfterMs: 750 }),
      );
      expect(explicitMs?.retryAfterMs).toBe(750);
      expect(explicitMs?.retryAfterSource).toBe("retry-after-ms");
    });

    it("bounds absurd Retry-After hints to the fail-closed cap", () => {
      const detail = parseProviderRateLimitDetail(
        rateLimitError("429 rate limited", { statusCode: 429, headers: { "Retry-After": "3600" } }),
      );
      expect(detail?.retryAfterMs).toBe(PROVIDER_RATE_LIMIT_MAX_WAIT_MS_V1);
    });

    it("returns undefined for non-rate-limit failures (no false positives)", () => {
      expect(parseProviderRateLimitDetail(new Error("STALLED_FIRST_ACTIVITY: zero activity"))).toBeUndefined();
      expect(parseProviderRateLimitDetail(new Error("INVALID payload rejected"))).toBeUndefined();
      expect(parseProviderRateLimitDetail(new Error("timeout after 100ms"))).toBeUndefined();
      expect(isProviderRateLimited(new Error("plain boom"))).toBe(false);
      expect(isProviderRateLimited(rateLimitError("429 Too Many Requests", { statusCode: 429 }))).toBe(true);
    });

    it("honors Retry-After as WAIT against the deadline budget (WAIT is not an attempt, never extends caps)", () => {
      const detail = { version: 1 as const, status: 429 as const, retryAfterMs: 5000, retryAfterSource: "retry-after-seconds" as const };
      // WAIT fits: honest countdown against the remaining budget.
      expect(providerRateLimitWaitMs(detail, 30_000)).toBe(5000);
      // WAIT larger than remaining: clamped to what is left, never extended.
      expect(providerRateLimitWaitMs(detail, 1000)).toBe(1000);
      // Exhausted budget: terminal 0.
      expect(providerRateLimitWaitMs(detail, 0)).toBe(0);
      expect(providerRateLimitWaitMs(undefined, 30_000)).toBe(0);
      // Absurd hint is capped even without a caller budget.
      const huge: ProviderRateLimitDetailV1 = { version: 1, status: 429, retryAfterMs: 3_600_000, retryAfterSource: "retry-after-seconds" };
      expect(providerRateLimitWaitMs(huge, 30_000)).toBeLessThanOrEqual(30_000);
      expect(providerRateLimitWaitMs(huge)).toBe(PROVIDER_RATE_LIMIT_MAX_WAIT_MS_V1);
    });

    it("narrow marker: bare retry-after without 429/rate-limit never labels rate-limited (regression)", () => {
      expect(parseProviderRateLimitDetail(new Error("retry-after: 5"))).toBeUndefined();
      expect(parseProviderRateLimitDetail(new Error("Retry-After: 120"))).toBeUndefined();
      expect(parseProviderRateLimitDetail({ headers: { "retry-after": "5" } })).toBeUndefined();
      expect(isProviderRateLimited(new Error("retry-after: 5"))).toBe(false);
      // With a real signal, the Retry-After hint is still honored.
      expect(parseProviderRateLimitDetail(new Error("rate limited, retry-after: 5"))?.retryAfterMs).toBe(5000);
      expect(parseProviderRateLimitDetail(rateLimitError("429", { statusCode: 429, headers: { "retry-after": "5" } }))?.retryAfterMs).toBe(5000);
    });

    it("deterministic time: HTTP-date Retry-After uses injectable clock (tests pin it, no Date.now)", () => {
      const date = "Wed, 21 Oct 2015 07:28:00 GMT";
      const dateMs = Date.parse(date);
      // Clock pinned 5s before the date → 5000ms WAIT.
      const early = parseProviderRateLimitDetail(
        rateLimitError("429 Too Many Requests", { statusCode: 429, headers: { "retry-after": date } }),
        () => dateMs - 5000
      );
      expect(early?.retryAfterSource).toBe("retry-after-http-date");
      expect(early?.retryAfterMs).toBe(5000);
      // Clock pinned after the date → 0 (already elapsed, fail-closed, never negative).
      const late = parseProviderRateLimitDetail(
        rateLimitError("429 Too Many Requests", { statusCode: 429, headers: { "retry-after": date } }),
        () => dateMs + 10_000
      );
      expect(late?.retryAfterMs).toBe(0);
      // Direct header parser pins the same clock.
      expect(parseRetryAfterHeaderValue(date, () => dateMs - 2000)?.ms).toBe(2000);
      expect(parseRetryAfterHeaderValue(date, () => dateMs + 1000)?.ms).toBe(0);
    });

    it("SDK 429 → WAIT honored → retry succeeds within budget (no network, scripted clock/sleep)", async () => {
      let attempts = 0;
      const sleeps: number[] = [];
      const result = await withProviderRateLimitRetry(
        async () => {
          attempts += 1;
          if (attempts === 1) {
            throw rateLimitError("429 Too Many Requests", { statusCode: 429, headers: { "retry-after": "2" } });
          }
          return "ok";
        },
        {
          timeoutMs: 30_000,
          nowMs: () => 0,
          sleepMs: async (ms) => {
            sleeps.push(ms);
          }
        }
      );
      expect(result).toBe("ok");
      expect(attempts).toBe(2);
      expect(sleeps).toEqual([2000]);
    });

    it("SDK 429 with exhausted budget is terminal (never extends caps)", async () => {
      let attempts = 0;
      await expect(
        withProviderRateLimitRetry(
          async () => {
            attempts += 1;
            throw rateLimitError("429 rate limited", { statusCode: 429, headers: { "retry-after": "5" } });
          },
          { timeoutMs: 0, nowMs: () => 0, sleepMs: async () => undefined }
        )
      ).rejects.toMatchObject({ name: "PaseoSdkRateLimitedError" });
      expect(attempts).toBe(1);
    });
  });

  describe("D2: bounded wave fan-out (QUEUE, never throw)", () => {
    it("caps default fan-out at the lease ceiling and clamps configured excess (single cap source, derived)", () => {
      // Single source: literal 16 lives only in DEFAULT_OPERATION_RESOURCE_POLICY;
      // WAVE_CONCURRENCY_LEASE_CAP_V1 derives from it (never duplicated).
      expect(DEFAULT_OPERATION_RESOURCE_POLICY.maxConcurrentProviderSessionsPerOperation).toBe(16);
      expect(WAVE_CONCURRENCY_LEASE_CAP_V1).toBe(DEFAULT_OPERATION_RESOURCE_POLICY.maxConcurrentProviderSessionsPerOperation);
      expect(waveConcurrencyV1(undefined, 100)).toBe(DEFAULT_OPERATION_RESOURCE_POLICY.maxConcurrentProviderSessionsPerOperation);
      expect(waveConcurrencyV1({ maxWaveConcurrency: 64 }, 64)).toBe(DEFAULT_OPERATION_RESOURCE_POLICY.maxConcurrentProviderSessionsPerOperation);
      expect(waveConcurrencyV1({ worktreeIsolation: true, maxWaveConcurrency: 2 }, 3)).toBe(2);
      expect(waveConcurrencyV1({ worktreeIsolation: false, maxWaveConcurrency: 4 }, 3)).toBe(1);
      expect(waveConcurrencyV1(undefined, 2)).toBe(2);
    });

    it("classifies backpressure as QUEUE and terminal failures as FAIL (narrow marker: bare retry-after never QUEUEs)", () => {
      expect(isWaveBackpressureError(new Error("RESOURCE_CEILING_EXHAUSTED: operation holds 16 active provider sessions"))).toBe(true);
      expect(isWaveBackpressureError(new Error("provider opencode is already leased in ws by owner-a."))).toBe(true);
      expect(isWaveBackpressureError(new Error("PASEO_PROVIDER_LEASE_TAKEOVER_BLOCKED: prior session active"))).toBe(true);
      expect(isWaveBackpressureError(new Error("429 Too Many Requests"))).toBe(true);
      expect(isWaveBackpressureError(new Error("INVALID payload rejected"))).toBe(false);
      expect(isWaveBackpressureError(new Error("Delegation escaped scope"))).toBe(false);
      expect(shouldQueueWaveWork(new Error("429 rate limited"))).toBe(true);
      expect(shouldQueueWaveWork(new Error("INVALID"))).toBe(false);
      // Narrow marker regression: bare retry-after without 429/rate-limit is not backpressure.
      expect(isWaveBackpressureError(new Error("retry-after: 5"))).toBe(false);
      expect(isWaveBackpressureError(new Error("Retry-After: 120"))).toBe(false);
      expect(shouldQueueWaveWork(new Error("retry-after: 5"))).toBe(false);
      expect(isProviderCapacityError(new Error("retry-after: 5"))).toBe(false);
    });

    it("bounds wave WAITs and reports terminal 0 on exhausted budgets", () => {
      expect(waveRateLimitWaitMs(5000, 30_000)).toBe(5000);
      expect(waveRateLimitWaitMs(5000, 1000)).toBe(1000);
      expect(waveRateLimitWaitMs(5000, 0)).toBe(0);
      expect(waveRateLimitWaitMs(undefined, 1000)).toBe(0);
      expect(waveRateLimitWaitMs(3_600_000)).toBe(WAVE_BACKPRESSURE_MAX_WAIT_MS_V1);
      expect(waveQueueWaitMs(250, 100)).toBe(100);
      expect(waveQueueWaitMs(undefined, 100)).toBe(0);
    });

    it("emits counter/gauge backpressure telemetry via existing recordEvent conventions", () => {
      expect(WAVE_BACKPRESSURE_EVENT_V1).toBe("harness.wave.backpressure");
      const attrs = waveBackpressureAttributes({ wave: 2, taskId: "TASK-1", active: 20, ceiling: 16, queued: 4, retryAfterMs: 250, disposition: "CLAMPED", rateLimited: true });
      expect(attrs).toMatchObject({ wave: 2, taskId: "TASK-1", active: 20, ceiling: 16, queued: 4, retryAfterMs: 250, disposition: "CLAMPED", rateLimited: true });
    });
  });

  describe("D2: lease conflicts QUEUE with bounded telemetry (no network)", () => {
    it("tryAcquire returns QUEUED (not throw) on write-write conflict, then ACQUIRED after release", () => {
      const supervisor = new RuntimeSupervisorV1({ leaseTtlMs: 60_000 });
      supervisor.acquireProviderLease({ provider: "opencode", projectId: "p", canonicalRoot: "/r", workspaceId: "w", mode: "write", ownerId: "owner-a" });
      const queued = supervisor.tryAcquireProviderLease({ provider: "opencode", projectId: "p", canonicalRoot: "/r", workspaceId: "w", mode: "write", ownerId: "owner-b" });
      expect(queued.status).toBe("QUEUED");
      if (queued.status === "QUEUED") {
        expect(queued.queueDepth).toBe(1);
        expect(queued.retryAfterMs).toBeGreaterThanOrEqual(0);
        expect(queued.retryAfterMs).toBeLessThanOrEqual(PROVIDER_LEASE_QUEUE_MAX_WAIT_MS_V1);
      }
      // Throwing acquisition still fails closed for direct callers.
      expect(() =>
        supervisor.acquireProviderLease({ provider: "opencode", projectId: "p", canonicalRoot: "/r", workspaceId: "w", mode: "write", ownerId: "owner-b" }),
      ).toThrow("already leased in");
      expect(isProviderLeaseConflictError(new Error("provider opencode is already leased in w by owner-a."))).toBe(true);
      expect(isProviderLeaseConflictError(new Error("INVALID"))).toBe(false);
    });

    it("lease QUEUE waits are bounded and terminal on exhausted budgets", () => {
      const queued = { status: "QUEUED" as const, retryAfterMs: 5000, queueDepth: 2, reason: "queued" };
      expect(providerLeaseQueueWaitMs(queued, 30_000)).toBe(5000);
      expect(providerLeaseQueueWaitMs(queued, 100)).toBe(100);
      expect(providerLeaseQueueWaitMs(queued, 0)).toBe(0);
      expect(providerLeaseQueueWaitMs(undefined, 1000)).toBe(0);
      const signal = providerLeaseBackpressureSignal(16, 2, 16);
      expect(signal).toMatchObject({ active: 16, queued: 2, ceiling: 16, saturated: true });
      expect(providerLeaseBackpressureSignal(3, 0, 16)).toMatchObject({ saturated: false });
    });
  });

  describe("D2: provider session capacity QUEUE with bounded waits (no network)", () => {
    it("checkProviderSessionBackpressure allows headroom and QUEUES saturation", () => {
      expect(checkProviderSessionBackpressure(3, 16)).toMatchObject({ allowed: true, active: 3, ceiling: 16 });
      const saturated = checkProviderSessionBackpressure(16, 16);
      expect(saturated.allowed).toBe(false);
      if (!saturated.allowed) {
        expect(saturated.disposition).toBe("QUEUE");
        expect(saturated.retryAfterMs).toBeGreaterThanOrEqual(0);
      }
      expect(checkProviderSessionBackpressure(20, 16).allowed).toBe(false);
    });

    it("classifies capacity/lease errors as QUEUE and other failures as terminal", () => {
      expect(isProviderCapacityError(new Error("RESOURCE_CEILING_EXHAUSTED: operation holds 2 active provider sessions"))).toBe(true);
      expect(isProviderCapacityError(new Error("provider x is already leased in w by o"))).toBe(true);
      expect(isProviderCapacityError(new Error("PASEO_PROVIDER_LEASE_TAKEOVER_BLOCKED: blocked"))).toBe(true);
      expect(isProviderCapacityError(new Error("INVALID payload"))).toBe(false);
    });

    it("bounded QUEUE wait acquires when capacity frees, else terminal without extending caps", async () => {
      let active = 16;
      const acquired = await waitForProviderSessionCapacity("/root", "op-1", {
        ceiling: 16,
        deadlineAtMs: 10_000,
        maxWaitMs: 1000,
        pollMs: 5,
        now: () => 0,
        sleep: async () => { active = 0; },
        countActive: () => active,
      });
      expect(acquired.acquired).toBe(true);
      expect(acquired.active).toBe(0);

      let now = 0;
      const exhausted = await waitForProviderSessionCapacity("/root", "op-1", {
        ceiling: 1,
        deadlineAtMs: 50,
        maxWaitMs: 1000,
        pollMs: 10,
        now: () => now,
        sleep: async (ms) => { now += ms; },
        countActive: () => 1,
      });
      expect(exhausted.acquired).toBe(false);
      expect(now).toBeLessThanOrEqual(1000);
    });

    it("backpressure telemetry stays bounded counter/gauge via existing conventions", () => {
      expect(PROVIDER_BACKPRESSURE_EVENT_V1).toBe("harness.provider.backpressure");
      const attrs = providerBackpressureAttributes({ operationId: "op-1", active: 16, ceiling: 16, queued: 3, retryAfterMs: 50, disposition: "QUEUE" });
      expect(attrs).toMatchObject({ operationId: "op-1", active: 16, ceiling: 16, queued: 3, disposition: "QUEUE" });
      expect(PROVIDER_BACKPRESSURE_MAX_WAIT_MS_V1).toBe(30_000);
    });
  });

  describe("D7: stall-marker vs 429 vs lease-conflict scripted fixtures", () => {
    it("stall marker and 429 classify on disjoint paths (no conflation)", () => {
      expect(isStalledFirstActivityText("STALLED_FIRST_ACTIVITY: provider turn produced zero provider-visible activity after 1500000ms")).toBe(true);
      expect(isStalledFirstActivityText("429 Too Many Requests")).toBe(false);
      expect(isProviderRateLimited(Object.assign(new Error("429 Too Many Requests"), { statusCode: 429 }))).toBe(true);
      expect(isProviderRateLimited(new Error("STALLED_FIRST_ACTIVITY: zero activity"))).toBe(false);
      // A stall kill is not wave backpressure; a 429 is.
      expect(isWaveBackpressureError(new Error("STALLED_FIRST_ACTIVITY: zero activity"))).toBe(false);
      expect(isWaveBackpressureError(new Error("429 Too Many Requests"))).toBe(true);
    });

    it("fail-closed invariants: caps unchanged (single source), waits bounded, exhausted budgets terminal", () => {
      // Single cap source: literal 16 only in DEFAULT_OPERATION_RESOURCE_POLICY; wave derives.
      expect(DEFAULT_OPERATION_RESOURCE_POLICY).toMatchObject({ maxOwnedResourcesPerOperation: 64, maxConcurrentProviderSessionsPerOperation: 16 });
      expect(WAVE_CONCURRENCY_LEASE_CAP_V1).toBe(DEFAULT_OPERATION_RESOURCE_POLICY.maxConcurrentProviderSessionsPerOperation);
      expect(PROVIDER_RATE_LIMIT_MAX_WAIT_MS_V1).toBe(60_000);
      expect(providerRateLimitWaitMs({ version: 1, status: 429, retryAfterMs: 999_999, retryAfterSource: "none" })).toBe(PROVIDER_RATE_LIMIT_MAX_WAIT_MS_V1);
      expect(waveRateLimitWaitMs(999_999)).toBe(WAVE_BACKPRESSURE_MAX_WAIT_MS_V1);
    });
  });

  describe("integration (no network): wired QUEUE paths proceed, never throw-on-conflict", () => {
    it("lease conflict → QUEUED → proceeds (not throw) via withWaveBackpressureRetry", async () => {
      let attempts = 0;
      const sleeps: number[] = [];
      const result = await withWaveBackpressureRetry(
        async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("provider opencode is already leased in w by owner-a.");
          }
          return "proceeded";
        },
        { timeoutMs: 5000, nowMs: () => 0, sleepMs: async (ms) => { sleeps.push(ms); } }
      );
      expect(result).toBe("proceeded");
      expect(attempts).toBe(2);
      expect(sleeps.length).toBe(1);
      expect(sleeps[0]).toBeGreaterThanOrEqual(0);
      expect(sleeps[0]).toBeLessThanOrEqual(WAVE_BACKPRESSURE_MAX_WAIT_MS_V1);
    });

    it("wave 429 → WAIT honored → retry succeeds (typed Retry-After, narrow marker)", async () => {
      let attempts = 0;
      const sleeps: number[] = [];
      const result = await withWaveBackpressureRetry(
        async () => {
          attempts += 1;
          if (attempts === 1) {
            throw rateLimitError("429 Too Many Requests", { statusCode: 429, headers: { "retry-after": "1" } });
          }
          return "ok";
        },
        { timeoutMs: 30_000, nowMs: () => 0, sleepMs: async (ms) => { sleeps.push(ms); } }
      );
      expect(result).toBe("ok");
      expect(attempts).toBe(2);
      expect(sleeps).toEqual([1000]);
    });

    it("wave QUEUE budget exhaustion is terminal FAIL (never extends caps)", async () => {
      let attempts = 0;
      await expect(
        withWaveBackpressureRetry(
          async () => {
            attempts += 1;
            throw new Error("429 Too Many Requests");
          },
          { timeoutMs: 0, nowMs: () => 0, sleepMs: async () => undefined }
        )
      ).rejects.toThrow("429");
      expect(attempts).toBe(1);
    });

    it("acquireWaveProviderSlotOrQueue QUEUES on conflict then ACQUIRES after release (not throw)", async () => {
      const supervisor = new RuntimeSupervisorV1({ leaseTtlMs: 60_000 });
      supervisor.acquireProviderLease({ provider: "wave", projectId: "p", canonicalRoot: "/r", workspaceId: "shared", mode: "write", ownerId: "task-a" });
      // Second writer QUEUES (not throw) with bounded WAIT hint.
      const queued = await acquireWaveProviderSlotOrQueue(
        supervisor,
        { provider: "wave", projectId: "p", canonicalRoot: "/r", workspaceId: "shared", ownerId: "task-b", mode: "write" },
        { remainingBudgetMs: 0 }
      );
      expect(queued.acquired).toBe(false);
      expect(queued.queueDepth).toBe(1);
      // Isolated workspace keys never contend (ACQUIRED).
      const isolated = await acquireWaveProviderSlotOrQueue(
        supervisor,
        { provider: "wave", projectId: "p", canonicalRoot: "/r", workspaceId: "isolated-task-c", ownerId: "task-c", mode: "write" },
        { remainingBudgetMs: 1000 }
      );
      expect(isolated.acquired).toBe(true);
    });
  });

  describe("Luna RED: budget-exhaustion, shared-contention, create-bound", () => {
    it("F1 budget-exhaustion: wave capacity WAIT honors remaining wave/operation budget (zero-remaining → immediate terminal, no wait)", async () => {
      const { resolveWaveCapacityDeadlineAtMs, remainingWaveBudgetMs } = await import("../src/agents/waveExecutor.js");
      // WAIT = min(requested, remaining). Operation deadline earlier than fresh 30s budget wins.
      const now = 1_000_000;
      const maxWait = 30_000;
      const opDeadline = now + 5_000;
      expect(resolveWaveCapacityDeadlineAtMs(now, opDeadline, maxWait)).toBe(opDeadline);
      expect(resolveWaveCapacityDeadlineAtMs(now, undefined, maxWait)).toBe(now + maxWait);
      expect(resolveWaveCapacityDeadlineAtMs(now, now + 60_000, maxWait)).toBe(now + maxWait);
      // Exhausted/expired → terminal 0, no wait.
      expect(remainingWaveBudgetMs(now + 5_000, now)).toBe(5_000);
      expect(remainingWaveBudgetMs(now, now)).toBe(0);
      expect(remainingWaveBudgetMs(now - 1, now)).toBe(0);
      // Zero-remaining capacity wait is immediate terminal with no sleep.
      const sleeps: number[] = [];
      const zero = await waitForProviderSessionCapacity("/root", "op-zero", {
        ceiling: 1,
        deadlineAtMs: now,
        maxWaitMs: 30_000,
        pollMs: 10,
        now: () => now,
        sleep: async (ms) => { sleeps.push(ms); },
        countActive: () => 1,
      });
      expect(zero.acquired).toBe(false);
      expect(sleeps).toEqual([]);
    });

    it("F2 shared-contention: wave slot gates on SHARED durable lease authority, not a fresh wave-local supervisor", async () => {
      const waveMod = await import("../src/agents/waveExecutor.js");
      const shared = (waveMod as unknown as Record<string, unknown>).acquireWaveProviderSlotSharedOrQueue as
        | ((root: string, input: { provider: string; projectId: string; canonicalRoot: string; workspaceId: string; ownerId: string; mode?: "read" | "write" }, options?: { remainingBudgetMs?: number; sleepMs?: (ms: number) => Promise<void>; nowMs?: () => number; countDurableConflicts?: () => Promise<{ queueDepth: number; retryAfterMs: number }> | { queueDepth: number; retryAfterMs: number } }) => Promise<{ acquired: boolean; retryAfterMs: number; queueDepth: number; scope: string }>)
        | undefined;
      expect(typeof shared).toBe("function");
      // Durable authority reports a cross-wave conflict (another wave/operation holds the scope).
      const sleeps: number[] = [];
      const queued = await shared!("/root", { provider: "wave", projectId: "p", canonicalRoot: "/r", workspaceId: "shared", ownerId: "task-b", mode: "write" }, {
        remainingBudgetMs: 0,
        sleepMs: async (ms) => { sleeps.push(ms); },
        nowMs: () => 0,
        countDurableConflicts: async () => ({ queueDepth: 1, retryAfterMs: 250 }),
      });
      expect(queued.acquired).toBe(false);
      expect(queued.queueDepth).toBe(1);
      expect(sleeps).toEqual([]);
      expect(queued.scope).toMatch(/shared|durable/i);
      // No durable conflict + no intra-wave conflict → ACQUIRED.
      const free = await shared!("/root", { provider: "wave", projectId: "p", canonicalRoot: "/r", workspaceId: "free", ownerId: "task-c", mode: "write" }, {
        remainingBudgetMs: 1000,
        sleepMs: async () => undefined,
        nowMs: () => 0,
        countDurableConflicts: async () => ({ queueDepth: 0, retryAfterMs: 0 }),
      });
      expect(free.acquired).toBe(true);
      // Fresh wave-local supervisor alone is blind to the durable conflict (documents why local-only is insufficient).
      const fresh = new RuntimeSupervisorV1({ leaseTtlMs: 60_000 });
      const blind = await acquireWaveProviderSlotOrQueue(
        fresh,
        { provider: "wave", projectId: "p", canonicalRoot: "/r", workspaceId: "shared", ownerId: "task-b", mode: "write" },
        { remainingBudgetMs: 1000 }
      );
      expect(blind.acquired).toBe(true);
    });

    it("F3 create-bound: materialize create attempt honors remaining budget (zero-remaining → terminal, no create, no wait)", async () => {
      const sdk = await import("../src/paseo/sdk.js");
      let creates = 0;
      const sleeps: number[] = [];
      const fakeHandle = { id: "agent-1", workspaceId: undefined as string | undefined, status: "idle" as unknown, latest: () => ({ status: "idle" }) };
      const fakeClient = {
        agents: {
          create: async () => { creates += 1; return fakeHandle; },
          ref: () => fakeHandle,
          list: async () => ({ entries: [] }),
        },
        connect: async () => undefined,
        close: async () => undefined,
      };
      await expect(
        sdk.materializePaseoSdkAgentWithClient(
          fakeClient as unknown as Parameters<typeof sdk.materializePaseoSdkAgentWithClient>[0],
          { cwd: "/root", provider: "codex/gpt-5.4", title: "t", timeoutMs: 0 },
          { nowMs: () => 0, sleepMs: async (ms: number) => { sleeps.push(ms); } }
        )
      ).rejects.toThrow();
      expect(creates).toBe(0);
      expect(sleeps).toEqual([]);
    });
  });
});
