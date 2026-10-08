import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// Round-3 RED: Luna rejected ru/attestation-propagation-2 (tip 2231bcc) with
// 2 points on deadline exactness (overrides/triage/exit-codes ACCEPTED).
// D1: success path skips post-query deadline check (starts before, returns
//     match after -> passes post-deadline). Required: check wall clock after
//     EVERY query return. Semantics: the deadline bounds CI STEP duration,
//     not attestation truth — a post-deadline SUCCESS is still a proven
//     attestation: ACCEPT it but TRACE deadline-exceeded (observability);
//     a post-deadline NON-success -> UNKNOWN fail (no more retries).
// D2: query timeout independent of remaining budget (overrun up to 120s).
//     Required: effective per-query timeout = min(configured query timeout,
//     remaining seconds); if remaining <= 0 (below the 1s floor), do NOT
//     issue another query — go directly to deadline-exceeded handling.
// Everything else ACCEPTED — only the poll-loop timing + tests are touched.
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
  viewSleepS?: number;
  /** Sleep only on integrity views after the first `sleepFrom` ones (0 = all). */
  sleepFrom?: number;
  deadlineS?: string;
  intervalS?: string;
  queryTimeoutS?: string;
  /** Stub `timeout(1)` to ignore its bound (simulates a query that outlives its bound). */
  stubTimeout?: boolean;
};

async function attestRun(opts: AttestOpts) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-attest-r3-"));
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
  const queryLog = path.join(dir, "query-log");
  const lagViews = opts.lagViews ?? 999999;
  const sleepS = opts.viewSleepS ?? 0;
  const sleepFrom = opts.sleepFrom ?? 0;
  await fs.writeFile(
    path.join(bin, "npm"),
    `#!/bin/sh\n` +
      `PUBLISH_CALLED="${publishCalled}"\n` +
      `VIEW_COUNT="${viewCount}"\n` +
      `QUERY_LOG="${queryLog}"\n` +
      `LAG_VIEWS="${lagViews}"\n` +
      `VISIBLE_INTEGRITY="${baseDigest}"\n` +
      `VIEW_SLEEP="${sleepS}"\n` +
      `SLEEP_FROM="${sleepFrom}"\n` +
      `if [ "$1" = "view" ]; then\n` +
      `  if [ ! -f "$PUBLISH_CALLED" ]; then echo "npm error code E404" >&2; echo "npm error 404 Not Found" >&2; exit 1; fi\n` +
      `  if [ "$3" = "dist.integrity" ]; then\n` +
      `    echo "QUERY_START $(date +%s)" >> "$QUERY_LOG"\n` +
      `    COUNT="$(cat "$VIEW_COUNT" 2>/dev/null || echo 0)"; COUNT=$((COUNT + 1)); echo "$COUNT" > "$VIEW_COUNT"\n` +
      `    if [ "$COUNT" -gt "$SLEEP_FROM" ]; then if [ "$VIEW_SLEEP" -gt 0 ] 2>/dev/null; then sleep "$VIEW_SLEEP"; fi; fi\n` +
      `    if [ "$COUNT" -le "$LAG_VIEWS" ]; then echo "QUERY_END $(date +%s) absent" >> "$QUERY_LOG"; echo "npm error code E404" >&2; echo "npm error 404 Not Found - GET dist.integrity (propagation lag)" >&2; exit 1; fi\n` +
      `    echo "QUERY_END $(date +%s) success" >> "$QUERY_LOG"; echo "$VISIBLE_INTEGRITY"; exit 0\n` +
      `  fi\n` +
      `  if [ "$3" = "dist.shasum" ]; then\n` +
      `    COUNT="$(cat "$VIEW_COUNT" 2>/dev/null || echo 0)"\n` +
      `    if [ "$COUNT" -gt "$SLEEP_FROM" ]; then if [ "$VIEW_SLEEP" -gt 0 ] 2>/dev/null; then sleep "$VIEW_SLEEP"; fi; fi\n` +
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
  if (opts.stubTimeout) {
    // Permissive timeout stub: drop the duration bound and exec directly, so a
    // query can deterministically return AFTER the deadline (the race D1 covers).
    await fs.writeFile(path.join(bin, "timeout"), `#!/bin/sh\nDURATION="$1"; shift\nexec "$@"\n`);
    await fs.chmod(path.join(bin, "timeout"), 0o755);
  }
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
  const r = spawnSync("bash", [sh], { cwd: dir, env, encoding: "utf8", timeout: 90000 });
  const wallS = (Date.now() - start) / 1000;
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  let qlog = "";
  try {
    qlog = await fs.readFile(queryLog, "utf8");
  } catch {}
  const queryStarts = qlog.split("\n").filter((l) => l.startsWith("QUERY_START")).length;
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
  return { code: r.status ?? -1, out, published, deprecated, wallS, qlog, queryStarts };
}

