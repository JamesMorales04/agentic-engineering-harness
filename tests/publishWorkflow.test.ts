import fs from "node:fs/promises";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

describe("automatic publish workflow", () => {
  it("publishes from main through one guarded OIDC-capable workflow", async () => {
    const text = await fs.readFile(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
    const workflow = parse(text) as Record<string, any>;
    expect(workflow.on.push.branches).toContain("main");
    expect(workflow.on.workflow_dispatch.inputs.bump.options).toEqual(["auto", "current", "patch", "minor", "major"]);
    expect(workflow.permissions).toEqual(expect.objectContaining({ contents: "write", "id-token": "write" }));
    expect(workflow.jobs.publish.if).toContain("AEH_AUTO_PUBLISH");
    const serialized = JSON.stringify(workflow.jobs.publish.steps);
    expect(serialized).toContain("scripts/release-version.mjs");
    expect(serialized).toContain("npm version");
    expect(serialized).toContain("npm run release:check");
    expect(serialized).toContain("npm publish");
    expect(serialized).toContain("gh release create");
    await expect(fs.access(new URL("../.github/workflows/release.yml", import.meta.url))).rejects.toThrow();
  });
});
