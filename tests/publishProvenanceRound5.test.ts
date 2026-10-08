import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// Round-5 (Luna round-4 rejection point): GITHUB_ENV-unset tolerance fails open.
// The recheck guard wrote VERIFIED_TARBALL_BASENAME only when GITHUB_ENV was
// nonempty, else continued; the upload path then expanded to the empty string =
// the retained DIRECTORY → siblings uploaded unrechecked.
// Fix: fail closed — GITHUB_ENV empty/unset → exit 1 loudly; plus a belt-and-
// suspenders pre-upload guard refuses an empty basename.
// No live publish: `npm` is stubbed / offline only.
const REPO = path.resolve(import.meta.dirname, "..");

async function loadPublish() {
  const text = await fs.readFile(path.join(REPO, ".github/workflows/publish.yml"), "utf8");
  return { text, workflow: parse(text) as Record<string, any> };
}

function publishNpmSteps(workflow: Record<string, any>) {
  return (workflow.jobs as Record<string, any>)["publish-npm"].steps as Array<{
    name?: string;
    run?: string;
    uses?: string;
    with?: any;
  }>;
}

describe("round-5: GITHUB_ENV empty/unset fails closed (no fail-open continue)", () => {
  it("recheck guard exits 1 loudly when GITHUB_ENV is empty/unset (no fail-open branch)", async () => {
    const { workflow } = await loadPublish();
    const steps = publishNpmSteps(workflow);
    const recheck = steps.find((s) => (s.run ?? "").includes("VERIFIED_TARBALL_BASENAME") && (s.run ?? "").includes("GITHUB_ENV"));
    expect(recheck, "recheck guard exists").toBeDefined();
    const run = recheck!.run!;
    // Fail closed: empty/unset GITHUB_ENV → loud exit 1.
    expect(run, "guard detects empty/unset GITHUB_ENV").toMatch(/GITHUB_ENV.*empty\/unset|empty\/unset.*GITHUB_ENV|\[ -z "\$\{GITHUB_ENV/);
    expect(run, "guard fails loudly").toMatch(/exit 1/);
    // The fail-open shape must be gone: conditional write that silently continues.
    expect(run, "no fail-open `if [ -n ...GITHUB_ENV...]` without else/exit").not.toMatch(/if \[ -n "\$\{GITHUB_ENV[^\n]*\n[^\n]*>>[^\n]*\n\s*fi/);
  });

  it("belt-and-suspenders pre-upload guard refuses empty basename immediately before upload", async () => {
    const { workflow } = await loadPublish();
    const steps = publishNpmSteps(workflow);
    const idx = steps.findIndex((s) => (s.uses ?? "").includes("upload-artifact"));
    expect(idx).toBeGreaterThan(0);
    const guard = steps[idx - 1] as { name?: string; run?: string };
    expect(guard.run ?? "", "pre-upload guard exists immediately before upload").toMatch(/VERIFIED_TARBALL_BASENAME/);
    expect(
      guard.run ?? "",
      'pre-upload guard refuses empty basename ([ -n "$VERIFIED_TARBALL_BASENAME" ] || exit 1)',
    ).toContain('[ -n "$VERIFIED_TARBALL_BASENAME" ] || exit 1');
  });

  it("e2e RED/GREEN: unset GITHUB_ENV → loud failure with no upload (stub npm, offline)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-prov5-guard-"));
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "aeh-test-pkg", version: "9.9.9" }));
    const pack = spawnSync("npm", ["pack", "--pack-destination", dir, "--silent"], { cwd: dir, encoding: "utf8" });
    if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`);
    const baseTgz = (await fs.readdir(dir)).find((f) => f.endsWith(".tgz"))!;
    const baseBytes = await fs.readFile(path.join(dir, baseTgz));
    const baseDigest = `sha512-${createHash("sha512").update(baseBytes).digest("base64")}`;
    const SHA = "d".repeat(40);
    await fs.symlink(path.join(REPO, "scripts"), path.join(dir, "scripts"));
    const retainDir = path.join(dir, "aeh-npm-retained");
    await fs.mkdir(retainDir);
    await fs.writeFile(path.join(retainDir, baseTgz), baseBytes);
    await fs.writeFile(
      path.join(retainDir, "npm-provenance.json"),
      JSON.stringify({ release_sha: SHA, tarball_sha512: baseDigest, name: "aeh-test-pkg", version: "9.9.9" }),
    );
    await fs.writeFile(path.join(retainDir, "npm-identity.digest"), `${baseDigest}\n`);
    const { workflow } = await loadPublish();
    const steps = publishNpmSteps(workflow);
    const recheck = steps.find((s) => (s.run ?? "").includes("VERIFIED_TARBALL_BASENAME") && (s.run ?? "").includes("GITHUB_ENV"))!;
    const sh = path.join(dir, "guard-step.sh");
    await fs.writeFile(sh, `set -euo pipefail\n${recheck.run}\n`);
    // Case A: GITHUB_ENV unset → must FAIL loudly (fail closed), no continue.
    const noEnv = { ...process.env, RUNNER_TEMP: dir } as NodeJS.ProcessEnv;
    delete (noEnv as Record<string, unknown>).GITHUB_ENV;
    const rFail = spawnSync("bash", [sh], { cwd: dir, env: noEnv, encoding: "utf8" });
    const outFail = `${rFail.stdout ?? ""}\n${rFail.stderr ?? ""}`;
    expect(rFail.status, "unset GITHUB_ENV must fail closed (nonzero exit, no upload)").not.toBe(0);
    expect(outFail, "failure is loud about GITHUB_ENV").toMatch(/GITHUB_ENV/);
    // Case B: GITHUB_ENV set → succeeds and pins the exact basename.
    const envFile = path.join(dir, "github_env");
    await fs.writeFile(envFile, "");
    const rOk = spawnSync("bash", [sh], {
      cwd: dir,
      env: { ...process.env, RUNNER_TEMP: dir, GITHUB_ENV: envFile } as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
    expect(rOk.status, "set GITHUB_ENV succeeds").toBe(0);
    const pinned = await fs.readFile(envFile, "utf8");
    expect(pinned, "exact basename is pinned via GITHUB_ENV").toMatch(/VERIFIED_TARBALL_BASENAME=.*\.tgz/);
  });

  it("e2e: pre-upload guard refuses empty/unset basename, accepts exact .tgz", async () => {
    const { workflow } = await loadPublish();
    const steps = publishNpmSteps(workflow);
    const idx = steps.findIndex((s) => (s.uses ?? "").includes("upload-artifact"));
    const guard = steps[idx - 1]!;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-prov5-pre-"));
    const sh = path.join(dir, "pre-upload-guard.sh");
    await fs.writeFile(sh, `${guard.run}\n`);
    const base = { ...process.env } as NodeJS.ProcessEnv;
    delete (base as Record<string, unknown>).VERIFIED_TARBALL_BASENAME;
    // Unset → fail (set -u unbound or explicit empty check; either way nonzero).
    const rUnset = spawnSync("bash", [sh], { cwd: dir, env: base, encoding: "utf8" });
    expect(rUnset.status, "unset basename must fail closed").not.toBe(0);
    // Empty → fail.
    const rEmpty = spawnSync("bash", [sh], {
      cwd: dir,
      env: { ...base, VERIFIED_TARBALL_BASENAME: "" } as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
    expect(rEmpty.status, "empty basename must fail closed (else upload expands to DIRECTORY)").not.toBe(0);
    // Non-tgz → fail.
    const rNonTgz = spawnSync("bash", [sh], {
      cwd: dir,
      env: { ...base, VERIFIED_TARBALL_BASENAME: "evil.txt" } as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
    expect(rNonTgz.status, "non-tgz basename must fail closed").not.toBe(0);
    // Exact .tgz → pass.
    const rOk = spawnSync("bash", [sh], {
      cwd: dir,
      env: { ...base, VERIFIED_TARBALL_BASENAME: "aeh-test-pkg-9.9.9.tgz" } as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
    expect(rOk.status, "exact .tgz basename passes").toBe(0);
  });
});
