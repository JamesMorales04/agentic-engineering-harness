import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  loadStallRetryStalls,
  stallRetryPendingFile,
} from "../src/operations/stallRetryBudget.js";

/**
 * RED for Luna round-8 B3-legacy: markers missing attempt/deadlineMs fail
 * well-formedness and refuse EXHAUSTED forever with no migration (stranded).
 * Correct migration: legacy marker (unparseable/new-format validation fails BUT
 * file is a marker, not ledger) with mtime older than 2x CURRENT max configured
 * stall deadline + margin → reconcile as durable +1 (consumed, never free) and
 * clear; fresh/unstatable legacy → EXHAUSTED fail-closed (operator clears).
 * One-time: post-migration all markers carry attempt+deadlineMs.
 */
describe("stall-retry legacy-marker migration (Luna round-8 B3-legacy)", () => {
  it("old legacy marker (mtime > 2*maxDeadline+margin) reconciles as durable +1 and clears", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-legacy-mig-"));
    const operationId = "LEGACY-MIG-1";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
    try {
      await fs.mkdir(path.dirname(pending), { recursive: true });
      // Legacy shape: no attempt/deadlineMs (pre-binding format).
      await fs.writeFile(
        pending,
        `${JSON.stringify({ version: 1, operationId, phase: "discovery", claimedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString() }, null, 2)}\n`,
      );
      // Age the FILE mtime 3h back (default threshold 2*30min+5min=65min).
      const oldMs = Date.now() - 3 * 60 * 60_000;
      await fs.utimes(pending, new Date(oldMs), new Date(oldMs));

      // Must NOT strand forever: durable +1 (consumed, never free) and cleared.
      const count = await loadStallRetryStalls(controlRoot, operationId, "discovery");
      expect(count).toBe(1);
      await expect(fs.stat(pending)).rejects.toMatchObject({ code: "ENOENT" });
      // Durable: second load sees the consumed attempt.
      expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(1);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("old unparseable marker (mtime > threshold) reconciles as durable +1 and clears", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-legacy-mig-"));
    const operationId = "LEGACY-MIG-2";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
    try {
      await fs.mkdir(path.dirname(pending), { recursive: true });
      await fs.writeFile(pending, "not-json-legacy\n");
      const oldMs = Date.now() - 3 * 60 * 60_000;
      await fs.utimes(pending, new Date(oldMs), new Date(oldMs));

      const count = await loadStallRetryStalls(controlRoot, operationId, "discovery");
      expect(count).toBe(1);
      await expect(fs.stat(pending)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("fresh legacy marker refuses EXHAUSTED fail-closed and is left for the operator", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-legacy-mig-"));
    const operationId = "LEGACY-MIG-3";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
    try {
      await fs.mkdir(path.dirname(pending), { recursive: true });
      await fs.writeFile(
        pending,
        `${JSON.stringify({ version: 1, operationId, phase: "discovery", claimedAt: new Date().toISOString() }, null, 2)}\n`,
      );
      // Fresh mtime (just written) → fail-closed, never silently dropped.
      await expect(loadStallRetryStalls(controlRoot, operationId, "discovery")).rejects.toThrow(
        /EXPLORER_STALL_BUDGET_EXHAUSTED/,
      );
      await expect(fs.stat(pending)).resolves.toBeDefined();
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });
});
