import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// Post-publish attestation propagation tolerance (incident run 37762308471):
// `npm publish` SUCCEEDED for 0.16.9, but the single immediate
// `npm view dist.integrity` query (~1s later) saw registry absence
// (propagation lag — npm says "may take a few minutes"), treated UNKNOWN
// absence as MISMATCH, failed the workflow, and attempted a nonsense
// deprecate ("No version found"). The published integrity LATER matched the
// sidecar exactly — pure false positive blocking the Release.
//
// Required behavior (post-publish attestation ONLY; everything else accepted):
//   (a) poll `npm view dist.integrity` with bounded backoff (up to ~10 min,
//       ~20s intervals) awaiting present-integrity or a stable answer;
//       Policy evidence (2026-10-08): 0.16.10's npm propagation tail exceeded
//       the old 300s deadline (>5min; 0.16.9 had failed the earlier immediate
//       check on ~1-2min lag before polling existed) — both published fine,
//       integrity later matched exactly — so
//       the production default is 600s/20s (query count ~30, same as the
//       old 300s/10s, CI cost sane).
//   (b) present + equal -> PASS; present + different -> PROVEN mismatch ->
//       deprecate (retry + runbook) + fail;
//   (c) persistently absent past deadline -> loud UNKNOWN failure WITHOUT
//       deprecate (nothing visible to deprecate; human triage — trace + runbook);
//   (d) NEVER treat absence as mismatch (regression pin: absent != mismatch).
// Repair-leg attestation is out of scope: already-published versions have no
// propagation window.
const REPO = path.resolve(import.meta.dirname, "..");
const WRONG_INTEGRITY =
  "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

async function loadPublishStep() {
  const text = await fs.readFile(path.join(REPO, ".github/workflows/publish.yml"), "utf8");
  const workflow = parse(text) as Record<string, any>;
  const steps = (workflow.jobs as Record<string, any>)["publish-npm"].steps as Array<{
    name?: string;
    run?: string;
  }>;
  const pubStep = steps.find((s) => (s.run ?? "").includes("npm publish"))!;
  return { text, run: pubStep.run! };
}

type StubOpts = {
  /** Number of post-publish dist.integrity queries that see E404 (lag). Infinity = persistently absent. */
  lagViews: number;
  /** Registry integrity once visible. Defaults to the retained tarball digest (match). */
  registryIntegrity?: string;
};

async function attestationFixture(opts: StubOpts) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-attest-prop-"));
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "aeh-test-pkg", version: "9.9.9" }));
  const pack = spawnSync("npm", ["pack", "--pack-destination", dir, "--silent"], { cwd: dir, encoding: "utf8" });
  if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`);
  const baseTgz = (await fs.readdir(dir)).find((f) => f.endsWith(".tgz"))!;
  const baseBytes = await fs.readFile(path.join(dir, baseTgz));
  const baseDigest = `sha512-${createHash("sha512").update(baseBytes).digest("base64")}`;
  const SHA = "c".repeat(40);
  const bin = path.join(dir, "stubbin");
  await fs.mkdir(bin);
  const publishCalled = path.join(dir, "publish-called");
  const viewCount = path.join(dir, "view-count");
  const visibleIntegrity = opts.registryIntegrity ?? baseDigest;
  // Stateful stub (no live publish, no live registry):
  //  - before `npm publish`: version is absent (E404 -> publish branch);
  //  - after publish: the first `lagViews` dist.integrity queries report E404
  //    (propagation lag), later queries report `visibleIntegrity`.
  // `npm deprecate` is recorded, never live.
  await fs.writeFile(
    path.join(bin, "npm"),
    `#!/bin/sh\n` +
      `PUBLISH_CALLED="${publishCalled}"\n` +
      `VIEW_COUNT="${viewCount}"\n` +
      `LAG_VIEWS="${Number.isFinite(opts.lagViews) ? opts.lagViews : 999999}"\n` +
      `VISIBLE_INTEGRITY="${visibleIntegrity}"\n` +
      `if [ "$1" = "view" ]; then\n` +
      `  if [ ! -f "$PUBLISH_CALLED" ]; then echo "npm error code E404" >&2; echo "npm error 404 Not Found" >&2; exit 1; fi\n` +
      `  if [ "$3" = "dist.integrity" ]; then\n` +
      `    COUNT="$(cat "$VIEW_COUNT" 2>/dev/null || echo 0)"; COUNT=$((COUNT + 1)); echo "$COUNT" > "$VIEW_COUNT"\n` +
      `    if [ "$COUNT" -le "$LAG_VIEWS" ]; then echo "npm error code E404" >&2; echo "npm error 404 Not Found - GET dist.integrity (propagation lag)" >&2; exit 1; fi\n` +
      `    echo "$VISIBLE_INTEGRITY"; exit 0\n` +
      `  fi\n` +
      `  if [ "$3" = "dist.shasum" ]; then\n` +
      `    COUNT="$(cat "$VIEW_COUNT" 2>/dev/null || echo 0)"\n` +
      `    if [ "$COUNT" -le "$LAG_VIEWS" ]; then echo "npm error code E404" >&2; echo "npm error 404 Not Found - GET dist.shasum" >&2; exit 1; fi\n` +
      `    echo ""; exit 1\n` +
      `  fi\n` +
      `  if [ "$3" = "version" ]; then\n` +
      `    COUNT="$(cat "$VIEW_COUNT" 2>/dev/null || echo 0)"\n` +
      `    if [ "$COUNT" -le "$LAG_VIEWS" ]; then echo "npm error code E404" >&2; echo "npm error 404 Not Found - GET version (propagation lag)" >&2; exit 1; fi\n` +
      `    echo "9.9.9"; exit 0\n` +
      `  fi\n` +
      `  exit 1\n` +
      `fi\n` +
      `if [ "$1" = "pack" ]; then DEST=""; PREV=""; for a in "$@"; do if [ "$PREV" = "--pack-destination" ]; then DEST="$a"; fi; PREV="$a"; done; cp "${path.join(dir, baseTgz)}" "$DEST/"; echo "${baseTgz}"; exit 0; fi\n` +
      `if [ "$1" = "publish" ]; then touch "$PUBLISH_CALLED"; echo "$@" > "$PUBLISH_CALLED.args"; exit 0; fi\n` +
      `if [ "$1" = "deprecate" ]; then touch "$PUBLISH_CALLED.deprecated"; echo "$@" > "$PUBLISH_CALLED.deprecated.args"; exit 0; fi\n` +
      `echo "stub: unsupported npm $*" >&2; exit 1\n`,
  );
  await fs.chmod(path.join(bin, "npm"), 0o755);
  await fs.symlink(path.join(REPO, "scripts"), path.join(dir, "scripts"));
  // Retained artifact as the retry path sees it: verified good tarball + sidecar.
  const retainDir = path.join(dir, "aeh-npm-retained");
  await fs.mkdir(retainDir);
  await fs.writeFile(path.join(retainDir, baseTgz), baseBytes);
  await fs.writeFile(
    path.join(retainDir, "npm-provenance.json"),
    JSON.stringify({ release_sha: SHA, tarball_sha512: baseDigest, name: "aeh-test-pkg", version: "9.9.9" }),
  );
  await fs.writeFile(path.join(retainDir, "npm-identity.digest"), `${baseDigest}\n`);
  const { run } = await loadPublishStep();
  const sh = path.join(dir, "publish-step.sh");
  await fs.writeFile(sh, `set -euo pipefail\n${run}\n`);
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    RUNNER_TEMP: dir,
    RELEASE_VERSION: "9.9.9",
    RELEASE_SHA: SHA,
    // Fast polling for the offline harness; production defaults (10 min / 20s)
    // apply when these are unset. Values must satisfy the round-2 bounds
    // (deadline 1..1800s, interval 5..120s) — invalid overrides fail loudly.
    AEH_ATTEST_DEADLINE_S: "15",
    AEH_ATTEST_INTERVAL_S: "5",
  } as NodeJS.ProcessEnv;
  const r = spawnSync("bash", [sh], { cwd: dir, env, encoding: "utf8" });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  let published = false;
  try {
    await fs.access(publishCalled);
    published = true;
  } catch {}
  let deprecated = false;
  try {
    await fs.access(`${publishCalled}.deprecated`);
    deprecated = true;
  } catch {}
  return { code: r.status ?? -1, out, published, deprecated, baseDigest };
}

