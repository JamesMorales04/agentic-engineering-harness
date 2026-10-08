import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DIRECT_STAGING_HEARTBEAT_FILENAME,
  sweepStaleDirectStagingRoots,
  writeDirectStagingHeartbeat
} from "../src/candidates/direct.js";

async function makeRoot(tmp: string, name: string): Promise<string> {
  const full = path.join(tmp, name);
  await fs.mkdir(full, { recursive: true });
  return full;
}

async function setHeartbeatMtime(root: string, mtime: Date): Promise<void> {
  await fs.utimes(path.join(root, DIRECT_STAGING_HEARTBEAT_FILENAME), mtime, mtime);
}

describe("P-NEW-7: janitor deletes only provably-abandoned DIRECT roots", () => {
  it("removes only stale-heartbeat aeh-direct-* roots", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-janitor-probe-"));
    try {
      const now = Date.now();
      const old = new Date(now - 25 * 60 * 60 * 1000);
      const fresh = new Date(now);

      // Provably abandoned: well-formed heartbeat, heartbeat itself stale.
      const abandoned = await makeRoot(tmp, "aeh-direct-old-xyz");
      await writeDirectStagingHeartbeat(abandoned, { operationId: "op-1", taskId: "t" });
      await setHeartbeatMtime(abandoned, old);
      await fs.utimes(abandoned, fresh, old);

      // Live: directory mtime old but heartbeat fresh — must survive.
      const live = await makeRoot(tmp, "aeh-direct-live-xyz");
      await writeDirectStagingHeartbeat(live, { operationId: "op-live", taskId: "t" });
      await setHeartbeatMtime(live, fresh);
      await fs.utimes(live, fresh, old);

      // No heartbeat: unprovable — preserved fail-closed even when old.
      const noMarker = await makeRoot(tmp, "aeh-direct-nomarker-xyz");
      await fs.utimes(noMarker, fresh, old);

      // Malformed heartbeat: unprovable — preserved.
      const malformed = await makeRoot(tmp, "aeh-direct-bad-xyz");
      await fs.writeFile(path.join(malformed, DIRECT_STAGING_HEARTBEAT_FILENAME), "not-json\n", "utf8");
      await setHeartbeatMtime(malformed, old);
      await fs.utimes(malformed, fresh, old);

      // Out of scope: never touched regardless of age.
      const other = await makeRoot(tmp, "other-old-xyz");
      await fs.utimes(other, fresh, old);

      const removed = await sweepStaleDirectStagingRoots({ tmpdir: tmp, maxAgeMs: 24 * 60 * 60 * 1000, now });
      expect(removed).toContain(abandoned);
      expect(removed).not.toContain(live);
      expect(removed).not.toContain(noMarker);
      expect(removed).not.toContain(malformed);
      expect(removed).not.toContain(other);
      await expect(fs.access(abandoned)).rejects.toThrow();
      await expect(fs.access(live)).resolves.toBeUndefined();
      await expect(fs.access(noMarker)).resolves.toBeUndefined();
      await expect(fs.access(malformed)).resolves.toBeUndefined();
      await expect(fs.access(other)).resolves.toBeUndefined();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("preserves fresh-heartbeat roots", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-janitor-probe-"));
    try {
      const now = Date.now();
      const fresh = new Date(now);
      const root = await makeRoot(tmp, "aeh-direct-fresh-xyz");
      await writeDirectStagingHeartbeat(root, { operationId: "op-1", taskId: "t" });
      await setHeartbeatMtime(root, fresh);
      const removed = await sweepStaleDirectStagingRoots({ tmpdir: tmp, maxAgeMs: 24 * 60 * 60 * 1000, now });
      expect(removed).not.toContain(root);
      await expect(fs.access(root)).resolves.toBeUndefined();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
