import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  STALL_RETRY_MAX_ATTEMPTS_PER_PHASE,
  claimStallRetryAttempt,
  loadStallRetryStalls,
  recordStallRetryStall,
  stallRetryBudgetFile,
  stallRetryPendingFile,
} from "../src/operations/stallRetryBudget.js";

/**
 * RED-first for ru/ledger-saturate-15 (Luna round-16 rejection of
 * ru/ledger-staleclaim-cap-14 tip c8339a7, same invariant: count NEVER
 * exceeds cap, no orphan counted twice).
 *
 * UNIFIED rule under test:
 * 1. TOMBSTONE every reconciled marker (same lock; positive record in the
 *    ledger via consumed-markers set; deletion alone is not a tombstone).
 * 2. SATURATE at cap: NO increment when count >= cap on EVERY path
 *    (including loader reconciliations); tombstone WITHOUT incrementing,
 *    throw/return EXHAUSTED.
 *
 * These tests MUST fail on the round-14 tip and pass after the fix.
 * MECHANISM: DETERMINISTIC (file-backed ledger + lock, no model judgment).
 */

async function readLedgerCount(controlRoot: string, operationId: string): Promise<number> {
  const raw = await fs.readFile(stallRetryBudgetFile(controlRoot, operationId), "utf8");
  const parsed = JSON.parse(raw) as { stalls: Record<string, number> };
  return parsed.stalls.discovery;
}

function staleRaw(operationId: string, attempt: number): string {
  const staleAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  return `${JSON.stringify({ version: 1, operationId, phase: "discovery", attempt, claimedAt: staleAt, deadlineMs: 30 * 60_000 }, null, 2)}\n`;
}

function legacyRaw(operationId: string): string {
  return `${JSON.stringify({ version: 1, operationId, phase: "discovery", claimedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString() }, null, 2)}\n`;
}

async function plantLegacy(pending: string, raw: string): Promise<void> {
  await fs.mkdir(path.dirname(pending), { recursive: true });
  await fs.writeFile(pending, raw);
  const oldMs = Date.now() - 3 * 60 * 60_000;
  await fs.utimes(pending, new Date(oldMs), new Date(oldMs));
}

