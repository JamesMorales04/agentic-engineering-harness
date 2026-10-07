import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runDoctor } from "../src/core/doctor.js";
import type { HarnessProjectConfig } from "../src/core/types.js";
import {
  listStallRetryQuarantineGraves,
  loadStallRetryStalls,
  stallRetryPendingFile,
} from "../src/operations/stallRetryBudget.js";

const MINIMAL_CONFIG: HarnessProjectConfig = {
  version: 1,
  project: { name: "quarantine-doctor-test" },
};

/**
 * RED for round-11 G2 (Luna round-10 rejection of `ru/ledger-grave-8`):
 * parked graves/quarantines are undiscoverable — nothing in the operator-
 * visible diagnostic surface (`aeh doctor`) reports their presence, and no
 * recovery procedure is documented. Required fix (honest, minimal): surface
 * the quarantine/grave count in the doctor output as a WARNING.
 */
describe("stall-retry quarantine doctor surfacing (round-11 G2)", () => {
  it("clean root reports no parked graves/quarantines", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-quarantine-doctor-clean-"));
    try {
      const results = await runDoctor(root, MINIMAL_CONFIG);
      const entry = results.find((r) => r.component === "stall-retry-quarantine");
      expect(entry).toBeDefined();
      expect(entry?.ok).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("parked quarantine is surfaced as a WARNING in doctor output", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-quarantine-doctor-parked-"));
    const operationId = "QUARANTINE-DOCTOR";
    const pending = stallRetryPendingFile(root, operationId, "discovery");
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
      // Force the quarantine arm directly: seed the operations dir with a
      // parked quarantine sibling (the exact artifact the mismatch path
      // parks), then assert the operator-visible diagnostic surfaces it.
      const parked = `${pending}.quarantine-seeded`;
      await fs.writeFile(parked, "seeded-parked-payload\n");
      expect(await listStallRetryQuarantineGraves(root, operationId, "discovery")).toEqual([
        path.basename(parked),
      ]);
      expect(await loadStallRetryStalls(root, operationId, "discovery")).toBe(1);

      const results = await runDoctor(root, MINIMAL_CONFIG);
      const entry = results.find((r) => r.component === "stall-retry-quarantine");
      expect(entry).toBeDefined();
      expect(entry?.ok).toBe(false);
      expect(entry?.required).toBe(false);
      expect(entry?.message).toMatch(/WARNING/);
      expect(entry?.message).toMatch(/1/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
