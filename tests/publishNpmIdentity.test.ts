import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(import.meta.dirname, "..");
const WRONG_INTEGRITY = "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

async function fixture(stub: { absent?: boolean; integrity?: string; registryError?: string }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-npmid-"));
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "aeh-test-pkg", version: "9.9.9" }));
  // Local tarball = what `npm pack` would upload; its real digest is ground truth.
  const pack = spawnSync("npm", ["pack", "--pack-destination", dir, "--silent"], { cwd: dir, encoding: "utf8" });
  if (pack.status !== 0) throw new Error(`npm pack failed offline: ${pack.stderr}`);
  const tgz = (await fs.readdir(dir)).find((f) => f.endsWith(".tgz"))!;
  const bytes = await fs.readFile(path.join(dir, tgz));
  const localIntegrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const bin = path.join(dir, "stubbin");
  await fs.mkdir(bin);
  const publishCalled = path.join(dir, "publish-called");
  await fs.writeFile(
    path.join(bin, "npm"),
    `#!/bin/sh\n` +
      `if [ "$1" = "view" ]; then\n` +
      `  if [ -n "$STUB_REGISTRY_ERROR" ]; then echo "npm error code $STUB_REGISTRY_ERROR" >&2; echo "npm error network $STUB_REGISTRY_ERROR" >&2; exit 1; fi\n` +
      `  if [ -n "$STUB_ABSENT" ]; then echo "npm error code E404" >&2; echo "npm error 404 Not Found" >&2; exit 1; fi\n` +
      `  case "$3" in version) echo "$STUB_VERSION";; dist.integrity) echo "$STUB_INTEGRITY";; dist.shasum) echo "$STUB_SHASUM";; *) exit 1;; esac\n` +
      `  exit 0\nfi\n` +
      `if [ "$1" = "pack" ]; then DEST=""; PREV=""; for a in "$@"; do if [ "$PREV" = "--pack-destination" ]; then DEST="$a"; fi; PREV="$a"; done; cp "${path.join(dir, tgz)}" "$DEST/"; echo "${tgz}"; exit 0; fi\n` +
      `if [ "$1" = "publish" ]; then touch "${publishCalled}"; echo "$@" > "${publishCalled}.args"; exit 0; fi\n` +
      `echo "stub: unsupported npm $*" >&2; exit 1\n`,
  );
  await fs.chmod(path.join(bin, "npm"), 0o755);
  // Helper resolves `scripts/ci/...` relative to cwd: link repo scripts into fixture.
  await fs.symlink(path.join(REPO, "scripts"), path.join(dir, "scripts"));
  return {
    dir,
    bin,
    publishCalled,
    localIntegrity,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      RELEASE_VERSION: "9.9.9",
      // Provenance binding: the publish step requires RELEASE_SHA to write /
      // verify the sidecar (absent/invalid/mismatch fails closed). Fixtures
      // model the current run's SHA so fresh-pack writes a valid sidecar.
      RELEASE_SHA: "a1b2c3d4e5a1b2c3d4e5a1b2c3d4e5a1b2c3d4e5",
      STUB_VERSION: "9.9.9",
      STUB_INTEGRITY: stub.integrity ?? localIntegrity,
      STUB_SHASUM: "",
      ...(stub.absent ? { STUB_ABSENT: "1" } : {}),
      ...(stub.registryError ? { STUB_REGISTRY_ERROR: stub.registryError } : {}),
    } as NodeJS.ProcessEnv,
  };
}

