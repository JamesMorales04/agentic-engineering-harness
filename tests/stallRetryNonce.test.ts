import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  claimStallRetryAttempt,
  clearStallRetryClaim,
  loadStallRetryStalls,
  stallRetryPendingFile,
} from "../src/operations/stallRetryBudget.js";

/**
 * RED-first for ru/ledger-nonce-17 (Luna round-18 REJECTED
 * ru/ledger-tombstone-16 tip 38164e5, 1 point):
 *
 * Tuple identity sha256(phase + attempt + claimedAt + raw) collides: the
 * spec-manager computes attempt from persisted+retries+1 and clears on clean
 * success, so a reused attempt number claimed in the SAME millisecond stamps
 * the SAME claimedAt ISO string with otherwise identical fields → byte-
 * identical (phase,attempt,claimedAt,raw) for DISTINCT generations. The
 * second orphan is treated as replay of the first → undercount.
 *
 * Required: per-generation NONCE — every marker gets `nonce:
 * crypto.randomUUID()` at claim time; identity tuple becomes
 * sha256(phase + attempt + claimedAt + nonce + raw). Replay carries the same
 * nonce (identical bytes → same hash → detected); distinct generations always
 * differ (cryptographic, not clock-dependent). Markers lacking a nonce
 * (pre-nonce format) route through the legacy/grave identity path — never
 * hashed into tuple space.
 *
 * N1 RED: two same-ms same-attempt claims MUST differ in bytes (old code:
 * identical) and their sequential orphans MUST count twice (old code: once).
 * MECHANISM: DETERMINISTIC (file-backed ledger + lock; frozen clock).
 */

const DEADLINE_MS = 30 * 60_000;
const STALE_THRESHOLD_MS = 2 * DEADLINE_MS + 5 * 60_000;

afterEach(() => {
  vi.useRealTimers();
});

