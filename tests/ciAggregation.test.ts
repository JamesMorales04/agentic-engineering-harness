import fs from "node:fs/promises";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// K-NEW-1: every release commit carried `[skip ci]`, so ci.yml never ran on
// the exact published bits. K-NEW-6 (sibling): no all-green aggregator and
// evidence uploads used `if-no-files-found: ignore`.
const REQUIRED_CI_JOBS = [
  "test",
  "packaged-consumer",
  "scenario-matrix",
  "adversarial-system",
  "human-e2e",
  "system-reliability",
  "rootless-isolation",
  "full-stack-contract",
  "provider-contracts",
  "supply-chain",
  "validation-contracts",
  "contract-testing",
  "integration-environment",
];

describe("release CI gating (K-NEW-1 / K-NEW-6)", () => {
  it("release commit message contains no [skip ci]", async () => {
    const text = await fs.readFile(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
    const workflow = parse(text) as Record<string, any>;
    const steps = workflow.jobs.publish.steps as Array<{ name?: string; run?: string }>;
    const commitStep = steps.find((step) => step.name === "Commit version and create tag");
    expect(commitStep).toBeDefined();
    expect(commitStep?.run).not.toContain("[skip ci]");
    expect(text).not.toContain("[skip ci]");
  });

  it("ci.yml has an all-green aggregator over every job with fail-on-any", async () => {
    const text = await fs.readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const workflow = parse(text) as Record<string, any>;
    const allGreen = workflow.jobs["all-green"] as
      | { if?: string; needs?: string[]; steps?: Array<unknown> }
      | undefined;
    expect(allGreen).toBeDefined();
    expect(allGreen?.if).toContain("always()");
    for (const job of REQUIRED_CI_JOBS) {
      expect(allGreen?.needs).toContain(job);
    }
    expect(allGreen?.needs).toHaveLength(REQUIRED_CI_JOBS.length);
    expect(JSON.stringify(allGreen)).toContain("failure");
  });

  it("evidence uploads fail loudly on missing files (no ignore)", async () => {
    const text = await fs.readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    expect(text).not.toContain("if-no-files-found: ignore");
    const values = [...text.matchAll(/if-no-files-found:\s*(\S+)/g)].map((match) => match[1]);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value).toBe("error");
    }
  });

  it("publish.yml verifies the tag before npm publish and gates the GitHub Release", async () => {
    const text = await fs.readFile(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
    const workflow = parse(text) as Record<string, any>;
    const jobs = workflow.jobs as Record<string, any>;
    const entries = Object.entries(jobs);
    const verifyEntry = entries.find(([name]) => /verify/i.test(name));
    expect(verifyEntry).toBeDefined();
    const [verifyName, verifyJob] = verifyEntry!;
    const verifyNeeds = Array.isArray(verifyJob.needs) ? verifyJob.needs : verifyJob.needs ? [verifyJob.needs] : [];
    expect(verifyNeeds).toContain("publish");
    const verifySerialized = JSON.stringify(verifyJob.steps ?? verifyJob);
    // Pre-publish tag verification: SHA equality against the prepare release SHA
    // plus the packaged-consumer contracts (no npm view here: nothing is public yet).
    expect(verifySerialized).toMatch(/needs\.publish\.outputs\.release_sha/);
    expect(verifySerialized).toContain("exact-match");
    expect(verifySerialized).toContain("toolchain compile");
    expect(verifySerialized).toContain("policy sync");
    expect(verifySerialized).toContain("test:packaged-consumer");
    // The prepare job exposes the release SHA and refuses stale tags without force-moving.
    expect(JSON.stringify(jobs.publish.outputs ?? {})).toMatch(/release_sha/);
    const prepareSerialized = JSON.stringify(jobs.publish.steps);
    expect(prepareSerialized).toMatch(/TAG_SHA/);
    expect(prepareSerialized).toMatch(/refusing.*stale|stale.*refus/i);
    const prepareSteps = jobs.publish.steps as Array<{ name?: string; run?: string }>;
    expect(prepareSteps.some((step) => step.name === "Publish to npm")).toBe(false);
    expect(prepareSteps.some((step) => (step.run ?? "").includes("npm publish --provenance"))).toBe(false);
    expect(prepareSteps.some((step) => (step.run ?? "").includes("gh release create"))).toBe(false);
    // npm publish runs only after verification: its job must need the verify job.
    const publishers = entries.filter(([, job]) => {
      const steps = ((job as any).steps ?? []) as Array<{ name?: string; run?: string }>;
      return steps.some(
        (step) => step.name === "Publish to npm" || (step.run ?? "").includes("npm publish --provenance"),
      );
    });
    expect(publishers.length).toBeGreaterThan(0);
    for (const [, job] of publishers) {
      const needs = Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [];
      expect(needs).toContain(verifyName);
    }
    // Post-publish confirmation lives in the gated publisher, not the pre-publish verifier.
    const publisherSerialized = publishers.map(([, job]) => JSON.stringify(job.steps ?? job)).join("\n");
    expect(publisherSerialized).toContain("npm view");
    const releaseCandidates = entries.filter(([, job]) => JSON.stringify(job).includes("gh release create"));
    expect(releaseCandidates.length).toBeGreaterThan(0);
    const releaseEntry = releaseCandidates.find(([, job]) => {
      const needs = Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [];
      return needs.includes(verifyName);
    });
    expect(releaseEntry).toBeDefined();
    const [releaseName, releaseJob] = releaseEntry!;
    expect(releaseName).not.toBe("publish");
    const releaseNeeds = Array.isArray(releaseJob.needs)
      ? releaseJob.needs
      : releaseJob.needs
        ? [releaseJob.needs]
        : [];
    expect(releaseNeeds).toContain(verifyName);
    // Release runs only after the gated publisher.
    const publisherNames = publishers.map(([name]) => name as string);
    expect(publisherNames.some((name) => releaseNeeds.includes(name))).toBe(true);
    // Every Release path is verification-gated: no verification-skipped repair Release.
    for (const [, job] of releaseCandidates) {
      const needs = Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [];
      expect(needs).toContain(verifyName);
    }
  });

  it("docs/PUBLISHING.md no longer documents [skip ci]", async () => {
    const text = await fs.readFile(new URL("../docs/PUBLISHING.md", import.meta.url), "utf8");
    expect(text).not.toContain("[skip ci]");
  });

  it("release checkout is SHA-bound and verify failure cleans up its own tag", async () => {
    const text = await fs.readFile(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
    const workflow = parse(text) as Record<string, any>;
    const jobs = workflow.jobs as Record<string, any>;
    // (a) TAG-DRIFT: gated release asserts HEAD == release_sha AND tag == release_sha.
    const releaseSerialized = JSON.stringify(jobs.release?.steps ?? jobs.release);
    expect(releaseSerialized).toMatch(/needs\.publish\.outputs\.release_sha/);
    expect(releaseSerialized).toContain("git rev-parse HEAD");
    expect(releaseSerialized).toContain("rev-list");
    // (b) RECOVERY: verify failure deletes only the just-created tag (SHA-guarded).
    const verifySerialized = JSON.stringify(jobs["verify-published"]?.steps ?? jobs["verify-published"]);
    expect(verifySerialized).toContain("failure()");
    expect(verifySerialized).toContain("push --delete");
    expect(verifySerialized).toMatch(/TAG_SHA/);
    expect(verifySerialized).toMatch(/RELEASE_SHA/);
    expect(verifySerialized).toMatch(/refusing.*delete|did not create/i);
  });
});
