import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// Round-2 RED: Luna rejected ru/attestation-propagation (ce30e0e) with 3 points.
// B1: deadline counter-based + overrides unbounded.
// B2: UNKNOWN conflates absent vs visible-unreadable.
const REPO = path.resolve(import.meta.dirname, "..");

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

type AttestOpts = {
  lagViews?: number;
  registryIntegrity?: string;
  // Hung-query stub: sleep S seconds on every post-publish view (simulates hung npm view).
  viewSleepS?: number;
  // Visible-unreadable stub: version visible, digests unreadable.
  visibleUnreadable?: boolean;
  deadlineS?: string;
  intervalS?: string;
  queryTimeoutS?: string;
};

async function attestRun(opts: AttestOpts) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-attest-r2-"));
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
  const lagViews = opts.lagViews ?? 999999;
  const visibleIntegrity = opts.registryIntegrity ?? baseDigest;
  const sleepS = opts.viewSleepS ?? 0;
  const mode = opts.visibleUnreadable ? "visible-unreadable" : "lag";
  await fs.writeFile(
    path.join(bin, "npm"),
    `#!/bin/sh\n` +
      `PUBLISH_CALLED="${publishCalled}"\n` +
      `VIEW_COUNT="${viewCount}"\n` +
      `LAG_VIEWS="${lagViews}"\n` +
      `VISIBLE_INTEGRITY="${visibleIntegrity}"\n` +
      `VIEW_SLEEP="${sleepS}"\n` +
      `MODE="${mode}"\n` +
      `if [ "$1" = "view" ]; then\n` +
      `  if [ ! -f "$PUBLISH_CALLED" ]; then echo "npm error code E404" >&2; echo "npm error 404 Not Found" >&2; exit 1; fi\n` +
      // Post-publish views: optional hang, then mode-specific answers.
      `  if [ "$VIEW_SLEEP" -gt 0 ] 2>/dev/null; then sleep "$VIEW_SLEEP"; fi\n` +
      `  if [ "$MODE" = "visible-unreadable" ]; then\n` +
      // dist.integrity + dist.shasum unreadable (empty failure), version visible.
      `    if [ "$3" = "dist.integrity" ]; then echo "npm error code E404" >&2; echo "npm error 404 Not Found - GET dist.integrity (digest missing)" >&2; exit 1; fi\n` +
      `    if [ "$3" = "dist.shasum" ]; then echo "npm error code E404" >&2; echo "npm error 404 Not Found - GET dist.shasum (digest missing)" >&2; exit 1; fi\n` +
      `    if [ "$3" = "version" ]; then echo "9.9.9"; exit 0; fi\n` +
      `    exit 1\n` +
      `  fi\n` +
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
    ...(opts.deadlineS !== undefined ? { AEH_ATTEST_DEADLINE_S: opts.deadlineS } : { AEH_ATTEST_DEADLINE_S: "10" }),
    ...(opts.intervalS !== undefined ? { AEH_ATTEST_INTERVAL_S: opts.intervalS } : { AEH_ATTEST_INTERVAL_S: "5" }),
    ...(opts.queryTimeoutS !== undefined ? { AEH_ATTEST_QUERY_TIMEOUT_S: opts.queryTimeoutS } : {}),
  } as NodeJS.ProcessEnv;
  const start = Date.now();
  const r = spawnSync("bash", [sh], { cwd: dir, env, encoding: "utf8", timeout: 55000 });
  const wallS = (Date.now() - start) / 1000;
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
  return { code: r.status ?? -1, out, published, deprecated, wallS, baseDigest };
}

