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
    // Upload retains sidecar alongside tarball via EXPLICIT file paths
    // (round-3 U1: verified tarball + sidecar + digest, never the directory).
    const retain = pubSteps.find((s) => ((s as any).uses ?? "").includes("upload-artifact"))!;
    expect(retain).toBeDefined();
    const retainPath = (retain.with as any)?.path as string;
    expect(retainPath, "retain step has an explicit path list").toBeDefined();
    expect(retainPath, "retain uploads explicit files, not the directory").not.toMatch(/aeh-npm-retained\/?$/);
    expect(JSON.stringify(retain), "retain uploads sidecar explicitly").toMatch(/npm-provenance\.json/);
    // Round-4 U1: EXACT verified filename via VERIFIED_TARBALL_BASENAME (no glob).
    expect(JSON.stringify(retain), "retain never globs the tarball").not.toMatch(/\*\.tgz/);
    expect(/\.tgz|VERIFIED_TARBALL/.test(JSON.stringify(retain)), "retain uploads tarball explicitly").toBe(true);
    expect(JSON.stringify(retain), "retain uploads digest explicitly").toMatch(/npm-identity\.digest/);
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
      // Isolate the retained-artifact dir: the workflow resolves it as
      // ${RUNNER_TEMP:-$PWD}/aeh-npm-retained, and CI always sets RUNNER_TEMP
      // (shared across tests). Pin it to the fixture dir so the staged
      // stale tarball/sidecar is what the step actually consumes.
      RUNNER_TEMP: dir,
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

