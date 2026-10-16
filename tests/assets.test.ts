import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { reconcileHarnessAssets } from "../src/core/assets.js";
import { generatedArtifactPaths, getChangedFiles } from "../src/core/git.js";
import type { HarnessProjectConfig } from "../src/core/types.js";

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

  it("leaves the manifest byte-identical on a no-op reconcile (D8 mtime hygiene)", async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-assets-idempotent-"));
    const v1 = await sourceRoot("v1");
    await reconcileHarnessAssets(project, { packageRoot: v1, aehVersion: "0.6.0" });
    const manifestFile = path.join(project, ".harness/managed-assets.json");
    const before = await fs.readFile(manifestFile, "utf8");
    // Pin mtime to the past: a no-op reconcile must not rewrite (mtime is the
    // observable; byte comparison alone would pass even with a rewrite).
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(manifestFile, past, past);
    const beforeStat = await fs.stat(manifestFile);
    const second = await reconcileHarnessAssets(project, { packageRoot: v1, aehVersion: "0.6.0" });
    expect(second.created).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.removed).toEqual([]);
    expect(await fs.readFile(manifestFile, "utf8")).toBe(before);
    expect((await fs.stat(manifestFile)).mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it("excludes the provisioned managed-asset manifest from validation changed files (D8)", async () => {
    const config = { version: 1, project: { name: "d8" } } as unknown as HarnessProjectConfig;
    expect(generatedArtifactPaths(config)).toContain(".harness/managed-assets.json");

    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-assets-changedfiles-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
    await fs.mkdir(path.join(repo, ".harness"), { recursive: true });
    await fs.writeFile(path.join(repo, ".harness/managed-assets.json"), '{}\n');
    await fs.writeFile(path.join(repo, "src-util.js"), "v1\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], { cwd: repo });
    // Provision-style rewrite (version stamp churn) plus a genuine source edit.
    await fs.writeFile(path.join(repo, ".harness/managed-assets.json"), '{"version":1}\n');
    await fs.writeFile(path.join(repo, "src-util.js"), "v2\n");
    const changed = await getChangedFiles(repo, "HEAD", { ignoredPaths: generatedArtifactPaths(config) });
    expect(changed).toEqual(["src-util.js"]);
  });
});
