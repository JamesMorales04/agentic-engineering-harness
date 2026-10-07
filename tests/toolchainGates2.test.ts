import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runToolchainDoctor } from "../src/toolchain/doctor.js";
import { setupToolchain } from "../src/toolchain/setup.js";
import {
  checkToolchainLockConsistency,
  parseMiseLock,
  parseMiseLockDetailed,
} from "../src/toolchain/pinning.js";
import type { HarnessProjectConfig } from "../src/core/types.js";

const project: HarnessProjectConfig = {
  version: 1,
  project: { name: "gates2-red" },
  toolchain: { configPath: ".harness/toolchain.yaml", lockPath: ".harness/toolchain.lock.json", statePath: ".harness/toolchain.state.json", generatedMisePath: ".config/mise/conf.d/aeh.toml" }
};

async function writeYaml(root: string, body: string): Promise<void> {
  await fs.mkdir(path.join(root, ".harness"), { recursive: true });
  await fs.writeFile(path.join(root, ".harness", "toolchain.yaml"), body);
}

describe("RED T1 inactive latest bypass", () => {
  it("setup refuses inactive latest version (fail-closed full config)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-t1-inactive-"));
    await writeYaml(root,
`version: 1\nmanager:\n  provider: mise\ntools:\n  node:\n    kind: mise\n    command: node\n    source: node\n    version: "22.23.2"\n    activateWhen: [always]\n  bun:\n    kind: mise\n    command: bun\n    source: bun\n    version: latest\n    activateWhen: [project:bun]\nprojectDependencies:\n  autoDetect: false\n`);
    await expect(setupToolchain(root, project, { dryRun: true })).rejects.toThrow(/TOOLCHAIN_UNPINNED_VERSION/);
  });

  it("doctor pinning refuses inactive latest version (full config)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-t1-doctor-"));
    await writeYaml(root,
`version: 1\nmanager:\n  provider: mise\ntools:\n  node:\n    kind: mise\n    command: node\n    source: node\n    version: "22.23.2"\n    activateWhen: [always]\n  bun:\n    kind: mise\n    command: bun\n    source: bun\n    version: latest\n    activateWhen: [project:bun]\nprojectDependencies:\n  autoDetect: false\n`);
    const doctor = await runToolchainDoctor(root, project);
    const pinning = doctor.find((item) => item.component === "toolchain-pinning");
    expect(pinning?.ok).toBe(false);
    expect(pinning?.state).toBe("INVALID");
  });

  it("doctor refuses inactive :latest container image (full config)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-t1-image-"));
    await writeYaml(root,
`version: 1\nmanager:\n  provider: mise\ntools:\n  node:\n    kind: mise\n    command: node\n    source: node\n    version: "22.23.2"\n    activateWhen: [always]\n  trivy:\n    kind: mise\n    command: trivy\n    source: "aqua:aquasecurity/trivy"\n    version: "0.70.0"\n    activateWhen: [validator:trivy]\n    container:\n      image: ghcr.io/aquasecurity/trivy:latest\nprojectDependencies:\n  autoDetect: false\n`);
    const doctor = await runToolchainDoctor(root, project);
    const pins = doctor.find((item) => item.component === "toolchain-container-pins");
    expect(pins?.ok).toBe(false);
    expect(pins?.state).toBe("INVALID");
  });
});

describe("RED T2 malformed lock passes", () => {
  it("unquoted version value is unparsed fail-closed (not silent undefined)", async () => {
    const { parseMiseLockDetailed: parse } = await import("../src/toolchain/pinning.js");
    const content = `lockfile_version = 2\n\n[[tools.node]]\nversion = 22.23.2\nbackend = "core:node"\nspecifiers = ["22.23.2"]\n`;
    const detailed = (parse as typeof parseMiseLockDetailed)(content);
    expect(detailed.unparsedInScope.length).toBeGreaterThanOrEqual(1);
  });

  it("unquoted backend value is unparsed fail-closed", async () => {
    const { parseMiseLockDetailed: parse } = await import("../src/toolchain/pinning.js");
    const content = `lockfile_version = 2\n\n[[tools.node]]\nversion = "22.23.2"\nbackend = core:node\nspecifiers = ["22.23.2"]\n`;
    const detailed = (parse as typeof parseMiseLockDetailed)(content);
    expect(detailed.unparsedInScope.length).toBeGreaterThanOrEqual(1);
  });

  it("mise entry without version is DRIFT (not silent ok)", () => {
    const parsed = parseMiseLock(`lockfile_version = 2\n\n[[tools.node]]\nbackend = "core:node"\nspecifiers = ["22.23.2"]\n`);
    const result = checkToolchainLockConsistency(
      { version: 1, manager: { provider: "mise" }, tools: { node: { kind: "mise", command: "node", source: "node", version: "22.23.2" } } },
      { version: 1, generatedAt: new Date().toISOString(), profile: "auto", tools: { node: { command: "node", provisioning: "mise", source: "node", requestedVersion: "22.23.2", resolvedVersion: "22.23.2" } } },
      parsed
    );
    expect(result.ok).toBe(false);
    expect(result.divergences.join("\n")).toMatch(/node/);
  });

  it("mise entry without backend is DRIFT (not silent ok)", () => {
    const parsed = parseMiseLock(`lockfile_version = 2\n\n[[tools.node]]\nversion = "22.23.2"\nspecifiers = ["22.23.2"]\n`);
    const result = checkToolchainLockConsistency(
      { version: 1, manager: { provider: "mise" }, tools: { node: { kind: "mise", command: "node", source: "node", version: "22.23.2" } } },
      { version: 1, generatedAt: new Date().toISOString(), profile: "auto", tools: { node: { command: "node", provisioning: "mise", source: "node", requestedVersion: "22.23.2", resolvedVersion: "22.23.2" } } },
      parsed
    );
    expect(result.ok).toBe(false);
    expect(result.divergences.join("\n")).toMatch(/node/);
  });
});
