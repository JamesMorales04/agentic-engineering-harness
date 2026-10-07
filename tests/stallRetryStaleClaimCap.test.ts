import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  STALL_RETRY_MAX_ATTEMPTS_PER_PHASE,
  claimStallRetryAttempt,
  clearStallRetryClaim,
  loadStallRetryStalls,
  recordStallRetryStall,
  stallRetryPendingFile,
} from "../src/operations/stallRetryBudget.js";

/**
 * Stale-claim cap gate (ru/ledger-staleclaim-cap-14, Luna round-15 gap on
 * ru/ledger-claim-cas-13 tip 5cbb878).
 *
 * Gap: claimStallRetryAttempt's stale-marker path reconciled-as-consumed
 * (durable +1, ~L642-648) then wrote a FRESH claim (~L669) without checking
 * STALL_RETRY_MAX_ATTEMPTS_PER_PHASE — an increment-to-cap still authorized
 * another launch (record path checks cap ~L514-535; stale path didn't).
 *
 * Required: after the stale reconcile increment, if post-increment count >=
 * cap → do NOT write the fresh claim; throw phase EXHAUSTED (fail-closed;
 * the +1 consumed the budget). Fresh claim only when post-count < cap.
 * MECHANISM: DETERMINISTIC (durable count comparison under lock).
 */
describe("stale-claim cap gate (ru/ledger-staleclaim-cap-14)", () => {
  it("stale reconcile at cap-1 refuses launch (no fresh claim, +1 consumed)", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-staleclaim-cap-"));
    const operationId = "STALECLAIM-CAP-AT-CAP-MINUS-1";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
    try {
      // Ledger to cap-1: one stall already consumed (cap is 2).
      expect(await recordStallRetryStall(controlRoot, operationId, "discovery", 1, 30 * 60_000)).toBe(
        STALL_RETRY_MAX_ATTEMPTS_PER_PHASE - 1,
      );
      // Crash-orphaned stale marker from attempt 2 (never recorded): 2h old,
      // deadline 30min → stale (threshold 2*30min+5min=65min).
      const staleAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      const staleRaw = `${JSON.stringify({ version: 1, operationId, phase: "discovery", attempt: 2, claimedAt: staleAt, deadlineMs: 30 * 60_000 }, null, 2)}\n`;
      await fs.mkdir(path.dirname(pending), { recursive: true });
      await fs.writeFile(pending, staleRaw);
      // Attempt 3 claims: the stale reconcile +1 consumes the budget (→ cap),
      // so the fresh claim must be refused — no launch.
      await expect(
        claimStallRetryAttempt(controlRoot, operationId, "discovery", 3, 30 * 60_000),
      ).rejects.toThrow(/EXPLORER_STALL_BUDGET_EXHAUSTED/);
      // No fresh claim written: stale orphan bytes untouched (still attempt 2).
      expect(await fs.readFile(pending, "utf8")).toBe(staleRaw);
      // The +1 consumed the budget: clear the orphan, durable count is exactly cap.
      await clearStallRetryClaim(controlRoot, operationId, "discovery", 2);
      expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(
        STALL_RETRY_MAX_ATTEMPTS_PER_PHASE,
      );
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("stale reconcile below cap still launches (post-count < cap → fresh claim)", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-staleclaim-cap-"));
    const operationId = "STALECLAIM-CAP-BELOW-CAP";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
    try {
      // No ledger yet (count 0): plant a crash-orphaned stale marker directly.
      const staleAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      const staleRaw = `${JSON.stringify({ version: 1, operationId, phase: "discovery", attempt: 1, claimedAt: staleAt, deadlineMs: 30 * 60_000 }, null, 2)}\n`;
      await fs.mkdir(path.dirname(pending), { recursive: true });
      await fs.writeFile(pending, staleRaw);
      // Stale reconcile +1 → 1 < cap (2): fresh claim must succeed (launch).
      await claimStallRetryAttempt(controlRoot, operationId, "discovery", 2, 30 * 60_000);
      const marker = JSON.parse(await fs.readFile(pending, "utf8"));
      expect(marker.attempt).toBe(2);
      // Orphan counted (never free): clear the new live claim, count is exactly 1.
      await clearStallRetryClaim(controlRoot, operationId, "discovery", 2);
      expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(1);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });
});
