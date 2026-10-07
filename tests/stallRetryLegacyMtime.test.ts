import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  loadStallRetryStalls,
  stallRetryBudgetFile,
  stallRetryPendingFile,
} from "../src/operations/stallRetryBudget.js";

/**
 * Round-10 (grave) successor of the ledger-mtime-7 guard test: the
 * legacy-migration path no longer unlinks the marker pathname at all — it
 * takes the marker to a detached grave BEFORE the durable write lands, so a
 * same-bytes rewrite landing after the take is a NEW file at the marker path
 * that is left alone while the decided orphan still reconciles as +1. The
 * replacement is never silently deleted NOR silently absorbed: a follow-up
 * load sees the fresh legacy file and refuses EXHAUSTED fail-closed.
 *
 * Deterministic interleaving: spy on fs.rename and, right after the ledger
 * temp→final rename lands (durable write done), rewrite the pending marker
 * with byte-identical content (mtime bumps to now). Under the old
 * check-then-unlink guard this replacement was deleted; under the grave
 * construction the marker path is never unlinked.
 */
describe("stall-retry legacy migration same-bytes mtime guard (ledger-mtime-7)", () => {
  it("same-bytes rewrite/touch between write and delete is left, not deleted", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-legacy-mtime-"));
    const operationId = "LEGACY-MTIME-1";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
    const ledgerFile = stallRetryBudgetFile(controlRoot, operationId);
    try {
      await fs.mkdir(path.dirname(pending), { recursive: true });
      const legacyBytes =
        `${JSON.stringify({ version: 1, operationId, phase: "discovery", claimedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString() }, null, 2)}\n`;
      await fs.writeFile(pending, legacyBytes);
      // Age the FILE mtime 3h back (threshold 2*30min+5min=65min default).
      const oldMs = Date.now() - 3 * 60 * 60_000;
      await fs.utimes(pending, new Date(oldMs), new Date(oldMs));

      const origRename = fs.rename;
      let fired = false;
      const spy = vi.spyOn(fs, "rename").mockImplementation((async (from: unknown, to: unknown, ...rest: unknown[]) => {
        const result = await (origRename as (...a: unknown[]) => Promise<void>)(from, to, ...rest);
        // Ledger durable write just landed; post-write guard has not run yet.
        // Same-bytes replacement with a fresh mtime in that window.
        if (!fired && String(to) === ledgerFile) {
          fired = true;
          await fs.writeFile(pending, legacyBytes);
        }
        return result;
      }) as typeof fs.rename);

      try {
        // Decided orphan reconciles (+1); the post-take replacement at the
        // marker path is left alone, never deleted.
        expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(1);
      } finally {
        spy.mockRestore();
      }
      expect(fired).toBe(true);

      // Replacement must survive: same bytes left on disk, fresh mtime kept.
      const afterRaw = await fs.readFile(pending, "utf8");
      expect(afterRaw).toBe(legacyBytes);
      const afterStat = await fs.stat(pending);
      expect(afterStat.mtimeMs).toBeGreaterThan(oldMs + 60_000);
      // …and never silently absorbed: the fresh legacy file fails closed
      // on the next load until it ages out (operator-visible, not dropped).
      await expect(loadStallRetryStalls(controlRoot, operationId, "discovery")).rejects.toThrow(
        /EXPLORER_STALL_BUDGET_EXHAUSTED/,
      );
      expect(await fs.readFile(pending, "utf8")).toBe(legacyBytes);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });
});
