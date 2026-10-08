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
    // COMPLETE identity only: `git commit` needs author + committer, and
    // annotated tags need the tagger (same bot). Half-identity (author-pair
    // OR committer-pair alone) is insufficient at runtime.
    const hasConfigPair = (block: string): boolean =>
      block.includes("git config user.name") && block.includes("git config user.email");
    const hasAuthorEnv = (block: string): boolean =>
      block.includes("GIT_AUTHOR_NAME") && block.includes("GIT_AUTHOR_EMAIL");
    const hasCommitterEnv = (block: string): boolean =>
      block.includes("GIT_COMMITTER_NAME") && block.includes("GIT_COMMITTER_EMAIL");
    const hasCompleteIdentity = (block: string): boolean =>
      hasConfigPair(block) || (hasAuthorEnv(block) && hasCommitterEnv(block));
    // HISTORICAL negative control (pre-fix predicate, kept inline so the
    // committed artifact self-proves discrimination): author-pair OR
    // committer-pair alone counted as complete — i.e. half-identity
    // would-have-accepted. New predicate requires BOTH pairs.
    const hasCompleteIdentityHistorical = (block: string): boolean =>
      hasConfigPair(block) || hasAuthorEnv(block) || hasCommitterEnv(block);
    const writesGitIdentity = (run: string): boolean =>
      /git commit\b/.test(run) || /git tag\b.*-[am]/.test(run) || /git tag -a/.test(run);
    for (const [jobName, job] of Object.entries(jobs) as Array<[string, any]>) {
      const steps = (job.steps ?? []) as Array<{ name?: string; run?: string; env?: Record<string, string> }>;
      const jobEnv = JSON.stringify(job.env ?? {});
      for (let i = 0; i < steps.length; i += 1) {
        const run = steps[i].run ?? "";
        if (!writesGitIdentity(run)) continue;
        // Identity must be configured in the SAME run block, in a PRECEDING
        // step of the same job, or via job/step-level env — and it must be
        // COMPLETE (config pair OR all four GIT_* env vars).
        const sameBlock = hasCompleteIdentity(run);
        const preceding = steps.slice(0, i).some((s) => hasCompleteIdentity(s.run ?? ""));
        const stepEnv = JSON.stringify(steps[i].env ?? {});
        const envCovered = hasCompleteIdentity(`${jobEnv} ${stepEnv}`);
        expect(
          sameBlock || preceding || envCovered,
          `job '${jobName}' step '${steps[i].name ?? i}' runs '${run.split("\n").find((l) => l.includes("git commit") || l.includes("git tag"))?.trim()}' without COMPLETE git identity (git config user.name+email or all four GIT_AUTHOR_*/GIT_COMMITTER_* env vars)`,
        ).toBe(true);
      }
    }
    // Negative controls (inline weakened fixtures, not a workflow change):
    // half-identity env must NOT count as complete — this is the gap the
    // previous author-pair-OR-committer-pair predicate missed.
    const authorOnly =
      "GIT_AUTHOR_NAME=github-actions[bot]\nGIT_AUTHOR_EMAIL=41898282+github-actions[bot]@users.noreply.github.com";
    const committerOnly =
      "GIT_COMMITTER_NAME=github-actions[bot]\nGIT_COMMITTER_EMAIL=41898282+github-actions[bot]@users.noreply.github.com";
    const completeEnv = `${authorOnly}\n${committerOnly}`;
    expect(hasCompleteIdentity(authorOnly)).toBe(false);
    expect(hasCompleteIdentity(committerOnly)).toBe(false);
    // HISTORICAL would-have-accepted: old predicate accepted each half alone.
    expect(hasCompleteIdentityHistorical(authorOnly)).toBe(true);
    expect(hasCompleteIdentityHistorical(committerOnly)).toBe(true);
    expect(hasCompleteIdentity(completeEnv)).toBe(true);
    expect(
      hasCompleteIdentity(
        'git config user.name "github-actions[bot]"\ngit config user.email "41898282+github-actions[bot]@users.noreply.github.com"',
      ),
    ).toBe(true);
    // Weakened job-env fixture (author pair only) must be rejected; full job env accepted.
    // HISTORICAL would-have-accepted the weakened job-env fixture too.
    expect(
      hasCompleteIdentityHistorical(JSON.stringify({ GIT_AUTHOR_NAME: BOT_NAME, GIT_AUTHOR_EMAIL: BOT_EMAIL })),
    ).toBe(true);
    expect(
      hasCompleteIdentity(JSON.stringify({ GIT_AUTHOR_NAME: BOT_NAME, GIT_AUTHOR_EMAIL: BOT_EMAIL })),
    ).toBe(false);
    expect(
      hasCompleteIdentity(
        JSON.stringify({
          GIT_AUTHOR_NAME: BOT_NAME,
          GIT_AUTHOR_EMAIL: BOT_EMAIL,
          GIT_COMMITTER_NAME: BOT_NAME,
          GIT_COMMITTER_EMAIL: BOT_EMAIL,
        }),
      ),
    ).toBe(true);
    // At least both write sites must exist (commit in publish, annotated tag in publish-npm).
    expect(JSON.stringify(jobs.publish)).toMatch(/git commit/);
    expect(JSON.stringify(jobs["publish-npm"])).toMatch(/git tag -a/);
  });

  it("bot identity setup makes commit and annotated tag succeed with empty global config", async () => {
    const text = await fs.readFile(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
    expect(text).toContain("github-actions[bot]");
    const BOT_NAME = "github-actions[bot]";
    const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";
    const BOT_IDENT = `${BOT_NAME} <${BOT_EMAIL}>`;
    // GIT_* allowlist for spawned git: git reads MANY GIT_* vars
    // (GIT_CONFIG_COUNT / GIT_CONFIG_KEY_* / GIT_CONFIG_VALUE_* /
    // GIT_CONFIG_PARAMETERS, GIT_AUTHOR_* / GIT_COMMITTER_*, GIT_DIR,
    // GIT_WORK_TREE, GIT_CEILING_DIRECTORIES, ...). Copying process.env
    // while deleting only the 4 author/committer vars lets ambient
    // GIT_CONFIG_COUNT injection (or any other GIT_* injection) supply
    // identity and silently pass the no-identity control. Rule: strip
    // EVERY key starting with `GIT_` first, then re-add ONLY the intended
    // entries — GIT_CONFIG_GLOBAL/SYSTEM -> empty file (config isolation),
    // plus (botEnv only) the 4 author/committer vars. All non-GIT_*
    // (PATH, HOME, SYSTEMROOT, ...) pass through untouched.
    const stripAllGitEnv = (env: Record<string, string>): void => {
      for (const key of Object.keys(env)) {
        if (key.startsWith("GIT_")) delete env[key];
      }
    };
    // Config path (mirrors publish.yml git config lines).
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-ident-"));
    try {
      const emptyGlobal = path.join(tmp, "empty-global-config");
      await fs.writeFile(emptyGlobal, "");
      const env: Record<string, string> = { ...process.env } as Record<string, string>;
      stripAllGitEnv(env);
      env.GIT_CONFIG_GLOBAL = emptyGlobal;
      env.GIT_CONFIG_SYSTEM = emptyGlobal;
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
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
    // Env-only path: proves the job-level GIT_AUTHOR_*/GIT_COMMITTER_* env
    // path (no local config, empty global/system config, ONLY the four env
    // vars). Temp repo only, no push.
    const tmpEnv = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-ident-env-"));
    try {
      const emptyGlobalEnv = path.join(tmpEnv, "empty-global-config");
      await fs.writeFile(emptyGlobalEnv, "");
      const baseEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
      // Allowlist: strip EVERY ambient GIT_* (GIT_CONFIG_COUNT injection,
      // GIT_DIR / GIT_WORK_TREE / GIT_CEILING_DIRECTORIES confusion, stale
      // GIT_AUTHOR_*/GIT_COMMITTER_*, ...) so the no-identity control fails
      // deterministically regardless of ambient env; re-add only the empty
      // global/system isolation pointers. botEnv below adds back exactly the
      // 4 intended author/committer vars — nothing else GIT_*.
      stripAllGitEnv(baseEnv);
      baseEnv.GIT_CONFIG_GLOBAL = emptyGlobalEnv;
      baseEnv.GIT_CONFIG_SYSTEM = emptyGlobalEnv;
      const botEnv: Record<string, string> = {
        ...baseEnv,
        GIT_AUTHOR_NAME: BOT_NAME,
        GIT_AUTHOR_EMAIL: BOT_EMAIL,
        GIT_COMMITTER_NAME: BOT_NAME,
        GIT_COMMITTER_EMAIL: BOT_EMAIL,
      };
      const gitBase = (args: string[]): string =>
        execFileSync("git", args, { cwd: tmpEnv, encoding: "utf8", env: baseEnv });
      const gitBot = (args: string[]): string =>
        execFileSync("git", args, { cwd: tmpEnv, encoding: "utf8", env: botEnv });
      gitBase(["init", "-q"]);
      // No local identity configured (proves env-only, not config).
      expect(gitBase(["config", "--local", "--list"])).not.toContain("user.name");
      expect(gitBase(["config", "--local", "--list"])).not.toContain("user.email");
      await fs.writeFile(path.join(tmpEnv, "probe.txt"), "identity-env\n");
      gitBase(["add", "probe.txt"]);
      // Without any identity, commit must fail.
      expect(() => gitBase(["commit", "-m", "probe-env"])).toThrow();
      // With ONLY the four env vars, commit + annotated tag succeed with bot identity.
      gitBot(["commit", "-m", "probe-env"]);
      expect(gitBot(["log", "--format=%an <%ae> %cn <%ce>", "-1"]).trim()).toBe(`${BOT_IDENT} ${BOT_IDENT}`);
      // Still no local config — identity came from env alone.
      expect(gitBase(["config", "--local", "--list"])).not.toContain("user.name");
      gitBot(["tag", "-a", "v9.9.9-env-test", "-m", "v9.9.9-env-test"]);
      expect(gitBot(["tag", "-l", "v9.9.9-env-test"]).trim()).toBe("v9.9.9-env-test");
      expect(
        gitBot(["for-each-ref", "--format=%(taggername) %(taggeremail)", "refs/tags/v9.9.9-env-test"]).trim(),
      ).toBe(BOT_IDENT);
    } finally {
      await fs.rm(tmpEnv, { recursive: true, force: true });
    }
  });
});
