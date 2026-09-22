import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveToolchain, profileTools } from "../src/toolchain/resolve.js";
import { loadToolchainConfig } from "../src/toolchain/config.js";
import { compileToolchain, setupToolchain } from "../src/toolchain/setup.js";
import { runToolchainDoctor } from "../src/toolchain/doctor.js";
import { runShell, clearToolchainEnvCache } from "../src/utils/process.js";
import type { HarnessProjectConfig } from "../src/core/types.js";

const project: HarnessProjectConfig = {
  version: 1,
  project: { name: "toolchain-test" },
  toolchain: { configPath: ".harness/toolchain.yaml", lockPath: ".harness/toolchain.lock.json", statePath: ".harness/toolchain.state.json", generatedMisePath: ".config/mise/conf.d/aeh.toml" },
  orchestration: { provider: "paseo" },
  codeIntelligence: { provider: "graphify" },
  validation: { opa: { enabled: true }, validators: [{ id: "trivy", adapter: "trivy" }] },
  security: { tools: ["opengrep"] }
};

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-toolchain-"));
  await fs.mkdir(path.join(root, ".harness"), { recursive: true });
  await fs.writeFile(path.join(root, ".harness", "toolchain.yaml"), `version: 1\nmanager:\n  provider: mise\n  generatedConfig: .config/mise/conf.d/aeh.toml\n  lockFile: .harness/toolchain.lock.json\n  stateFile: .harness/toolchain.state.json\n  minimumVersion: \"2026.7.0\"\nprofiles:\n  core:\n    tools: [git, node]\n  agents:\n    extends: [core]\n    tools: [paseo]\ntools:\n  git:\n    kind: system\n    command: git\n    activateWhen: [always]\n  node:\n    kind: mise\n    command: node\n    source: node\n    version: \"22\"\n    activateWhen: [always]\n  paseo:\n    kind: mise\n    command: paseo\n    source: \"npm:@getpaseo/cli\"\n    version: latest\n    activateWhen: [orchestration:paseo]\n  uv:\n    kind: mise\n    command: uv\n    source: uv\n    version: latest\n    activateWhen: [code-intelligence:graphify]\n  graphify:\n    kind: mise\n    command: graphify\n    source: \"pipx:graphifyy\"\n    version: latest\n    dependsOn: [uv]\n    activateWhen: [code-intelligence:graphify]\n  opa:\n    kind: mise\n    command: opa\n    source: \"github:open-policy-agent/opa\"\n    version: latest\n    activateWhen: [validation:opa]\n  opengrep:\n    kind: mise\n    command: opengrep\n    source: \"github:opengrep/opengrep\"\n    version: latest\n    activateWhen: [security-tool:opengrep]\n  trivy:\n    kind: mise\n    command: trivy\n    source: \"github:aquasecurity/trivy\"\n    version: latest\n    activateWhen: [validator:trivy]\nprojectDependencies:\n  autoDetect: false\n`);
  return root;
}

async function fileExists(file: string): Promise<boolean> { try { await fs.access(file); return true; } catch { return false; } }

