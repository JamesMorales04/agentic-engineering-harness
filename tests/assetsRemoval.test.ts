import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { reconcileHarnessAssets } from "../src/core/assets.js";

async function packageRoot(withRetiredSkill: boolean): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-assets-remove-source-"));
  await fs.mkdir(path.join(root, "skills", "active"), { recursive: true });
  await fs.writeFile(path.join(root, "skills", "active", "SKILL.md"), "active\n");
  if (withRetiredSkill) {
    await fs.mkdir(path.join(root, "skills", "retired"), { recursive: true });
    await fs.writeFile(path.join(root, "skills", "retired", "SKILL.md"), "retired\n");
  }
  return root;
}

describe("retired managed Harness assets", () => {
  it("removes an untouched retired asset but preserves a modified retired override", async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-assets-remove-project-"));
    const oldPackage = await packageRoot(true);
    await reconcileHarnessAssets(project, { packageRoot: oldPackage, aehVersion: "0.6.1" });

    const retired = path.join(project, ".harness/skills/retired/SKILL.md");
    const newPackage = await packageRoot(false);
    const removed = await reconcileHarnessAssets(project, { packageRoot: newPackage, aehVersion: "0.6.2" });
    expect(removed.removed).toContain(".harness/skills/retired/SKILL.md");
    await expect(fs.access(retired)).rejects.toThrow();

    await reconcileHarnessAssets(project, { packageRoot: oldPackage, aehVersion: "0.6.1" });
    await fs.writeFile(retired, "project override\n");
    const preserved = await reconcileHarnessAssets(project, { packageRoot: newPackage, aehVersion: "0.6.2" });
    expect(preserved.preservedOverrides).toContain(".harness/skills/retired/SKILL.md");
    expect(await fs.readFile(retired, "utf8")).toBe("project override\n");
  });
});