describe("attestation round-3 (Luna deadline-exactness rejection of 2231bcc)", () => {
  it("D1-static: wall clock is checked after EVERY query return (success and non-success)", async () => {
    const { run } = await loadPublishStep();
    // Post-return checks against END on both branches (not just before-query).
    const postReturnChecks = run.match(/ATTEST_AFTER.*-ge.*ATTEST_END/g) ?? [];
    expect(postReturnChecks.length, "checked after each query: success AND non-success returns").toBeGreaterThanOrEqual(2);
    // Post-deadline success is ACCEPTED (still breaks/passes) but traced.
    expect(run, "post-deadline success accepted with deadline-exceeded trace").toMatch(/VERIFIED-deadline-exceeded/);
  });

  it("D2-static: effective per-query timeout is min(configured, remaining) with a no-budget floor", async () => {
    const { run } = await loadPublishStep();
    expect(run, "remaining budget computed from END").toMatch(/ATTEST_REMAINING/);
    expect(run, "effective timeout takes the minimum").toMatch(/ATTEST_EFFECTIVE_TIMEOUT/);
    expect(run, "remaining <= 0 issues no further query (floor)").toMatch(/ATTEST_REMAINING.*-le 0/);
    expect(run, "the query runs under the EFFECTIVE timeout, not the configured one").toMatch(
      /timeout "\$\{ATTEST_EFFECTIVE_TIMEOUT_S\}s"/,
    );
  });

  it(
    "D1-dynamic: post-deadline SUCCESS is ACCEPTED but TRACED deadline-exceeded",
    { timeout: 60000 },
    async () => {
      // Query starts before END and returns a match after END (timeout stubbed
      // permissive to deterministically exercise the post-deadline race).
      const r = await attestRun({ lagViews: 0, viewSleepS: 12, deadlineS: "10", intervalS: "5", stubTimeout: true });
      expect(r.published, "publish still happens before attestation").toBe(true);
      expect(r.code, `proven attestation is ACCEPTED even post-deadline (out: ${r.out})`).toBe(0);
      expect(r.out, "attestation success is traced").toMatch(/attestation verified/i);
      expect(r.out, "deadline-exceeded is marked for observability").toMatch(/deadline-exceeded/i);
      expect(r.out, "machine-readable trace records the accept").toMatch(/result=VERIFIED-deadline-exceeded/);
      expect(r.deprecated, "proven attestation never deprecates").toBe(false);
    },
  );

  it(
    "D1-control: in-deadline success stays a plain verified pass (no deadline-exceeded mark)",
    { timeout: 60000 },
    async () => {
      const r = await attestRun({ lagViews: 0, viewSleepS: 0, deadlineS: "15", intervalS: "5" });
      expect(r.code, `in-deadline match must pass (out: ${r.out})`).toBe(0);
      expect(r.out, "attestation success is traced").toMatch(/attestation verified/i);
      expect(r.out, "in-deadline pass is NOT marked deadline-exceeded").not.toMatch(/deadline-exceeded/i);
      expect(r.deprecated).toBe(false);
    },
  );

  it(
    "D2-dynamic: hung query is bounded by the remaining budget (no overrun past END)",
    { timeout: 60000 },
    async () => {
      // Views hang 12s each; deadline 10s, configured query timeout 60s
      // (default). Fixed code kills the in-flight query at ~remaining (10s);
      // pre-fix code runs the full hang (24s+) past END.
      const r = await attestRun({ lagViews: 999999, viewSleepS: 12, deadlineS: "10", intervalS: "5" });
      expect(r.published, "publish still happens before attestation").toBe(true);
      expect(r.code, "persistent absence must fail loudly (UNKNOWN)").not.toBe(0);
      expect(r.out, "UNKNOWN failure is loud with triage").toMatch(/UNKNOWN|triage/i);
      expect(r.deprecated, "absence is NEVER mismatch: nothing is deprecated").toBe(false);
      expect(r.wallS, `in-flight query bounded by min() (wall ${r.wallS}s vs deadline 10s)`).toBeLessThan(20);
      expect(r.queryStarts, "no further query is issued once the budget is exhausted").toBe(1);
    },
  );

  it(
    "D2-floor: second query with a small remaining budget is killed at the budget, then no more queries",
    { timeout: 60000 },
    async () => {
      // First query fast-absent, then hung views; deadline 10s, interval 5s.
      // The second query starts with ~5s remaining: fixed code bounds it by
      // min(60, ~5) and the post-query check fails the deadline with no third
      // query; pre-fix code runs the full 60s hang past END.
      const r = await attestRun({
        lagViews: 999999,
        viewSleepS: 30,
        sleepFrom: 1,
        deadlineS: "10",
        intervalS: "5",
      });
      expect(r.published).toBe(true);
      expect(r.code, "must fail loudly (UNKNOWN)").not.toBe(0);
      expect(r.deprecated, "absence never deprecates").toBe(false);
      expect(r.wallS, `bounded by remaining budget (wall ${r.wallS}s vs deadline 10s)`).toBeLessThan(20);
      expect(r.queryStarts, "exactly two queries: no query issued with no remaining budget").toBe(2);
    },
  );
});
