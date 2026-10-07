import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  STALL_RETRY_MAX_ATTEMPTS_PER_PHASE,
  loadStallRetryStalls,
  recordStallRetryStall,
  stallRetryBudgetFile,
  stallRetryPendingFile,
} from "../src/operations/stallRetryBudget.js";

/**
 * RED-first for ru/ledger-tombstone-16 (Luna round-17 rejection of
 * ru/ledger-saturate-15 tip f4443a2):
 * (T1) tombstone map unbounded: saturation paths append distinct hashes past
 *   cap indefinitely. Fixed rule: at cap, DESTROY the marker WITHOUT recording
 *   a tombstone (replay safe: load refuses at count>=cap regardless of marker
 *   state). Tombstones ONLY when count < cap pre-increment (accompanying a real
 *   increment) => per-phase entries <= cap BY CONSTRUCTION + fail-closed bound
 *   assertion.
 * (T2) bytes-only identity collision: distinct generations with identical bytes
 *   map to one entry => undercount. Fixed rule: well-formed identity tuple =
 *   sha256(phase + attempt + claimedAt + nonce + raw); pre-nonce/unparseable =
 *   sha256(path + raw) via the legacy/grave path (ru/ledger-nonce-17: the nonce,
 *   crypto.randomUUID at claim time, separates same-ms same-attempt distinct
 *   generations cryptographically).
 *
 * T1 RED: N distinct at-cap orphans => consumed grows past cap on the old tip.
 * T2 RED: consumed entry must equal the tuple/path-bound hash, not sha256(raw);
 *   plus two same-bytes markers counted once (replay, QED by the nonce proof).
 *
 * T1 RED: N distinct at-cap orphans => consumed grows past cap on the old tip.
 * T2 RED: consumed entry must equal the tuple/path-bound hash, not sha256(raw);
 *   plus two same-bytes markers counted once (replay, QED by the tuple proof).
 * MECHANISM: DETERMINISTIC (file-backed ledger + lock).
 */

const CAP = STALL_RETRY_MAX_ATTEMPTS_PER_PHASE;

async function readLedger(controlRoot: string, operationId: string): Promise<{ count: number; consumed: string[] }> {
  const raw = await fs.readFile(stallRetryBudgetFile(controlRoot, operationId), "utf8");
  const parsed = JSON.parse(raw) as { stalls: Record<string, number>; consumed?: Record<string, string[]> };
  return { count: parsed.stalls.discovery, consumed: parsed.consumed?.discovery ?? [] };
}

function staleRaw(operationId: string, attempt: number, claimedAt: string, nonce = crypto.randomUUID()): string {
  return `${JSON.stringify({ version: 1, operationId, phase: "discovery", attempt, claimedAt, deadlineMs: 30 * 60_000, nonce }, null, 2)}\n`;
}

function staleOldRaw(operationId: string, attempt: number): string {
  const staleAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  return staleRaw(operationId, attempt, staleAt);
}

function legacyRaw(): string {
  return `not-json-legacy-marker\n`;
}

async function plantLegacy(pending: string, raw: string): Promise<void> {
  await fs.mkdir(path.dirname(pending), { recursive: true });
  await fs.writeFile(pending, raw);
  const oldMs = Date.now() - 3 * 60 * 60_000;
  await fs.utimes(pending, new Date(oldMs), new Date(oldMs));
}

