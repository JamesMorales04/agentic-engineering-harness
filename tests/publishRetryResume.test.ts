import fs from "node:fs/promises";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// Retry-resume regression: same-version retry must resume at the first
// incomplete step (never move tags, never skip verify).
describe("publish retry resume (idempotent same-SHA)", () => {
  it("(i) existing tag at same SHA resumes instead of refusing", async () => {
    const text = await fs.readFile(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
    const workflow = parse(text) as Record<string, any>;
    const publisher = (workflow.jobs as Record<string, any>)["publish-npm"];
    expect(publisher).toBeDefined();
    const serialized = JSON.stringify(publisher.steps ?? publisher);
    // Must distinguish same-SHA resume from elsewhere refusal.
    expect(serialized).toMatch(/already points at|resum.*idempotent/i);
    expect(serialized).toMatch(/PEELED_SHA|peeled/i);
    // Still refuses stale tags loudly, never force-moves.
    expect(serialized).toMatch(/refusing.*stale|stale.*refus/i);
    expect(serialized).not.toMatch(/git tag -f|tag --force/);
  });

  it("(ii) npm-view-present skips publish idempotently", async () => {
    const text = await fs.readFile(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
    const workflow = parse(text) as Record<string, any>;
    const publisher = (workflow.jobs as Record<string, any>)["publish-npm"];
    expect(publisher).toBeDefined();
    const steps = publisher.steps as Array<{ name?: string; run?: string }>;
    const pubStep = steps.find((step) => (step.run ?? "").includes("npm publish --provenance"));
    expect(pubStep).toBeDefined();
    expect(pubStep!.run).toContain("npm view");
    expect(pubStep!.run).toMatch(/skipping publish|already on npm/i);
  });

  it("(iii) repair in published-but-unreleased state reaches SHA-bound Release", async () => {
    const text = await fs.readFile(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
    const workflow = parse(text) as Record<string, any>;
    const jobs = workflow.jobs as Record<string, any>;
    const entries = Object.entries(jobs) as Array<[string, any]>;
    const verifyName = Object.keys(jobs).find((name) => /verify/i.test(name));
    expect(verifyName).toBeDefined();
    const releasers = entries.filter(([, job]) => JSON.stringify(job).includes("gh release create"));
    // Normal gated release + dedicated repair Release path.
    expect(releasers.length).toBeGreaterThan(1);
    const repair = releasers.find(([name]) => /repair/i.test(name));
    expect(repair).toBeDefined();
    const [, repairJob] = repair!;
    const needs = Array.isArray(repairJob.needs) ? repairJob.needs : repairJob.needs ? [repairJob.needs] : [];
    expect(needs).toContain(verifyName);
    const serialized = JSON.stringify(repairJob);
    expect(serialized).toContain("--verify-tag");
    expect(serialized).toContain("npm view");
    expect(serialized).toMatch(/TAG_SHA|rev-list/);
    // Publish-job repair gate must still refuse non-eligible states but allow eligible.
    const publishSteps = jobs.publish.steps as Array<{ name?: string; run?: string }>;
    const gate = publishSteps.find((step) => step.name === "Repair missing GitHub Release for current version");
    expect(gate).toBeDefined();
    expect(gate!.run).toContain("npm view");
    expect(gate!.run).toContain("ls-remote");
    expect(gate!.run).toMatch(/Refusing|exit 1/);
  });
});
