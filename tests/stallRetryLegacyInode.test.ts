import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  listStallRetryQuarantineGraves,
  loadStallRetryStalls,
  stallRetryBudgetFile,
  stallRetryPendingFile,
} from "../src/operations/stallRetryBudget.js";

/**
 * RED for round-11 G1 (Luna round-10 rejection of `ru/ledger-grave-8`): the
 * grave VERIFY compares only the content hash against the decided snapshot.
 * A fresh IDENTICAL-BYTES replacement (different inode) landing between the
 * staleness decision and the take passes the hash check and is wrongfully
 * counted (+1 for a file never proven crash-orphaned).
 *
 * Required fix: bind identity to the INODE — capture (dev, ino) at
 * decision/stat time; after the rename, fstat the GRAVE fd and require
 * (dev, ino) equal to the decided inode (rename preserves inode; any
 * replacement has a different inode and fails even with identical bytes).
 * Mismatch → quarantine + fail-closed (existing path).
 *
 * Deterministic injection (no timing): hook the ledger-lock acquisition —
 * strictly after the decision (read + stat + staleness evaluation) and
 * strictly before the take — and atomically replace the marker (rm +
 * rewrite, the harness temp+rename idiom) with byte-identical content. The
 * replacement is a fresh file: new inode, fresh mtime.
 */
describe("stall-retry legacy migration inode binding (round-11 G1)", () => {
  it("fresh identical-bytes replacement (different inode) between decision and take is NOT counted", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-legacy-inode-"));
    const operationId = "LEGACY-INODE-G1";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
    const ledgerFile = stallRetryBudgetFile(controlRoot, operationId);
    const lockPath = `${ledgerFile}.lock`;
    try {
      await fs.mkdir(path.dirname(pending), { recursive: true });
      const bytes =
        `${JSON.stringify(
          {
            version: 1,
            operationId,
            phase: "discovery",
            claimedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
          },
          null,
          2,
        )}\n`;
      await fs.writeFile(pending, bytes);
      const oldMs = Date.now() - 3 * 60 * 60_000;
      await fs.utimes(pending, new Date(oldMs), new Date(oldMs));
      const decidedIno = (await fs.stat(pending)).ino;

      // Atomic replacement (rm + rewrite ⇒ new inode), byte-identical.
      const origOpen = fs.open;
      let fired = false;
      let replacementIno = -1;
      const spy = vi.spyOn(fs, "open").mockImplementation((async (p: unknown, ...rest: unknown[]) => {
        if (!fired && String(p) === lockPath) {
          fired = true;
          await fs.rm(pending, { force: true });
          await fs.writeFile(pending, bytes);
          replacementIno = (await fs.stat(pending)).ino;
        }
        return (origOpen as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
      }) as typeof fs.open);

      try {
        await expect(loadStallRetryStalls(controlRoot, operationId, "discovery")).rejects.toThrow(
          /EXPLORER_STALL_BUDGET_EXHAUSTED/,
        );
      } finally {
        spy.mockRestore();
      }
      expect(fired).toBe(true);
      // Setup validity: the replacement really is a different file.
      expect(replacementIno).not.toBe(-1);
      expect(replacementIno).not.toBe(decidedIno);

      // No increment on inode mismatch: parked aside, never unlinked, nothing
      // counted. The take swept the fresh replacement into the grave (marker
      // path empty), the grave disagreed with the decided inode, so it was
      // quarantined and the load failed closed.
      await expect(fs.stat(pending)).rejects.toMatchObject({ code: "ENOENT" });
      const entries = await fs.readdir(path.dirname(pending));
      const base = path.basename(pending);
      expect(entries.filter((e) => e.startsWith(`${base}.grave-`))).toEqual([]);
      const quarantines = entries.filter((e) => e.startsWith(`${base}.quarantine-`)).sort();
      expect(quarantines).toHaveLength(1);
      expect(await fs.readFile(path.join(path.dirname(pending), quarantines[0]), "utf8")).toBe(bytes);
      expect(await listStallRetryQuarantineGraves(controlRoot, operationId, "discovery")).toEqual(
        quarantines,
      );
      // Ledger still empty → affirmative zero on the next load.
      expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(0);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });
});
