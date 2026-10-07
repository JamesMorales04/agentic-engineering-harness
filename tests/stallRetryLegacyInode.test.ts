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
 * strictly before the take — and replace the marker with byte-identical
 * content using PRODUCTION sequencing: rename-first. The decided marker is
 * renamed aside to a holding grave BEFORE the replacement is created at the
 * marker path, exactly as production's take detaches to
 * `<pending>.grave-<uuid>` before verifying. The old inode stays allocated
 * in the holding grave, so the kernel cannot reuse its number for the
 * replacement — inode divergence holds on ANY filesystem. (A delete-then-
 * recreate `rm + writeFile` here is load-bearing-brittle: some filesystems,
 * e.g. the CI runner's, immediately reuse the freed inode number, so the
 * "different file" setup silently collapses into the same inode and the
 * setup-validity assertion below fails.) The replacement is a fresh file:
 * new inode, fresh mtime (~3h newer than the decided mtime — far apart, so
 * the mtime arm is granularity-robust too).
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

      // Rename-first replacement (production sequencing): detach the decided
      // marker to a holding grave BEFORE creating the replacement at the
      // marker path. The old inode stays allocated, so the replacement is
      // necessarily a different file on any filesystem. Byte-identical.
      const origOpen = fs.open;
      let fired = false;
      let replacementIno = -1;
      const holding = `${pending}.test-holding-inode`;
      const spy = vi.spyOn(fs, "open").mockImplementation((async (p: unknown, ...rest: unknown[]) => {
        if (!fired && String(p) === lockPath) {
          fired = true;
          await fs.rename(pending, holding);
          try {
            await fs.writeFile(pending, bytes);
            replacementIno = (await fs.stat(pending)).ino;
          } finally {
            // Safe to release now: the replacement's inode number was
            // assigned at creation while the old inode was still allocated,
            // so freeing the holding grave cannot retroactively alias them.
            await fs.rm(holding, { force: true });
          }
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
      // Kernel-guaranteed by rename-first (the old inode was still allocated
      // when the replacement was created), on any filesystem.
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
