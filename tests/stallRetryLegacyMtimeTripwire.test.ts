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
 * GREEN for round-12 R2 (Luna round-11 rejection of `ru/ledger-inode-9`):
 * same-inode in-place rewrite by a non-lock writer kept (dev, ino) and
 * (for identical bytes) the hash, so dev/ino+hash passed. Two layers:
 * (a) AUDIT — every harness writer uses atomic temp+rename only (the sole
 * marker writer is `writePendingAtomic`, call sites `claimStallRetryAttempt`
 * + `recordStallRetryStall` pre-claim, both in-lock; no in-place writer in
 * src/), so harness actors swap the inode and can never mutate the decided
 * inode in place; (b) DEFENSE-IN-DEPTH tripwire — post-take grave fstat mtime
 * must equal the decided mtime (in addition to dev/ino+hash); mismatch →
 * quarantine + fail-closed. Residual (honest): same-ms identical-bytes
 * in-place rewrite by a non-harness fd-holder is outside the threat model
 * (requires ambient filesystem write access the harness does not grant; all
 * harness writers take the lock + temp+rename).
 */
describe("stall-retry legacy migration mtime tripwire (round-12 R2)", () => {
  it("same-inode identical-bytes rewrite with new mtime quarantines (mtime-mismatch)", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-legacy-mtime-trip-"));
    const operationId = "LEGACY-MTIME-TRIP";
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
      const decided = await fs.stat(pending);
      const decidedIno = decided.ino;
      const decidedMtime = decided.mtimeMs;

      // Non-harness in-place writer: truncate+write same bytes WITHOUT rm —
      // same inode, fresh mtime. Harness writers never do this (temp+rename
      // only); the tripwire must catch it.
      const origOpen = fs.open;
      let fired = false;
      let afterIno = -1;
      let afterMtime = Number.NaN;
      const spy = vi.spyOn(fs, "open").mockImplementation((async (p: unknown, ...rest: unknown[]) => {
        if (!fired && String(p) === lockPath) {
          fired = true;
          await fs.writeFile(pending, bytes);
          const st = await fs.stat(pending);
          afterIno = st.ino;
          afterMtime = st.mtimeMs;
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
      // Setup validity: same inode, different mtime — hash alone and
      // inode alone both still match; only the mtime tripwire distinguishes.
      expect(afterIno).toBe(decidedIno);
      expect(afterMtime).not.toBe(decidedMtime);

      // Quarantined, never counted: marker path empty (take swept the
      // mutated inode), exactly one quarantine holding the swept bytes,
      // ledger still empty.
      await expect(fs.stat(pending)).rejects.toMatchObject({ code: "ENOENT" });
      const entries = await fs.readdir(path.dirname(pending));
      const base = path.basename(pending);
      expect(entries.filter((e) => e.startsWith(`${base}.grave-`))).toEqual([]);
      const quarantines = entries.filter((e) => e.startsWith(`${base}.quarantine-`)).sort();
      expect(quarantines).toHaveLength(1);
      expect(await fs.readFile(path.join(path.dirname(pending), quarantines[0]), "utf8")).toBe(bytes);
      expect(await listStallRetryQuarantineGraves(controlRoot, operationId, "discovery")).toEqual(quarantines);
      expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(0);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("undisturbed stale legacy still counts (no false trip)", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-legacy-mtime-trip-clean-"));
    const operationId = "LEGACY-MTIME-CLEAN";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
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

      expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(1);
      await expect(fs.stat(pending)).rejects.toMatchObject({ code: "ENOENT" });
      const entries = await fs.readdir(path.dirname(pending));
      const base = path.basename(pending);
      expect(entries.filter((e) => e.startsWith(`${base}.grave-`))).toEqual([]);
      expect(entries.filter((e) => e.startsWith(`${base}.quarantine-`))).toEqual([]);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });
});
