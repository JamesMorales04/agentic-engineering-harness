import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  loadStallRetryStalls,
  stallRetryPendingFile,
} from "../src/operations/stallRetryBudget.js";

/**
 * RED for Luna round-7 B2: replacement-marker reconcile.
 *
 * Pre-lock sees stale marker A (attempt=1, 2h old). Before the in-lock
 * recheck, A is replaced by fresh marker B (attempt=2, just claimed, live).
 * Buggy behavior: in-lock only proves SOME marker exists → increments +1 and
 * deletes B (live claim erased + free count). Correct: capture identity
 * (attempt + claimedAt + content hash) pre-lock; in-lock reconcile ONLY if
 * identical; if replaced → release lock, re-evaluate from scratch (no
 * increment, no delete) — B is fresh so refuse EXHAUSTED, B remains.
 */
describe("stall-retry binding B2: reconcile identical marker only", () => {
  it("replacement between pre-lock and in-lock is not incremented/deleted", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-bind-b2-"));
    const operationId = "BIND-B2-1";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
    try {
      const staleAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      await fs.mkdir(path.dirname(pending), { recursive: true });
      await fs.writeFile(
        pending,
        `${JSON.stringify({ version: 1, operationId, phase: "discovery", attempt: 1, claimedAt: staleAt, deadlineMs: 30 * 60_000 }, null, 2)}\n`,
      );

      // Simulate replacement after the pre-lock read: first marker read
      // returns stale A, then we swap in fresh B before the in-lock re-read.
      const origReadFile = fs.readFile;
      let markerReads = 0;
      const spy = vi.spyOn(fs, "readFile").mockImplementation((async (target: unknown, ...rest: unknown[]) => {
        if (String(target) === pending) {
          markerReads += 1;
          if (markerReads === 1) {
            // Pre-lock read sees stale A; swap in fresh live B immediately.
            const rawA = await (origReadFile as (...a: unknown[]) => Promise<string>)(target, ...rest);
            const freshAt = new Date().toISOString();
            await fs.writeFile(
              String(target),
              `${JSON.stringify({ version: 1, operationId, phase: "discovery", attempt: 2, claimedAt: freshAt, deadlineMs: 30 * 60_000 }, null, 2)}\n`,
            );
            return rawA;
          }
        }
        return (origReadFile as (...a: unknown[]) => Promise<never>)(target, ...rest);
      }) as typeof fs.readFile);

      try {
        // B is fresh/live → must refuse, not reconcile.
        await expect(loadStallRetryStalls(controlRoot, operationId, "discovery")).rejects.toThrow(
          /EXPLORER_STALL_BUDGET_EXHAUSTED/,
        );
      } finally {
        spy.mockRestore();
      }

      // No increment happened (ledger still 0/absent) and live B remains.
      const markerAfter = JSON.parse(await fs.readFile(pending, "utf8"));
      expect(markerAfter.attempt).toBe(2);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });
});
