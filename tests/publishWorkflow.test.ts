import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
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
    const steps = workflow.jobs.publish.steps as Array<{ name?: string; run?: string; id?: string }>;
    const serialized = JSON.stringify(steps);
    expect(serialized).toContain("scripts/release-version.mjs");
    expect(serialized).toContain("npm version");
    expect(serialized).toContain("npm run release:check");
    // npm publish must NOT live in the prepare job: nothing public until verified.
    // (Prose may mention the pipeline; forbid the actual publish command/step.)
    expect(steps.some((step) => step.name === "Publish to npm")).toBe(false);
    expect(steps.some((step) => (step.run ?? "").includes("npm publish --provenance"))).toBe(false);
    expect(JSON.stringify(workflow.jobs)).toContain("gh release create");
    const synchronizeIndex = steps.findIndex((step) => step.name === "Synchronize package metadata");
    const validationIndex = steps.findIndex((step) => step.name === "Validate release candidate");
    const commitIndex = steps.findIndex((step) => step.name === "Commit version");
    expect(steps[validationIndex]?.run).toBe("npm run release:check");
    expect(synchronizeIndex).toBeLessThan(validationIndex);
    expect(validationIndex).toBeLessThan(commitIndex);

    // (a) TAG-AFTER-VERIFY: prepare exposes the release SHA and creates NO tag.
    // Tag creation lives after verification (publish-npm), so `git tag` must be
    // absent from the publish job entirely.
    expect(JSON.stringify(workflow.jobs.publish.outputs ?? {})).toMatch(/release_sha/);
    const commitStep = steps.find((step) => step.name === "Commit version");
    expect(commitStep).toBeDefined();
    expect(commitStep?.id).toBe("release-commit");
    const commitSerialized = JSON.stringify(commitStep);
    expect(commitSerialized).toMatch(/RELEASE_SHA/);
    expect(commitSerialized).toContain("release_sha=");
    expect(JSON.stringify(steps)).not.toContain("git tag");
    // No tag-delete recovery anywhere: no tag exists before verify, so there is
    // nothing to delete and no conditional delete by name.
    expect(text).not.toContain("push --delete");

    // GITHUB_TOKEN pushes do not trigger push workflows, so the GitHub
    // Release must be gated by in-workflow verification of the release bits.
    const entries = Object.entries(workflow.jobs as Record<string, any>) as Array<[string, any]>;
    const verifyEntry = entries.find(([name]) => /verify/i.test(name));
    expect(verifyEntry).toBeDefined();
    const [verifyName, verifyJob] = verifyEntry! as [string, any];
    const verifyNeeds = Array.isArray(verifyJob.needs) ? verifyJob.needs : [verifyJob.needs];
    expect(verifyNeeds).toContain("publish");
    // (a) verify checks out the release COMMIT SHA directly (never a tag name).
    const verifySerialized = JSON.stringify(verifyJob.steps ?? verifyJob);
    expect(verifySerialized).toMatch(/needs\.publish\.outputs\.release_sha/);
    expect(verifySerialized).toContain("git rev-parse HEAD");
    expect(verifySerialized).toContain("git fetch origin");
    expect(verifySerialized).toContain("checkout --detach");
    expect(verifySerialized).not.toContain("tags/v");
    expect(verifySerialized).not.toContain("push --delete");
    expect(verifySerialized).not.toContain("git tag");

    // (b) PUBLISH-BEFORE-VERIFY is forbidden: the job containing `npm publish`
    // must need the verify job, so consumer verification runs before anything public.
    const publishers = entries.filter(([, job]) => {
      const steps = (job.steps ?? []) as Array<{ name?: string; run?: string }>;
      return steps.some(
        (step) => step.name === "Publish to npm" || (step.run ?? "").includes("npm publish --provenance"),
      );
    });
    expect(publishers.length).toBeGreaterThan(0);
    for (const [, job] of publishers) {
      const needs = Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [];
      expect(needs).toContain(verifyName);
    }
    // The post-verify publisher confirms the version landed on npm.
    const publisherWithView = publishers.find(([, job]) =>
      JSON.stringify(job.steps ?? job).includes("npm view"),
    );
    expect(publisherWithView).toBeDefined();

    // The gated release job (not a repair step) must need verification.
    const gatedRelease = (Object.entries(workflow.jobs as Record<string, any>) as Array<[string, any]>)
      .filter(([, job]) => JSON.stringify(job).includes("gh release create"))
      .find(([, job]) => {
        const needs = Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [];
        return needs.includes(verifyName);
      });
    expect(gatedRelease).toBeDefined();
    expect(JSON.stringify(gatedRelease![1])).toContain("--verify-tag");
    // Release runs only after the gated publisher: needs verify + publisher.
    const publisherNames = publishers.map(([name]) => name);
    const gatedNeeds = Array.isArray(gatedRelease![1].needs)
      ? gatedRelease![1].needs
      : gatedRelease![1].needs
        ? [gatedRelease![1].needs]
        : [];
    expect(gatedNeeds).toContain(verifyName);
    expect(publisherNames.some((name) => gatedNeeds.includes(name))).toBe(true);
    // Verification-skipped repair Release must be impossible: no `gh release create` in prepare.
    expect(steps.some((step) => (step.run ?? "").includes("gh release create"))).toBe(false);
    const releasers = entries.filter(([, job]) => JSON.stringify(job).includes("gh release create"));
    expect(releasers.length).toBeGreaterThan(0);
    for (const [, job] of releasers) {
      const needs = Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [];
      expect(needs).toContain(verifyName);
    }
    await expect(fs.access(new URL("../.github/workflows/release.yml", import.meta.url))).rejects.toThrow();
  });

  it("creates the version tag only after verification, bound to release_sha", async () => {
    const text = await fs.readFile(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
    const workflow = parse(text) as Record<string, any>;
    const jobs = workflow.jobs as Record<string, any>;
    const entries = Object.entries(jobs) as Array<[string, any]>;
    const verifyEntry = entries.find(([name]) => /verify/i.test(name));
    expect(verifyEntry).toBeDefined();
    const [verifyName] = verifyEntry!;
    // (i) publish job MUST NOT contain tag creation.
    const publishSerialized = JSON.stringify(jobs.publish.steps ?? jobs.publish);
    expect(publishSerialized).not.toContain("git tag");
    // (ii) verify-published MUST check out by SHA (never a tag name).
    const verifyJob = jobs["verify-published"];
    expect(verifyJob).toBeDefined();
    const verifySerialized = JSON.stringify(verifyJob.steps ?? verifyJob);
    expect(verifySerialized).toMatch(/needs\.publish\.outputs\.release_sha/);
    expect(verifySerialized).toContain("git fetch origin");
    expect(verifySerialized).toContain("checkout --detach");
    expect(verifySerialized).toContain("git rev-parse HEAD");
    expect(verifySerialized).not.toContain("tags/v");
    expect(verifySerialized).not.toContain("git tag");
    // No verify-failure tag delete: no tag exists at verify time, so the
    // check-then-delete-by-name race disappears by construction.
    expect(verifySerialized).not.toContain("failure()");
    expect(verifySerialized).not.toContain("push --delete");
    expect(text).not.toContain("push --delete");
    // (iii) tag creation MUST live in a job needing verify, with absent-only semantics.
    const taggers = entries.filter(([, job]) =>
      JSON.stringify(job.steps ?? job).includes("git tag"),
    );
    expect(taggers.length).toBeGreaterThan(0);
    for (const [, job] of taggers) {
      const needs = Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [];
      expect(needs).toContain(verifyName);
    }
    const taggerSerialized = taggers.map(([, job]) => JSON.stringify(job.steps ?? job)).join("\n");
    expect(taggerSerialized).toContain("ls-remote");
    expect(taggerSerialized).toMatch(/TAG_SHA/);
    expect(taggerSerialized).toMatch(/RELEASE_SHA/);
    expect(taggerSerialized).toMatch(/refusing.*stale|stale.*refus/i);
    expect(taggerSerialized).not.toMatch(/git tag -f|tag --force/);
    // The gated publisher owns the post-verify tag.
    const publisher = jobs["publish-npm"];
    expect(publisher).toBeDefined();
    const pubNeeds = Array.isArray(publisher.needs) ? publisher.needs : [publisher.needs];
    expect(pubNeeds).toContain(verifyName);
    expect(JSON.stringify(publisher.steps ?? publisher)).toContain("git tag");
    // (iv) TAG-DRIFT: release + publisher checkouts assert HEAD == release_sha AND tag == release_sha.
    const releaseJob = jobs.release;
    expect(releaseJob).toBeDefined();
    const releaseSerialized = JSON.stringify(releaseJob.steps ?? releaseJob);
    expect(releaseSerialized).toMatch(/needs\.publish\.outputs\.release_sha/);
    expect(releaseSerialized).toContain("git rev-parse HEAD");
    expect(releaseSerialized).toContain("rev-list");
    const pubSerialized = JSON.stringify(publisher.steps ?? publisher);
    expect(pubSerialized).toMatch(/needs\.publish\.outputs\.release_sha/);
    expect(pubSerialized).toContain("git rev-parse HEAD");
    expect(pubSerialized).toContain("rev-list");
  });

  it("configures a stable bot git identity before every commit/tag write", async () => {
    const text = await fs.readFile(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
    const workflow = parse(text) as Record<string, any>;
    const jobs = workflow.jobs as Record<string, any>;
    const BOT_NAME = "github-actions[bot]";
    const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";
    // The bot identity must be present somewhere (no personal identity).
    expect(text).toContain(BOT_NAME);
    expect(text).toContain(BOT_EMAIL);
    expect(text).not.toMatch(/jamesmoralesmoreno@gmail\.com/);
    const hasIdentityConfig = (block: string): boolean =>
      (block.includes("git config user.name") && block.includes("git config user.email")) ||
      (block.includes("GIT_AUTHOR_NAME") && block.includes("GIT_AUTHOR_EMAIL")) ||
      (block.includes("GIT_COMMITTER_NAME") && block.includes("GIT_COMMITTER_EMAIL"));
    const writesGitIdentity = (run: string): boolean =>
      /git commit\b/.test(run) || /git tag\b.*-[am]/.test(run) || /git tag -a/.test(run);
    for (const [jobName, job] of Object.entries(jobs) as Array<[string, any]>) {
      const steps = (job.steps ?? []) as Array<{ name?: string; run?: string; env?: Record<string, string> }>;
      const jobEnv = JSON.stringify(job.env ?? {});
      for (let i = 0; i < steps.length; i += 1) {
        const run = steps[i].run ?? "";
        if (!writesGitIdentity(run)) continue;
        // Identity must be configured in the SAME run block, in a PRECEDING
        // step of the same job, or via job/step-level env.
        const sameBlock = hasIdentityConfig(run);
        const preceding = steps.slice(0, i).some((s) => hasIdentityConfig(s.run ?? ""));
        const stepEnv = JSON.stringify(steps[i].env ?? {});
        const envCovered = hasIdentityConfig(`${jobEnv} ${stepEnv}`);
        expect(
          sameBlock || preceding || envCovered,
          `job '${jobName}' step '${steps[i].name ?? i}' runs '${run.split("\n").find((l) => l.includes("git commit") || l.includes("git tag"))?.trim()}' without a preceding in-job git identity (git config user.* or GIT_AUTHOR_*/GIT_COMMITTER_* env)`,
        ).toBe(true);
      }
    }
    // At least both write sites must exist (commit in publish, annotated tag in publish-npm).
    expect(JSON.stringify(jobs.publish)).toMatch(/git commit/);
    expect(JSON.stringify(jobs["publish-npm"])).toMatch(/git tag -a/);
  });

  it("bot identity setup makes commit and annotated tag succeed with empty global config", async () => {
    const text = await fs.readFile(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
    expect(text).toContain("github-actions[bot]");
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-ident-"));
    const emptyGlobal = path.join(tmp, "empty-global-config");
    await fs.writeFile(emptyGlobal, "");
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    env.GIT_CONFIG_GLOBAL = emptyGlobal;
    env.GIT_CONFIG_SYSTEM = emptyGlobal;
    delete env.GIT_AUTHOR_NAME;
    delete env.GIT_AUTHOR_EMAIL;
    delete env.GIT_COMMITTER_NAME;
    delete env.GIT_COMMITTER_EMAIL;
    const git = (args: string[], cwd = tmp): string =>
      execFileSync("git", args, { cwd, encoding: "utf8", env });
    git(["init", "-q"]);
    git(["config", "--local", "--list"]);
    await fs.writeFile(path.join(tmp, "probe.txt"), "identity\n");
    git(["add", "probe.txt"]);
    // Without identity, commit must fail (proves the gate is real).
    expect(() => git(["commit", "-m", "probe"])).toThrow();
    // Workflow's bot identity setup (mirrors publish.yml git config lines).
    git(["config", "user.name", "github-actions[bot]"]);
    git(["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
    git(["commit", "-m", "probe"]);
    expect(git(["log", "--format=%an <%ae>", "-1"]).trim()).toBe(
      "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
    );
    // Annotated tags need the same tagger identity (fatal: empty ident name without it).
    git(["tag", "-a", "v9.9.9-test", "-m", "v9.9.9-test"]);
    expect(git(["tag", "-l", "v9.9.9-test"]).trim()).toBe("v9.9.9-test");
    await fs.rm(tmp, { recursive: true, force: true });
  });
});
