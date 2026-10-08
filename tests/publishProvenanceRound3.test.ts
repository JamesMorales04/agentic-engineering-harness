import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// Round-3 (Luna U1/U2): upload scoping + post-publish attestation.
// U1: pre-upload rechecks ONE *.tgz but must not upload unrechecked siblings.
//   Fix: single-tgz guard (fail closed on 0/>1) + EXPLICIT file upload paths
//   (verified tarball + sidecar + digest), never the retained directory.
// U2: recheck→publish is a file-based handoff to a separate `npm publish`
//   process; a swap after the recheck needs NO preimage. Fix: POST-PUBLISH
//   ATTESTATION (registry `dist.integrity` vs sidecar digest; mismatch ->
//   LOUD fail + `npm deprecate` + trace). Threat model: runner-local swap
//   only (workspace-write mid-step; NOT remotely exploitable) -> detected-and-
//   deprecated with bounded blast radius. No live publish: `npm` is stubbed.
const REPO = path.resolve(import.meta.dirname, "..");
const WRONG_INTEGRITY =
  "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

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

describe("round-3 U1: upload scope binds the verified tarball (no sibling crossing)", () => {
  it("upload lists EXPLICIT files (tarball + sidecar + digest), never the directory", async () => {
    const { workflow } = await loadPublish();
    const steps = publishNpmSteps(workflow);
    const upload = steps.find((s) => (s.uses ?? "").includes("upload-artifact"));
    expect(upload, "upload-artifact step exists").toBeDefined();
    const p = (upload!.with as any)?.path as string;
    expect(p, "explicit path list exists").toBeDefined();
    expect(p, "must not upload the retained directory").not.toMatch(/aeh-npm-retained\/?$/);
    expect(p, "sidecar is explicit").toMatch(/npm-provenance\.json/);
    expect(p, "digest is explicit").toMatch(/npm-identity\.digest/);
    expect(p, "tarball is explicit").toMatch(/\.tgz/);
  });

  it("pre-upload recheck enforces exactly ONE tarball (siblings fail closed)", async () => {
    const { workflow } = await loadPublish();
    const steps = publishNpmSteps(workflow);
    const idx = steps.findIndex((s) => (s.uses ?? "").includes("upload-artifact"));
    expect(idx, "upload-artifact step exists").toBeGreaterThan(0);
    const pre = steps[idx - 1] as { name?: string; run?: string };
    expect(pre.name ?? "", "recheck immediately precedes upload").toMatch(/recheck/i);
    expect(pre.run ?? "", "single-tgz guard fails closed on siblings").toMatch(/exactly ONE/i);
    expect(pre.run ?? "", "guard reports sibling count").toMatch(/sibling/i);
    expect(pre.run ?? "", "guard uses the script bind").toMatch(/verify-artifact-provenance\.mjs --recheck/);
  });

  it("no other consumer depends on extra files in the artifact", async () => {
    const { text, workflow } = await loadPublish();
    const jobs = workflow.jobs as Record<string, any>;
    // Every download of the artifact restores to the retained dir and consumes
    // via `ls *.tgz | head` + sidecar + digest (no extra-file dependency).
    const downloads: Array<{ job: string; with: any }> = [];
    for (const [jobName, job] of Object.entries(jobs) as Array<[string, any]>) {
      for (const s of (job.steps ?? []) as Array<any>) {
        if ((s.uses ?? "").includes("download-artifact") && (s.with as any)?.name === "aeh-npm-tarball") {
          downloads.push({ job: jobName, with: s.with });
        }
      }
    }
    expect(downloads.length, "exactly the two known restores (publish-npm + repair-release)").toBe(2);
    expect(text, "retained consumers bind the sidecar").toMatch(/npm-provenance\.json/);
    expect(text, "retained consumers use the digest fallback").toMatch(/npm-identity\.digest/);
  });

  it("U1 e2e: sibling tarball fails the pre-upload guard; single verified tarball passes", async () => {
    const { workflow } = await loadPublish();
    const steps = publishNpmSteps(workflow);
    const idx = steps.findIndex((s) => (s.uses ?? "").includes("upload-artifact"));
    const preRun = (steps[idx - 1] as any).run as string;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-prov3-u1-"));
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "aeh-test-pkg", version: "9.9.9" }));
    const pack = spawnSync("npm", ["pack", "--pack-destination", dir, "--silent"], { cwd: dir, encoding: "utf8" });
    if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`);
    const baseTgz = (await fs.readdir(dir)).find((f) => f.endsWith(".tgz"))!;
    const baseBytes = await fs.readFile(path.join(dir, baseTgz));
    const baseDigest = `sha512-${createHash("sha512").update(baseBytes).digest("base64")}`;
    const SHA = "a".repeat(40);
    await fs.symlink(path.join(REPO, "scripts"), path.join(dir, "scripts"));
    const retainDir = path.join(dir, "aeh-npm-retained");
    await fs.mkdir(retainDir);
    // Verified file + sidecar + digest.
    await fs.writeFile(path.join(retainDir, baseTgz), baseBytes);
    await fs.writeFile(
      path.join(retainDir, "npm-provenance.json"),
      JSON.stringify({ release_sha: SHA, tarball_sha512: baseDigest, name: "aeh-test-pkg", version: "9.9.9" }),
    );
    await fs.writeFile(path.join(retainDir, "npm-identity.digest"), `${baseDigest}\n`);
    const sh = path.join(dir, "pre-upload.sh");
    await fs.writeFile(sh, `set -euo pipefail\n${preRun}\n`);
    const env = { ...process.env, RUNNER_TEMP: dir } as NodeJS.ProcessEnv;
    // Control: single tarball passes the guard + recheck.
    const ok = spawnSync("bash", [sh], { cwd: dir, env, encoding: "utf8" });
    expect(ok.status, `single verified tarball must pass (out: ${ok.stdout}\n${ok.stderr})`).toBe(0);
    // Attack: sibling tarball appears (unrechecked) -> guard must fail closed.
    await fs.writeFile(path.join(retainDir, "sibling-evil-9.9.9.tgz"), "evil-sibling-bytes");
    const bad = spawnSync("bash", [sh], { cwd: dir, env, encoding: "utf8" });
    expect(bad.status, "sibling tarball must fail the upload guard").not.toBe(0);
    expect(`${bad.stdout}\n${bad.stderr}`, "sibling refusal is loud").toMatch(/exactly ONE|sibling/i);
  });
});

describe("round-3 U2: post-publish attestation (detect-and-deprecate)", () => {
  it("publish step attests registry integrity AFTER publish, deprecates on mismatch, honest model", async () => {
    const { text, workflow } = await loadPublish();
    const steps = publishNpmSteps(workflow);
    const pub = steps.find((s) => (s.run ?? "").includes("npm publish"))!;
    expect(pub).toBeDefined();
    const run = pub!.run!;
    const lines = run.split("\n");
    const publishIdx = lines.findIndex((l) => /npm publish ["']/.test(l));
    expect(publishIdx, "actual publish invocation exists").toBeGreaterThanOrEqual(0);
    const attestIdx = lines.findIndex((l, i) => i > publishIdx && l.includes("dist.integrity"));
    expect(attestIdx, "registry integrity is queried AFTER publish").toBeGreaterThan(publishIdx);
    expect(run, "mismatch deprecates to block installs").toMatch(/npm deprecate/);
    expect(run, "attestation traces the decision").toMatch(/attestation trace/i);
    expect(run, "honest threat model: runner-local").toMatch(/runner-local/i);
    expect(run, "honest threat model: workspace-write").toMatch(/workspace-write/i);
    expect(run, "honest threat model: NOT remotely exploitable").toMatch(/NOT remotely/i);
    expect(run, "no sub-ms race fable").not.toMatch(/sub-ms|sub-millisecond/i);
    expect(run, "no preimage-required fable").not.toMatch(/needs a sha512 preimage/i);
    expect(text, "gate documents the honest residual").toMatch(/POST-PUBLISH ATTESTATION/i);
  });

  async function u2Fixture(opts: { registryIntegrity: string; startAbsent: boolean }) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-prov3-u2-"));
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "aeh-test-pkg", version: "9.9.9" }));
    const pack = spawnSync("npm", ["pack", "--pack-destination", dir, "--silent"], { cwd: dir, encoding: "utf8" });
    if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`);
    const baseTgz = (await fs.readdir(dir)).find((f) => f.endsWith(".tgz"))!;
    const baseBytes = await fs.readFile(path.join(dir, baseTgz));
    const baseDigest = `sha512-${createHash("sha512").update(baseBytes).digest("base64")}`;
    const SHA = "b".repeat(40);
    const bin = path.join(dir, "stubbin");
    await fs.mkdir(bin);
    const publishCalled = path.join(dir, "publish-called");
    // Stateful stub (no live publish): before `npm publish` the version is
    // absent (E404 -> publish branch); after publish the registry reports
    // opts.registryIntegrity (good digest = clean publish, WRONG digest =
    // runner-local swap published). `npm deprecate` is recorded, never live.
    await fs.writeFile(
      path.join(bin, "npm"),
      `#!/bin/sh\n` +
        `if [ "$1" = "view" ]; then\n` +
        `  if [ ! -f "${publishCalled}" ]; then echo "npm error code E404" >&2; echo "npm error 404 Not Found" >&2; exit 1; fi\n` +
        `  case "$3" in version) echo "9.9.9";; dist.integrity) echo "${opts.registryIntegrity}";; dist.shasum) echo "";; *) exit 1;; esac\n` +
        `  exit 0\nfi\n` +
        `if [ "$1" = "pack" ]; then DEST=""; PREV=""; for a in "$@"; do if [ "$PREV" = "--pack-destination" ]; then DEST="$a"; fi; PREV="$a"; done; cp "${path.join(dir, baseTgz)}" "$DEST/"; echo "${baseTgz}"; exit 0; fi\n` +
        `if [ "$1" = "publish" ]; then touch "${publishCalled}"; echo "$@" > "${publishCalled}.args"; exit 0; fi\n` +
        `if [ "$1" = "deprecate" ]; then touch "${publishCalled}.deprecated"; echo "$@" > "${publishCalled}.deprecated.args"; exit 0; fi\n` +
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
    const { workflow } = await loadPublish();
    const steps = publishNpmSteps(workflow);
    const pubStep = steps.find((s) => (s.run ?? "").includes("npm publish"))!;
    const sh = path.join(dir, "publish-step.sh");
    await fs.writeFile(sh, `set -euo pipefail\n${pubStep.run}\n`);
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      RUNNER_TEMP: dir,
      RELEASE_VERSION: "9.9.9",
      RELEASE_SHA: SHA,
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

  it("U2 e2e: runner-local swap published after the recheck is detected, deprecated, and fails LOUDLY", async () => {
    // Registry reports ATTACKER bytes after publish (swap needed NO preimage).
    const r = await u2Fixture({ registryIntegrity: WRONG_INTEGRITY, startAbsent: true });
    expect(r.published, "swap reaches the publish invocation (recheck cannot close the handoff)").toBe(true);
    expect(r.code, "attestation must fail the workflow LOUDLY").not.toBe(0);
    expect(r.out, "mismatch is loud").toMatch(/attestation.*fail|mismatch/i);
    expect(r.deprecated, "mismatched version is deprecated to block installs").toBe(true);
    expect(r.out, "trace records the decision").toMatch(/trace/i);
  });

  it("U2 e2e control: clean publish attests and proceeds (no deprecate)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-prov3-u2c-"));
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "aeh-test-pkg", version: "9.9.9" }));
    const pack = spawnSync("npm", ["pack", "--pack-destination", dir, "--silent"], { cwd: dir, encoding: "utf8" });
    if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`);
    const baseTgz = (await fs.readdir(dir)).find((f) => f.endsWith(".tgz"))!;
    const baseBytes = await fs.readFile(path.join(dir, baseTgz));
    const baseDigest = `sha512-${createHash("sha512").update(baseBytes).digest("base64")}`;
    const r = await u2Fixture({ registryIntegrity: baseDigest, startAbsent: true });
    expect(r.published, "clean publish still publishes").toBe(true);
    expect(r.code, "matching integrity attests clean").toBe(0);
    expect(r.deprecated, "clean publish never deprecates").toBe(false);
    expect(r.out, "attestation success is traced").toMatch(/attestation verified/i);
  });
});
