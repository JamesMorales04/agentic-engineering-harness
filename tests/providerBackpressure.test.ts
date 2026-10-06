import { describe, expect, it } from "vitest";
import {
  PROVIDER_RATE_LIMIT_DEFAULT_WAIT_MS_V1,
  PROVIDER_RATE_LIMIT_MAX_WAIT_MS_V1,
  isProviderRateLimited,
  parseProviderRateLimitDetail,
  providerRateLimitWaitMs,
  type ProviderRateLimitDetailV1,
} from "../src/paseo/sdk.js";
import {
  WAVE_BACKPRESSURE_EVENT_V1,
  WAVE_BACKPRESSURE_MAX_WAIT_MS_V1,
  WAVE_CONCURRENCY_LEASE_CAP_V1,
  isWaveBackpressureError,
  shouldQueueWaveWork,
  waveBackpressureAttributes,
  waveConcurrencyV1,
  waveQueueWaitMs,
  waveRateLimitWaitMs,
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
  });

  describe("D2: bounded wave fan-out (QUEUE, never throw)", () => {
    it("caps default fan-out at the lease ceiling and clamps configured excess", () => {
      expect(WAVE_CONCURRENCY_LEASE_CAP_V1).toBe(16);
      expect(WAVE_CONCURRENCY_LEASE_CAP_V1).toBe(DEFAULT_OPERATION_RESOURCE_POLICY.maxConcurrentProviderSessionsPerOperation);
      expect(waveConcurrencyV1(undefined, 100)).toBe(16);
      expect(waveConcurrencyV1({ maxWaveConcurrency: 64 }, 64)).toBe(16);
      expect(waveConcurrencyV1({ worktreeIsolation: true, maxWaveConcurrency: 2 }, 3)).toBe(2);
      expect(waveConcurrencyV1({ worktreeIsolation: false, maxWaveConcurrency: 4 }, 3)).toBe(1);
      expect(waveConcurrencyV1(undefined, 2)).toBe(2);
    });

    it("classifies backpressure as QUEUE and terminal failures as FAIL", () => {
      expect(isWaveBackpressureError(new Error("RESOURCE_CEILING_EXHAUSTED: operation holds 16 active provider sessions"))).toBe(true);
      expect(isWaveBackpressureError(new Error("provider opencode is already leased in ws by owner-a."))).toBe(true);
      expect(isWaveBackpressureError(new Error("PASEO_PROVIDER_LEASE_TAKEOVER_BLOCKED: prior session active"))).toBe(true);
      expect(isWaveBackpressureError(new Error("429 Too Many Requests"))).toBe(true);
      expect(isWaveBackpressureError(new Error("INVALID payload rejected"))).toBe(false);
      expect(isWaveBackpressureError(new Error("Delegation escaped scope"))).toBe(false);
      expect(shouldQueueWaveWork(new Error("429 rate limited"))).toBe(true);
      expect(shouldQueueWaveWork(new Error("INVALID"))).toBe(false);
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

    it("fail-closed invariants: caps unchanged, waits bounded, exhausted budgets terminal", () => {
      expect(DEFAULT_OPERATION_RESOURCE_POLICY).toMatchObject({ maxOwnedResourcesPerOperation: 64, maxConcurrentProviderSessionsPerOperation: 16 });
      expect(WAVE_CONCURRENCY_LEASE_CAP_V1).toBeLessThanOrEqual(DEFAULT_OPERATION_RESOURCE_POLICY.maxConcurrentProviderSessionsPerOperation);
      expect(PROVIDER_RATE_LIMIT_MAX_WAIT_MS_V1).toBe(60_000);
      expect(providerRateLimitWaitMs({ version: 1, status: 429, retryAfterMs: 999_999, retryAfterSource: "none" })).toBe(PROVIDER_RATE_LIMIT_MAX_WAIT_MS_V1);
      expect(waveRateLimitWaitMs(999_999)).toBe(WAVE_BACKPRESSURE_MAX_WAIT_MS_V1);
    });
  });
});
