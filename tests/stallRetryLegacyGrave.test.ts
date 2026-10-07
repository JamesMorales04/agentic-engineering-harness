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
 * RED for round-10 (Luna round-9 rejection of `ru/ledger-mtime-7`): the
 * legacy-migration delete guard compared raw bytes AND file mtime, then
 * unlinked the marker PATH. Three points on that one guard:
 *
 * G1 — check-then-unlink race vs NON-lock-taking writers. The ledger lock
 *   serializes ledger users only; a writer that never takes the lock can
 *   replace the marker between the final guard read and the unlink, and the
 *   unlink deletes someone else's live claim.
 * G2 — read/stat pair not atomic. `Promise.all([readFile, stat])` observes two
 *   generations (mixed snapshot); the guard's decision can rest on bytes from
 *   one generation and an mtime from another.
 * G3 — same-ms mtime blind spot. mtime equality cannot detect a replacement
 *   landing inside the same mtime tick; a same-ms same-bytes replacement
 *   passes the guard and is deleted.
 *
 * Required construction (all three eliminated, no mtime reliance):
 * TAKE (atomic rename to unguessable grave) + VERIFY (fd fstat+read, same
 * inode; content-sha vs decided snapshot) + DESTROY-or-QUARANTINE.
 *
 * Each test is deterministic: spies hook exact syscalls (rename/rm/stat —
 * the established stall-retry idiom, cf. stallRetryLegacyMtime.test.ts) and
 * races are injected with direct fs manipulation, never timing.
 */

const DEADLINE_MS = 30 * 60_000;

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

function liveClaimBytes(operationId: string): string {
  return (
    `${JSON.stringify(
      {
        version: 1,
        operationId,
        phase: "discovery",
        attempt: 2,
        claimedAt: new Date().toISOString(),
        deadlineMs: DEADLINE_MS,
      },
      null,
      2,
    )}\n`
  );
}

async function siblingTags(pending: string): Promise<{ graves: string[]; quarantines: string[] }> {
  const entries = await fs.readdir(path.dirname(pending));
  const base = path.basename(pending);
  return {
    graves: entries.filter((e) => e.startsWith(`${base}.grave-`)).sort(),
    quarantines: entries.filter((e) => e.startsWith(`${base}.quarantine-`)).sort(),
  };
}