describe("unified saturate+tombstone (ru/ledger-saturate-15 RED)", () => {
  it("replay same stale marker 3x counts exactly once (loader)", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-sat-replay-stale-"));
    const operationId = "SATURATE-REPLAY-STALE";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
    try {
      const raw = staleRaw(operationId, 7);
      for (let i = 0; i < 3; i += 1) {
        await fs.mkdir(path.dirname(pending), { recursive: true });
        await fs.writeFile(pending, raw);
        const count = await loadStallRetryStalls(controlRoot, operationId, "discovery");
        expect(count).toBe(1);
      }
      expect(await readLedgerCount(controlRoot, operationId)).toBe(1);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("replay same legacy marker 3x counts exactly once (loader)", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-sat-replay-legacy-"));
    const operationId = "SATURATE-REPLAY-LEGACY";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
    try {
      const raw = legacyRaw(operationId);
      for (let i = 0; i < 3; i += 1) {
        await plantLegacy(pending, raw);
        const count = await loadStallRetryStalls(controlRoot, operationId, "discovery");
        expect(count).toBe(1);
      }
      expect(await readLedgerCount(controlRoot, operationId)).toBe(1);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("claim-stale at cap: no increment + tombstoned + EXHAUSTED", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-sat-claim-stale-cap-"));
    const operationId = "SATURATE-CLAIM-STALE-AT-CAP";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
    try {
      await recordStallRetryStall(controlRoot, operationId, "discovery", 1, 30 * 60_000);
      await recordStallRetryStall(controlRoot, operationId, "discovery", 2, 30 * 60_000);
      expect(await readLedgerCount(controlRoot, operationId)).toBe(STALL_RETRY_MAX_ATTEMPTS_PER_PHASE);
      const raw = staleRaw(operationId, 3);
      await fs.mkdir(path.dirname(pending), { recursive: true });
      await fs.writeFile(pending, raw);
      await expect(
        claimStallRetryAttempt(controlRoot, operationId, "discovery", 4, 30 * 60_000),
      ).rejects.toThrow(/EXPLORER_STALL_BUDGET_EXHAUSTED/);
      // NO increment past cap.
      expect(await readLedgerCount(controlRoot, operationId)).toBe(STALL_RETRY_MAX_ATTEMPTS_PER_PHASE);
      // Tombstoned: marker gone (not left live for replay).
      await expect(fs.stat(pending)).rejects.toMatchObject({ code: "ENOENT" });
      // Replay with identical bytes must not increment either.
      await fs.writeFile(pending, raw);
      await expect(loadStallRetryStalls(controlRoot, operationId, "discovery")).rejects.toThrow(
        /EXPLORER_STALL_BUDGET_EXHAUSTED/,
      );
      expect(await readLedgerCount(controlRoot, operationId)).toBe(STALL_RETRY_MAX_ATTEMPTS_PER_PHASE);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("claim-legacy at cap: no increment + tombstoned + EXHAUSTED", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-sat-claim-legacy-cap-"));
    const operationId = "SATURATE-CLAIM-LEGACY-AT-CAP";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
    try {
      await recordStallRetryStall(controlRoot, operationId, "discovery", 1, 30 * 60_000);
      await recordStallRetryStall(controlRoot, operationId, "discovery", 2, 30 * 60_000);
      expect(await readLedgerCount(controlRoot, operationId)).toBe(STALL_RETRY_MAX_ATTEMPTS_PER_PHASE);
      const raw = legacyRaw(operationId);
      await plantLegacy(pending, raw);
      await expect(
        claimStallRetryAttempt(controlRoot, operationId, "discovery", 4, 30 * 60_000),
      ).rejects.toThrow(/EXPLORER_STALL_BUDGET_EXHAUSTED/);
      expect(await readLedgerCount(controlRoot, operationId)).toBe(STALL_RETRY_MAX_ATTEMPTS_PER_PHASE);
      await expect(fs.stat(pending)).rejects.toMatchObject({ code: "ENOENT" });
      // Tombstoned: no parked grave left behind for a counted-or-saturated orphan.
      const entries = await fs.readdir(path.dirname(pending));
      const base = path.basename(pending);
      expect(entries.filter((e) => e.startsWith(`${base}.grave-`))).toEqual([]);
      // Replay with identical bytes must not increment either.
      await plantLegacy(pending, raw);
      await expect(loadStallRetryStalls(controlRoot, operationId, "discovery")).rejects.toThrow(
        /EXPLORER_STALL_BUDGET_EXHAUSTED/,
      );
      expect(await readLedgerCount(controlRoot, operationId)).toBe(STALL_RETRY_MAX_ATTEMPTS_PER_PHASE);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("loader-stale at cap: no increment + tombstoned + EXHAUSTED", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-sat-loader-stale-cap-"));
    const operationId = "SATURATE-LOADER-STALE-AT-CAP";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
    try {
      await recordStallRetryStall(controlRoot, operationId, "discovery", 1, 30 * 60_000);
      await recordStallRetryStall(controlRoot, operationId, "discovery", 2, 30 * 60_000);
      const raw = staleRaw(operationId, 3);
      await fs.mkdir(path.dirname(pending), { recursive: true });
      await fs.writeFile(pending, raw);
      await expect(loadStallRetryStalls(controlRoot, operationId, "discovery")).rejects.toThrow(
        /EXPLORER_STALL_BUDGET_EXHAUSTED/,
      );
      expect(await readLedgerCount(controlRoot, operationId)).toBe(STALL_RETRY_MAX_ATTEMPTS_PER_PHASE);
      await expect(fs.stat(pending)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("loader-legacy at cap: no increment + tombstoned + EXHAUSTED", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-sat-loader-legacy-cap-"));
    const operationId = "SATURATE-LOADER-LEGACY-AT-CAP";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
    try {
      await recordStallRetryStall(controlRoot, operationId, "discovery", 1, 30 * 60_000);
      await recordStallRetryStall(controlRoot, operationId, "discovery", 2, 30 * 60_000);
      const raw = legacyRaw(operationId);
      await plantLegacy(pending, raw);
      await expect(loadStallRetryStalls(controlRoot, operationId, "discovery")).rejects.toThrow(
        /EXPLORER_STALL_BUDGET_EXHAUSTED/,
      );
      expect(await readLedgerCount(controlRoot, operationId)).toBe(STALL_RETRY_MAX_ATTEMPTS_PER_PHASE);
      await expect(fs.stat(pending)).rejects.toMatchObject({ code: "ENOENT" });
      const entries = await fs.readdir(path.dirname(pending));
      const base = path.basename(pending);
      expect(entries.filter((e) => e.startsWith(`${base}.grave-`))).toEqual([]);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });
});
