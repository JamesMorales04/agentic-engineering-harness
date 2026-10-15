import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { HarnessProjectConfig } from "../src/core/types.js";
import { ignoreVerdict, assertDigestNeutralReportPersist, materializeRepairEvidence, verifyRepairEvidenceUntampered, writeContainedFile } from "../src/utils/repositoryPath.js";

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
      const copied = path.join(target, ".harness", "reports", "T-9.json");
      expect(await fs.readFile(copied, "utf8")).toBe(content);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(target, { recursive: true, force: true });
    }
  });

  it("materializes evidence read-only so tampering fails loudly", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-repair-evidence-"));
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-repair-evidence-target-"));
    try {
      await fs.mkdir(path.join(root, ".harness", "reports"), { recursive: true });
      await fs.writeFile(path.join(root, ".harness", "reports", "T-9.json"), "{}");
      expect(await materializeRepairEvidence(root, target, config, "T-9")).toBe(true);
      const copied = path.join(target, ".harness", "reports", "T-9.json");
      const mode = (await fs.stat(copied)).mode & 0o777;
      expect(mode & 0o222).toBe(0);
      // Refreshing over a previous read-only copy converges instead of failing.
      expect(await materializeRepairEvidence(root, target, config, "T-9")).toBe(true);
      expect(await fs.readFile(copied, "utf8")).toBe("{}");
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

  it("refuses writes through symlinked parents without creating outside the root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-repair-evidence-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-repair-evidence-outside-"));
    try {
      await fs.mkdir(path.join(root, "sub"), { recursive: true });
      await fs.symlink(outside, path.join(root, "sub", "link"));
      await expect(writeContainedFile(root, "sub/link/nested/report.json", "{}")).rejects.toThrow(/ESCAPE/);
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses writes through a destination symlink", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-repair-evidence-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-repair-evidence-outside-"));
    try {
      await fs.mkdir(path.join(root, "reports"), { recursive: true });
      const outsideFile = path.join(outside, "victim.txt");
      await fs.writeFile(outsideFile, "victim");
      await fs.symlink(outsideFile, path.join(root, "reports", "T-1.json"));
      await expect(writeContainedFile(root, "reports/T-1.json", "{}")).rejects.toThrow(/ESCAPE/);
      expect(await fs.readFile(outsideFile, "utf8")).toBe("victim");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("reports git-ignore verdicts for digest visibility", async () => {
    const { execFileSync } = await import("node:child_process");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-repair-evidence-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      await fs.writeFile(path.join(root, ".gitignore"), ".harness/\n");
      expect(await ignoreVerdict(root, ".harness/reports/T-1.json")).toBe("ignored");
      expect(await ignoreVerdict(root, "reports/T-1.json")).toBe("tracked-visible");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("passes digest-neutral persists for isolated execution and conventional locations", async () => {
    const { execFileSync } = await import("node:child_process");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-repair-evidence-"));
    const other = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-repair-evidence-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      await fs.writeFile(path.join(root, ".gitignore"), ".harness/\n");
      await assertDigestNeutralReportPersist(root, other, ".harness/reports", "T-1");
      await assertDigestNeutralReportPersist(root, root, ".harness/reports", "T-1");
      await assertDigestNeutralReportPersist(root, root, undefined, "T-1");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(other, { recursive: true, force: true });
    }
  });

  it("fails closed for digest-visible reports locations in local execution", async () => {
    const { execFileSync } = await import("node:child_process");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-repair-evidence-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      await fs.writeFile(path.join(root, ".gitignore"), ".harness/\n");
      await expect(assertDigestNeutralReportPersist(root, root, "reports", "T-1"))
        .rejects.toThrow(/REPAIR_REPORT_CONFIG_INVALID/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-repair-evidence-"));
    try {
      await expect(assertDigestNeutralReportPersist(plain, plain, "reports", "T-1"))
        .rejects.toThrow(/REPAIR_REPORT_CONFIG_INVALID/);
      await assertDigestNeutralReportPersist(plain, plain, undefined, "T-1");
    } finally {
      await fs.rm(plain, { recursive: true, force: true });
    }
  });

  it("detects post-turn evidence tampering even past read-only modes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-repair-evidence-"));
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-repair-evidence-target-"));
    try {
      await fs.mkdir(path.join(root, ".harness", "reports"), { recursive: true });
      await fs.writeFile(path.join(root, ".harness", "reports", "T-9.json"), '{"ok":true}');
      expect(await materializeRepairEvidence(root, target, config, "T-9")).toBe(true);
      await verifyRepairEvidenceUntampered(root, target, config, "T-9");
      // A shell-capable participant re-chmods and rewrites the ignored copy.
      const copied = path.join(target, ".harness", "reports", "T-9.json");
      await fs.chmod(copied, 0o644);
      await fs.writeFile(copied, '{"ok":false}');
      await expect(verifyRepairEvidenceUntampered(root, target, config, "T-9"))
        .rejects.toThrow(/REPAIR_EVIDENCE_TAMPERED/);
      // Deletion is tampering too.
      await fs.unlink(copied);
      await expect(verifyRepairEvidenceUntampered(root, target, config, "T-9"))
        .rejects.toThrow(/REPAIR_EVIDENCE_TAMPERED/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(target, { recursive: true, force: true });
    }
  });
});