describe("stall-retry legacy migration grave take (round-10)", () => {
  it("G1: a non-lock replacement landing in the final unlink window is never deleted", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-legacy-grave-g1-"));
    const operationId = "LEGACY-GRAVE-G1";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
    try {
      await fs.mkdir(path.dirname(pending), { recursive: true });
      await fs.writeFile(pending, legacyBytes(operationId, 3 * 60 * 60_000));
      const oldMs = Date.now() - 3 * 60 * 60_000;
      await fs.utimes(pending, new Date(oldMs), new Date(oldMs));

      // Non-lock-taking writer: direct fs write, never touches the ledger lock.
      // Hook the final unlink itself: plant the live claim immediately before
      // the pathname removal goes through. A marker-path unlink deletes it
      // (G1); a grave construction never unlinks the marker path (plant never
      // fires, decided orphan reconciles, grave is destroyed instead).
      const origRm = fs.rm;
      let fired = false;
      const spy = vi.spyOn(fs, "rm").mockImplementation((async (target: unknown, options: unknown) => {
        if (String(target) === pending && !fired) {
          fired = true;
          await fs.writeFile(pending, liveClaimBytes(operationId));
        }
        return (origRm as (t: string, o: object) => Promise<void>)(target as string, options as object);
      }) as typeof fs.rm);

      let count = -1;
      try {
        count = await loadStallRetryStalls(controlRoot, operationId, "discovery");
      } finally {
        spy.mockRestore();
      }

      // Invariant: the marker pathname is never unlinked after the decision —
      // destroy touches the detached grave only — so the hook never fires.
      expect(fired).toBe(false);
      expect(count).toBe(1);
      await expect(fs.stat(pending)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await siblingTags(pending)).toEqual({ graves: [], quarantines: [] });
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("G2: after take, no read/stat observes the live marker path (single-inode fd verify)", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-legacy-grave-g2-"));
    const operationId = "LEGACY-GRAVE-G2";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
    try {
      await fs.mkdir(path.dirname(pending), { recursive: true });
      await fs.writeFile(pending, legacyBytes(operationId, 3 * 60 * 60_000));
      const oldMs = Date.now() - 3 * 60 * 60_000;
      await fs.utimes(pending, new Date(oldMs), new Date(oldMs));
      const replacement = liveClaimBytes(operationId);

      // Hook the atomic take: the moment the marker is renamed to its grave,
      // a concurrent writer creates a NEW file at the marker path (direct fs
      // manipulation, no lock). The guard must verify the detached grave
      // inode and never observe the live path again — no read/stat pair, so
      // no mixed snapshot is possible by construction.
      const origRename = fs.rename;
      let took = false;
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation((async (from: unknown, to: unknown, ...rest: unknown[]) => {
        const result = await (origRename as (...a: unknown[]) => Promise<void>)(from, to, ...rest);
        if (String(from) === pending && String(to).startsWith(`${pending}.grave-`) && !took) {
          took = true;
          await fs.writeFile(pending, replacement);
        }
        return result;
      }) as typeof fs.rename);

      const origStat = fs.stat;
      const origReadFile = fs.readFile;
      let postTakeObservations = 0;
      const statSpy = vi.spyOn(fs, "stat").mockImplementation((async (p: unknown, ...rest: unknown[]) => {
        if (took && String(p) === pending) postTakeObservations += 1;
        return (origStat as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
      }) as typeof fs.stat);
      const readSpy = vi.spyOn(fs, "readFile").mockImplementation((async (p: unknown, ...rest: unknown[]) => {
        if (took && typeof p === "string" && p === pending) postTakeObservations += 1;
        return (origReadFile as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
      }) as typeof fs.readFile);

      let count = -1;
      try {
        count = await loadStallRetryStalls(controlRoot, operationId, "discovery");
      } finally {
        renameSpy.mockRestore();
        statSpy.mockRestore();
        readSpy.mockRestore();
      }

      // The take happened (old guard never renames the marker — RED without it)
      // and nothing observed the live path afterwards.
      expect(took).toBe(true);
      expect(postTakeObservations).toBe(0);
      // Decided orphan counted; concurrent writer's file untouched.
      expect(count).toBe(1);
      expect(await fs.readFile(pending, "utf8")).toBe(replacement);
      expect(await siblingTags(pending)).toEqual({ graves: [], quarantines: [] });
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });

  it("G3: same-ms same-bytes replacement is not deleted (no mtime reliance)", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-legacy-grave-g3-"));
    const operationId = "LEGACY-GRAVE-G3";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
    const ledgerFile = stallRetryBudgetFile(controlRoot, operationId);
    try {
      await fs.mkdir(path.dirname(pending), { recursive: true });
      const bytes = legacyBytes(operationId, 3 * 60 * 60_000);
      await fs.writeFile(pending, bytes);
      const oldMs = Date.now() - 3 * 60 * 60_000;
      await fs.utimes(pending, new Date(oldMs), new Date(oldMs));
      const origMtimeMs = (await fs.stat(pending)).mtimeMs;

      // Same-ms blind spot, exact: byte-identical rewrite with the mtime
      // restored to the tick the guard decided on. An mtime-equality guard
      // cannot distinguish this replacement from the original and deletes it.
      const origRename = fs.rename;
      let fired = false;
      const spy = vi.spyOn(fs, "rename").mockImplementation((async (from: unknown, to: unknown, ...rest: unknown[]) => {
        const result = await (origRename as (...a: unknown[]) => Promise<void>)(from, to, ...rest);
        if (!fired && String(to) === ledgerFile) {
          fired = true;
          await fs.writeFile(pending, bytes);
          await fs.utimes(pending, new Date(origMtimeMs), new Date(origMtimeMs));
        }
        return result;
      }) as typeof fs.rename);

      let count = -1;
      try {
        count = await loadStallRetryStalls(controlRoot, operationId, "discovery");
      } finally {
        spy.mockRestore();
      }
      expect(fired).toBe(true);

      // Decided orphan counted; the same-ms file was never unlinked (the
      // guard compares content-sha of the detached grave, never mtimes).
      expect(count).toBe(1);
      expect(await fs.readFile(pending, "utf8")).toBe(bytes);
      // Blind-spot conditions held: mtime restored to the decided tick within
      // filesystem timestamp granularity (not a fresh write) — and the file
      // survived regardless.
      const afterMtimeMs = (await fs.stat(pending)).mtimeMs;
      expect(Math.abs(afterMtimeMs - origMtimeMs)).toBeLessThan(5);
      expect(afterMtimeMs).toBeLessThan(oldMs + 60_000);
      expect(await siblingTags(pending)).toEqual({ graves: [], quarantines: [] });
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });
});
