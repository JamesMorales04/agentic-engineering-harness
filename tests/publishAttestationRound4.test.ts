import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// Round-4 RED: Luna rejected ru/attestation-propagation-3 (tip 1c47659) with
// 2 consistency points (late-accept semantics + min-timeout ACCEPTED).
// C1: exit-1 mismatch path skips the post-return clock check while success
//     and others check. Required: SINGLE check point — check wall clock ONCE
//     immediately after every query return, record exceeded flag, THEN
//     dispatch by exit code (success→accept[+trace if exceeded];
//     mismatch→deprecate+fail[+trace if exceeded];
//     unknown→UNKNOWN-fail-if-exceeded-else-retry).
// C2: retry sleep uncapped by remaining (up to 120s past END). Required:
//     sleep = min(INTERVAL, remaining); remaining<=0 → skip sleep, go
//     straight to deadline handling.
// Everything else ACCEPTED — only the poll-loop structure + tests are touched.
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
  sleepFrom?: number;
  deadlineS?: string;
  intervalS?: string;
  queryTimeoutS?: string;
  stubTimeout?: boolean;
  /** Return a valid-but-different integrity so the gate exits 1 (PROVEN mismatch). */
  mismatch?: boolean;
};

async function attestRun(opts: AttestOpts) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-attest-r4-"));
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "aeh-test-pkg", version: "9.9.9" }));
  const pack = spawnSync("npm", ["pack", "--pack-destination", dir, "--silent"], { cwd: dir, encoding: "utf8" });
  if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`);
  const baseTgz = (await fs.readdir(dir)).find((f) => f.endsWith(".tgz"))!;
  const baseBytes = await fs.readFile(path.join(dir, baseTgz));
  const baseDigest = `sha512-${createHash("sha512").update(baseBytes).digest("base64")}`;
  const registryDigest = opts.mismatch
    ? `sha512-${createHash("sha512").update("aeh-mismatch-sentinel").digest("base64")}`
    : baseDigest;
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
      `VISIBLE_INTEGRITY="${registryDigest}"\n` +
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

describe("attestation round-4 (Luna consistency rejection of 1c47659)", () => {
  it("C1-static: SINGLE post-return clock check, exceeded flag recorded BEFORE dispatch", async () => {
    const { run } = await loadPublishStep();
    // Exactly ONE wall-clock read immediately after query return (no per-branch duplicates).
    const afterReads = run.match(/ATTEST_AFTER="\$\(date \+%s\)"/g) ?? [];
    expect(afterReads.length, "SINGLE check point: exactly one ATTEST_AFTER read after query return").toBe(1);
    // Exceeded flag is recorded...
    expect(run, "exceeded flag is recorded").toMatch(/ATTEST_EXCEEDED=1/);
    expect(run, "non-exceeded flag is recorded").toMatch(/ATTEST_EXCEEDED=0/);
    // ...BEFORE dispatch by exit code (success / mismatch / unknown all see the flag).
    const flagPos = run.indexOf("ATTEST_EXCEEDED=1");
    const mismatchPos = run.indexOf('attest_code" -eq 1');
    const successPos = run.indexOf('attest_code" -eq 0');
    expect(flagPos, "flag recorded before dispatch").toBeGreaterThanOrEqual(0);
    expect(mismatchPos, "mismatch dispatch exists").toBeGreaterThanOrEqual(0);
    expect(successPos, "success dispatch exists").toBeGreaterThanOrEqual(0);
    expect(flagPos, "exceeded flag recorded BEFORE mismatch/success dispatch (no path bypasses the check)").toBeLessThan(
      Math.min(mismatchPos, successPos),
    );
  });

  it("C1-static: mismatch path traces deadline-exceeded (deadline doesn't un-prove inequality)", async () => {
    const { run } = await loadPublishStep();
    // The mismatch trace must carry a deadline-exceeded mark for the post-deadline case.
    expect(run, "mismatch deprecate+fail traces deadline-exceeded when exceeded").toMatch(
      /FAILED-deprecated-deadline-exceeded/,
    );
  });

  it("C2-static: retry sleep is min(INTERVAL, remaining); remaining<=0 skips sleep to deadline handling", async () => {
    const { run } = await loadPublishStep();
    expect(run, "bounded sleep variable computed from remaining").toMatch(/ATTEST_SLEEP_S/);
    expect(run, "sleep bound takes the minimum of interval and remaining").toMatch(/ATTEST_SLEEP_REMAINING/);
    expect(run, "remaining<=0 skips sleep and goes straight to deadline handling").toMatch(
      /ATTEST_SLEEP_REMAINING.*-le 0/,
    );
    expect(run, "the retry sleeps the BOUNDED duration, not the raw interval").toMatch(/sleep "\$ATTEST_SLEEP_S"/);
    expect(run, "no raw-interval sleep remains on the retry path").not.toMatch(/sleep "\$ATTEST_INTERVAL_S"/);
  });

  it(
    "C1-dynamic: post-deadline MISMATCH still deprecates+ fails BUT traces deadline-exceeded",
    { timeout: 60000 },
    async () => {
      // Query starts before END, returns PROVEN inequality after END (timeout
      // stubbed permissive to deterministically exercise the post-deadline race).
      const r = await attestRun({
        lagViews: 0,
        viewSleepS: 12,
        deadlineS: "10",
        intervalS: "5",
        stubTimeout: true,
        mismatch: true,
      });
      expect(r.published, "publish still happens before attestation").toBe(true);
      expect(r.code, `proven mismatch must fail LOUDLY even post-deadline (out: ${r.out})`).not.toBe(0);
      expect(r.deprecated, "proven inequality still deprecates post-deadline (deadline doesn't un-prove it)").toBe(true);
      expect(r.out, "mismatch failure is loud").toMatch(/FAILED|MISMATCH/i);
      expect(r.out, "post-deadline mismatch is traced deadline-exceeded").toMatch(/deadline-exceeded/i);
      expect(r.out, "machine-readable mismatch trace records the accept").toMatch(/FAILED-deprecated-deadline-exceeded/);
    },
  );

  it(
    "C1-control: in-deadline mismatch deprecates WITHOUT a deadline-exceeded mark",
    { timeout: 60000 },
    async () => {
      const r = await attestRun({ lagViews: 0, viewSleepS: 0, deadlineS: "15", intervalS: "5", mismatch: true });
      expect(r.code, `in-deadline mismatch must fail (out: ${r.out})`).not.toBe(0);
      expect(r.deprecated, "proven inequality deprecates").toBe(true);
      expect(r.out, "mismatch trace records the deprecate").toMatch(/FAILED-deprecated/);
      expect(r.out, "in-deadline mismatch is NOT marked deadline-exceeded").not.toMatch(/deadline-exceeded/i);
    },
  );

  it(
    "C2-dynamic: retry sleep is capped by the remaining budget (no overrun past END)",
    { timeout: 90000 },
    async () => {
      // First query fast-absent, then a 30s retry sleep against a 10s deadline.
      // Fixed code sleeps min(30, ~10) and fails at ~10s; pre-fix code sleeps
      // the full 30s interval past END.
      const r = await attestRun({ lagViews: 999999, viewSleepS: 0, deadlineS: "10", intervalS: "30" });
      expect(r.published, "publish still happens before attestation").toBe(true);
      expect(r.code, "persistent absence must fail loudly (UNKNOWN)").not.toBe(0);
      expect(r.deprecated, "absence is NEVER mismatch: nothing is deprecated").toBe(false);
      expect(r.wallS, `retry sleep bounded by remaining (wall ${r.wallS}s vs deadline 10s + interval 30s)`).toBeLessThan(20);
      expect(r.queryStarts, "no further query is issued once the budget is exhausted").toBe(1);
    },
  );
});
