import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { HarnessProjectConfig } from "../src/core/types.js";
import { materializeRepairEvidence } from "../src/utils/repositoryPath.js";

const config = { version: 1, project: { name: "repair-evidence-test" } } as HarnessProjectConfig;

describe("materializeRepairEvidence", () => {
  it("copies the validation report into the isolated workspace byte-identical", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-repair-evidence-"));
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-repair-evidence-target-"));
    try {
      await fs.mkdir(path.join(root, ".harness", "reports"), { recursive: true });
      const content = JSON.stringify({ taskId: "T-9", status: "FAIL", checks: [] });
      await fs.writeFile(path.join(root, ".harness", "reports", "T-9.json"), content);
      expect(await materializeRepairEvidence(root, target, config, "T-9")).toBe(true);
      expect(await fs.readFile(path.join(target, ".harness", "reports", "T-9.json"), "utf8")).toBe(content);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(target, { recursive: true, force: true });
    }
  });

  it("is a no-op when no report exists yet", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-repair-evidence-"));
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-repair-evidence-target-"));
    try {
      expect(await materializeRepairEvidence(root, target, config, "T-absent")).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(target, { recursive: true, force: true });
    }
  });

  it("refuses task ids that escape the report directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-repair-evidence-"));
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-repair-evidence-target-"));
    try {
      await expect(materializeRepairEvidence(root, target, config, "../escape")).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(target, { recursive: true, force: true });
    }
  });
});