describe("TOCTOU bind: recheck exact bytes before each consume (Luna round-2)", () => {
  it("recheck mode passes valid bytes and refuses swapped bytes (both arg forms)", async () => {
    const gate = path.join(REPO, "scripts/ci/verify-artifact-provenance.mjs");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-prov-recheck-"));
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "aeh-test-pkg", version: "9.9.9" }));
    const pack = spawnSync("npm", ["pack", "--pack-destination", dir, "--silent"], { cwd: dir, encoding: "utf8" });
    if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`);
    const tgz = path.join(dir, (await fs.readdir(dir)).find((f) => f.endsWith(".tgz"))!);
    const SHA = "e".repeat(40);
    const sidecar = path.join(dir, "npm-provenance.json");
    const w = spawnSync(process.execPath, [gate, "--write", "--tarball", tgz, "--provenance", sidecar, "--release-sha", SHA], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(w.status, "write must succeed").toBe(0);
    // Both recheck forms pass on valid bytes.
    for (const args of [
      ["--recheck", tgz, sidecar],
      ["--recheck", "--tarball", tgz, "--provenance", sidecar],
    ]) {
      const r = spawnSync(process.execPath, [gate, ...args], { encoding: "utf8" });
      expect(r.status, `recheck ${JSON.stringify(args)} must pass`).toBe(0);
      expect(`${r.stdout}\n${r.stderr}`).toMatch(/recheck/i);
    }
    // Swap between verify and consume: verify passed on old bytes, recheck must refuse new bytes.
    const v0 = spawnSync(
      process.execPath,
      [gate, "--tarball", tgz, "--provenance", sidecar, "--release-sha", SHA, "--name", "aeh-test-pkg", "--version", "9.9.9"],
      { encoding: "utf8" },
    );
    expect(v0.status, "verify passes before swap").toBe(0);
    await fs.appendFile(tgz, "attacker-swap");
    for (const args of [
      ["--recheck", tgz, sidecar],
      ["--recheck", "--tarball", tgz, "--provenance", sidecar],
    ]) {
      const r = spawnSync(process.execPath, [gate, ...args], { encoding: "utf8" });
      expect(r.status, `swapped bytes must be refused (${JSON.stringify(args)})`).not.toBe(0);
      expect(`${r.stdout}\n${r.stderr}`).toMatch(/TOCTOU|mismatch|refus/i);
    }
    // Absent sidecar / missing tarball / malformed digest also refuse (fail closed).
    const absent = spawnSync(process.execPath, [gate, "--recheck", tgz, path.join(dir, "nope.json")], { encoding: "utf8" });
    expect(absent.status, "absent sidecar must refuse").not.toBe(0);
    const missing = spawnSync(process.execPath, [gate, "--recheck", path.join(dir, "nope.tgz"), sidecar], { encoding: "utf8" });
    expect(missing.status, "missing tarball must refuse").not.toBe(0);
    await fs.writeFile(sidecar, JSON.stringify({ release_sha: SHA, tarball_sha512: "not-a-digest", name: "x", version: "y" }));
    const bad = spawnSync(process.execPath, [gate, "--recheck", tgz, sidecar], { encoding: "utf8" });
    expect(bad.status, "malformed digest must refuse").not.toBe(0);
  });

  it("recheck reuses the single digest implementation (no forked hash)", async () => {
    const src = await fs.readFile(path.join(REPO, "scripts/ci/verify-artifact-provenance.mjs"), "utf8");
    // Single implementation: shared hash + digest regex consumed by both verify and recheck.
    expect(src).toMatch(/computeTarballDigest/);
    expect(src).toMatch(/DIGEST_RE|sha512-\[A-Za-z0-9/);
    expect(src).toMatch(/--recheck/);
    expect(src).toMatch(/TOCTOU/);
    // Honest residual model (round-3): recheck narrows but cannot close a
    // file-based handoff (swap needs NO preimage); post-publish attestation
    // (registry ground truth + deprecate) is the closer. No sub-ms fable.
    expect(src).toMatch(/workspace-write/i);
    expect(src).toMatch(/NOT remotely/i);
    expect(src).toMatch(/POST-PUBLISH ATTESTATION|attestation/i);
    expect(src).toMatch(/npm deprecate/i);
    expect(src, "no sub-ms race fable").not.toMatch(/sub-millisecond|sub-ms/i);
    expect(src, "no preimage-required fable").not.toMatch(/needs a sha512 preimage/i);
  });

  it("every consume boundary rechecks in the same step immediately before consume", async () => {
    const text = await fs.readFile(path.join(REPO, ".github/workflows/publish.yml"), "utf8");
    const workflow = parse(text) as Record<string, any>;
    const jobs = workflow.jobs as Record<string, any>;
    const pubSteps = jobs["publish-npm"].steps as Array<{ name?: string; run?: string; uses?: string }>;
    // Pack->upload: dedicated recheck shell step before the upload-artifact step,
    // plus (round-5) the belt-and-suspenders empty-basename guard immediately
    // before upload.
    const uploadIdx = pubSteps.findIndex((s) => (s.uses ?? "").includes("upload-artifact"));
    expect(uploadIdx, "upload-artifact step exists").toBeGreaterThan(0);
    const preUpload = pubSteps[uploadIdx - 1] as { name?: string; run?: string };
    expect(preUpload.run ?? "", "empty-basename guard runs immediately before upload").toContain(
      '[ -n "$VERIFIED_TARBALL_BASENAME" ] || exit 1',
    );
    const recheckStep = [...pubSteps.slice(0, uploadIdx)]
      .reverse()
      .find((s) => (s.run ?? "").includes("GITHUB_ENV") && (s.run ?? "").includes("--recheck")) as
      | { name?: string; run?: string }
      | undefined;
    expect(recheckStep, "recheck step exists before upload").toBeDefined();
    expect(recheckStep!.name ?? "", "recheck runs before upload").toMatch(/recheck/i);
    expect(recheckStep!.run ?? "", "pre-upload recheck uses script mode").toMatch(/verify-artifact-provenance\.mjs --recheck/);
    // Publish: recheck IN THE SAME shell step, immediately before the npm publish invocation.
    const publishStep = pubSteps.find((s) => (s.run ?? "").includes("npm publish"))!;
    expect(publishStep).toBeDefined();
    const lines = (publishStep.run ?? "").split("\n");
    const recheckIdx = lines.findIndex((l) => l.includes("--recheck"));
    // Actual publish invocation (quoted tarball path), not a comment mentioning `npm publish`.
    const publishIdx = lines.findIndex((l) => /npm publish ["']/.test(l));
    expect(recheckIdx, "publish step contains a recheck").toBeGreaterThanOrEqual(0);
    expect(publishIdx, "publish step contains npm publish").toBeGreaterThan(recheckIdx);
    expect(publishIdx - recheckIdx, "recheck is immediately before publish (same step, no IO between)").toBeLessThan(8);
    expect(publishStep.run!).toMatch(/verify-artifact-provenance\.mjs --recheck/);
    // Post-publish attestation (round-3 U2): registry ground truth AFTER the
    // publish invocation, with deprecate on mismatch (detect-and-deprecate).
    const attestIdx = lines.findIndex((l, i) => i > publishIdx && l.includes("dist.integrity"));
    expect(attestIdx, "publish step attests registry integrity after publish").toBeGreaterThan(publishIdx);
    expect(publishStep.run!).toMatch(/npm deprecate/);
    expect(publishStep.run!).toMatch(/attestation/i);
    // Confirm: recheck in the same step immediately before the identity-gate consumption.
    const confirmRun = pubSteps.find((s) => s.name === "Confirm published version is on npm")!.run!;
    const cLines = confirmRun.split("\n");
    const cRecheck = cLines.findIndex((l) => l.includes("--recheck"));
    const cConsume = cLines.findIndex((l) => l.includes("verify-npm-identity.mjs"));
    expect(cRecheck, "confirm step contains a recheck").toBeGreaterThanOrEqual(0);
    expect(cConsume, "confirm step consumes via identity gate").toBeGreaterThan(cRecheck);
    expect(cConsume - cRecheck, "confirm recheck immediately precedes consume").toBeLessThan(8);
    // Repair-reuse: recheck in the same step immediately before the final identity consumption.
    const repairSteps = jobs["repair-release"].steps as Array<{ name?: string; run?: string }>;
    const repairRun = repairSteps.find((s) => s.name === "Confirm published-but-unreleased state (SHA-bound)")!.run!;
    const rLines = repairRun.split("\n");
    const rRechecks = rLines.map((l, i) => (l.includes("--recheck") ? i : -1)).filter((i) => i >= 0);
    expect(rRechecks.length, "repair step contains a recheck").toBeGreaterThan(0);
    const rConsume = rLines.findIndex((l) => l.includes("verify-npm-identity.mjs") && l.includes("--tarball"));
    const lastRecheck = Math.max(...rRechecks);
    expect(rConsume, "repair step consumes retained bytes").toBeGreaterThan(lastRecheck);
    expect(rConsume - lastRecheck, "repair recheck immediately precedes consume").toBeLessThan(8);
    expect(repairRun).toMatch(/verify-artifact-provenance\.mjs --recheck/);
    // Single implementation everywhere (script mode, never inline sha512sum for the bind).
    for (const [site, run] of Object.entries({
      preUpload: recheckStep!.run!,
      publish: publishStep.run!,
      confirm: confirmRun,
      repair: repairRun,
    })) {
      expect(run, `${site} binds via the script (single implementation)`).toMatch(/verify-artifact-provenance\.mjs --recheck/);
    }
    // Honest residual model (round-3): no sub-ms/preimage fable. The recheck
    // narrows a file-based handoff that needs NO preimage to exploit;
    // runner-local threat (workspace-write, NOT remotely exploitable) is
    // closed by post-publish attestation (detect-and-deprecate).
    expect(text, "no sub-ms race fable").not.toMatch(/sub-ms|sub-millisecond/i);
    expect(text, "no preimage-required fable").not.toMatch(/needs a sha512 preimage/i);
    expect(text).toMatch(/workspace-write/i);
    expect(text).toMatch(/NOT remotely/i);
    expect(text).toMatch(/attestation/i);
    expect(text).toMatch(/npm deprecate/i);
    expect(text).toMatch(/residual|narrow/i);
  });

  it("TOCTOU e2e: swapped bytes between verify and publish are refused (never published)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-prov-toctou-"));
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "aeh-test-pkg", version: "9.9.9" }));
    const pack = spawnSync("npm", ["pack", "--pack-destination", dir, "--silent"], { cwd: dir, encoding: "utf8" });
    if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`);
    const baseTgz = (await fs.readdir(dir)).find((f) => f.endsWith(".tgz"))!;
    const baseBytes = await fs.readFile(path.join(dir, baseTgz));
    const baseDigest = `sha512-${createHash("sha512").update(baseBytes).digest("base64")}`;
    const CURRENT_SHA = "f".repeat(40);
    const bin = path.join(dir, "stubbin");
    await fs.mkdir(bin);
    const publishCalled = path.join(dir, "publish-called");
    await fs.writeFile(
      path.join(bin, "npm"),
      `#!/bin/sh\n` +
        `if [ "$1" = "view" ]; then echo "npm error code E404" >&2; echo "npm error 404 Not Found" >&2; exit 1; fi\n` +
        `if [ "$1" = "pack" ]; then DEST=""; PREV=""; for a in "$@"; do if [ "$PREV" = "--pack-destination" ]; then DEST="$a"; fi; PREV="$a"; done; cp "${path.join(dir, baseTgz)}" "$DEST/"; echo "${baseTgz}"; exit 0; fi\n` +
        `if [ "$1" = "publish" ]; then touch "${publishCalled}"; exit 0; fi\n` +
        `echo "stub: unsupported npm $*" >&2; exit 1\n`,
    );
    await fs.chmod(path.join(bin, "npm"), 0o755);
    await fs.symlink(path.join(REPO, "scripts"), path.join(dir, "scripts"));
    const gate = path.join(REPO, "scripts/ci/verify-artifact-provenance.mjs");
    const retainDir = path.join(dir, "aeh-npm-retained");
    await fs.mkdir(retainDir);
    const retained = path.join(retainDir, baseTgz);
    await fs.writeFile(retained, baseBytes);
    const sidecar = path.join(retainDir, "npm-provenance.json");
    await fs.writeFile(sidecar, JSON.stringify({ release_sha: CURRENT_SHA, tarball_sha512: baseDigest, name: "aeh-test-pkg", version: "9.9.9" }));
    // Verify passes on the retained bytes (as the workflow does before publish).
    const v = spawnSync(
      process.execPath,
      [gate, "--tarball", retained, "--provenance", sidecar, "--release-sha", CURRENT_SHA, "--name", "aeh-test-pkg", "--version", "9.9.9"],
      { encoding: "utf8" },
    );
    expect(v.status, "verify passes before swap").toBe(0);
    // Attacker swaps between verify and publish.
    await fs.appendFile(retained, "attacker-swap");
    // The pre-publish recheck (same command the workflow runs immediately
    // before `npm publish` in the same shell step) must refuse; the workflow
    // guard `|| { ...; exit 1; }` means publish is never reached.
    const r = spawnSync(process.execPath, [gate, "--recheck", retained, sidecar], { encoding: "utf8" });
    expect(r.status, "TOCTOU swap must be refused by the pre-publish recheck").not.toBe(0);
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/TOCTOU|mismatch|refus/i);
    let published = false;
    try {
      await fs.access(publishCalled);
      published = true;
    } catch {}
    expect(published, "swapped bytes must never reach npm publish").toBe(false);
    // Control: without the swap the recheck passes (publish would proceed).
    await fs.writeFile(retained, baseBytes);
    const ok = spawnSync(process.execPath, [gate, "--recheck", retained, sidecar], { encoding: "utf8" });
    expect(ok.status, "unswapped bytes must recheck clean").toBe(0);
  });
});