describe("toolchain", () => {
  it("resolves active capabilities plus transitive dependencies", async () => {
    const root = await fixture(); const config = await loadToolchainConfig(root, project); const resolved = await resolveToolchain(root, project, config);
    expect(resolved.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["git", "node", "paseo", "uv", "graphify", "opa", "opengrep", "trivy"]));
    expect(resolved.tools.find((tool) => tool.name === "uv")?.selectedBy).toContain("activation:code-intelligence:graphify");
    expect(resolved.tools.find((tool) => tool.name === "graphify")?.dependsOn).toContain("uv");
  });

  it("expands named profiles deterministically", async () => {
    const root = await fixture(); const config = await loadToolchainConfig(root, project);
    expect(profileTools(config, "agents")).toEqual(expect.arrayContaining(["git", "node", "paseo"]));
  });

  it("respects project-pinned runtime versions before locking", async () => {
    const root = await fixture(); await fs.writeFile(path.join(root, ".node-version"), "22.18.3\n");
    const config = await loadToolchainConfig(root, project); const resolved = await resolveToolchain(root, project, config);
    expect(resolved.tools.find((tool) => tool.name === "node")?.version).toBe("22.18.3");
  });

  it("compiles locked exact versions into the generated mise layer", async () => {
    const root = await fixture(); await fs.writeFile(path.join(root, ".harness", "toolchain.lock.json"), JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), profile: "auto", tools: { node: { command: "node", provisioning: "mise", source: "node", requestedVersion: "22", resolvedVersion: "22.99.1" }, paseo: { command: "paseo", provisioning: "mise", source: "npm:@getpaseo/cli", requestedVersion: "latest", resolvedVersion: "9.9.9" } } }));
    await compileToolchain(root, project);
    const generated = await fs.readFile(path.join(root, ".config", "mise", "conf.d", "aeh.toml"), "utf8");
    expect(generated).toContain('node = "22.99.1"');
    expect(generated).toContain('"npm:@getpaseo/cli" = "9.9.9"');
  });

  it("keeps setup dry-run side-effect free", async () => {
    const root = await fixture(); const result = await setupToolchain(root, project, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.installed.length).toBeGreaterThan(0);
    expect(await fileExists(path.join(root, ".config", "mise", "conf.d", "aeh.toml"))).toBe(false);
    expect(await fileExists(path.join(root, ".harness", "toolchain.lock.json"))).toBe(false);
    expect(await fileExists(path.join(root, ".harness", "toolchain.state.json"))).toBe(false);
  });

  it("reconciles through mise and produces a compliant lock/state without shell activation", async () => {
    const root = await fixture();
    const fakeSystem = path.join(root, "fake-system"); const fakeBins = path.join(root, "fake-tools");
    await fs.mkdir(fakeSystem, { recursive: true }); await fs.mkdir(fakeBins, { recursive: true });
    const versions: Record<string, string> = { node: "22.23.1", paseo: "1.4.0", uv: "0.8.12", graphify: "0.3.0", opa: "1.7.1", opengrep: "1.12.0", trivy: "0.66.0" };
    for (const [command, version] of Object.entries(versions)) {
      const file = path.join(fakeBins, command); await fs.writeFile(file, `#!/bin/sh\necho ${command} ${version}\n`, { mode: 0o755 }); await fs.chmod(file, 0o755);
    }
    const mise = path.join(fakeSystem, "mise");
    await fs.writeFile(mise, `#!/bin/sh\nset -eu\ncase "${'$'}{1:-}" in\n  --version) echo "mise 2026.7.0" ;;\n  trust) exit 0 ;;\n  -y) [ "${'$'}{2:-}" = install ] && exit 0; exit 2 ;;\n  bin-paths) printf '%s\\n' "${'$'}FAKE_MISE_BIN" ;;\n  which)\n    case "${'$'}{2:-}" in\n      node) echo 22.23.1 ;; paseo) echo 1.4.0 ;; uv) echo 0.8.12 ;; graphify) echo 0.3.0 ;; opa) echo 1.7.1 ;; opengrep) echo 1.12.0 ;; trivy) echo 0.66.0 ;; *) exit 3 ;;\n    esac ;;\n  *) exit 4 ;;\nesac\n`, { mode: 0o755 }); await fs.chmod(mise, 0o755);

    const previousPath = process.env.PATH; const previousFake = process.env.FAKE_MISE_BIN;
    process.env.PATH = `${fakeSystem}${path.delimiter}${previousPath ?? ""}`; process.env.FAKE_MISE_BIN = fakeBins; clearToolchainEnvCache();
    try {
      const result = await setupToolchain(root, project);
      expect(result.installed).toContain("node@22.23.1");
      const lock = JSON.parse(await fs.readFile(path.join(root, ".harness", "toolchain.lock.json"), "utf8")) as { tools: Record<string, { resolvedVersion?: string }> };
      expect(lock.tools.graphify.resolvedVersion).toBe("0.3.0");
      const state = JSON.parse(await fs.readFile(path.join(root, ".harness", "toolchain.state.json"), "utf8")) as { binPaths: string[] };
      expect(state.binPaths).toContain(fakeBins);
      const launched = await runShell("graphify --version", { cwd: root }); expect(launched.stdout).toContain("graphify 0.3.0");
      const doctor = await runToolchainDoctor(root, project); expect(doctor.every((item) => item.ok)).toBe(true);
    } finally {
      process.env.PATH = previousPath; if (previousFake === undefined) delete process.env.FAKE_MISE_BIN; else process.env.FAKE_MISE_BIN = previousFake; clearToolchainEnvCache();
    }
  });

  it("preserves fuzzy selectors by default and bumps only active mise tools for update-lock", async () => {
    const root = await fixture();
    const minimalProject: HarnessProjectConfig = {
      version: 1,
      project: { name: "mise-bump-contract" },
      toolchain: { configPath: ".harness/toolchain.yaml", lockPath: ".harness/toolchain.lock.json", statePath: ".harness/toolchain.state.json", generatedMisePath: ".config/mise/conf.d/aeh.toml" }
    };
    await fs.writeFile(path.join(root, ".harness", "toolchain.yaml"), `version: 1\nmanager:\n  provider: mise\n  generatedConfig: .config/mise/conf.d/aeh.toml\n  lockFile: .harness/toolchain.lock.json\n  stateFile: .harness/toolchain.state.json\n  minimumVersion: "2026.7.0"\nprofiles:\n  core:\n    tools: [node]\ntools:\n  node:\n    kind: mise\n    command: node\n    source: node\n    version: latest\n    activateWhen: [always]\n  serena:\n    kind: mise\n    command: serena\n    source: "pipx:serena-agent"\n    version: "1.6.1"\n    activateWhen: [semantic-retrieval:serena]\nprojectDependencies:\n  autoDetect: false\n`);
    await fs.writeFile(path.join(root, ".harness", "toolchain.lock.json"), JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      profile: "auto",
      tools: { node: { source: "node", requestedVersion: "latest", resolvedVersion: "22.1.0", command: "node", provisioning: "mise" } }
    }));

    const fakeSystem = path.join(root, "fake-system");
    const fakeBins = path.join(root, "fake-tools");
    const resolvedFile = path.join(root, "resolved-version");
    const callsFile = path.join(root, "mise-calls");
    await fs.mkdir(fakeSystem, { recursive: true });
    await fs.mkdir(fakeBins, { recursive: true });
    await fs.writeFile(resolvedFile, "22.1.0\n");
    const mise = path.join(fakeSystem, "mise");
    await fs.writeFile(mise, `#!/bin/sh
set -eu
case "${"$"}{1:-}" in
  --version) echo "mise 2026.7.0" ;;
  trust) echo trust >> "${"$"}FAKE_MISE_CALLS" ;;
  lock)
    [ "${"$"}{2:-}" = "--bump" ] || exit 12
    [ "${"$"}{3:-}" = "node" ] || exit 15
    [ "${"$"}{4:-}" = "" ] || exit 16
    [ "${"$"}MISE_PIPX_UVX" = "false" ] || exit 17
    [ "${"$"}MISE_PYPI_UVX" = "false" ] || exit 18
    echo "lock --bump ${"$"}{3} python-version-only" >> "${"$"}FAKE_MISE_CALLS"
    echo "22.2.0" > "${"$"}FAKE_MISE_RESOLVED"
    ;;
  -y) [ "${"$"}{2:-}" = "install" ] || exit 13; echo install >> "${"$"}FAKE_MISE_CALLS" ;;
  bin-paths) printf '%s\\n' "${"$"}FAKE_MISE_BIN" ;;
  which) cat "${"$"}FAKE_MISE_RESOLVED" ;;
  *) exit 14 ;;
esac
`, { mode: 0o755 });
    await fs.chmod(mise, 0o755);

    const previousPath = process.env.PATH;
    const previousBin = process.env.FAKE_MISE_BIN;
    const previousResolved = process.env.FAKE_MISE_RESOLVED;
    const previousCalls = process.env.FAKE_MISE_CALLS;
    process.env.PATH = `${fakeSystem}${path.delimiter}${previousPath ?? ""}`;
    process.env.FAKE_MISE_BIN = fakeBins;
    process.env.FAKE_MISE_RESOLVED = resolvedFile;
    process.env.FAKE_MISE_CALLS = callsFile;
    clearToolchainEnvCache();
    try {
      await setupToolchain(root, minimalProject, { skipProjectDependencies: true });
      let generated = await fs.readFile(path.join(root, ".config", "mise", "conf.d", "aeh.toml"), "utf8");
      let lock = JSON.parse(await fs.readFile(path.join(root, ".harness", "toolchain.lock.json"), "utf8")) as { tools: Record<string, { resolvedVersion?: string }> };
      expect(generated).toContain('node = "22.1.0"');
      expect(lock.tools.node.resolvedVersion).toBe("22.1.0");
      expect(await fs.readFile(callsFile, "utf8")).not.toContain("lock --bump");

      await fs.writeFile(resolvedFile, "22.1.0\n");
      await fs.writeFile(callsFile, "");
      await setupToolchain(root, minimalProject, { skipProjectDependencies: true, updateLock: true });
      generated = await fs.readFile(path.join(root, ".config", "mise", "conf.d", "aeh.toml"), "utf8");
      lock = JSON.parse(await fs.readFile(path.join(root, ".harness", "toolchain.lock.json"), "utf8")) as { tools: Record<string, { resolvedVersion?: string }> };
      expect(generated).toContain('node = "latest"');
      expect(lock.tools.node.resolvedVersion).toBe("22.2.0");
      expect(await fs.readFile(callsFile, "utf8")).toBe("trust\nlock --bump node python-version-only\ninstall\n");
    } finally {
      process.env.PATH = previousPath;
      restoreEnv("FAKE_MISE_BIN", previousBin);
      restoreEnv("FAKE_MISE_RESOLVED", previousResolved);
      restoreEnv("FAKE_MISE_CALLS", previousCalls);
      clearToolchainEnvCache();
    }
  });

  it("reports installed profile compliance separately from excluded project requirements", async () => {
    const root = await fixture();
    const minimalProject: HarnessProjectConfig = {
      version: 1,
      project: { name: "doctor-profile-contract" },
      sdd: { authoring: { provider: "openspec" } },
      toolchain: { configPath: ".harness/toolchain.yaml", lockPath: ".harness/toolchain.lock.json", statePath: ".harness/toolchain.state.json", generatedMisePath: ".config/mise/conf.d/aeh.toml" }
    };
    await fs.writeFile(path.join(root, ".harness", "toolchain.yaml"), `version: 1\nmanager:\n  provider: mise\nprofiles:\n  agents:\n    tools: []\ntools:\n  openspec:\n    kind: system\n    command: aeh-doctor-test-openspec-not-installed\n    required: true\n    activateWhen: [spec-authoring:openspec]\nprojectDependencies:\n  autoDetect: false\n`);
    await fs.writeFile(path.join(root, ".harness", "toolchain.lock.json"), JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), profile: "agents", tools: {} }));
    await fs.writeFile(path.join(root, ".harness", "toolchain.state.json"), JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), manager: { provider: "mise", command: "mise" }, binPaths: [], projectDependencyCommands: [] }));

    const doctor = await runToolchainDoctor(root, minimalProject);
    expect(doctor).toContainEqual(expect.objectContaining({ component: "toolchain-profile", scope: "INSTALLED_PROFILE", ok: true, message: expect.stringContaining("agents") }));
    expect(doctor).toContainEqual(expect.objectContaining({ component: "toolchain:project:openspec", scope: "ACTIVE_PROJECT", state: "EXCLUDED", required: true, ok: false, message: expect.stringContaining("excluded by installed profile 'agents'") }));
    expect(doctor.find((item) => item.component === "toolchain-project-requirements")?.ok).toBe(false);
  });

  it("injects machine-local toolchain bin paths without shell activation", async () => {
    const root = await fixture(); const bin = path.join(root, ".harness", "fake-bin"); await fs.mkdir(bin, { recursive: true });
    const fake = path.join(bin, "aeh-fake-tool"); await fs.writeFile(fake, "#!/bin/sh\necho provisioned\n", { mode: 0o755 }); await fs.chmod(fake, 0o755);
    await fs.writeFile(path.join(root, ".harness", "toolchain.state.json"), JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), manager: { provider: "mise", command: "mise" }, binPaths: [bin], projectDependencyCommands: [] }));
    clearToolchainEnvCache(); const result = await runShell("aeh-fake-tool", { cwd: root }); expect(result.exitCode).toBe(0); expect(result.stdout.trim()).toBe("provisioned");
  });
});

function restoreEnv(name: string, value: string | undefined): void { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