describe("attestation round-2 (Luna rejection of ce30e0e)", () => {
  it("B1-static: wall-clock deadline (END epoch) + per-query timeout + bounded overrides", async () => {
    const { text } = await loadPublishStep();
    // Wall-clock: END epoch computed once from now + deadline, checked before each query.
    expect(text, "wall-clock deadline (END epoch via date +%s)").toMatch(/ATTEST_END|END.*date \+%s|date \+%s.*ATTEST/i);
    // Per-query timeout via `timeout ... npm view` (helper runs under timeout).
    expect(text, "per-query timeout via timeout (hung npm view cannot extend past deadline)").toMatch(/timeout\s+\S*60|timeout.*node scripts\/ci\/verify-npm-identity|ATTEST_QUERY_TIMEOUT/i);
    // Bounded overrides: deadline ≤30min (1800s), interval 5s–120s, invalid → loud fail.
    expect(text, "deadline bound ≤30min (1800s)").toMatch(/1800|30min/i);
    expect(text, "interval bounds documented").toMatch(/5\.\.120|5.*120/i);
    expect(text, "invalid override fails loudly (reject-invalid, fail-closed)").toMatch(/invalid.*override|Refusing.*attestation|must be integer/i);
  });

  it(
    "B1-dynamic: huge deadline override is rejected loudly (not accepted indefinitely)",
    { timeout: 60000 },
    async () => {
      // Absent registry + huge deadline: fixed code must fail FAST with invalid-override,
      // never poll indefinitely. Pre-fix code accepts any numeric deadline (RED).
      const r = await attestRun({ lagViews: 999999, deadlineS: "999999", intervalS: "5" });
      expect(r.published, "publish still happens before attestation").toBe(true);
      expect(r.code, "huge override must fail loudly").not.toBe(0);
      expect(r.out, "invalid override is explicit").toMatch(/invalid|must be integer|1\.\.1800|30min/i);
      expect(r.wallS, "reject-invalid must fail fast (not poll indefinitely)").toBeLessThan(20);
      expect(r.deprecated, "invalid config never deprecates").toBe(false);
    },
  );

  it(
    "B1-dynamic: hung npm view cannot extend past the wall-clock deadline (per-query timeout)",
    { timeout: 60000 },
    async () => {
      // Each post-publish view hangs 12s; deadline 10s, query timeout 2s (test override,
      // production default 60s). Fixed code kills each hung query after 2s and fails
      // at ~deadline; pre-fix counter-based code lets the hung query extend past it (RED).
      const r = await attestRun({ lagViews: 999999, viewSleepS: 12, deadlineS: "10", intervalS: "5", queryTimeoutS: "2" });
      expect(r.published).toBe(true);
      expect(r.code, "hung registry must still fail loudly (UNKNOWN, no silent pass)").not.toBe(0);
      expect(r.out, "hung query surfaces as timeout/UNKNOWN with triage").toMatch(/timeout|UNKNOWN|triage/i);
      expect(r.deprecated, "hung/UNKNOWN never deprecates").toBe(false);
      // Wall-clock bound: deadline (10s) + one query-timeout (2s) + one interval (5s) + slack.
      expect(r.wallS, `hung query must not extend indefinitely (wall ${r.wallS}s)`).toBeLessThan(25);
    },
  );

  it(
    "B2: visible-unreadable (version visible, digests unreadable) gets a DIFFERENT triage message, never mislabeled absent",
    { timeout: 60000 },
    async () => {
      const r = await attestRun({ visibleUnreadable: true, deadlineS: "10", intervalS: "5" });
      expect(r.published).toBe(true);
      expect(r.code, "persistent visible-unreadable must fail loudly").not.toBe(0);
      expect(r.deprecated, "mismatch unproven → cannot deprecate (would nuke a good version)").toBe(false);
      expect(r.out, "machine-readable VISIBLE_UNREADABLE reason is threaded").toMatch(/VISIBLE_UNREADABLE|visible.*unreadable/i);
      expect(r.out, "suspicious triage is distinct from absent-propagation").toMatch(/suspicious|version visible/i);
      expect(r.out, "human runbook is printed").toMatch(/HUMAN TRIAGE REQUIRED/);
      // Must NOT be mislabeled as plain absent/propagation-lag.
      expect(r.out, "must not be mislabeled as authoritative-absent").not.toMatch(/authoritative-absent|awaiting appearance/i);
    },
  );

  it("B2-helper: verify-npm-identity threads a machine-readable reason for version-visible exit 3", async () => {
    const src = await fs.readFile(path.join(REPO, "scripts/ci/verify-npm-identity.mjs"), "utf8");
    expect(src, "helper exposes visible-unreadable with a distinct prefix").toMatch(/VISIBLE_UNREADABLE/);
  });
});
