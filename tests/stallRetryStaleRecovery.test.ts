import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  loadStallRetryStalls,
  recordStallRetryStall,
  stallRetryPendingFile,
} from "../src/operations/stallRetryBudget.js";

/**
 * RED for Luna B2 (round 6): a stale (crash-orphaned) pre-claim marker has no
 * recovery — the loader treats ANY marker as EXHAUSTED forever, so a crash
 * between claim and reconcile blocks the phase indefinitely even though the
 * counted attempt is long dead.
 *
 * Expected post-fix contract: a marker older than the phase hard deadline is
 * reconciled as a CONSUMED attempt (durable +1, never a free retry) and
 * cleared; fresh markers still refuse EXHAUSTED; malformed markers never read
 * as zero and are never silently dropped.
 */
function staleClaimedAt(): string {
  return new Date(Date.now() - 2 * 60 * 60_000).toISOString();
}

async function writeMarker(
  controlRoot: string,
  operationId: string,
  phase: "discovery",
  claimedAt: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const pending = stallRetryPendingFile(controlRoot, operationId, phase);
  await fs.mkdir(path.dirname(pending), { recursive: true });
  await fs.writeFile(
    pending,
    `${JSON.stringify({ version: 1, operationId, phase, attempt: 1, claimedAt, deadlineMs: 30 * 60_000, ...extra }, null, 2)}\n`,
  );
}

describe("stall-retry stale-claim recovery (Luna B2)", () => {
  it("stale marker recovers as a durable +1 (never free) and clears", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-stale-"));
    const operationId = "STALE-1";
    try {
      await writeMarker(controlRoot, operationId, "discovery", staleClaimedAt());
      // Must NOT refuse forever: the orphaned claim counts as one consumed
      // attempt and unblocks the phase within the remaining budget.
      expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(1);
      await expect(fs.stat(stallRetryPendingFile(controlRoot, operationId, "discovery"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      // Durable: a fresh load sees the consumed attempt, not zero.
      expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(1);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("stale marker increments the existing durable count (never resets)", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-stale-"));
    const operationId = "STALE-2";
    try {
      expect(await recordStallRetryStall(controlRoot, operationId, "discovery")).toBe(1);
      await writeMarker(controlRoot, operationId, "discovery", staleClaimedAt(), { attempt: 2 });
      expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(2);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("stale legacy marker without attempt/deadline refuses fail-closed (cannot prove staleness, never silently dropped)", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-stale-"));
    const operationId = "STALE-3";
    try {
      const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
      await fs.mkdir(path.dirname(pending), { recursive: true });
      await fs.writeFile(
        pending,
        `${JSON.stringify({ version: 1, operationId, phase: "discovery", claimedAt: staleClaimedAt() }, null, 2)}\n`,
      );
      // Binding invariant (round 7): staleness requires the marker's own attempt +
      // deadlineMs; legacy markers missing them cannot prove orphanhood, so fail
      // closed EXHAUSTED and never drop (never a free retry, never a silent clear).
      await expect(loadStallRetryStalls(controlRoot, operationId, "discovery")).rejects.toThrow(
        /EXPLORER_STALL_BUDGET_EXHAUSTED/,
      );
      await expect(fs.stat(pending)).resolves.toBeDefined();
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("fresh marker still refuses EXHAUSTED (a live attempt may still run)", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-stale-"));
    const operationId = "STALE-FRESH";
    try {
      await writeMarker(controlRoot, operationId, "discovery", new Date().toISOString());
      await expect(loadStallRetryStalls(controlRoot, operationId, "discovery")).rejects.toThrow(
        /EXPLORER_STALL_BUDGET_EXHAUSTED/,
      );
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("corrupt marker still refuses EXHAUSTED and is never dropped as zero", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-stale-"));
    const operationId = "STALE-CORRUPT";
    try {
      const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
      await fs.mkdir(path.dirname(pending), { recursive: true });
      await fs.writeFile(pending, "not-json\n");
      await expect(loadStallRetryStalls(controlRoot, operationId, "discovery")).rejects.toThrow(
        /EXPLORER_STALL_BUDGET_EXHAUSTED/,
      );
      await expect(fs.stat(pending)).resolves.toBeDefined();
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });
});
