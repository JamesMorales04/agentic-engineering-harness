import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { runToolchainDoctor } from "../src/toolchain/doctor.js";
import { setupToolchain } from "../src/toolchain/setup.js";
import {
  checkToolchainLockConsistency,
  extractReportedVersion,
  isUnpinnedImage,
  parseMiseLock,
  reportedVersionsEqual,
} from "../src/toolchain/pinning.js";
import type { HarnessProjectConfig } from "../src/core/types.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function readYamlVersions(doc: string): Record<string, string | undefined> {
  const parsed = YAML.parse(doc) as { tools?: Record<string, { version?: string; container?: { image?: string } }> };
  const result: Record<string, string | undefined> = {};
  for (const [name, def] of Object.entries(parsed.tools ?? {})) result[name] = def.version;
  return result;
}

describe("toolchain pinning (L-NEW-1/L-NEW-2/L-NEW-3/L-NEW-4/L-NEW-6/L-NEW-7)", () => {
  it("pins exact versions for locally-resolved tools in both toolchain yamls", async () => {
    const harnessYaml = await fs.readFile(path.join(REPO_ROOT, ".harness", "toolchain.yaml"), "utf8");
    const templateYaml = await fs.readFile(path.join(REPO_ROOT, "templates", "toolchain.yaml"), "utf8");
    const harness = readYamlVersions(harnessYaml);
    const template = readYamlVersions(templateYaml);
    expect(harness.opencode).toBe("1.18.32");
    expect(harness.paseo).toBe("0.9.1");
    expect(harness.uv).toBe("0.12.18");
    expect(harness.node).toBe("22.23.2");
    expect(harness.python).toBe("3.13.15");
    expect(template.opencode).toBe("1.18.32");
    expect(template.paseo).toBe("0.9.1");
    expect(template.uv).toBe("0.12.18");
    expect(template.node).toBe("22.23.2");
    expect(template.python).toBe("3.13.15");
    expect(template.codex).toBe("0.156.1");
    for (const [name, version] of Object.entries(harness)) {
      if (["opencode", "paseo", "uv", "node", "python", "codex"].includes(name)) {
        expect(String(version ?? "").toLowerCase()).not.toBe("latest");
      }
    }
  });

  it("has NO global .npmrc ignore-scripts so the repo's own prepare keeps working", async () => {
    // INVERSION JUSTIFICATION (Luna blocker a): the previous revision shipped
    // `.npmrc` with `ignore-scripts=true`. That breaks this repo's own first CI
    // job: `npm ci` would skip the root `prepare` script (which builds dist and
    // links the self CLI via scripts/link-self-bin.mjs), yet CI then requires
    // `node_modules/.bin/aeh` before `release:check` builds. Lifecycle-script
    // protection was moved to its true scope instead: project-dependency
    // installs in src/toolchain/setup.ts run with a HERMITIC PATH (pinned
    // prefix only, no ambient-PATH tail), which closes the L6 decoy-shim vector
    // while keeping scripts functional. A global ignore-scripts must never
    // return: the file must be absent, or contain no active ignore-scripts
    // directive (commented rationale lines are allowed).
    const npmrcPath = path.join(REPO_ROOT, ".npmrc");
    const npmrc = await fs.readFile(npmrcPath, "utf8").catch(() => undefined);
    if (npmrc !== undefined) {
      const active = npmrc.split(/\r?\n/).filter((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) return false;
        return /^\s*ignore-scripts\s*=/m.test(line);
      });
      expect(active).toEqual([]);
    }
    const pkg = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "package.json"), "utf8")) as { packageManager?: string };
    expect(typeof pkg.packageManager).toBe("string");
    expect(pkg.packageManager).toMatch(/^(npm|pnpm|yarn)@\d+\.\d+\.\d+(-.+)?$/);
  });

  it("builds a hermetic install env for project dependencies (no ambient-PATH tail)", async () => {
    // Luna blocker (a) RED: setup.ts project-dependency installs must run with
    // a HERMITIC PATH (pinned prefix only). An ambient PATH containing a decoy
    // shim dir must NOT leak into the install env PATH (L6 decoy-shim vector).
    const { buildProjectDependencyInstallEnv } = await import("../src/toolchain/setup.js");
    const { buildHermeticChildPath } = await import("../src/utils/process.js");
    expect(typeof buildProjectDependencyInstallEnv).toBe("function");
    const decoy = path.join(os.tmpdir(), "aeh-decoy-shim-red");
    const ambient = `${decoy}${path.delimiter}/usr/local/bin${path.delimiter}/usr/bin${path.delimiter}/bin`;
    const previousPath = process.env.PATH;
    process.env.PATH = ambient;
    try {
      const env = (buildProjectDependencyInstallEnv as (w: string, b: readonly string[]) => Record<string, string>)(
        "/repo/.harness/bin",
        ["/repo/.config/mise/shims"]
      );
      const entries = String(env.PATH).split(path.delimiter);
      expect(entries).toContain("/repo/.harness/bin");
      expect(entries).toContain("/repo/.config/mise/shims");
      expect(String(env.PATH)).not.toContain(decoy);
      // Exact hermetic construction: pinned prefix + minimal system dirs, and
      // nothing else (no ambient tail even though ambient PATH has the decoy).
      expect(String(env.PATH)).toBe(
        (buildHermeticChildPath as (p?: string) => string)(
          ["/repo/.harness/bin", "/repo/.config/mise/shims"].join(path.delimiter)
        )
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("uses exact-equality version semantics (pre-release suffixes never strip)", () => {
    expect(extractReportedVersion("opengrep 1.22.0-unpinned")).toBe("1.22.0-unpinned");
    expect(extractReportedVersion("v22.23.2")).toBe("22.23.2");
    expect(reportedVersionsEqual("1.22.0", "opengrep 1.22.0-unpinned")).toBe(false);
    expect(reportedVersionsEqual("1.22.0", "opengrep 1.22.0")).toBe(true);
    expect(reportedVersionsEqual("22.23.2", "v22.23.2")).toBe(true);
  });

  it("doctor rejects a -unpinned build as drift (not compliant)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-pinning-unpinned-"));
    await fs.mkdir(path.join(root, ".harness"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".harness", "toolchain.yaml"),
      `version: 1\nmanager:\n  provider: mise\nprofiles:\n  core:\n    tools: [opengrep]\ntools:\n  opengrep:\n    kind: mise\n    command: aeh-pin-test-opengrep\n    source: "aqua:opengrep/opengrep"\n    version: "1.22.0"\n    activateWhen: [always]\nprojectDependencies:\n  autoDetect: false\n`
    );
    const bin = path.join(root, "bin");
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, "aeh-pin-test-opengrep"), "#!/bin/sh\necho 'opengrep 1.22.0-unpinned'\n", { mode: 0o755 });
    await fs.chmod(path.join(bin, "aeh-pin-test-opengrep"), 0o755);
    const project: HarnessProjectConfig = {
      version: 1,
      project: { name: "pinning-unpinned" },
      toolchain: { configPath: ".harness/toolchain.yaml", lockPath: ".harness/toolchain.lock.json", statePath: ".harness/toolchain.state.json", generatedMisePath: ".config/mise/conf.d/aeh.toml" }
    };
    await fs.writeFile(
      path.join(root, ".harness", "toolchain.lock.json"),
      JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), profile: "auto", tools: { opengrep: { command: "aeh-pin-test-opengrep", provisioning: "system", source: "aqua:opengrep/opengrep", requestedVersion: "1.22.0", resolvedVersion: "1.22.0" } } })
    );
    await fs.writeFile(
      path.join(root, ".harness", "toolchain.state.json"),
      JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), manager: { provider: "mise", command: "mise" }, binPaths: [bin], projectDependencyCommands: [] })
    );
    const doctor = await runToolchainDoctor(root, project);
    const entry = doctor.find((item) => item.component === "toolchain:profile:opengrep" || item.component === "toolchain:project:opengrep");
    expect(entry?.state).toBe("DRIFT");
    expect(entry?.ok).toBe(false);
    expect(entry?.message).toMatch(/drift/i);
  });

  it("doctor reports lock drift naming the divergence (yaml vs locks)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-pinning-drift-"));
    await fs.mkdir(path.join(root, ".harness"), { recursive: true });
    await fs.mkdir(path.join(root, ".config", "mise"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".harness", "toolchain.yaml"),
      `version: 1\nmanager:\n  provider: mise\ntools:\n  node:\n    kind: mise\n    command: node\n    source: node\n    version: "22.23.2"\n    activateWhen: [always]\nprojectDependencies:\n  autoDetect: false\n`
    );
    await fs.writeFile(
      path.join(root, ".harness", "toolchain.lock.json"),
      JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), profile: "auto", tools: { node: { command: "node", provisioning: "mise", source: "node", requestedVersion: "22.23.1", resolvedVersion: "22.23.1" } } })
    );
    await fs.writeFile(
      path.join(root, ".config", "mise", "mise.lock"),
      `lockfile_version = 2\n\n[[tools.node]]\nversion = "22.23.2"\nbackend = "core:node"\nspecifiers = [\n    "22.23.2",\n    "latest",\n]\n`
    );
    const project: HarnessProjectConfig = {
      version: 1,
      project: { name: "pinning-drift" },
      toolchain: { configPath: ".harness/toolchain.yaml", lockPath: ".harness/toolchain.lock.json", statePath: ".harness/toolchain.state.json", generatedMisePath: ".config/mise/conf.d/aeh.toml" }
    };
    await fs.writeFile(
      path.join(root, ".harness", "toolchain.state.json"),
      JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), manager: { provider: "mise", command: "mise" }, binPaths: [], projectDependencyCommands: [] })
    );
    const doctor = await runToolchainDoctor(root, project);
    const consistency = doctor.find((item) => item.component === "toolchain-lock-consistency");
    expect(consistency?.ok).toBe(false);
    expect(consistency?.state).toBe("DRIFT");
    expect(consistency?.message).toMatch(/requestedVersion divergence|specifiers contain unpinned|version divergence/);
    expect(consistency?.message).toMatch(/node/);
  });

  it("checkToolchainLockConsistency passes for aligned pins without latest specifiers", () => {
    const parsed = parseMiseLock(`lockfile_version = 2\n\n[[tools.node]]\nversion = "22.23.2"\nbackend = "core:node"\nspecifiers = ["22.23.2"]\n`);
    const result = checkToolchainLockConsistency(
      { version: 1, manager: { provider: "mise" }, tools: { node: { kind: "mise", command: "node", source: "node", version: "22.23.2" } } },
      { version: 1, generatedAt: new Date().toISOString(), profile: "auto", tools: { node: { command: "node", provisioning: "mise", source: "node", requestedVersion: "22.23.2", resolvedVersion: "22.23.2" } } },
      parsed
    );
    expect(result.ok).toBe(true);
    expect(result.divergences).toEqual([]);
  });

  it("shipped mise.lock parses with zero unparsed in-scope lines (gate stays conclusive)", async () => {
    // Regression guard for the fail-closed parser: the repo's own committed
    // mise.lock (platform checksum blocks + aube digest lines) must remain in
    // the documented ignored subset, so doctor on this repo never reports a
    // spurious INCONCLUSIVE.
    const { parseMiseLockDetailed } = await import("../src/toolchain/pinning.js");
    const content = await fs.readFile(path.join(REPO_ROOT, ".config", "mise", "mise.lock"), "utf8");
    const detailed = (parseMiseLockDetailed as (c: string) => { entries: Record<string, unknown>; unparsedInScope: string[] })(content);
    expect(detailed.unparsedInScope).toEqual([]);
    expect(Object.keys(detailed.entries).length).toBeGreaterThan(0);
  });

  it("fails closed when toolchain.lock.json is absent (uninitialized, never consistent)", () => {
    // Luna blocker (b) RED 1: toolchain.lock.json is gitignored machine-local
    // state that `aeh setup` always writes. Absence means uninitialized — the
    // old code returned ok:true ("consistent"), a lie on fresh checkouts.
    const result = checkToolchainLockConsistency(
      { version: 1, manager: { provider: "mise" }, tools: { node: { kind: "mise", command: "node", source: "node", version: "22.23.2" } } },
      undefined,
      {}
    );
    expect(result.ok).toBe(false);
    expect(result.divergences.join("\n")).toMatch(/toolchain-lock-uninitialized/);
    expect(result.divergences.join("\n")).toMatch(/aeh setup/);
  });

  it("treats a missing mise entry for a pinned tool as DRIFT (cannot verify, not skip)", () => {
    // Luna blocker (b) RED 2: the old code silently skipped tools with no
    // mise.lock entry. A pinned mise-provisioned tool with no entry cannot be
    // verified and must fail closed.
    const result = checkToolchainLockConsistency(
      { version: 1, manager: { provider: "mise" }, tools: { node: { kind: "mise", command: "node", source: "node", version: "22.23.2" } } },
      { version: 1, generatedAt: new Date().toISOString(), profile: "auto", tools: { node: { command: "node", provisioning: "mise", source: "node", requestedVersion: "22.23.2", resolvedVersion: "22.23.2" } } },
      {}
    );
    expect(result.ok).toBe(false);
    expect(result.divergences.join("\n")).toMatch(/node/);
    expect(result.divergences.join("\n")).toMatch(/mise\.lock/);
  });

  it("counts unparseable in-scope mise.lock constructs instead of false-complying", async () => {
    // Luna blocker (b) RED 3: inline comments on [[tools.*]] headers and
    // dotted-key headers are constructs the subset parser cannot parse. They
    // must be counted fail-closed (INCONCLUSIVE), never silently skipped —
    // and following fields must not be misattributed to the previous tool.
    const { parseMiseLockDetailed } = await import("../src/toolchain/pinning.js");
    expect(typeof parseMiseLockDetailed).toBe("function");
    const parse = parseMiseLockDetailed as (
      content: string
    ) => { entries: Record<string, { version?: string }>; unparsedInScope: string[] };
    const content = `lockfile_version = 2\n\n[[tools.node]]\nversion = "22.23.2"\nbackend = "core:node"\nspecifiers = ["22.23.2"]\n\n[[tools.node.extra]]\nversion = "9.9.9"\n\n[[tools.python]] # trailing comment\nversion = "3.13.15"\n`;
    const detailed = parse(content);
    expect(detailed.unparsedInScope.length).toBeGreaterThanOrEqual(2);
    // Fail-closed non-attribution: fields under unparseable headers never land
    // on another tool (dotted header must not clobber node; commented header
    // yields no python entry at all).
    expect(detailed.entries["node"]?.version).toBe("22.23.2");
    expect(detailed.entries["python"]).toBeUndefined();
    const aligned = checkToolchainLockConsistency(
      { version: 1, manager: { provider: "mise" }, tools: { node: { kind: "mise", command: "node", source: "node", version: "22.23.2" } } },
      { version: 1, generatedAt: new Date().toISOString(), profile: "auto", tools: { node: { command: "node", provisioning: "mise", source: "node", requestedVersion: "22.23.2", resolvedVersion: "22.23.2" } } },
      parseMiseLock(content),
      { miseLockUnparsedInScope: detailed.unparsedInScope }
    );
    expect(aligned.ok).toBe(false);
    expect(aligned.divergences.join("\n")).toMatch(/INCONCLUSIVE/);
  });

  it("fresh-machine doctor reports lock-consistency uninitialized instead of consistent", async () => {
    // Luna blocker (b) doctor integration: no toolchain.lock.json on disk
    // (fresh checkout, lock path is gitignored) must surface a non-ok
    // toolchain-lock-uninitialized diagnostic, not ok:true "consistent".
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-pinning-uninit-"));
    await fs.mkdir(path.join(root, ".harness"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".harness", "toolchain.yaml"),
      `version: 1\nmanager:\n  provider: mise\ntools:\n  node:\n    kind: mise\n    command: node\n    source: node\n    version: "22.23.2"\n    activateWhen: [always]\nprojectDependencies:\n  autoDetect: false\n`
    );
    const project: HarnessProjectConfig = {
      version: 1,
      project: { name: "pinning-uninit" },
      toolchain: { configPath: ".harness/toolchain.yaml", lockPath: ".harness/toolchain.lock.json", statePath: ".harness/toolchain.state.json", generatedMisePath: ".config/mise/conf.d/aeh.toml" }
    };
    const doctor = await runToolchainDoctor(root, project);
    const consistency = doctor.find((item) => item.component === "toolchain-lock-consistency");
    expect(consistency?.ok).toBe(false);
    expect(consistency?.message).toMatch(/toolchain-lock-uninitialized/);
    expect(consistency?.message).toMatch(/aeh setup/);
  });

  it("setup refuses version:latest requested pins (fail-closed)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-pinning-latest-"));
    await fs.mkdir(path.join(root, ".harness"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".harness", "toolchain.yaml"),
      `version: 1\nmanager:\n  provider: mise\ntools:\n  node:\n    kind: mise\n    command: node\n    source: node\n    version: latest\n    activateWhen: [always]\nprojectDependencies:\n  autoDetect: false\n`
    );
    const project: HarnessProjectConfig = {
      version: 1,
      project: { name: "pinning-latest" },
      toolchain: { configPath: ".harness/toolchain.yaml", lockPath: ".harness/toolchain.lock.json", statePath: ".harness/toolchain.state.json", generatedMisePath: ".config/mise/conf.d/aeh.toml" }
    };
    await expect(setupToolchain(root, project, { dryRun: true })).rejects.toThrow(/TOOLCHAIN_UNPINNED_VERSION/);
    const doctor = await runToolchainDoctor(root, project);
    const pinning = doctor.find((item) => item.component === "toolchain-pinning");
    expect(pinning?.ok).toBe(false);
    expect(pinning?.state).toBe("INVALID");
    expect(pinning?.message).toMatch(/TOOLCHAIN_UNPINNED_VERSION/);
  });

  it("refuses :latest container images for active container tools (fail-closed unit gate)", async () => {
    const { assertNoLatestPins } = await import("../src/toolchain/pinning.js");
    expect(isUnpinnedImage("ghcr.io/aquasecurity/trivy:latest")).toBe(true);
    expect(isUnpinnedImage("docker.io/openpolicyagent/opa:latest-static")).toBe(true);
    expect(isUnpinnedImage("ghcr.io/aquasecurity/trivy:0.70.0")).toBe(false);
    expect(isUnpinnedImage("ghcr.io/aquasecurity/trivy:0.70.0@sha256:abc123")).toBe(false);
    expect(() =>
      assertNoLatestPins([
        {
          name: "trivy",
          kind: "mise",
          command: "trivy",
          source: "aqua:aquasecurity/trivy",
          version: "0.70.0",
          provisioning: "container",
          selectedBy: ["test"],
          container: { image: "ghcr.io/aquasecurity/trivy:latest" },
        },
      ])
    ).toThrow(/TOOLCHAIN_UNPINNED_IMAGE/);
    expect(() =>
      assertNoLatestPins([
        {
          name: "trivy",
          kind: "mise",
          command: "trivy",
          source: "aqua:aquasecurity/trivy",
          version: "0.70.0",
          provisioning: "container",
          selectedBy: ["test"],
          container: { image: "ghcr.io/aquasecurity/trivy:0.70.0@sha256:abc123" },
        },
      ])
    ).not.toThrow();
  });
});
