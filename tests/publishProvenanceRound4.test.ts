import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// Round-4 (Luna U1-U4): repair of round-3 rejection a469a95.
// U1: upload path STILL globs *.tgz — sibling landing between guard and upload
//   escapes. Fix: upload the EXACT verified filename (deterministic
//   package-name-version.tgz, no glob anywhere in the upload step).
// U2: deprecate `|| true` swallows failure. Fix: bounded retry (3x); persistent
//   failure -> loud fail with MANUAL-DEPRECATE runbook (version + exact command
//   + reason). Never silent.
// U3: registry-MITM trust boundary undocumented. Fix: document in workflow
//   comments + helper header that attestation trusts the npm registry TLS
//   channel (dist.integrity as ground truth); registry-compromise/valid-TLS-MITM
//   explicitly outside threat model.
// U4: repair-release mismatch has no deprecate. Fix: same deprecate-on-mismatch
//   pattern on the repair leg (retry + runbook).
// No live publish: `npm` is stubbed.
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

function repairSteps(workflow: Record<string, any>) {
  return (workflow.jobs as Record<string, any>)["repair-release"].steps as Array<{
    name?: string;
    run?: string;
    uses?: string;
    with?: any;
    env?: any;
  }>;
}

describe("round-4 U1: upload binds the EXACT verified filename (no glob)", () => {
  it("upload path fields contain zero `*.tgz` globs", async () => {
    const { workflow } = await loadPublish();
    const steps = publishNpmSteps(workflow);
    const upload = steps.find((s) => (s.uses ?? "").includes("upload-artifact"));
    expect(upload, "upload-artifact step exists").toBeDefined();
    const p = String((upload!.with as any)?.path ?? "");
    expect(p, "upload path exists").not.toBe("");
    expect(p, "upload must not glob *.tgz (sibling would escape)").not.toMatch(/\*\.tgz/);
    // Explicit file: either a literal .tgz filename or the EXACT verified
    // basename exported by the recheck step (resolves to package-name-version.tgz).
    const isExplicitTgz = /\.tgz/.test(p) || /VERIFIED_TARBALL/.test(p);
    expect(isExplicitTgz, "upload still names the explicit tarball file (literal .tgz or VERIFIED_TARBALL basename)").toBe(true);
    expect(p, "sidecar is explicit").toMatch(/npm-provenance\.json/);
    expect(p, "digest is explicit").toMatch(/npm-identity\.digest/);
  });

  it("recheck exports the EXACT verified basename; upload consumes it (no glob anywhere in upload)", async () => {
    const { workflow, text } = await loadPublish();
    const steps = publishNpmSteps(workflow);
    const idx = steps.findIndex((s) => (s.uses ?? "").includes("upload-artifact"));
    expect(idx).toBeGreaterThan(0);
    // Round-5: belt-and-suspenders empty-basename guard sits immediately before
    // upload; the GITHUB_ENV-exporting recheck is the nearest prior step that
    // mentions GITHUB_ENV.
    const recheck = [...steps.slice(0, idx)]
      .reverse()
      .find((s) => (s.run ?? "").includes("GITHUB_ENV")) as { name?: string; run?: string } | undefined;
    expect(recheck, "recheck step exporting via GITHUB_ENV exists before upload").toBeDefined();
    expect(recheck!.run ?? "", "recheck pins the exact verified file").toMatch(/VERIFIED_TARBALL_BASENAME|VERIFIED_TARBALL/);
    expect(recheck!.run ?? "", "exact basename is exported for the upload step").toMatch(/GITHUB_ENV/);
    const upload = steps[idx] as any;
    const uploadYaml = JSON.stringify(upload.with ?? {});
    expect(uploadYaml, "no glob anywhere in the upload step").not.toMatch(/\*\.tgz/);
    // The upload path must resolve to the deterministic package-name-version.tgz:
    // either via the exported basename or via a version-pinned explicit filename.
    const uploadPath = String((upload.with as any)?.path ?? "");
    const usesVerifiedEnv = /VERIFIED_TARBALL/.test(uploadPath);
    const usesVersionPin = /needs\.publish\.outputs\.version/.test(uploadPath) && /\.tgz/.test(uploadPath);
    expect(usesVerifiedEnv || usesVersionPin, "upload path is the EXACT verified filename (env basename or version-pinned .tgz)").toBe(true);
    expect(text, "workflow documents the exact-file bind").toMatch(/EXACT|exact verified/i);
  });
});

