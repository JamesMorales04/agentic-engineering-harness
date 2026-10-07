import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  listStallRetryQuarantineGraves,
  loadStallRetryStalls,
  stallRetryPendingFile,
} from "../src/operations/stallRetryBudget.js";

/**
 * GREEN-only companion to stallRetryLegacyGrave.test.ts (round-10): the
 * mismatch arm of take+verify+destroy-or-quarantine. A concurrent replace
 * slipping between the decision read and the take leaves a grave that
 * disagrees with the decided snapshot → no increment, no unlink of live
 * state, quarantine aside + fail-closed EXHAUSTED (operator recovers).
 * RED pre-repair (no grave/quarantine construction exists); GREEN post-repair.
 */
describe("stall-retry legacy migration quarantine (round-10)", () => {
  it("mismatch between decided snapshot and grave quarantines fail-closed (operator recovers)", async () => {
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-legacy-grave-q-"));
    const operationId = "LEGACY-GRAVE-Q";
    const pending = stallRetryPendingFile(controlRoot, operationId, "discovery");
    const liveClaim =
      `${JSON.stringify(
        {
          version: 1,
          operationId,
          phase: "discovery",
          attempt: 2,
          claimedAt: new Date().toISOString(),
          deadlineMs: 30 * 60_000,
        },
        null,
        2,
      )}\n`;
    try {
      await fs.mkdir(path.dirname(pending), { recursive: true });
      await fs.writeFile(
        pending,
        `${JSON.stringify(
          {
            version: 1,
            operationId,
            phase: "discovery",
            claimedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
          },
          null,
          2,
        )}\n`,
      );
      const oldMs = Date.now() - 3 * 60 * 60_000;
      await fs.utimes(pending, new Date(oldMs), new Date(oldMs));

      // Hook the take itself and swap different-bytes content in first.
      const origRename = fs.rename;
      let fired = false;
      const spy = vi.spyOn(fs, "rename").mockImplementation((async (from: unknown, to: unknown, ...rest: unknown[]) => {
        if (!fired && String(from) === pending && String(to).startsWith(`${pending}.grave-`)) {
          fired = true;
          await fs.writeFile(pending, liveClaim);
        }
        return (origRename as (...a: unknown[]) => Promise<void>)(from, to, ...rest);
      }) as typeof fs.rename);

      try {
        await expect(loadStallRetryStalls(controlRoot, operationId, "discovery")).rejects.toThrow(
          /EXPLORER_STALL_BUDGET_EXHAUSTED/,
        );
      } finally {
        spy.mockRestore();
      }
      expect(fired).toBe(true);

      // Take swept the replacement into the grave (marker path empty — nothing
      // to delete there); the grave disagreed with the decided snapshot, so it
      // was parked aside, never unlinked, and nothing was counted.
      await expect(fs.stat(pending)).rejects.toMatchObject({ code: "ENOENT" });
      const entries = await fs.readdir(path.dirname(pending));
      const base = path.basename(pending);
      expect(entries.filter((e) => e.startsWith(`${base}.grave-`))).toEqual([]);
      const quarantines = entries.filter((e) => e.startsWith(`${base}.quarantine-`)).sort();
      expect(quarantines).toHaveLength(1);
      // Parked content is the someone-else's-live-claim bytes (operator recovers).
      expect(await fs.readFile(path.join(path.dirname(pending), quarantines[0]), "utf8")).toBe(
        liveClaim,
      );
      // Visible to the operator via the debug listing.
      expect(await listStallRetryQuarantineGraves(controlRoot, operationId, "discovery")).toEqual(
        quarantines,
      );
      // No increment happened on mismatch: ledger still empty → affirmative zero.
      expect(await loadStallRetryStalls(controlRoot, operationId, "discovery")).toBe(0);
    } finally {
      await fs.rm(controlRoot, { recursive: true, force: true });
    }
  });
});
