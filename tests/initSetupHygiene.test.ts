import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileAgentTopology } from "../src/agents/compiler.js";
import { loadProjectConfig } from "../src/core/config.js";
import { initializeProject } from "../src/core/init.js";
import { reconcileHarnessAssets } from "../src/core/assets.js";
import { PACKAGE_ROOT } from "../src/version.js";
import { compileToolchain, setupToolchain } from "../src/toolchain/setup.js";

const roots: string[] = [];
const declarativeHarnessFiles = [
  ".harness/project.yaml",
  ".harness/toolchain.yaml",
  ".harness/provider-versions.json",
  ".harness/agents.source.jsonc",
  ".harness/otel-collector.yaml",
  ".harness/managed-assets.json",
  "openspec/config.yaml"
];
const runtimeFiles = [
  ".harness/operations/OP-1/state.json",
  ".harness/paseo/lead-session.json",
  ".harness/runs/RUN-1.json",
  ".harness/audits/AUDIT-1.json",
  ".harness/reports/report.json",
  ".harness/telemetry/events.ndjson",
  ".harness/controller/state.json",
  ".harness/delivery/state.json",
  ".harness/evals/results/result.json",
  ".harness/evals/workspaces/fixture/file.txt",
  ".harness/toolchain.lock.json",
  ".config/mise/conf.d/aeh.toml",
  ".serena/cache/project/state.bin",
  ".serena/project.local.yml",
  ".graphify/cache.json",
  "graphify-out/graph.json"
];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("init and source checkout hygiene", () => {
  it("bootstraps a consumer with trackable configuration and ignored runtime state", async () => {
    const root = await tempRoot("aeh-init-consumer-");
    initGit(root);

    const created = await initializeProject(root);
    expect(created).toContain(".harness/project.yaml");
    expect(created).toContain(".harness/toolchain.yaml");
    expect(created).toContain(".harness/provider-versions.json");
    expect(created).toContain(".harness/agents.source.jsonc");
    expect(created).toContain(".harness/otel-collector.yaml");
    expect(created).toContain("openspec/config.yaml");

    for (const file of declarativeHarnessFiles) {
      await expect(fs.access(path.join(root, file)), `${file} exists`).resolves.toBeUndefined();
      expect(isGitIgnored(root, file), `${file} remains versionable`).toBe(false);
    }

    for (const file of runtimeFiles) {
      const target = path.join(root, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, "generated state\n");
      expect(isGitIgnored(root, file), `${file} is ignored`).toBe(true);
    }

    const lockFiles = [".config/mise/mise.lock", ".config/mise/locks/npm-pkg/1.0.0/aube-lock.yaml"];
    for (const file of lockFiles) {
      const target = path.join(root, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, "reproducibility lock\n");
      expect(isGitIgnored(root, file), `${file} remains versionable`).toBe(false);
    }
  });

  it("does not treat package names or repository directory names alone as source identity", async () => {
    const root = await tempRoot("agentic-engineering-harness-");
    initGit(root);
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
      name: "agentic-engineering-harness",
      repository: { type: "git", url: "https://example.invalid/consumer/project.git" }
    }));

    expect(await initializeProject(root)).toContain(".harness/project.yaml");
  });

  it("uses source-owned configuration and skips consumer bootstrap during source init and setup", async () => {
    const root = await createSourceCheckout();
    const canonicalFiles = [
      "package.json",
      "package-lock.json",
      ".gitignore",
      ".harness/project.yaml",
      ".harness/toolchain.yaml",
      ".harness/agents.source.jsonc",
      ".config/mise/mise.lock",
      "templates/project.yaml",
      "templates/toolchain.yaml",
      "templates/provider-versions.json",
      "templates/agents.source.jsonc",
      "templates/otel-collector.yaml",
      "templates/openspec-config.yaml",
      "openspec/config.yaml",
      "AGENTS.md"
    ];
    const before = await snapshot(root, canonicalFiles);

    expect(await initializeProject(root)).toEqual([]);
    const config = await loadProjectConfig(root);
    const topology = await compileAgentTopology(root, config);
    expect(topology.ok, topology.issues.join("; ")).toBe(true);
    await compileToolchain(root, config, { profile: "core" });
    const setup = await setupToolchain(root, config, { profile: "core", dryRun: true });
    expect(setup.dryRun).toBe(true);
    expect(await reconcileHarnessAssets(root)).toEqual({
      manifestPath: ".harness/managed-assets.json",
      created: [],
      updated: [],
      removed: [],
      preservedOverrides: [],
      unchanged: []
    });

    for (const file of [
      ".harness/provider-versions.json",
      ".harness/otel-collector.yaml",
      ".harness/managed-assets.json",
      ".harness/skills/engineering-workflow/SKILL.md",
      ".harness/policies/core/dependency-policy.rego",
    ]) {
      await expect(fs.access(path.join(root, file)), `${file} is not copied into the source checkout`).rejects.toThrow();
    }

    const sourcePackage = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as {
      name: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    expect(sourcePackage.dependencies?.[sourcePackage.name]).toBeUndefined();
    expect(sourcePackage.devDependencies?.[sourcePackage.name]).toBeUndefined();
    expect(sourcePackage.optionalDependencies?.[sourcePackage.name]).toBeUndefined();
    expect(await snapshot(root, canonicalFiles)).toEqual(before);
    expect(gitStatus(root)).toBe("");
  });

  it("keeps init, toolchain setup, and reconciliation idempotent", async () => {
    const root = await tempRoot("aeh-init-idempotent-");
    initGit(root);
    await initializeProject(root);
    const config = await loadProjectConfig(root);
    await compileToolchain(root, config, { profile: "core" });
    await setupToolchain(root, config, { profile: "core", dryRun: true });
    const firstStatus = gitStatus(root);
    const firstManifest = await fs.readFile(path.join(root, ".harness/managed-assets.json"), "utf8");

    expect(await initializeProject(root)).toEqual([]);
    await compileToolchain(root, config, { profile: "core" });
    await setupToolchain(root, config, { profile: "core", dryRun: true });

    expect(await fs.readFile(path.join(root, ".harness/managed-assets.json"), "utf8")).toBe(firstManifest);
    expect(gitStatus(root)).toBe(firstStatus);
  });
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function createSourceCheckout(): Promise<string> {
  const root = await tempRoot("aeh-source-checkout-");
  initGit(root);
  const packageFiles = ["package.json", "package-lock.json", ".gitignore", "AGENTS.md", ".config/mise/mise.lock"];
  const sourceFiles = [
    ".harness/project.yaml",
    ".harness/toolchain.yaml",
    ".harness/agents.source.jsonc",
    "openspec/config.yaml",
    "templates/project.yaml",
    "templates/toolchain.yaml",
    "templates/provider-versions.json",
    "templates/agents.source.jsonc",
    "templates/otel-collector.yaml",
    "templates/openspec-config.yaml"
  ];
  for (const file of [...packageFiles, ...sourceFiles]) {
    const source = path.join(PACKAGE_ROOT, file);
    const target = path.join(root, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  }
  await fs.cp(path.join(PACKAGE_ROOT, "skills"), path.join(root, "skills"), { recursive: true });
  await fs.cp(path.join(PACKAGE_ROOT, "policies"), path.join(root, "policies"), { recursive: true });
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "source checkout fixture"], { cwd: root, stdio: "ignore" });
  return root;
}

function initGit(root: string): void {
  execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "AEH Test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "aeh@example.invalid"], { cwd: root, stdio: "ignore" });
}

function isGitIgnored(root: string, file: string): boolean {
  const result = spawnSync("git", ["check-ignore", "--no-index", "--quiet", file], { cwd: root });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) throw new Error(`git check-ignore failed for ${file}: ${result.status}`);
  return result.status === 0;
}

function gitStatus(root: string): string {
  return execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
}

async function snapshot(root: string, files: string[]): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(files.map(async (file) => [
    file,
    await fs.readFile(path.join(root, file), "utf8")
  ])));
}