async function publishStepRun(fx: Awaited<ReturnType<typeof fixture>>) {
  const text = await fs.readFile(path.join(REPO, ".github/workflows/publish.yml"), "utf8");
  const workflow = parse(text) as Record<string, any>;
  const steps = (workflow.jobs as Record<string, any>)["publish-npm"].steps as Array<{ name?: string; run?: string }>;
  const pubStep = steps.find((s) => (s.run ?? "").includes("npm publish"))!;
  const sh = path.join(fx.dir, "publish-step.sh");
  await fs.writeFile(sh, `set -euo pipefail\n${pubStep.run}\n`);
  const r = spawnSync("bash", [sh], { cwd: fx.dir, env: fx.env, encoding: "utf8" });
  let published = false;
  try {
    await fs.access(fx.publishCalled);
    published = true;
  } catch {}
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}`, published };
}

describe("npm resume identity (fail closed on content mismatch)", () => {
  it("mismatched registry content must NOT skip-publish / release (fail closed)", async () => {
    const fx = await fixture({ integrity: WRONG_INTEGRITY });
    const r = await publishStepRun(fx);
    expect(r.published).toBe(false); // never publish OVER a foreign tarball
    expect(r.code).not.toBe(0); // FAILS pre-repair: existence-only logic exits 0 (gap)
    expect(r.out).toMatch(/mismatch|refus|fail/i);
  });

  it("identical integrity resumes idempotently (skip, no publish)", async () => {
    const fx = await fixture({});
    const r = await publishStepRun(fx);
    expect(r.code).toBe(0);
    expect(r.published).toBe(false);
    expect(r.out).toMatch(/skipping publish|idempotent|verified identical/i);
  });

  it("absent version still publishes", async () => {
    const fx = await fixture({ absent: true });
    const r = await publishStepRun(fx);
    expect(r.code).toBe(0);
    expect(r.published).toBe(true);
  });

  it("all resume/release gates delegate to the canonical identity gate (fail closed)", async () => {
    const text = await fs.readFile(path.join(REPO, ".github/workflows/publish.yml"), "utf8");
    const workflow = parse(text) as Record<string, any>;
    const jobs = workflow.jobs as Record<string, any>;
    const runs = (steps: Array<{ run?: string }>) => (steps ?? []).map((s) => s.run ?? "").join("\n");
    const publishGate = (jobs.publish.steps as Array<{ name?: string; run?: string }>).find(
      (s) => s.name === "Repair missing GitHub Release for current version",
    )!.run!;
    const pubSteps = jobs["publish-npm"].steps as Array<{ name?: string; run?: string }>;
    const publishRun = pubSteps.find((s) => (s.run ?? "").includes("npm publish"))!.run!;
    const confirmRun = pubSteps.find((s) => s.name === "Confirm published version is on npm")!.run!;
    const repairRun = runs(jobs["repair-release"].steps);
    for (const [site, run] of Object.entries({ publishGate, publishRun, confirmRun, repairRun })) {
      // Same check everywhere: canonical gate (which compares dist.integrity /
      // dist.shasum against the local tarball), never bare existence.
      expect(run, site).toContain("verify-npm-identity.mjs");
      expect(run, site).toMatch(/mismatch/i);
      // Retain+reuse: every gate compares THE SAME tarball bytes (no fresh repack).
      expect(run, site).toMatch(/--tarball|--local-digest/);
    }
    // Publish path publishes THE SAME retained tarball and fails UNKNOWN loudly.
    expect(publishRun).toMatch(/npm publish .*TARBALL|npm publish "\$/i);
    expect(publishRun).toMatch(/-eq 3|UNKNOWN/);
    // The gate itself compares digests, never mere existence.
    const gate = await fs.readFile(path.join(REPO, "scripts/ci/verify-npm-identity.mjs"), "utf8");
    expect(gate).toContain("dist.integrity");
    expect(gate).toContain("dist.shasum");
    expect(gate).toContain('"pack"');
    expect(gate).toMatch(/process\.exit\(1\)/);
  });

  it("identity helper exit codes: 0 identical, 1 mismatch, 2 absent, 3 unknown", async () => {
    const gate = path.join(REPO, "scripts/ci/verify-npm-identity.mjs");
    const run = (fx: Awaited<ReturnType<typeof fixture>>) =>
      spawnSync(process.execPath, [gate, "aeh-test-pkg", "9.9.9"], { cwd: fx.dir, env: fx.env, encoding: "utf8" });
    const same = run(await fixture({}));
    expect(same.status).toBe(0);
    const diff = run(await fixture({ integrity: WRONG_INTEGRITY }));
    expect(diff.status).toBe(1);
    expect(diff.stderr).toMatch(/mismatch/i);
    expect(run(await fixture({ absent: true })).status).toBe(2);
    // N2 RED: registry lookup failure (network/auth/parse, no 404) must be
    // UNKNOWN exit 3, never absent exit 2.
    const netErr = run(await fixture({ registryError: "ENETUNREACH" }));
    expect(netErr.status).toBe(3);
    expect(`${netErr.stdout}\n${netErr.stderr}`).toMatch(/unknown/i);
  });

  it("N1 RED: retry reuses retained tarball instead of repacking (rebuild-nondeterminism)", async () => {
    // Nondeterministic pack: every `npm pack` yields different bytes
    // (timestamp suffix). Registry holds FIRST-pack content (publish-then-fail-later).
    // A retry that repacks gets different bytes -> exit 1 forever (bug).
    // Fix: retain first tarball (+digest record) and reuse THE SAME bytes.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-npmid-n1-"));
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "aeh-test-pkg", version: "9.9.9" }));
    const basePack = spawnSync("npm", ["pack", "--pack-destination", dir, "--silent"], {
      cwd: dir,
      encoding: "utf8",
    });
    if (basePack.status !== 0) throw new Error(`npm pack failed offline: ${basePack.stderr}`);
    const baseTgz = (await fs.readdir(dir)).find((f) => f.endsWith(".tgz"))!;
    const baseBytes = await fs.readFile(path.join(dir, baseTgz));
    const bin = path.join(dir, "stubbin");
    await fs.mkdir(bin);
    // Nondeterministic stub pack: copy base then append nanoseconds -> digest differs per pack.
    await fs.writeFile(
      path.join(bin, "npm"),
      `#!/bin/sh\n` +
        `if [ "$1" = "view" ]; then case "$3" in version) echo "9.9.9";; dist.integrity) echo "$STUB_INTEGRITY";; *) exit 1;; esac; exit 0; fi\n` +
        `if [ "$1" = "pack" ]; then DEST=""; PREV=""; for a in "$@"; do if [ "$PREV" = "--pack-destination" ]; then DEST="$a"; fi; PREV="$a"; done; cp "${path.join(dir, baseTgz)}" "$DEST/${baseTgz}"; date +%s%N >> "$DEST/${baseTgz}"; echo "${baseTgz}"; exit 0; fi\n` +
        `if [ "$1" = "publish" ]; then exit 0; fi\n` +
        `echo "stub: unsupported npm $*" >&2; exit 1\n`,
    );
    await fs.chmod(path.join(bin, "npm"), 0o755);
    await fs.symlink(path.join(REPO, "scripts"), path.join(dir, "scripts"));
    // First pack via stub = what was published before the later failure.
    const firstOut = path.join(dir, "firstpack");
    await fs.mkdir(firstOut);
    const p1 = spawnSync("npm", ["pack", "--pack-destination", firstOut], {
      cwd: dir,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
      encoding: "utf8",
    });
    if (p1.status !== 0) throw new Error(`stub pack failed: ${p1.stderr}`);
    const firstTgz = path.join(firstOut, (await fs.readdir(firstOut)).find((f) => f.endsWith(".tgz"))!);
    const firstBytes = await fs.readFile(firstTgz);
    void baseBytes;
    const firstIntegrity = `sha512-${createHash("sha512").update(firstBytes).digest("base64")}`;
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      STUB_INTEGRITY: firstIntegrity,
    } as NodeJS.ProcessEnv;
    const gate = path.join(REPO, "scripts/ci/verify-npm-identity.mjs");
    // Fresh repack differs -> legacy helper exits 1 forever (documents the bug).
    const repacked = spawnSync(process.execPath, [gate, "aeh-test-pkg", "9.9.9"], {
      cwd: dir,
      env,
      encoding: "utf8",
    });
    expect(repacked.status).toBe(1);
    // Retain+reuse: SAME tarball must verify (exit 0). Pre-fix helper ignores
    // --tarball and repacks -> exit 1 (RED). Post-fix exit 0 (GREEN).
    const reused = spawnSync(process.execPath, [gate, "aeh-test-pkg", "9.9.9", "--tarball", firstTgz], {
      cwd: dir,
      env,
      encoding: "utf8",
    });
    expect(reused.status).toBe(0);
    // Digest-record fallback: comparing registry against the RECORDED first-pack
    // digest must verify without repacking. Pre-fix unsupported -> non-zero (RED).
    const digestFile = path.join(dir, "first.digest");
    await fs.writeFile(digestFile, `${firstIntegrity}\n`);
    const recorded = spawnSync(
      process.execPath,
      [gate, "aeh-test-pkg", "9.9.9", "--local-digest", firstIntegrity],
      { cwd: dir, env, encoding: "utf8" },
    );
    expect(recorded.status).toBe(0);
    // Workflow must retain the tarball as an artifact and reuse THE SAME file.
    const yml = await fs.readFile(path.join(REPO, ".github/workflows/publish.yml"), "utf8");
    expect(yml).toMatch(/upload-artifact/);
    expect(yml).toMatch(/download-artifact/);
    expect(yml).toMatch(/--tarball/);
    expect(yml).toMatch(/npm publish .*\.tgz|npm publish "\$|npm publish .*TARBALL/i);
  });

  it("N2 RED: registry lookup failure is UNKNOWN (exit 3) and never publishes", async () => {
    const fx = await fixture({ registryError: "ENETUNREACH" });
    const gate = path.join(REPO, "scripts/ci/verify-npm-identity.mjs");
    const r = spawnSync(process.execPath, [gate, "aeh-test-pkg", "9.9.9"], {
      cwd: fx.dir,
      env: fx.env,
      encoding: "utf8",
    });
    // Fail-closed UNKNOWN, never absent.
    expect(r.status).toBe(3);
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/unknown/i);
    // Publish step must NOT publish on UNKNOWN.
    const step = await publishStepRun(fx);
    expect(step.published).toBe(false);
    expect(step.code).not.toBe(0);
    expect(step.out).toMatch(/unknown/i);
    // Workflow routes exit 3 loudly, never through the publish path.
    const yml = await fs.readFile(path.join(REPO, ".github/workflows/publish.yml"), "utf8");
    expect(yml).toMatch(/-eq 3|exit 3|UNKNOWN/);
  });

  // R3 (Luna round-3): mixed-lookup absence is unsafe unless the VERSION query
  // itself is authoritative. Digest 404s must not contribute; any version-query
  // transport/auth/parse failure is UNKNOWN (exit 3, never publish).
  async function fixtureMixed(opts: {
    integrityMode: "e404" | "network" | "value";
    shasumMode: "e404" | "network" | "value";
    versionMode: "e404" | "network" | "empty" | "value";
    integrityValue?: string;
  }) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-npmid-r3-"));
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "aeh-test-pkg", version: "9.9.9" }));
    const pack = spawnSync("npm", ["pack", "--pack-destination", dir, "--silent"], { cwd: dir, encoding: "utf8" });
    if (pack.status !== 0) throw new Error(`npm pack failed offline: ${pack.stderr}`);
    const tgz = (await fs.readdir(dir)).find((f) => f.endsWith(".tgz"))!;
    const bytes = await fs.readFile(path.join(dir, tgz));
    const localIntegrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const bin = path.join(dir, "stubbin");
    await fs.mkdir(bin);
    const publishCalled = path.join(dir, "publish-called");
    const viewImpl = (mode: string, field: string, fallback: string) => {
      if (mode === "e404")
        return `echo "npm error code E404" >&2; echo "npm error 404 Not Found - GET ${field}" >&2; exit 1`;
      if (mode === "network")
        return `echo "npm error code ENETUNREACH" >&2; echo "npm error network ENETUNREACH" >&2; exit 1`;
      if (mode === "empty") return `exit 0`;
      return `echo "${fallback}"; exit 0`;
    };
    const integrityFallback = opts.integrityValue ?? localIntegrity;
    await fs.writeFile(
      path.join(bin, "npm"),
      `#!/bin/sh\n` +
        `if [ "$1" = "view" ]; then\n` +
        `  FIELD="$3"\n` +
        `  if [ "$FIELD" = "dist.integrity" ]; then ${viewImpl(opts.integrityMode, "integrity", integrityFallback)}; fi\n` +
        `  if [ "$FIELD" = "dist.shasum" ]; then ${viewImpl(opts.shasumMode, "shasum", "")}; fi\n` +
        `  if [ "$FIELD" = "version" ]; then ${viewImpl(opts.versionMode, "version", "9.9.9")}; fi\n` +
        `  exit 1\nfi\n` +
        `if [ "$1" = "pack" ]; then DEST=""; PREV=""; for a in "$@"; do if [ "$PREV" = "--pack-destination" ]; then DEST="$a"; fi; PREV="$a"; done; cp "${path.join(dir, tgz)}" "$DEST/"; echo "${tgz}"; exit 0; fi\n` +
        `if [ "$1" = "publish" ]; then touch "${publishCalled}"; echo "$@" > "${publishCalled}.args"; exit 0; fi\n` +
        `echo "stub: unsupported npm $*" >&2; exit 1\n`,
    );
    await fs.chmod(path.join(bin, "npm"), 0o755);
    await fs.symlink(path.join(REPO, "scripts"), path.join(dir, "scripts"));
    return {
      dir,
      bin,
      publishCalled,
      localIntegrity,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        RELEASE_VERSION: "9.9.9",
        RELEASE_SHA: "b2c3d4e5f6b2c3d4e5f6b2c3d4e5f6b2c3d4e5f6",
      } as NodeJS.ProcessEnv,
    };
  }

  it("R1: digest-E404 + failed version query is UNKNOWN (exit 3), never absent", async () => {
    // Luna blocker: E404 from a DIGEST-field lookup combined with a FAILED
    // (network-error, no-output) version lookup must NOT yield exit 2.
    const fx = await fixtureMixed({ integrityMode: "e404", shasumMode: "e404", versionMode: "network" });
    const gate = path.join(REPO, "scripts/ci/verify-npm-identity.mjs");
    const r = spawnSync(process.execPath, [gate, "aeh-test-pkg", "9.9.9"], {
      cwd: fx.dir,
      env: fx.env,
      encoding: "utf8",
    });
    expect(r.status).toBe(3);
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/unknown/i);
    // Publish path must NOT publish on this UNKNOWN.
    const step = await publishStepRun({ ...fx, env: { ...fx.env, RELEASE_VERSION: "9.9.9" } } as any);
    expect(step.published).toBe(false);
    expect(step.code).not.toBe(0);
    expect(step.out).toMatch(/unknown/i);
    // Helper must not use digest 404s for the absence decision.
    const src = await fs.readFile(path.join(REPO, "scripts/ci/verify-npm-identity.mjs"), "utf8");
    expect(src).not.toMatch(/const combined|let combined|const any404|let any404/);
    expect(src).toMatch(/VERSION query ONLY|VERSION-query|versionText/);
    expect(src).toMatch(/isTransportFailure/);
  });

  it("R1: authoritative VERSION-query absence (empty success) is exit 2 without digest 404s", async () => {
    // Successful query proving version absent: clean empty on VERSION with
    // transport success, even when digest fields show network errors.
    const fx = await fixtureMixed({ integrityMode: "network", shasumMode: "network", versionMode: "empty" });
    const gate = path.join(REPO, "scripts/ci/verify-npm-identity.mjs");
    const r = spawnSync(process.execPath, [gate, "aeh-test-pkg", "9.9.9"], {
      cwd: fx.dir,
      env: fx.env,
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    // Version E404 with transport success is also authoritative, independent of digests.
    const fx2 = await fixtureMixed({ integrityMode: "e404", shasumMode: "network", versionMode: "e404" });
    const r2 = spawnSync(process.execPath, [gate, "aeh-test-pkg", "9.9.9"], {
      cwd: fx2.dir,
      env: fx2.env,
      encoding: "utf8",
    });
    expect(r2.status).toBe(2);
    // Version present but digest unreadable stays UNKNOWN.
    const fx3 = await fixtureMixed({ integrityMode: "network", shasumMode: "network", versionMode: "value" });
    const r3 = spawnSync(process.execPath, [gate, "aeh-test-pkg", "9.9.9"], {
      cwd: fx3.dir,
      env: fx3.env,
      encoding: "utf8",
    });
    expect(r3.status).toBe(3);
  });

  it("R2: repair-release reuses the retained tarball artifact (no fresh repack)", async () => {
    const text = await fs.readFile(path.join(REPO, ".github/workflows/publish.yml"), "utf8");
    const workflow = parse(text) as Record<string, any>;
    const jobs = workflow.jobs as Record<string, any>;
    const pubSteps = (jobs["publish-npm"].steps as Array<any>).map((s) => JSON.stringify(s)).join("\n");
    const repairSteps = jobs["repair-release"].steps as Array<{ name?: string; uses?: string; with?: any; run?: string }>;
    const repairSer = JSON.stringify(repairSteps);
    // Same retained-artifact restore as publish-npm (~L357-396).
    expect(repairSer).toMatch(/download-artifact/);
    expect(repairSer).toMatch(/aeh-npm-tarball/);
    const restore = repairSteps.find((s) => (s.uses ?? "").includes("download-artifact"));
    expect(restore).toBeDefined();
    expect((restore!.with as any).name).toBe("aeh-npm-tarball");
    // Publish-npm restore parity: same artifact name/path.
    expect(pubSteps).toMatch(/aeh-npm-tarball/);
    const confirm = repairSteps.find((s) => s.name === "Confirm published-but-unreleased state (SHA-bound)")!;
    expect(confirm).toBeDefined();
    expect(confirm.run!).toContain("verify-npm-identity.mjs");
    expect(confirm.run!).toContain("--tarball");
    expect(confirm.run!).toMatch(/Reusing retained tarball/);
    expect(confirm.run!).toMatch(/mismatch/i);
    // Fresh pack is gated: only when no artifact AND registry proves absent (exit 2).
    expect(confirm.run!).toMatch(/No retained tarball artifact/);
    expect(confirm.run!).toMatch(/-eq 2/);
    expect(confirm.run!).toMatch(/residual/i);
    expect(confirm.run!).toMatch(/UNKNOWN|UNKNOWN.*never release|Refusing.*UNKNOWN/i);
    // Fresh pack appears only inside the gated residual branch (after the
    // no-artifact probe and the exit-2 check), never as an unconditional repack.
    expect(confirm.run!).toMatch(/if ls.*\.tgz[\s\S]*Reusing retained[\s\S]*else[\s\S]*probe[\s\S]*-eq 2[\s\S]*npm pack/);
    expect(confirm.run!).not.toMatch(/# UNKNOWN registry lookups \(exit 3\) fail loudly and never release\.\nnpm run build/);
    // Functional retain+reuse: retained bytes verify (exit 0), fresh repack mismatches (exit 1).
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-npmid-r2-"));
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "aeh-test-pkg", version: "9.9.9" }));
    const basePack = spawnSync("npm", ["pack", "--pack-destination", dir, "--silent"], { cwd: dir, encoding: "utf8" });
    if (basePack.status !== 0) throw new Error(`npm pack failed offline: ${basePack.stderr}`);
    const baseTgz = (await fs.readdir(dir)).find((f) => f.endsWith(".tgz"))!;
    const bin = path.join(dir, "stubbin");
    await fs.mkdir(bin);
    const firstOut = path.join(dir, "firstpack");
    await fs.mkdir(firstOut);
    // Nondeterministic stub pack appends nanoseconds.
    await fs.writeFile(
      path.join(bin, "npm"),
      `#!/bin/sh\n` +
        `if [ "$1" = "view" ]; then case "$3" in version) echo "9.9.9";; dist.integrity) echo "$STUB_INTEGRITY";; *) exit 1;; esac; exit 0; fi\n` +
        `if [ "$1" = "pack" ]; then DEST=""; PREV=""; for a in "$@"; do if [ "$PREV" = "--pack-destination" ]; then DEST="$a"; fi; PREV="$a"; done; cp "${path.join(dir, baseTgz)}" "$DEST/${baseTgz}"; date +%s%N >> "$DEST/${baseTgz}"; echo "${baseTgz}"; exit 0; fi\n` +
        `if [ "$1" = "publish" ]; then exit 0; fi\n` +
        `echo "stub: unsupported npm $*" >&2; exit 1\n`,
    );
    await fs.chmod(path.join(bin, "npm"), 0o755);
    await fs.symlink(path.join(REPO, "scripts"), path.join(dir, "scripts"));
    const p1 = spawnSync("npm", ["pack", "--pack-destination", firstOut], {
      cwd: dir,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
      encoding: "utf8",
    });
    if (p1.status !== 0) throw new Error(`stub pack failed: ${p1.stderr}`);
    const firstTgz = path.join(firstOut, (await fs.readdir(firstOut)).find((f) => f.endsWith(".tgz"))!);
    const firstBytes = await fs.readFile(firstTgz);
    const firstIntegrity = `sha512-${createHash("sha512").update(firstBytes).digest("base64")}`;
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, STUB_INTEGRITY: firstIntegrity } as any;
    const gate = path.join(REPO, "scripts/ci/verify-npm-identity.mjs");
    const reused = spawnSync(process.execPath, [gate, "aeh-test-pkg", "9.9.9", "--tarball", firstTgz], {
      cwd: dir,
      env,
      encoding: "utf8",
    });
    expect(reused.status).toBe(0);
    const repacked = spawnSync(process.execPath, [gate, "aeh-test-pkg", "9.9.9"], { cwd: dir, env, encoding: "utf8" });
    expect(repacked.status).toBe(1);
  });
});
