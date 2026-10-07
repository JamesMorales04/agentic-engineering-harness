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
 * Legacy-then-claim cap gate (ru/ledger-staleclaim-cap-14 sibling, Luna
 * round-15 same-class gap on tip 78421e4; tombstone hardened
 * ru/ledger-saturate-15).
 *
 * Gap: claimStallRetryAttempt's legacy-marker path (grave-take path,
 * ~L749-757) reconciled-as-consumed (durable +1) then wrote a FRESH claim
 * without checking STALL_RETRY_MAX_ATTEMPTS_PER_PHASE — an increment-to-cap
 * still authorized another launch (record path checks cap ~L514-535; stale
 * path now checks post-increment; legacy path didn't).
 *
 * Required: after the legacy reconcile increment, if post-increment count >=
 * cap → do NOT write the fresh claim; throw phase EXHAUSTED (fail-closed;
 * the +1 consumed the budget). Fresh claim only when post-count < cap.
 * UNIFIED (ru/ledger-saturate-15, Luna round-16): the counted orphan is
 * TOMBSTONED atomically (grave destroyed + identity recorded in the ledger
 * consumed set) so replay cannot double-count past cap.
 * MECHANISM: DETERMINISTIC (durable count + set comparison under lock).
 */
describe("legacy-claim cap gate (ru/ledger-staleclaim-cap-14 sibling)", () => {
  it("legacy reconcile at cap-1 refuses launch (no fresh claim, +1 consumed)", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-legacyclaim-cap-"));
    const operationId = "LEGACYCLAIM-CAP-AT-CAP-MINUS-1";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
    try {
      // Ledger to cap-1: one stall already consumed (cap is 2).
      expect(await recordStallRetryStall(controlRoot, operationId, "discovery", 1, 30 * 60_000)).toBe(
        STALL_RETRY_MAX_ATTEMPTS_PER_PHASE - 1,
      );
      // Crash-orphaned legacy marker (pre-binding, no attempt/deadlineMs):
      // file mtime 3h old → old via mtime bound (threshold 65min).
      const legacyRaw = `${JSON.stringify({ version: 1, operationId, phase: "discovery", claimedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString() }, null, 2)}\n`;
      await fs.mkdir(path.dirname(pending), { recursive: true });
      await fs.writeFile(pending, legacyRaw);
      const oldMs = Date.now() - 3 * 60 * 60_000;
      await fs.utimes(pending, new Date(oldMs), new Date(oldMs));
      // Attempt 2 claims: the legacy reconcile +1 consumes the budget (→ cap),
      // so the fresh claim must be refused — no launch.
      await expect(
        claimStallRetryAttempt(controlRoot, operationId, "discovery", 2, 30 * 60_000),
      ).rejects.toThrow(/EXPLORER_STALL_BUDGET_EXHAUSTED/);
      // No fresh claim written: marker path empty (taken to grave), no live
      // claim at the pending path; grave DESTROYED (tombstoned via the ledger
      // consumed set, never parked for a counted orphan — unified rule).
      await expect(fs.stat(pending)).rejects.toMatchObject({ code: "ENOENT" });
      const entries = await fs.readdir(path.dirname(pending));
      const base = path.basename(pending);
      expect(entries.filter((e) => e.startsWith(`${base}.grave-`))).toEqual([]);
      expect(entries.filter((e) => e.startsWith(`${base}.quarantine-`))).toEqual([]);
      // The +1 consumed the budget: durable count is exactly cap (never over).
      expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(
        STALL_RETRY_MAX_ATTEMPTS_PER_PHASE,
      );
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("legacy reconcile below cap still launches (post-count < cap → fresh claim)", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-legacyclaim-cap-"));
    const operationId = "LEGACYCLAIM-CAP-BELOW-CAP";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
    try {
      // No ledger yet (count 0): plant a crash-orphaned legacy marker directly.
      const legacyRaw = `${JSON.stringify({ version: 1, operationId, phase: "discovery", claimedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString() }, null, 2)}\n`;
      await fs.mkdir(path.dirname(pending), { recursive: true });
      await fs.writeFile(pending, legacyRaw);
      const oldMs = Date.now() - 3 * 60 * 60_000;
      await fs.utimes(pending, new Date(oldMs), new Date(oldMs));
      // Legacy reconcile +1 → 1 < cap (2): fresh claim must succeed (launch).
      await claimStallRetryAttempt(controlRoot, operationId, "discovery", 1, 30 * 60_000);
      const marker = JSON.parse(await fs.readFile(pending, "utf8"));
      expect(marker.attempt).toBe(1);
      const entries = await fs.readdir(path.dirname(pending));
      const base = path.basename(pending);
      expect(entries.filter((e) => e.startsWith(`${base}.grave-`))).toEqual([]);
      expect(entries.filter((e) => e.startsWith(`${base}.quarantine-`))).toEqual([]);
      // Orphan counted (never free): clear the new live claim, count is exactly 1.
      await clearStallRetryClaim(controlRoot, operationId, "discovery", 1);
      expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(1);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });
});
