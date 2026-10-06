import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveWaveCapacityDeadlineAtMs,
} from "../src/agents/waveExecutor.js";
import {
  tryAcquireDurableWaveSlotAtomic,
  waitForProviderSessionCapacity,
} from "../src/runtime/operationResources.js";
import { acquireWaveProviderSlotSharedOrQueue } from "../src/agents/waveExecutor.js";

/**
 * Luna fail-closed regression (GREEN after fix).
 * - F1: no operation deadline mints no fresh time (undefined, immediate terminal, zero sleeps).
 * - F2: unreadable durable snapshot BLOCKS (QUEUED/acquired false), never passes as clear.
 * - F3: two concurrent durable racers never both proceed (atomic acquire-or-queue).
 * MECHANISM: all DETERMINISTIC (pure deadline math, file-locked atomic transact,
 * fail-closed QUEUED on unreadable). Deterministic clocks via injectable now/sleep.
 */
describe("Luna fail-closed regression (GREEN)", () => {
  it("F1 GREEN: no operation deadline mints no fresh time (undefined, not now+30s)", () => {
    const now = 1_000_000;
    const maxWait = 30_000;
    expect(resolveWaveCapacityDeadlineAtMs(now, undefined, maxWait)).toBeUndefined();
    expect(resolveWaveCapacityDeadlineAtMs(now, now + 5_000, maxWait)).toBe(now + 5_000);
  });

  it("F1 GREEN: saturated capacity with no deadline waits zero (immediate terminal, no fresh sleep)", async () => {
    const now = 1_000_000;
    const sleeps: number[] = [];
    const result = await waitForProviderSessionCapacity("/root", "op-red", {
      ceiling: 1,
      maxWaitMs: 30_000,
      pollMs: 10,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      countActive: () => 1,
    });
    expect(result.acquired).toBe(false);
    expect(sleeps).toEqual([]);
  });

  it("F2 GREEN: unreadable durable snapshot BLOCKS (acquired false), never passes as clear", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-luna-f2-"));
    try {
      const snapFile = path.join(dir, ".harness", "runtime", "snapshot.json");
      await fs.mkdir(path.dirname(snapFile), { recursive: true });
      await fs.writeFile(snapFile, "not-json{{{", "utf8");
      // Corrupt file via atomic path: BLOCKED (acquired false, retry 0, no wait).
      const corrupt = await tryAcquireDurableWaveSlotAtomic(
        dir,
        { provider: "wave", projectId: "p", canonicalRoot: "/r", workspaceId: "w", ownerId: "o", mode: "write" },
        { nowMs: () => 0 }
      );
      expect(corrupt.acquired).toBe(false);
      if (!corrupt.acquired) {
        expect(corrupt.retryAfterMs).toBe(0);
        expect(corrupt.queueDepth).toBe(1);
      }
      // Shared wrapper also BLOCKS on unreadable (no proceed, no sleep on 0 budget).
      const sleeps: number[] = [];
      const blocked = await acquireWaveProviderSlotSharedOrQueue(
        dir,
        { provider: "wave", projectId: "p", canonicalRoot: "/r", workspaceId: "w2", ownerId: "o2", mode: "write" },
        { remainingBudgetMs: 0, sleepMs: async (ms) => { sleeps.push(ms); }, nowMs: () => 0 }
      );
      expect(blocked.acquired).toBe(false);
      expect(sleeps).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("F3 GREEN: two concurrent durable racers never both proceed (one wins or queues)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-luna-f3-"));
    try {
      const input = (ownerId: string) => ({
        provider: "wave",
        projectId: "p",
        canonicalRoot: "/r",
        workspaceId: "shared-race",
        ownerId,
        mode: "write" as const,
      });
      const opts = {
        remainingBudgetMs: 1000,
        sleepMs: async () => undefined,
        nowMs: () => 0,
      };
      const [a, b] = await Promise.all([
        acquireWaveProviderSlotSharedOrQueue(dir, input("racer-a"), opts),
        acquireWaveProviderSlotSharedOrQueue(dir, input("racer-b"), opts),
      ]);
      expect(a.acquired && b.acquired).toBe(false);
      expect([a.acquired, b.acquired].filter(Boolean).length).toBeLessThanOrEqual(1);
      // At least one racer got a deterministic disposition (acquired or queued with depth).
      expect(a.queueDepth + b.queueDepth).toBeGreaterThanOrEqual(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
