import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sweepStaleDirectStagingRoots } from "../src/candidates/direct.js";

describe("P-NEW-7 RED: stale aeh-* tmp janitor", () => {
  it("removes only old aeh-* entries", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-janitor-probe-"));
    const oldAeh = path.join(tmp, "aeh-direct-old-xyz");
    const freshAeh = path.join(tmp, "aeh-direct-fresh-xyz");
    const other = path.join(tmp, "other-old-xyz");
    await fs.mkdir(oldAeh, { recursive: true });
    await fs.mkdir(freshAeh, { recursive: true });
    await fs.mkdir(other, { recursive: true });
    const now = Date.now();
    const old = new Date(now - 25 * 60 * 60 * 1000);
    const fresh = new Date(now);
    await fs.utimes(oldAeh, fresh, old);
    await fs.utimes(freshAeh, fresh, fresh);
    await fs.utimes(other, fresh, old);

    const removed = await sweepStaleDirectStagingRoots({ tmpdir: tmp, maxAgeMs: 24 * 60 * 60 * 1000, now });
    expect(removed).toContain(oldAeh);
    await expect(fs.access(oldAeh)).rejects.toThrow();
    await expect(fs.access(freshAeh)).resolves.toBeUndefined();
    await expect(fs.access(other)).resolves.toBeUndefined();
    await fs.rm(tmp, { recursive: true, force: true });
  });
});
