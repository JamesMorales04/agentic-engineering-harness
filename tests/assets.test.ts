import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { reconcileHarnessAssets } from "../src/core/assets.js";

async function sourceRoot(version: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `aeh-assets-source-${version}-`));
  await fs.mkdir(path.join(root, "skills", "engineering-workflow"), { recursive: true });
  await fs.mkdir(path.join(root, "policies", "core"), { recursive: true });
  await fs.writeFile(path.join(root, "skills", "engineering-workflow", "SKILL.md"), `skill ${version}\n`);
  await fs.writeFile(path.join(root, "policies", "core", "policy.rego"), `policy ${version}\n`);
  return root;
}

describe("managed Harness assets", () => {
  it("restores missing assets and upgrades untouched managed files", async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-assets-project-"));
    const v1 = await sourceRoot("v1");
    const first = await reconcileHarnessAssets(project, { packageRoot: v1, aehVersion: "0.6.0" });
    expect(first.created).toContain(".harness/skills/engineering-workflow/SKILL.md");
    expect(await fs.readFile(path.join(project, ".harness/skills/engineering-workflow/SKILL.md"), "utf8")).toBe("skill v1\n");

    await fs.rm(path.join(project, ".harness/policies/core/policy.rego"));
    const restored = await reconcileHarnessAssets(project, { packageRoot: v1, aehVersion: "0.6.0" });
    expect(restored.created).toContain(".harness/policies/core/policy.rego");

    const v2 = await sourceRoot("v2");
    const upgraded = await reconcileHarnessAssets(project, { packageRoot: v2, aehVersion: "0.6.1" });
    expect(upgraded.updated).toContain(".harness/skills/engineering-workflow/SKILL.md");
    expect(await fs.readFile(path.join(project, ".harness/skills/engineering-workflow/SKILL.md"), "utf8")).toBe("skill v2\n");

    const manifest = JSON.parse(await fs.readFile(path.join(project, ".harness/managed-assets.json"), "utf8")) as { aehVersion: string };
    expect(manifest.aehVersion).toBe("0.6.1");
  });

  it("preserves local overrides across package upgrades", async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-assets-override-"));
    const v1 = await sourceRoot("v1");
    await reconcileHarnessAssets(project, { packageRoot: v1, aehVersion: "0.6.0" });

    const skill = path.join(project, ".harness/skills/engineering-workflow/SKILL.md");
    await fs.writeFile(skill, "local override\n");
    const v2 = await sourceRoot("v2");
    const result = await reconcileHarnessAssets(project, { packageRoot: v2, aehVersion: "0.6.1" });

    expect(result.preservedOverrides).toContain(".harness/skills/engineering-workflow/SKILL.md");
    expect(await fs.readFile(skill, "utf8")).toBe("local override\n");
  });
});
