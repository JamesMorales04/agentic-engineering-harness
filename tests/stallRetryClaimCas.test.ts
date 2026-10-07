import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  claimStallRetryAttempt,
  loadStallRetryStalls,
  recordStallRetryStall,
  clearStallRetryClaim,
  stallRetryPendingFile,
} from "../src/operations/stallRetryBudget.js";

/**
 * Atomic claim check-and-set (ru/ledger-claim-cas-13, Luna round-14 race).
 *
 * claimStallRetryAttempt wrote the pending marker under lock but never checked
 * for an existing claim: two concurrent callers passed the unlocked
 * per-iteration load gates, serialized through claim, second overwrote first,
 * BOTH launched (more attempts than cap).
 *
 * Required: under the SAME lock — read marker; live → throw phase
 * EXHAUSTED/CLAIM-CONFLICT (fail closed, no launch, no overwrite); stale →
 * reconcile-as-consumed first (existing stale logic), then write; none → write.
 * MECHANISM: DETERMINISTIC (file lock + marker, no model judgment).
 */
describe("claim CAS atomic check-and-set (ru/ledger-claim-cas-13)", () => {
  it("two concurrent live claims — exactly one wins, loser throws CLAIM-CONFLICT (no overwrite, no launch)", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-claim-cas-"));
    const operationId = "CLAIM-CAS-CONCURRENT";
    try {
      const p1 = claimStallRetryAttempt(controlRoot, operationId, "discovery", 1, 30 * 60_000);
      const p2 = claimStallRetryAttempt(controlRoot, operationId, "discovery", 2, 30 * 60_000);
      const results = await Promise.allSettled([p1, p2]);
      const fulfilled = results.filter((r) => r.status === "fulfilled").length;
      const rejected = results.filter((r) => r.status === "rejected").length;
      expect(fulfilled).toBe(1);
      expect(rejected).toBe(1);
      const reason = (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason as Error;
      expect(String(reason?.message)).toMatch(/EXPLORER_STALL_BUDGET_EXHAUSTED.*CLAIM-CONFLICT/);
      // Winner identity: marker attempt equals the fulfilled call's attempt (no overwrite by loser).
      const winnerAttempt = results[0].status === "fulfilled" ? 1 : 2;
      const marker = JSON.parse(await fs.readFile(stallRetryPendingFile(controlRoot, operationId, "discovery"), "utf8"));
      expect(marker.attempt).toBe(winnerAttempt);
      // Live claim still fails closed on load (never zero).
      await expect(loadStallRetryStalls(controlRoot, operationId, "discovery")).rejects.toThrow(
        /EXPLORER_STALL_BUDGET_EXHAUSTED/,
      );
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("sequential second live claim throws CLAIM-CONFLICT and leaves marker bytes untouched", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-claim-cas-"));
    const operationId = "CLAIM-CAS-SEQ";
    try {
      await claimStallRetryAttempt(controlRoot, operationId, "planning", 1, 30 * 60_000);
      const beforeRaw = await fs.readFile(stallRetryPendingFile(controlRoot, operationId, "planning"), "utf8");
      await expect(
        claimStallRetryAttempt(controlRoot, operationId, "planning", 2, 30 * 60_000)
      ).rejects.toThrow(/PLANNER_STALL_BUDGET_EXHAUSTED.*CLAIM-CONFLICT/);
      const afterRaw = await fs.readFile(stallRetryPendingFile(controlRoot, operationId, "planning"), "utf8");
      expect(afterRaw).toBe(beforeRaw);
      expect(JSON.parse(afterRaw).attempt).toBe(1);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("stale live marker reconciles-as-consumed (+1 durable) then new claim succeeds", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-claim-cas-"));
    const operationId = "CLAIM-CAS-STALE";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
    try {
      // No marker → first claim writes.
      await claimStallRetryAttempt(controlRoot, operationId, "discovery", 1, 30 * 60_000);
      // Age the marker into crash-orphanhood: 2h old, deadline 30min → stale
      // (threshold 2*30min+5min=65min).
      const staleAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      await fs.mkdir(path.dirname(pending), { recursive: true });
      await fs.writeFile(
        pending,
        `${JSON.stringify({ version: 1, operationId, phase: "discovery", attempt: 1, claimedAt: staleAt, deadlineMs: 30 * 60_000 }, null, 2)}\n`
      );
      // New claim reconciles the stale orphan (+1) then writes fresh.
      await claimStallRetryAttempt(controlRoot, operationId, "discovery", 2, 30 * 60_000);
      const marker = JSON.parse(await fs.readFile(pending, "utf8"));
      expect(marker.attempt).toBe(2);
      expect(Date.parse(marker.claimedAt)).toBeGreaterThan(Date.parse(staleAt));
      // Orphan counted (never free) + new live claim pending → load refuses.
      await expect(loadStallRetryStalls(controlRoot, operationId, "discovery")).rejects.toThrow(
        /EXPLORER_STALL_BUDGET_EXHAUSTED/
      );
      // Reconcile the new live claim via success path, then durable count is exactly the orphan +1.
      await clearStallRetryClaim(controlRoot, operationId, "discovery", 2);
      expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(1);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("fresh marker is never treated as stale (no free +1, no overwrite)", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-claim-cas-"));
    const operationId = "CLAIM-CAS-FRESH";
    try {
      await claimStallRetryAttempt(controlRoot, operationId, "spec-manager", 1, 30 * 60_000);
      await expect(
        claimStallRetryAttempt(controlRoot, operationId, "spec-manager", 2, 30 * 60_000)
      ).rejects.toThrow(/SPEC_MANAGER_STALL_BUDGET_EXHAUSTED.*CLAIM-CONFLICT/);
      // No increment happened: clear winner, count stays zero (nothing consumed).
      await clearStallRetryClaim(controlRoot, operationId, "spec-manager", 1);
      expect(await loadStallRetryStalls(controlRoot, operationId, "spec-manager")).toBe(0);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("phase-scoped: live claim on one phase does not block another phase", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-claim-cas-"));
    const operationId = "CLAIM-CAS-PHASES";
    try {
      await claimStallRetryAttempt(controlRoot, operationId, "discovery", 1, 30 * 60_000);
      await claimStallRetryAttempt(controlRoot, operationId, "planning", 1, 30 * 60_000);
      expect(JSON.parse(await fs.readFile(stallRetryPendingFile(controlRoot, operationId, "discovery"), "utf8")).attempt).toBe(1);
      expect(JSON.parse(await fs.readFile(stallRetryPendingFile(controlRoot, operationId, "planning"), "utf8")).attempt).toBe(1);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("record after winning claim still counts and supersedes own marker", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-claim-cas-"));
    const operationId = "CLAIM-CAS-RECORD";
    try {
      await claimStallRetryAttempt(controlRoot, operationId, "discovery", 1, 30 * 60_000);
      expect(await recordStallRetryStall(controlRoot, operationId, "discovery", 1, 30 * 60_000)).toBe(1);
      await expect(fs.stat(stallRetryPendingFile(controlRoot, operationId, "discovery"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(1);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });
});