describe("post-publish attestation propagation tolerance (incident 37762308471)", () => {
  it("static: attestation polls with bounded backoff and distinguishes absent from mismatch", async () => {
    const { text } = await loadPublishStep();
    expect(text, "polls the registry (bounded retries after publish)").toMatch(/ATTEST|poll|retry/i);
    expect(text, "documents the bound (e.g. up to 10 min, ~20s intervals)").toMatch(/10 min|600|INTERVAL|interval/i);
    expect(text, "distinguishes proven-mismatch deprecate from absent UNKNOWN").toMatch(/UNKNOWN/i);
  });

  it(
    "RED: transient absence right after publish (propagation lag) must attest PASS, never deprecate",
    { timeout: 60000 },
    async () => {
      // Registry is absent on the first post-publish query (~1s after publish,
      // the exact incident shape) but converges to the sidecar digest.
      const r = await attestationFixture({ lagViews: 1 });
      expect(r.published, "publish still happens").toBe(true);
      expect(r.code, `lag must be tolerated by polling, not failed (out: ${r.out})`).toBe(0);
      expect(r.deprecated, "lag is absence, never mismatch: must NOT deprecate").toBe(false);
      expect(r.out, "attestation success is traced").toMatch(/attestation verified/i);
    },
  );

  it(
    "persistently absent past the deadline fails LOUDLY as UNKNOWN WITHOUT deprecate (absent != mismatch)",
    { timeout: 60000 },
    async () => {
      const r = await attestationFixture({ lagViews: Number.POSITIVE_INFINITY });
      expect(r.published, "publish still happens").toBe(true);
      expect(r.code, "persistent absence must fail the workflow loudly").not.toBe(0);
      expect(r.deprecated, "absent != mismatch: nothing visible to deprecate").toBe(false);
      expect(r.out, "UNKNOWN is loud with triage guidance").toMatch(/unknown|propagation|triage/i);
      expect(r.out, "human triage runbook is printed").toMatch(/HUMAN TRIAGE REQUIRED/);
      expect(r.out, "trace records UNKNOWN without deprecate").toMatch(/result=UNKNOWN-no-deprecate/);
      expect(r.out, "absence is never labelled a proven mismatch").not.toMatch(/PROVEN mismatch|FAILED-deprecated/);
    },
  );

  it(
    "present + different stays a PROVEN mismatch: deprecate (retry + runbook) + fail",
    { timeout: 60000 },
    async () => {
      const r = await attestationFixture({ lagViews: 0, registryIntegrity: WRONG_INTEGRITY });
      expect(r.published, "swap reaches publish (recheck cannot close the handoff)").toBe(true);
      expect(r.code, "proven mismatch must fail loudly").not.toBe(0);
      expect(r.deprecated, "proven mismatch is deprecated to block installs").toBe(true);
      expect(r.out, "mismatch is loud").toMatch(/mismatch/i);
      expect(r.out, "trace records the decision").toMatch(/trace/i);
    },
  );
});