describe("round-4 U2: deprecate never swallows failure (bounded retry + runbook)", () => {
  it("publish attestation retries deprecate 3x and emits MANUAL-DEPRECATE runbook (no `|| true`)", async () => {
    const { workflow } = await loadPublish();
    const steps = publishNpmSteps(workflow);
    const pub = steps.find((s) => (s.run ?? "").includes("npm publish"))!;
    expect(pub).toBeDefined();
    const run = pub!.run!;
    // No silent swallow anywhere near deprecate.
    const deprecateLines = run.split("\n").filter((l) => l.includes("deprecate"));
    expect(deprecateLines.length, "deprecate invocation exists").toBeGreaterThan(0);
    for (const l of deprecateLines) {
      // Allow `|| true` only on pure diagnostic listings, never on deprecate.
      expect(l, "deprecate must never be silenced with `|| true`").not.toMatch(/\|\|\s*true/);
    }
    expect(run, "bounded retry (3 attempts)").toMatch(/3|retry|attempt/i);
    expect(run, "retry loop mentions attempts").toMatch(/attempt|for .* in 1 2 3|seq|retry/i);
    expect(run, "persistent failure prints MANUAL-DEPRECATE runbook").toMatch(/MANUAL-DEPRECATE/);
    expect(run, "runbook carries the exact deprecate command").toMatch(/npm deprecate/);
    expect(run, "runbook carries version + reason").toMatch(/version|reason/i);
    expect(run, "attestation still fails LOUDLY").toMatch(/exit 1/);
  });

  it("U2 e2e: persistent deprecate failure is LOUD with MANUAL-DEPRECATE runbook (stub npm, no live publish)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-prov4-u2-"));
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
    const deprecateCalls = path.join(dir, "deprecate-calls");
    await fs.writeFile(
      path.join(bin, "npm"),
      `#!/bin/sh\n` +
        `if [ "$1" = "view" ]; then\n` +
        `  if [ ! -f "${publishCalled}" ]; then echo "npm error code E404" >&2; echo "npm error 404 Not Found" >&2; exit 1; fi\n` +
        `  case "$3" in version) echo "9.9.9";; dist.integrity) echo "${WRONG_INTEGRITY}";; dist.shasum) echo "";; *) exit 1;; esac\n` +
        `  exit 0\nfi\n` +
        `if [ "$1" = "pack" ]; then DEST=""; PREV=""; for a in "$@"; do if [ "$PREV" = "--pack-destination" ]; then DEST="$a"; fi; PREV="$a"; done; cp "${path.join(dir, baseTgz)}" "$DEST/"; echo "${baseTgz}"; exit 0; fi\n` +
        `if [ "$1" = "publish" ]; then touch "${publishCalled}"; exit 0; fi\n` +
        // Deprecate ALWAYS fails (persistent failure) but counts calls.
        `if [ "$1" = "deprecate" ]; then echo "x" >> "${deprecateCalls}"; echo "stub deprecate failed (persistent)" >&2; exit 1; fi\n` +
        `echo "stub: unsupported npm $*" >&2; exit 1\n`,
    );
    await fs.chmod(path.join(bin, "npm"), 0o755);
    // Stub `sleep` so the bounded 3x retry (sleep 5) stays fast offline.
    await fs.writeFile(path.join(bin, "sleep"), `#!/bin/sh\nexit 0\n`);
    await fs.chmod(path.join(bin, "sleep"), 0o755);
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
    expect(r.status, "persistent deprecate failure must still fail LOUDLY").not.toBe(0);
    expect(out, "MANUAL-DEPRECATE runbook is printed").toMatch(/MANUAL-DEPRECATE/);
    expect(out, "runbook carries version + exact command").toMatch(/aeh-test-pkg@9\.9\.9[\s\S]*npm deprecate|npm deprecate[\s\S]*aeh-test-pkg@9\.9\.9/);
    let calls = 0;
    try {
      const raw = await fs.readFile(deprecateCalls, "utf8");
      calls = raw.split("\n").filter((l) => l.trim() === "x").length;
    } catch {}
    expect(calls, "deprecate is retried (bounded 3x)").toBe(3);
  });
});

