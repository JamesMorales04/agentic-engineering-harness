import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { recordPaseoTrace } from "../src/paseo/trace.js";

describe("Paseo integration traces", () => {
  it("persists local NDJSON even when project telemetry/config is unavailable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-paseo-trace-"));
    try {
      await recordPaseoTrace(root, "provider.preflight", {
        provider: "codex",
        model: "gpt-test",
        ok: true
      });
      const file = path.join(root, ".harness/telemetry/paseo.ndjson");
      const lines = (await fs.readFile(file, "utf8")).trim().split(/\r?\n/);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toEqual(
        expect.objectContaining({
          name: "harness.paseo.provider.preflight",
          attributes: expect.objectContaining({
            provider: "codex",
            model: "gpt-test",
            ok: true
          })
        })
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
