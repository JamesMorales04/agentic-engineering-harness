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

  it("ships .npmrc with ignore-scripts=true and a pinned packageManager", async () => {
    const npmrc = await fs.readFile(path.join(REPO_ROOT, ".npmrc"), "utf8");
    expect(npmrc).toMatch(/^\s*ignore-scripts\s*=\s*true\s*$/m);
    const pkg = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "package.json"), "utf8")) as { packageManager?: string };
    expect(typeof pkg.packageManager).toBe("string");
    expect(pkg.packageManager).toMatch(/^(npm|pnpm|yarn)@\d+\.\d+\.\d+(-.+)?$/);
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
