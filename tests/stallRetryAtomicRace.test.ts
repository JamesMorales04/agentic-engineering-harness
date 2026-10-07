import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  clearStallRetryClaim,
  recordStallRetryStall,
  stallRetryPendingFile,
} from "../src/operations/stallRetryBudget.js";

/**
 * RED for Luna round-8 B1-race: clearStallRetryClaim reads+validates the marker
 * then later removes the pathname (lock-free). A concurrent claimStallRetryAttempt
 * replacing the marker between check and delete causes the old caller to delete
 * the replacement. Correct: check+delete ATOMIC inside a single lock-held
 * critical section (re-read + identity comparison + unlink under the existing
 * ledger-lock idiom, all marker access via the lock).
 *
 * Deterministic interleaving: the first pending read returns stale A but swaps
 * in live B (attempt=2) via a direct write before returning — simulating a
 * concurrent claim landing between check and delete.
 */
describe("stall-retry atomic clear race (Luna round-8 B1-race)", () => {
  it("clear with stale owner does not delete a replacement landing between check and delete", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-atomic-race-"));
    const operationId = "ATOMIC-RACE-1";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
    try {
      await fs.mkdir(path.dirname(pending), { recursive: true });
      const staleAt = new Date(Date.now() - 1000).toISOString();
      await fs.writeFile(
        pending,
        `${JSON.stringify({ version: 1, operationId, phase: "discovery", attempt: 1, claimedAt: staleAt, deadlineMs: 30 * 60_000 }, null, 2)}\n`,
      );

      const origReadFile = fs.readFile;
      const origWriteFile = fs.writeFile;
      let pendingReads = 0;
      const spy = vi.spyOn(fs, "readFile").mockImplementation((async (target: unknown, ...rest: unknown[]) => {
        if (String(target) === pending) {
          pendingReads += 1;
          if (pendingReads === 1) {
            const rawA = await (origReadFile as (...a: unknown[]) => Promise<string>)(target, ...rest);
            // Concurrent replacement claims attempt=2 (live) between check and delete.
            // Direct write simulates the interleaving window deterministically;
            // a lock-disciplined fix must re-read inside the lock and see B.
            const freshAt = new Date().toISOString();
            await (origWriteFile as (...a: unknown[]) => Promise<void>)(
              String(target),
              `${JSON.stringify({ version: 1, operationId, phase: "discovery", attempt: 2, claimedAt: freshAt, deadlineMs: 30 * 60_000 }, null, 2)}\n`,
            );
            return rawA;
          }
        }
        return (origReadFile as (...a: unknown[]) => Promise<never>)(target, ...rest);
      }) as typeof fs.readFile);

      try {
        // Caller owns attempt=1 (stale); replacement owns attempt=2 (live).
        await (clearStallRetryClaim as (...args: unknown[]) => Promise<void>)(
          controlRoot, operationId, "discovery", 1,
        );
      } finally {
        spy.mockRestore();
      }

      // Live replacement must survive the stale clearer.
      const afterRaw = await fs.readFile(pending, "utf8");
      const after = JSON.parse(afterRaw);
      expect(after.attempt).toBe(2);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("record-supersede does not delete a replacement landing between check and delete", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-atomic-race-"));
    const operationId = "ATOMIC-RACE-2";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
    try {
      await fs.mkdir(path.dirname(pending), { recursive: true });
      const staleAt = new Date(Date.now() - 1000).toISOString();
      await fs.writeFile(
        pending,
        `${JSON.stringify({ version: 1, operationId, phase: "discovery", attempt: 1, claimedAt: staleAt, deadlineMs: 30 * 60_000 }, null, 2)}\n`,
      );

      const origReadFile = fs.readFile;
      const origWriteFile = fs.writeFile;
      let pendingReads = 0;
      const spy = vi.spyOn(fs, "readFile").mockImplementation((async (target: unknown, ...rest: unknown[]) => {
        if (String(target) === pending) {
          pendingReads += 1;
          // 1st pending read = record pre-claim check (leave alone).
          // 2nd pending read = supersede check: swap in live B between check and delete.
          if (pendingReads === 2) {
            const rawA = await (origReadFile as (...a: unknown[]) => Promise<string>)(target, ...rest);
            const freshAt = new Date().toISOString();
            await (origWriteFile as (...a: unknown[]) => Promise<void>)(
              String(target),
              `${JSON.stringify({ version: 1, operationId, phase: "discovery", attempt: 2, claimedAt: freshAt, deadlineMs: 30 * 60_000 }, null, 2)}\n`,
            );
            return rawA;
          }
        }
        return (origReadFile as (...a: unknown[]) => Promise<never>)(target, ...rest);
      }) as typeof fs.readFile);

      let count = 0;
      try {
        count = await (recordStallRetryStall as (...args: unknown[]) => Promise<number>)(
          controlRoot, operationId, "discovery", 1, 30 * 60_000,
        );
      } finally {
        spy.mockRestore();
      }

      // Stall still counts (caller's own stall), but live B must survive supersede.
      expect(count).toBe(1);
      const afterRaw = await fs.readFile(pending, "utf8");
      const after = JSON.parse(afterRaw);
      expect(after.attempt).toBe(2);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });
});