function sha(raw: string): string {
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

describe("tombstone bounds (ru/ledger-tombstone-16 RED)", () => {
  it("T1: N distinct at-cap stale orphans do NOT grow consumed past cap", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-tomb-bounds-stale-"));
    const operationId = "TOMB-BOUNDS-STALE";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
    try {
      await recordStallRetryStall(controlRoot, operationId, "discovery", 1, 30 * 60_000);
      await recordStallRetryStall(controlRoot, operationId, "discovery", 2, 30 * 60_000);
      const before = await readLedger(controlRoot, operationId);
      expect(before.count).toBe(CAP);
      // N=5 distinct at-cap orphans (distinct attempt => distinct bytes).
      for (let attempt = 10; attempt < 15; attempt += 1) {
        await fs.mkdir(path.dirname(pending), { recursive: true });
        await fs.writeFile(pending, staleOldRaw(operationId, attempt));
        await expect(loadStallRetryStalls(controlRoot, operationId, "discovery")).rejects.toThrow(
          /EXPLORER_STALL_BUDGET_EXHAUSTED/,
        );
        // Marker destroyed (no live bytes left for replay).
        await expect(fs.stat(pending)).rejects.toMatchObject({ code: "ENOENT" });
      }
      const after = await readLedger(controlRoot, operationId);
      expect(after.count).toBe(CAP);
      // BOUND: per-phase tombstones never exceed cap (fail-closed if violated).
      expect(after.consumed.length).toBeLessThanOrEqual(CAP);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("T1-legacy: N distinct at-cap legacy orphans do NOT grow consumed past cap", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-tomb-bounds-legacy-"));
    const operationId = "TOMB-BOUNDS-LEGACY";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
    try {
      await recordStallRetryStall(controlRoot, operationId, "discovery", 1, 30 * 60_000);
      await recordStallRetryStall(controlRoot, operationId, "discovery", 2, 30 * 60_000);
      for (let i = 0; i < 5; i += 1) {
        await plantLegacy(pending, `legacy-distinct-${i}\n`);
        await expect(loadStallRetryStalls(controlRoot, operationId, "discovery")).rejects.toThrow(
          /EXPLORER_STALL_BUDGET_EXHAUSTED/,
        );
        await expect(fs.stat(pending)).rejects.toMatchObject({ code: "ENOENT" });
      }
      const after = await readLedger(controlRoot, operationId);
      expect(after.count).toBe(CAP);
      expect(after.consumed.length).toBeLessThanOrEqual(CAP);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("T2-wellformed: consumed identity is the (phase+attempt+claimedAt+nonce+raw) tuple; same-bytes replay counts once", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-tomb-tuple-"));
    const operationId = "TOMB-TUPLE";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
    try {
      const claimedAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      const nonce = crypto.randomUUID();
      const raw = staleRaw(operationId, 7, claimedAt, nonce);
      await fs.mkdir(path.dirname(pending), { recursive: true });
      await fs.writeFile(pending, raw);
      expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(1);
      const ledger = await readLedger(controlRoot, operationId);
      expect(ledger.count).toBe(1);
      expect(ledger.consumed.length).toBe(1);
      // Tuple identity: sha256(phase + attempt + claimedAt + nonce + raw), NOT sha256(raw).
      const tupleHash = sha(`discovery\x007\x00${claimedAt}\x00${nonce}\x00${raw}`);
      const rawHash = sha(raw);
      expect(tupleHash).not.toBe(rawHash);
      expect(ledger.consumed[0]).toBe(tupleHash);
      // Replay identical bytes (same nonce) => counted exactly once (identical
      // tuples ARE the same orphan: the per-generation nonce separates distinct
      // generations cryptographically, so a shared tuple means replay, QED).
      await fs.writeFile(pending, raw);
      expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(1);
      const ledger2 = await readLedger(controlRoot, operationId);
      expect(ledger2.count).toBe(1);
      expect(ledger2.consumed.length).toBe(1);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("T2-legacy: consumed identity is sha256(path+raw); same-bytes replay counts once", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-tomb-path-"));
    const operationId = "TOMB-PATH";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
    try {
      const raw = legacyRaw();
      await plantLegacy(pending, raw);
      expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(1);
      const ledger = await readLedger(controlRoot, operationId);
      expect(ledger.count).toBe(1);
      expect(ledger.consumed.length).toBe(1);
      const pathHash = sha(`${pending}\x00${raw}`);
      const rawHash = sha(raw);
      expect(pathHash).not.toBe(rawHash);
      expect(ledger.consumed[0]).toBe(pathHash);
      // Replay identical bytes at the same path => same orphan, counted once.
      await plantLegacy(pending, raw);
      expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(1);
      const ledger2 = await readLedger(controlRoot, operationId);
      expect(ledger2.count).toBe(1);
      expect(ledger2.consumed.length).toBe(1);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });
});
