import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseJsonc } from "../src/agents/jsonc.js";
import { reconcileHarnessAssets } from "../src/core/assets.js";
import { PACKAGE_ROOT } from "../src/version.js";

const packageRoot = path.resolve(PACKAGE_ROOT);
const sourceSkill = path.join(packageRoot, "skills", "aeh-browser-e2e", "SKILL.md");
const managedSkill = ".harness/skills/aeh-browser-e2e/SKILL.md";

describe("aeh-browser-e2e repository skill", () => {
  it("declares the canonical SKILL.md metadata and the frozen operational anchors", async () => {
    const source = await fs.readFile(sourceSkill, "utf8");
    const frontmatter = source.match(/^---\n([\s\S]*?)\n---\n/);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter![1]).toMatch(/^name: aeh-browser-e2e$/m);
    expect(frontmatter![1]).toMatch(/^description: .+$/m);
    expect(frontmatter![1]).toMatch(/^license: Apache-2\.0$/m);
    for (const anchor of [
      "Golden path",
      "npm ci && npm run build",
      "npm run aeh -- start --no-open",
      "controlCenterPairing",
      "node_modules/.bin/playwright",
      "browser_list_tabs",
      "X-AEH-CSRF",
      "SPEC_AUTHORING",
      "PAUSED",
      "HUMAN_REQUIRED",
      "PRODUCT_DEFECT",
      "TEST_DEFECT",
      "TEST_INFRASTRUCTURE_UNAVAILABLE",
      "ENVIRONMENT_DEFECT",
      "AUTHORIZATION_REQUIRED",
      "ARCHITECTURE_DECISION_REQUIRED",
      "REPRODUCE -> CLASSIFY -> ISOLATE -> REPAIR -> FOCUSED RERUN -> FULL BROWSER JOURNEY -> AFFECTED DETERMINISTIC GATES"
    ]) {
      expect(source, `missing anchor: ${anchor}`).toContain(anchor);
    }
    expect(source.trim().split("\n").length).toBeGreaterThan(100);
  });

  it("reconciles the packaged source skill into the project-managed skill root", async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-browser-e2e-skill-"));
    try {
      const result = await reconcileHarnessAssets(project, { packageRoot });
      expect(result.created).toContain(managedSkill);
      const reconciled = await fs.readFile(path.join(project, managedSkill), "utf8");
      expect(reconciled).toBe(await fs.readFile(sourceSkill, "utf8"));
      const manifest = JSON.parse(await fs.readFile(path.join(project, ".harness", "managed-assets.json"), "utf8")) as {
        assets: Record<string, { sourceSha256?: string; managedSha256?: string }>;
      };
      expect(manifest.assets[managedSkill]?.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(manifest.assets[managedSkill]?.managedSha256).toBe(manifest.assets[managedSkill]?.sourceSha256);
      const rerun = await reconcileHarnessAssets(project, { packageRoot });
      expect(rerun.unchanged).toContain(managedSkill);
    } finally {
      await fs.rm(project, { recursive: true, force: true });
    }
  });

  it("is shipped by the package files whitelist and resolvable from the repository skill roots", async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")) as { files?: string[] };
    expect(pkg.files).toContain("skills");
    const topology = parseJsonc(await fs.readFile(path.join(packageRoot, ".harness", "agents.source.jsonc"), "utf8")) as { skillRoots?: string[] };
    expect(topology.skillRoots).toContain("skills");
    await expect(fs.access(path.join(packageRoot, "skills", "aeh-browser-e2e", "SKILL.md"))).resolves.toBeUndefined();
  });
});