describe("round-4 U3: registry-MITM trust boundary documented", () => {
  it("workflow comments document TLS trust + out-of-scope registry compromise", async () => {
    const { text } = await loadPublish();
    expect(text, "attestation trusts the npm registry TLS channel").toMatch(/TLS/i);
    expect(text, "dist.integrity is the ground truth").toMatch(/dist\.integrity[\s\S]{0,200}ground truth|ground truth[\s\S]{0,200}dist\.integrity/i);
    expect(text, "registry-compromise / valid-TLS-MITM explicitly out of scope").toMatch(/outside threat model|out of scope|out-of-scope/i);
    expect(text, "names the MITM / registry-compromise adversary").toMatch(/MITM|registry-compromis/i);
  });

  it("helper headers document the same trust boundary", async () => {
    const prov = await fs.readFile(path.join(REPO, "scripts/ci/verify-artifact-provenance.mjs"), "utf8");
    const ident = await fs.readFile(path.join(REPO, "scripts/ci/verify-npm-identity.mjs"), "utf8");
    for (const [name, src] of [["verify-artifact-provenance.mjs", prov], ["verify-npm-identity.mjs", ident]] as Array<[string, string]>) {
      expect(src, `${name} documents TLS trust`).toMatch(/TLS/i);
      expect(src, `${name} documents dist.integrity ground truth`).toMatch(/dist\.integrity|ground truth/i);
      expect(src, `${name} marks registry-compromise out of scope`).toMatch(/outside threat model|out of scope|out-of-scope/i);
    }
  });
});

