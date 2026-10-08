import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// Luna stabilization BLOCKER: publish retry-resume trusts an unverified artifact.
// .github/workflows/publish.yml download uses continue-on-error; pack reuses any
// .tgz without validating against current release SHA; publish checks
// name/version/identity but not provenance-to-this-run.
// Required: sidecar (release_sha + tarball sha512 + name/version) written at
// pack/upload, verified on reuse (release_sha match + digest recompute +
// name/version match); absent/invalid/mismatch => fail closed (refuse publish AND Release).
const REPO = path.resolve(import.meta.dirname, "..");

function publishNpmJob() {
  return fs.readFile(path.join(REPO, ".github/workflows/publish.yml"), "utf8").then((text) => ({
    text,
    workflow: parse(text) as Record<string, any>,
  }));
}

describe("artifact provenance binding (release_sha sidecar)", () => {
  it("pack/upload sites write a provenance sidecar alongside the tarball", async () => {
    const { text, workflow } = await publishNpmJob();
    const jobs = workflow.jobs as Record<string, any>;
    const pubSteps = jobs["publish-npm"].steps as Array<{ name?: string; run?: string; with?: any }>;
    const packStep = pubSteps.find((s) => (s.name ?? "").includes("Pack release tarball"))!;
    expect(packStep).toBeDefined();
    // Sidecar write: release_sha + tarball digest + name/version, uploaded alongside.
    expect(packStep.run!, "pack step writes sidecar").toMatch(/provenance/i);
    expect(packStep.run!, "sidecar binds release_sha").toMatch(/release_sha/i);
    expect(packStep.run!, "sidecar records tarball digest").toMatch(/sha512/i);
    // Upload retains sidecar alongside tarball (directory upload or explicit file).
    const retain = pubSteps.find((s) => JSON.stringify(s).includes("upload-artifact"))!;
    expect(retain).toBeDefined();
    expect(JSON.stringify(retain), "retain uploads sidecar dir").toMatch(/aeh-npm-retained/);
    // Sidecar filename convention present in workflow.
    expect(text).toMatch(/npm-provenance\.json|provenance\.json/i);
  });

  it("reuse sites verify sidecar (release_sha + digest + name/version), fail closed", async () => {
    const { workflow } = await publishNpmJob();
    const jobs = workflow.jobs as Record<string, any>;
    const pubSteps = jobs["publish-npm"].steps as Array<{ name?: string; run?: string }>;
    const packRun = pubSteps.find((s) => (s.name ?? "").includes("Pack release tarball"))!.run!;
    const publishRun = pubSteps.find((s) => (s.run ?? "").includes("npm publish"))!.run!;
    const confirmRun = pubSteps.find((s) => s.name === "Confirm published version is on npm")!.run!;
    const repairSteps = jobs["repair-release"].steps as Array<{ name?: string; run?: string }>;
    const repairRun = repairSteps.find((s) => s.name === "Confirm published-but-unreleased state (SHA-bound)")!.run!;
    for (const [site, run] of Object.entries({ packRun, publishRun, confirmRun, repairRun })) {
      // Verifiable provenance gate at every reuse site.
      expect(run, `${site} calls provenance verifier`).toMatch(/verify-artifact-provenance|artifact-provenance/i);
      expect(run, `${site} binds release_sha`).toMatch(/release_sha|RELEASE_SHA/i);
      expect(run, `${site} fails closed loudly`).toMatch(/Refus|fail closed|provenance/i);
    }
    // Absent sidecar must refuse (no silent fresh-pack over published bytes in publish path).
    expect(publishRun).toMatch(/Missing|absent|no .*provenance|Refus/i);
  });

  it("verifier refuses stale same-version artifact with valid registry identity but wrong release_sha", async () => {
    // DETERMINISTIC mechanism: string equality (release_sha), sha512 recompute, name/version match.
    const gate = path.join(REPO, "scripts/ci/verify-artifact-provenance.mjs");
    await expect(fs.access(gate)).resolves.toBeUndefined();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-prov-red-"));
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "aeh-test-pkg", version: "9.9.9" }));
    const pack = spawnSync("npm", ["pack", "--pack-destination", dir, "--silent"], { cwd: dir, encoding: "utf8" });
    if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`);
    const tgz = path.join(dir, (await fs.readdir(dir)).find((f) => f.endsWith(".tgz"))!);
    const bytes = await fs.readFile(tgz);
    const digest = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const CURRENT_SHA = "a".repeat(40);
    const STALE_SHA = "b".repeat(40);
    // Stale sidecar: valid digest + valid name/version, but WRONG release_sha.
    const staleSidecar = path.join(dir, "stale.provenance.json");
    await fs.writeFile(
      staleSidecar,
      JSON.stringify({ release_sha: STALE_SHA, tarball_sha512: digest, name: "aeh-test-pkg", version: "9.9.9" }),
    );
    const refused = spawnSync(
      process.execPath,
      [gate, "--tarball", tgz, "--provenance", staleSidecar, "--release-sha", CURRENT_SHA, "--name", "aeh-test-pkg", "--version", "9.9.9"],
      { encoding: "utf8" },
    );
    expect(refused.status, "wrong release_sha must refuse").not.toBe(0);
    expect(`${refused.stdout}\n${refused.stderr}`).toMatch(/provenance|release_sha|refus|mismatch/i);
    // Absent sidecar must also refuse (fail closed).
    const absent = spawnSync(
      process.execPath,
      [gate, "--tarball", tgz, "--provenance", path.join(dir, "does-not-exist.json"), "--release-sha", CURRENT_SHA, "--name", "aeh-test-pkg", "--version", "9.9.9"],
      { encoding: "utf8" },
    );
    expect(absent.status, "absent sidecar must refuse").not.toBe(0);
    // Tampered tarball (digest mismatch) must refuse even with correct release_sha.
    await fs.appendFile(tgz, "tamper");
    const goodSidecar = path.join(dir, "good.provenance.json");
    await fs.writeFile(
      goodSidecar,
      JSON.stringify({ release_sha: CURRENT_SHA, tarball_sha512: digest, name: "aeh-test-pkg", version: "9.9.9" }),
    );
    const tampered = spawnSync(
      process.execPath,
      [gate, "--tarball", tgz, "--provenance", goodSidecar, "--release-sha", CURRENT_SHA, "--name", "aeh-test-pkg", "--version", "9.9.9"],
      { encoding: "utf8" },
    );
    expect(tampered.status, "digest mismatch must refuse").not.toBe(0);
    // Control: correct sidecar + untampered tarball verifies.
    await fs.writeFile(tgz, bytes);
    const ok = spawnSync(
      process.execPath,
      [gate, "--tarball", tgz, "--provenance", goodSidecar, "--release-sha", CURRENT_SHA, "--name", "aeh-test-pkg", "--version", "9.9.9"],
      { encoding: "utf8" },
    );
    expect(ok.status, "valid provenance must verify").toBe(0);
  });

  it("publish step refuses a stale same-version retained tarball (valid registry identity, wrong release_sha)", async () => {
    // End-to-end Luna BLOCKER scenario through the REAL publish-step script:
    // a retained .tgz whose digest matches the registry (identity gate would
    // PASS) but whose sidecar binds a DIFFERENT release_sha must be refused
    // (no publish, loud provenance error) — never skipped-published or published.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-prov-e2e-"));
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "aeh-test-pkg", version: "9.9.9" }));
    const pack = spawnSync("npm", ["pack", "--pack-destination", dir, "--silent"], { cwd: dir, encoding: "utf8" });
    if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`);
    const baseTgz = (await fs.readdir(dir)).find((f) => f.endsWith(".tgz"))!;
    const baseBytes = await fs.readFile(path.join(dir, baseTgz));
    const baseDigest = `sha512-${createHash("sha512").update(baseBytes).digest("base64")}`;
    const CURRENT_SHA = "c".repeat(40);
    const STALE_SHA = "d".repeat(40);
    // Stub registry: version present, integrity == STALE tarball (identity VALID).
    const bin = path.join(dir, "stubbin");
    await fs.mkdir(bin);
    const publishCalled = path.join(dir, "publish-called");
    await fs.writeFile(
      path.join(bin, "npm"),
      `#!/bin/sh\n` +
        `if [ "$1" = "view" ]; then\n` +
        `  case "$3" in version) echo "9.9.9";; dist.integrity) echo "${baseDigest}";; dist.shasum) echo "";; *) exit 1;; esac\n` +
        `  exit 0\nfi\n` +
        `if [ "$1" = "pack" ]; then DEST=""; PREV=""; for a in "$@"; do if [ "$PREV" = "--pack-destination" ]; then DEST="$a"; fi; PREV="$a"; done; cp "${path.join(dir, baseTgz)}" "$DEST/"; echo "${baseTgz}"; exit 0; fi\n` +
        `if [ "$1" = "publish" ]; then touch "${publishCalled}"; exit 0; fi\n` +
        `echo "stub: unsupported npm $*" >&2; exit 1\n`,
    );
    await fs.chmod(path.join(bin, "npm"), 0o755);
    await fs.symlink(path.join(REPO, "scripts"), path.join(dir, "scripts"));
    // Simulate the downloaded artifact: stale tarball + sidecar bound to STALE_SHA.
    const retainDir = path.join(dir, "aeh-npm-retained");
    await fs.mkdir(retainDir);
    await fs.writeFile(path.join(retainDir, baseTgz), baseBytes);
    await fs.writeFile(
      path.join(retainDir, "npm-provenance.json"),
      JSON.stringify({ release_sha: STALE_SHA, tarball_sha512: baseDigest, name: "aeh-test-pkg", version: "9.9.9" }),
    );
    const { workflow } = await publishNpmJob();
    const steps = (workflow.jobs as Record<string, any>)["publish-npm"].steps as Array<{ name?: string; run?: string }>;
    const pubStep = steps.find((s) => (s.run ?? "").includes("npm publish"))!;
    const sh = path.join(dir, "publish-step.sh");
    await fs.writeFile(sh, `set -euo pipefail\n${pubStep.run}\n`);
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      RELEASE_VERSION: "9.9.9",
      RELEASE_SHA: CURRENT_SHA,
    } as NodeJS.ProcessEnv;
    const r = spawnSync("bash", [sh], { cwd: dir, env, encoding: "utf8" });
    let published = false;
    try {
      await fs.access(publishCalled);
      published = true;
    } catch {}
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    expect(published, "stale artifact must never reach npm publish").toBe(false);
    expect(r.status, "stale artifact must fail closed").not.toBe(0);
    expect(out).toMatch(/provenance|release_sha|refus/i);
    // Control: sidecar rebound to CURRENT_SHA reuses idempotently (skip, no publish).
    await fs.writeFile(
      path.join(retainDir, "npm-provenance.json"),
      JSON.stringify({ release_sha: CURRENT_SHA, tarball_sha512: baseDigest, name: "aeh-test-pkg", version: "9.9.9" }),
    );
    try {
      await fs.rm(publishCalled, { force: true });
    } catch {}
    const r2 = spawnSync("bash", [sh], { cwd: dir, env, encoding: "utf8" });
    let published2 = false;
    try {
      await fs.access(publishCalled);
      published2 = true;
    } catch {}
    expect(r2.status, "valid provenance resumes idempotently").toBe(0);
    expect(published2, "idempotent resume must not republish").toBe(false);
  });
});
