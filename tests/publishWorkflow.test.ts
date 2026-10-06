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
    const steps = workflow.jobs.publish.steps as Array<{ name?: string; run?: string }>;
    const serialized = JSON.stringify(steps);
    expect(serialized).toContain("scripts/release-version.mjs");
    expect(serialized).toContain("npm version");
    expect(serialized).toContain("npm run release:check");
    expect(serialized).toContain("npm publish");
    expect(JSON.stringify(workflow.jobs)).toContain("gh release create");
    const synchronizeIndex = steps.findIndex((step) => step.name === "Synchronize package metadata");
    const validationIndex = steps.findIndex((step) => step.name === "Validate release candidate");
    const commitIndex = steps.findIndex((step) => step.name === "Commit version and create tag");
    const publishIndex = steps.findIndex((step) => step.name === "Publish to npm");
    expect(steps[validationIndex]?.run).toBe("npm run release:check");
    expect(synchronizeIndex).toBeLessThan(validationIndex);
    expect(validationIndex).toBeLessThan(commitIndex);
    expect(commitIndex).toBeLessThan(publishIndex);
    // GITHUB_TOKEN pushes do not trigger push workflows, so the GitHub
    // Release must be gated by in-workflow verification of the published bits.
    const verifyEntry = Object.entries(workflow.jobs as Record<string, any>).find(([name]) =>
      /verify/i.test(name),
    );
    expect(verifyEntry).toBeDefined();
    const [verifyName, verifyJob] = verifyEntry! as [string, any];
    const verifyNeeds = Array.isArray(verifyJob.needs) ? verifyJob.needs : [verifyJob.needs];
    expect(verifyNeeds).toContain("publish");
    const releaseEntry = Object.entries(workflow.jobs as Record<string, any>).find(([, job]) =>
      JSON.stringify(job).includes("gh release create"),
    );
    // The gated release job (not the legacy repair step) must need verification.
    const gatedRelease = (Object.entries(workflow.jobs as Record<string, any>) as Array<[string, any]>)
      .filter(([, job]) => JSON.stringify(job).includes("gh release create"))
      .find(([, job]) => {
        const needs = Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [];
        return needs.includes(verifyName);
      });
    expect(gatedRelease).toBeDefined();
    expect(JSON.stringify(gatedRelease![1])).toContain("--verify-tag");
    expect(releaseEntry).toBeDefined();
    await expect(fs.access(new URL("../.github/workflows/release.yml", import.meta.url))).rejects.toThrow();
  });
});
