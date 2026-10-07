import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  loadStallRetryStalls,
  stallRetryPendingFile,
} from "../src/operations/stallRetryBudget.js";

/**
 * RED for Luna round-7 B3: 60-min constant invalid for long deadlines.
 *
 * Provider-turn deadline is configurable to any positive int (agentPrompt
 * providerTurnDeadlineMs, config orchestration.operations.liveness.
 * providerTurnDeadlineMs). A marker with deadlineMs=90min claimed 70min ago
 * is LIVE (70min < 2*90min + margin) but older than the buggy 60min global
 * constant. Buggy: reconciles as stale +1 and deletes (live marker erased).
 * Correct: staleness derived from the marker's own deadlineMs —
 * stale iff now - claimedAt > 2*deadlineMs + margin; never a global constant.
 */
describe("stall-retry binding B3: staleness from configured deadline", () => {
  it("70min-old marker with 90min deadline is live, not stale", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-bind-b3-"));
    const operationId = "BIND-B3-1";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
    try {
      const claimedAt = new Date(Date.now() - 70 * 60_000).toISOString();
      await fs.mkdir(path.dirname(pending), { recursive: true });
      await fs.writeFile(
        pending,
        `${JSON.stringify({ version: 1, operationId, phase: "discovery", attempt: 1, claimedAt, deadlineMs: 90 * 60_000 }, null, 2)}\n`,
      );
      // Live (70 < 2*90+margin) → must refuse EXHAUSTED, never reconcile.
      await expect(loadStallRetryStalls(controlRoot, operationId, "discovery")).rejects.toThrow(
        /EXPLORER_STALL_BUDGET_EXHAUSTED/,
      );
      // Marker remains (not deleted as stale).
      const after = JSON.parse(await fs.readFile(pending, "utf8"));
      expect(after.attempt).toBe(1);
      expect(after.deadlineMs).toBe(90 * 60_000);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("190min-old marker with 90min deadline is stale (2*90+margin)", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-bind-b3-"));
    const operationId = "BIND-B3-2";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
    try {
      const claimedAt = new Date(Date.now() - 190 * 60_000).toISOString();
      await fs.mkdir(path.dirname(pending), { recursive: true });
      await fs.writeFile(
        pending,
        `${JSON.stringify({ version: 1, operationId, phase: "discovery", attempt: 1, claimedAt, deadlineMs: 90 * 60_000 }, null, 2)}\n`,
      );
      // Stale (190 > 2*90+5 margin) → durable +1, cleared.
      expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(1);
      await expect(fs.stat(pending)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });
});