describe("round-4 U4: repair leg deprecates on mismatch (retry + runbook)", () => {
  it("repair confirm deprecates on identity mismatch (same pattern as publish leg)", async () => {
    const { workflow } = await loadPublish();
    const steps = repairSteps(workflow);
    const confirm = steps.find((s) => (s.name ?? "").includes("Confirm published-but-unreleased"))!;
    expect(confirm).toBeDefined();
    const run = confirm!.run!;
    expect(run, "repair mismatch deprecates to block installs").toMatch(/npm deprecate/);
    const deprecateLines = run.split("\n").filter((l) => l.includes("deprecate"));
    for (const l of deprecateLines) {
      expect(l, "repair deprecate never silenced").not.toMatch(/\|\|\s*true/);
    }
    expect(run, "repair retry is bounded (3x)").toMatch(/3|retry|attempt/i);
    expect(run, "repair prints MANUAL-DEPRECATE runbook on persistent failure").toMatch(/MANUAL-DEPRECATE/);
    expect(run, "repair runbook carries the exact command").toMatch(/npm deprecate/);
  });

  it("U4 e2e: repair mismatch is deprecated + fails LOUDLY (stub npm, no live publish)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-prov4-u4-"));
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "aeh-test-pkg", version: "9.9.9" }));
    const pack = spawnSync("npm", ["pack", "--pack-destination", dir, "--silent"], { cwd: dir, encoding: "utf8" });
    if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`);
    const baseTgz = (await fs.readdir(dir)).find((f) => f.endsWith(".tgz"))!;
    const baseBytes = await fs.readFile(path.join(dir, baseTgz));
    const baseDigest = `sha512-${createHash("sha512").update(baseBytes).digest("base64")}`;
    const SHA = "c".repeat(40);
    const bin = path.join(dir, "stubbin");
    await fs.mkdir(bin);
    const deprecated = path.join(dir, "deprecated-marker");
    // Registry reports ATTACKER bytes (mismatch); version present; tag/HEAD plumbing stubbed via git.
    await fs.writeFile(
      path.join(bin, "npm"),
      `#!/bin/sh\n` +
        `if [ "$1" = "view" ]; then case "$3" in version) echo "9.9.9";; dist.integrity) echo "${WRONG_INTEGRITY}";; dist.shasum) echo "";; *) exit 1;; esac; exit 0; fi\n` +
        `if [ "$1" = "deprecate" ]; then touch "${deprecated}"; echo "$@" > "${deprecated}.args"; exit 0; fi\n` +
        `echo "stub: unsupported npm $*" >&2; exit 1\n`,
    );
    await fs.chmod(path.join(bin, "npm"), 0o755);
    await fs.symlink(path.join(REPO, "scripts"), path.join(dir, "scripts"));
    // Minimal git repo: tag v9.9.9 == HEAD, version matches.
    spawnSync("git", ["init", "-q"], { cwd: dir });
    spawnSync("git", ["config", "user.email", "t@t.t"], { cwd: dir });
    spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
    await fs.writeFile(path.join(dir, "marker.txt"), "x");
    spawnSync("git", ["add", "."], { cwd: dir });
    spawnSync("git", ["commit", "-qm", "init"], { cwd: dir });
    spawnSync("git", ["tag", "v9.9.9"], { cwd: dir });
    // Mock `git fetch` + `git rev-list`/`rev-parse`/`describe` via PATH shim so the
    // repair script runs offline: wrap real git, short-circuit fetch to success.
    const gitShim = path.join(bin, "git");
    await fs.writeFile(
      gitShim,
      `#!/bin/sh\nif [ "$1" = "fetch" ]; then exit 0; fi\nexec /usr/bin/git "$@"\n`,
    );
    await fs.chmod(gitShim, 0o755);
    const retainDir = path.join(dir, "aeh-npm-retained");
    await fs.mkdir(retainDir);
    await fs.writeFile(path.join(retainDir, baseTgz), baseBytes);
    await fs.writeFile(
      path.join(retainDir, "npm-provenance.json"),
      JSON.stringify({ release_sha: SHA, tarball_sha512: baseDigest, name: "aeh-test-pkg", version: "9.9.9" }),
    );
    // Rewrite sidecar release_sha to HEAD so provenance passes and only the
    // registry-identity gate mismatches (the U4 path).
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
    await fs.writeFile(
      path.join(retainDir, "npm-provenance.json"),
      JSON.stringify({ release_sha: head, tarball_sha512: baseDigest, name: "aeh-test-pkg", version: "9.9.9" }),
    );
    const { workflow } = await loadPublish();
    const steps = repairSteps(workflow);
    const confirm = steps.find((s) => (s.name ?? "").includes("Confirm published-but-unreleased"))!;
    const sh = path.join(dir, "repair-step.sh");
    await fs.writeFile(sh, `set -euo pipefail\n${confirm!.run}\n`);
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      RUNNER_TEMP: dir,
      RELEASE_VERSION: "9.9.9",
    } as NodeJS.ProcessEnv;
    const r = spawnSync("bash", [sh], { cwd: dir, env, encoding: "utf8" });
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    expect(r.status, "repair mismatch must fail LOUDLY").not.toBe(0);
    expect(out, "repair mismatch is loud").toMatch(/mismatch|attestation|identity/i);
    let wasDeprecated = false;
    try {
      await fs.access(deprecated);
      wasDeprecated = true;
    } catch {}
    expect(wasDeprecated, "repair mismatch deprecates to block installs").toBe(true);
  });
});
