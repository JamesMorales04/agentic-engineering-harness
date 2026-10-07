import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  claimStallRetryAttempt,
  clearStallRetryClaim,
  loadStallRetryStalls,
  recordStallRetryStall,
  stallRetryPendingFile,
} from "../src/operations/stallRetryBudget.js";

/**
 * RED for Luna round-7 B1: cross-attempt clear erases another attempt's marker.
 *
 * Scenario: attempt 1 claims (marker attempt=1), then attempt 2 claims
 * (marker attempt=2, overwrites — second attempt starts). Attempt 1 finishes
 * (success/non-stall) and calls clear with ITS attempt number (1). Correct
 * behavior: leave marker attempt=2 alone (another live attempt owns it) +
 * trace. Buggy behavior: unconditionally removes marker, erasing live claim.
 */
describe("stall-retry binding B1: clear bound to (phase, attempt)", () => {
  it("clear with stale attempt number leaves live marker alone", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-bind-b1-"));
    const operationId = "BIND-B1-1";
    try {
      // Attempt 1 claims, then attempt 2 claims (live).
      await (claimStallRetryAttempt as (...args: unknown[]) => Promise<void>)(
        controlRoot, operationId, "discovery", 1, 30 * 60_000,
      );
      await (claimStallRetryAttempt as (...args: unknown[]) => Promise<void>)(
        controlRoot, operationId, "discovery", 2, 30 * 60_000,
      );
      const before = JSON.parse(
        await fs.readFile(stallRetryPendingFile(controlRoot, operationId, "discovery"), "utf8"),
      );
      expect(before.attempt).toBe(2);

      // Attempt 1's cleanup (stale owner) must NOT erase attempt 2's marker.
      await (clearStallRetryClaim as (...args: unknown[]) => Promise<void>)(
        controlRoot, operationId, "discovery", 1,
      );

      // Live marker survives.
      const afterRaw = await fs.readFile(stallRetryPendingFile(controlRoot, operationId, "discovery"), "utf8");
      const after = JSON.parse(afterRaw);
      expect(after.attempt).toBe(2);
      // And the live claim still fails closed (not silently cleared to zero).
      await expect(loadStallRetryStalls(controlRoot, operationId, "discovery")).rejects.toThrow(
        /EXPLORER_STALL_BUDGET_EXHAUSTED/,
      );
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("record-supersede with stale attempt leaves live marker alone but still counts stall", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-bind-b1-"));
    const operationId = "BIND-B1-2";
    try {
      await (claimStallRetryAttempt as (...args: unknown[]) => Promise<void>)(
        controlRoot, operationId, "discovery", 2, 30 * 60_000,
      );
      // Attempt 1 stall-kills late (stale owner) — its stall must count,
      // but it must NOT supersede (delete) attempt 2's live marker.
      const count = await (recordStallRetryStall as (...args: unknown[]) => Promise<number>)(
        controlRoot, operationId, "discovery", 1, 30 * 60_000,
      );
      expect(count).toBe(1);
      const marker = JSON.parse(
        await fs.readFile(stallRetryPendingFile(controlRoot, operationId, "discovery"), "utf8"),
      );
      expect(marker.attempt).toBe(2);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });
});
