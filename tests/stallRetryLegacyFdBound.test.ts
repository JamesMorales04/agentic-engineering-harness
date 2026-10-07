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
 * GREEN for round-12 R1 (Luna round-11 rejection of `ru/ledger-inode-9`):
 * preRaw was read BEFORE the decision stat — identical-bytes replacement
 * between them split hash(old)/identity(new) and the grave check passed
 * both. Required fix: bind content+identity to ONE file object — open()
 * first, then fstat(fd)+read(fd) through the same handle; hash THAT content;
 * decide staleness/identity from THAT fstat; no path-based read-then-stat
 * anywhere in the decision path.
 */
function legacyBytes(operationId: string, claimedAgoMs: number): string {
  return (
    `${JSON.stringify(
      {
        version: 1,
        operationId,
        phase: "discovery",
        claimedAt: new Date(Date.now() - claimedAgoMs).toISOString(),
      },
      null,
      2,
    )}\n`
  );
}

describe("stall-retry legacy migration fd-bound decision (round-12 R1)", () => {
  it("decision uses a single fd (open+fstat+read), no path-based read-then-stat", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-legacy-fdbound-"));
    const operationId = "LEGACY-FDBOUND";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
    try {
      await fs.mkdir(path.dirname(pending), { recursive: true });
      await fs.writeFile(pending, legacyBytes(operationId, 3 * 60 * 60_000));
      const oldMs = Date.now() - 3 * 60 * 60_000;
      await fs.utimes(pending, new Date(oldMs), new Date(oldMs));

      const origOpen = fs.open;
      const origStat = fs.stat;
      const origReadFile = fs.readFile;
      let openPendingCalls = 0;
      let statPendingCalls = 0;
      let readFilePendingCalls = 0;
      const openSpy = vi.spyOn(fs, "open").mockImplementation((async (p: unknown, ...rest: unknown[]) => {
        if (String(p) === pending) openPendingCalls += 1;
        return (origOpen as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
      }) as typeof fs.open);
      const statSpy = vi.spyOn(fs, "stat").mockImplementation((async (p: unknown, ...rest: unknown[]) => {
        if (String(p) === pending) statPendingCalls += 1;
        return (origStat as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
      }) as typeof fs.stat);
      const readSpy = vi.spyOn(fs, "readFile").mockImplementation((async (p: unknown, ...rest: unknown[]) => {
        if (typeof p === "string" && p === pending) readFilePendingCalls += 1;
        return (origReadFile as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
      }) as typeof fs.readFile);

      let count = -1;
      try {
        count = await loadStallRetryStalls(controlRoot, operationId, "discovery");
      } finally {
        openSpy.mockRestore();
        statSpy.mockRestore();
        readSpy.mockRestore();
      }

      // Correctly counts the stale legacy marker.
      expect(count).toBe(1);
      // FD-bound: exactly one path-based open for the decision snapshot;
      // exactly one path-based stat (the existence probe in load); zero
      // path-based reads of the marker (decision reads via the fd handle).
      // Pre-fix code did readFile(pending) + stat(pending) in the decision
      // (statPendingCalls === 2, readFilePendingCalls >= 1, openPendingCalls === 0).
      expect(openPendingCalls).toBeGreaterThanOrEqual(1);
      expect(statPendingCalls).toBe(1);
      expect(readFilePendingCalls).toBe(0);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("identical-bytes rename preserving old mtime after the snapshot quarantines (no split)", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-legacy-fdbound-split-"));
    const operationId = "LEGACY-FDBOUND-SPLIT";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
    const ledgerFile = stallRetryBudgetFile(controlRoot, operationId);
    const lockPath = `${ledgerFile}.lock`;
    try {
      await fs.mkdir(path.dirname(pending), { recursive: true });
      const bytes = legacyBytes(operationId, 3 * 60 * 60_000);
      await fs.writeFile(pending, bytes);
      const oldMs = Date.now() - 3 * 60 * 60_000;
      await fs.utimes(pending, new Date(oldMs), new Date(oldMs));
      const decidedStat = await fs.stat(pending);
      const decidedIno = decidedStat.ino;
      const decidedMtimeMs = decidedStat.mtimeMs;

      // Post-snapshot rename replacement (new inode) with old mtime restored:
      // identical bytes, stale mtime — the pre-fix read(old)/stat(new) split
      // hashed the old read but bound the new identity and passed both.
      // FD-bound snapshot pins the old inode, so the take sweeps the new one
      // and the inode check quarantines. Production sequencing (rename-first):
      // the decided marker is renamed aside to a holding grave BEFORE the
      // replacement is created, so the old inode stays allocated and the
      // replacement necessarily carries a different inode on ANY filesystem
      // (delete-then-recreate `rm + writeFile` lets some filesystems, e.g.
      // the CI runner's, reuse the freed inode number — collapsing the setup
      // into a full match that counts instead of quarantining). Both the
      // decided marker and the replacement derive their mtime from the same
      // `oldMs` utimes input, so mtime equality survives any filesystem
      // timestamp granularity by construction (identical input ⇒ identical
      // stored value); only the inode differs, isolating the inode check.
      const origOpen = fs.open;
      let fired = false;
      let replacementIno = -1;
      let replacementMtimeMs = Number.NaN;
      const holding = `${pending}.test-holding-fdbound`;
      const spy = vi.spyOn(fs, "open").mockImplementation((async (p: unknown, ...rest: unknown[]) => {
        if (!fired && String(p) === lockPath) {
          fired = true;
          await fs.rename(pending, holding);
          try {
            await fs.writeFile(pending, bytes);
            await fs.utimes(pending, new Date(oldMs), new Date(oldMs));
            const st = await fs.stat(pending);
            replacementIno = st.ino;
            replacementMtimeMs = st.mtimeMs;
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
      expect(replacementIno).not.toBe(-1);
      expect(replacementIno).not.toBe(decidedIno);
      // Setup validity: mtime preserved (same `oldMs` input ⇒ same stored
      // value on any granularity), so the ONLY decided-vs-grave divergence
      // is the inode — the quarantine below is load-bearing on the inode
      // check specifically, not the mtime tripwire. Tolerance (2s) covers
      // the coarsest real-world timestamp granularities (FAT 2s); a fresh
      // mtime would differ by ~3h, so this still isolates the inode arm.
      expect(Math.abs(replacementMtimeMs - decidedMtimeMs)).toBeLessThanOrEqual(2000);

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
});
