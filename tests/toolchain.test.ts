import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveToolchain, profileTools } from "../src/toolchain/resolve.js";
import { loadToolchainConfig } from "../src/toolchain/config.js";
import { compileToolchain } from "../src/toolchain/setup.js";
import { runProcess, clearToolchainEnvCache } from "../src/utils/process.js";
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
  await fs.writeFile(path.join(root, ".harness", "toolchain.yaml"), `version: 1\nmanager:\n  provider: mise\n  generatedConfig: .config/mise/conf.d/aeh.toml\n  lockFile: .harness/toolchain.lock.json\n  stateFile: .harness/toolchain.state.json\nprofiles:\n  core:\n    tools: [git, node]\n  agents:\n    extends: [core]\n    tools: [paseo]\ntools:\n  git:\n    kind: system\n    command: git\n    activateWhen: [always]\n  node:\n    kind: mise\n    command: node\n    source: node\n    version: \"22\"\n    activateWhen: [always]\n  paseo:\n    kind: mise\n    command: paseo\n    source: \"npm:@getpaseo/cli\"\n    version: latest\n    activateWhen: [orchestration:paseo]\n  uv:\n    kind: mise\n    command: uv\n    source: uv\n    version: latest\n    activateWhen: [code-intelligence:graphify]\n  graphify:\n    kind: mise\n    command: graphify\n    source: \"pipx:graphifyy\"\n    version: latest\n    dependsOn: [uv]\n    activateWhen: [code-intelligence:graphify]\n  opa:\n    kind: mise\n    command: opa\n    source: \"github:open-policy-agent/opa\"\n    version: latest\n    activateWhen: [validation:opa]\n  opengrep:\n    kind: mise\n    command: opengrep\n    source: \"github:opengrep/opengrep\"\n    version: latest\n    activateWhen: [security-tool:opengrep]\n  trivy:\n    kind: mise\n    command: trivy\n    source: \"github:aquasecurity/trivy\"\n    version: latest\n    activateWhen: [validator:trivy]\nprojectDependencies:\n  autoDetect: false\n`);
  return root;
}

describe("toolchain", () => {
  it("resolves active capabilities plus transitive dependencies", async () => {
    const root = await fixture(); const config = await loadToolchainConfig(root, project); const resolved = await resolveToolchain(root, project, config);
    expect(resolved.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["git", "node", "paseo", "uv", "graphify", "opa", "opengrep", "trivy"]));
    expect(resolved.tools.find((tool) => tool.name === "uv")?.selectedBy).toContain("dependency:graphify");
  });

  it("expands named profiles deterministically", async () => {
    const root = await fixture(); const config = await loadToolchainConfig(root, project);
    expect(profileTools(config, "agents")).toEqual(expect.arrayContaining(["git", "node", "paseo"]));
  });

  it("compiles locked exact versions into the generated mise layer", async () => {
    const root = await fixture(); await fs.writeFile(path.join(root, ".harness", "toolchain.lock.json"), JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), profile: "auto", tools: { node: { command: "node", provisioning: "mise", source: "node", requestedVersion: "22", resolvedVersion: "22.99.1" }, paseo: { command: "paseo", provisioning: "mise", source: "npm:@getpaseo/cli", requestedVersion: "latest", resolvedVersion: "9.9.9" } } }));
    await compileToolchain(root, project);
    const generated = await fs.readFile(path.join(root, ".config", "mise", "conf.d", "aeh.toml"), "utf8");
    expect(generated).toContain('node = "22.99.1"');
    expect(generated).toContain('"npm:@getpaseo/cli" = "9.9.9"');
  });

  it("injects machine-local toolchain bin paths without shell activation", async () => {
    const root = await fixture(); const bin = path.join(root, ".harness", "fake-bin"); await fs.mkdir(bin, { recursive: true });
    const fake = path.join(bin, "aeh-fake-tool"); await fs.writeFile(fake, "#!/bin/sh\necho provisioned\n", { mode: 0o755 }); await fs.chmod(fake, 0o755);
    await fs.writeFile(path.join(root, ".harness", "toolchain.state.json"), JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), manager: { provider: "mise", command: "mise" }, binPaths: [bin], projectDependencyCommands: [] }));
    clearToolchainEnvCache(); const result = await runProcess("aeh-fake-tool", { cwd: root }); expect(result.exitCode).toBe(0); expect(result.stdout.trim()).toBe("provisioned");
  });
});