describe("ledger per-generation nonce (ru/ledger-nonce-17 RED)", () => {
  it("N1: same-ms same-attempt distinct generations differ and count twice; identical replay counts once", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-ledger-nonce-"));
    const operationId = "LEDGER-NONCE-1";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
    try {
      // Freeze the clock: both claims stamp the same millisecond, and the
      // attempt number is reused (clean-success clear between claims, as the
      // spec-manager does: attempt from persisted+retries+1, cleared on
      // success). Sequential claims: no lock contention, so frozen timers
      // never block the ledger lock.
      const t0 = Date.now();
      vi.useFakeTimers();
      vi.setSystemTime(t0);
      await claimStallRetryAttempt(controlRoot, operationId, "discovery", 1, DEADLINE_MS);
      const rawA = await fs.readFile(pending, "utf8");
      await clearStallRetryClaim(controlRoot, operationId, "discovery", 1);
      await claimStallRetryAttempt(controlRoot, operationId, "discovery", 1, DEADLINE_MS);
      const rawB = await fs.readFile(pending, "utf8");
      await clearStallRetryClaim(controlRoot, operationId, "discovery", 1);

      // Generation uniqueness: same (phase, attempt, claimedAt) MUST still
      // differ — the nonce separates generations cryptographically.
      // OLD CODE: byte-identical → this assertion is the RED failure.
      expect(rawB).not.toBe(rawA);
      const markerA = JSON.parse(rawA) as { nonce?: unknown; claimedAt?: unknown };
      const markerB = JSON.parse(rawB) as { nonce?: unknown; claimedAt?: unknown };
      expect(markerA.claimedAt).toBe(markerB.claimedAt);
      expect(typeof markerA.nonce).toBe("string");
      expect(typeof markerB.nonce).toBe("string");
      expect((markerA.nonce as string).length).toBeGreaterThan(0);
      expect(markerB.nonce).not.toBe(markerA.nonce);

      // Age both generations past staleness, then reconcile sequentially:
      // DISTINCT generations (distinct nonces) MUST count twice.
      // OLD CODE: identical tuples → second treated as replay → count stays 1.
      vi.setSystemTime(t0 + STALE_THRESHOLD_MS + 1);
      await fs.mkdir(path.dirname(pending), { recursive: true });
      await fs.writeFile(pending, rawA);
      expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(1);
      // Replay carries the same nonce (identical bytes) → detected, no second count.
      await fs.writeFile(pending, rawA);
      expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(1);
      await fs.writeFile(pending, rawB);
      expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(2);

      // At cap the accepted saturate rule refuses regardless of marker state
      // (fail-closed EXHAUSTED, marker destroyed) — replay of rawB included.
      await fs.writeFile(pending, rawB);
      await expect(loadStallRetryStalls(controlRoot, operationId, "discovery")).rejects.toThrow(
        /EXPLORER_STALL_BUDGET_EXHAUSTED/,
      );
      await expect(fs.stat(pending)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      vi.useRealTimers();
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("N2: claim writer stamps a UUID nonce at claim time", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-ledger-nonce-writer-"));
    const operationId = "LEDGER-NONCE-2";
    const pending = stallRetryPendingFile(controlRoot, operationId, "planning");
    try {
      await claimStallRetryAttempt(controlRoot, operationId, "planning", 1, DEADLINE_MS);
      const marker = JSON.parse(await fs.readFile(pending, "utf8")) as { nonce?: unknown };
      expect(typeof marker.nonce).toBe("string");
      expect(marker.nonce as string).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("N3: pre-nonce marker (no nonce) routes to the legacy path, never tuple space", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-ledger-nonce-legacy-"));
    const operationId = "LEDGER-NONCE-3";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
    try {
      // Well-formed in every pre-nonce field (attempt + claimedAt + deadlineMs,
      // stale by its own clock) but LACKING a nonce → legacy routing.
      const staleAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      const preNonceRaw =
        `${JSON.stringify({ version: 1, operationId, phase: "discovery", attempt: 1, claimedAt: staleAt, deadlineMs: DEADLINE_MS }, null, 2)}\n`;
      await fs.mkdir(path.dirname(pending), { recursive: true });
      await fs.writeFile(pending, preNonceRaw);
      const oldMs = Date.now() - 3 * 60 * 60_000;
      await fs.utimes(pending, new Date(oldMs), new Date(oldMs));

      // Old by mtime → migrates via the grave path (+1, never free).
      expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(1);
      const ledgerRaw = await fs.readFile(
        (await import("../src/operations/stallRetryBudget.js")).stallRetryBudgetFile(controlRoot, operationId),
        "utf8",
      );
      const consumed = (JSON.parse(ledgerRaw) as { consumed?: Record<string, string[]> }).consumed?.discovery ?? [];
      expect(consumed.length).toBe(1);
      // Legacy identity: sha256(path + raw) — NOT the tuple space. A tuple
      // hash here would risk aliasing a real generation; the grave path must
      // own pre-nonce bytes.
      const legacyHash = crypto.createHash("sha256").update(`${pending}\0${preNonceRaw}`, "utf8").digest("hex");
      expect(consumed[0]).toBe(legacyHash);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("N4: fresh pre-nonce marker fails closed (never reconciled as stale, never dropped)", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-ledger-nonce-freshlegacy-"));
    const operationId = "LEDGER-NONCE-4";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
    try {
      // Nonce-less but fresh by mtime → cannot prove orphanhood either way →
      // fail closed EXHAUSTED, marker left for the operator.
      const raw =
        `${JSON.stringify({ version: 1, operationId, phase: "discovery", attempt: 1, claimedAt: new Date().toISOString(), deadlineMs: DEADLINE_MS }, null, 2)}\n`;
      await fs.mkdir(path.dirname(pending), { recursive: true });
      await fs.writeFile(pending, raw);
      await expect(loadStallRetryStalls(controlRoot, operationId, "discovery")).rejects.toThrow(
        /EXPLORER_STALL_BUDGET_EXHAUSTED/,
      );
      await expect(fs.stat(pending)).resolves.toBeDefined();
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });
});
