import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessProjectConfig } from "../core/types.js";
import { runProcess, clearToolchainEnvCache } from "../utils/process.js";
import { generatedMisePath, loadToolchainConfig, loadToolchainLock, toolchainLockPath, toolchainStatePath, writeJsonFile } from "./config.js";
import { resolveToolchain } from "./resolve.js";
import { installMiseTools, miseBinPaths, miseResolvedVersion, resolveMiseAdapter, writeMiseConfig } from "./mise.js";
import type { ToolchainLock, ToolchainLockTool, ToolchainSetupOptions, ToolchainSetupResult, ToolchainState } from "./types.js";

export async function setupToolchain(root: string, project: HarnessProjectConfig, options: ToolchainSetupOptions = {}): Promise<ToolchainSetupResult> {
  const toolchain = await loadToolchainConfig(root, project);
  const lock = await loadToolchainLock(root, project, toolchain);
  const engine = toolchain.strategy?.containerEngine ?? "podman";
  const engineAvailable = await rawCommandExists(root, engine);
  const resolved = await resolveToolchain(root, project, toolchain, { profile: options.profile, preferContainers: options.preferContainers, containerAvailable: engineAvailable });
  const generatedConfig = generatedMisePath(project, toolchain);
  const lockFile = toolchainLockPath(project, toolchain);
  const stateFile = toolchainStatePath(project, toolchain);
  const systemMissing: string[] = [];
  const installed: string[] = [];
  const containers: string[] = [];
  const lockTools: Record<string, ToolchainLockTool> = {};
  const projectDependencyCommands = await resolveProjectDependencyCommands(root, toolchain.projectDependencies?.autoDetect !== false, toolchain.projectDependencies?.commands ?? []);

  for (const tool of resolved.tools.filter((item) => item.provisioning === "system")) {
    const ok = await rawCommandExists(root, tool.command);
    if (!ok) systemMissing.push(tool.name);
    lockTools[tool.name] = { command: tool.command, provisioning: "system", requestedVersion: tool.version, resolvedVersion: ok ? await commandVersion(root, tool.command) : undefined };
  }

  const requiredMissing = resolved.tools.filter((tool) => tool.provisioning === "system" && tool.required && systemMissing.includes(tool.name));
  if (requiredMissing.length && !options.dryRun) throw new Error(`Required host tools are missing and are not installed automatically: ${requiredMissing.map((item) => item.command).join(", ")}.`);

  const miseTools = resolved.tools.filter((item) => item.provisioning === "mise");
  const containerTools = resolved.tools.filter((item) => item.provisioning === "container");
  if (options.dryRun) {
    installed.push(...miseTools.map((tool) => `${tool.name}@${!options.updateLock ? lock?.tools[tool.name]?.resolvedVersion ?? tool.version ?? "latest" : tool.version ?? "latest"}`));
    containers.push(...containerTools.map((tool) => `${tool.name}:${!options.updateLock ? lock?.tools[tool.name]?.digestRef ?? tool.container!.image : tool.container!.image}`));
    return { profile: resolved.profile, generatedConfig, lockFile, stateFile, installed, containers, systemMissing, projectDependencyCommands, dryRun: true };
  }

  let adapter: Awaited<ReturnType<typeof resolveMiseAdapter>> | undefined;
  let binPaths: string[] = [];
  if (miseTools.length) {
    adapter = await resolveMiseAdapter(root, toolchain.manager.minimumVersion);
    await writeMiseConfig(root, generatedConfig, toolchain, resolved, lock, options.updateLock ?? false);
    await installMiseTools(root, adapter, false);
    binPaths = await miseBinPaths(root, adapter);
    for (const tool of miseTools) {
      const resolvedVersion = await miseResolvedVersion(root, adapter, tool.command);
      lockTools[tool.name] = { source: tool.source, requestedVersion: tool.version, resolvedVersion, command: tool.command, provisioning: "mise" };
      installed.push(`${tool.name}@${resolvedVersion ?? tool.version ?? "unknown"}`);
    }
  }

  const wrappersDir = path.resolve(root, ".harness/bin");
  for (const tool of containerTools) {
    const configuredImage = tool.container!.image;
    const lockedRef = !options.updateLock ? lock?.tools[tool.name]?.digestRef : undefined;
    const pullRef = lockedRef ?? configuredImage;
    const pull = await runProcess(`${engine} pull ${quote(pullRef)}`, { cwd: root, timeoutMs: 900_000, toolchain: false });
    if (pull.exitCode !== 0) throw new Error(`${engine} pull failed for ${pullRef}: ${pull.stderr || pull.stdout}`);
    const digestRef = lockedRef ?? await inspectDigest(root, engine, configuredImage);
    await writeContainerWrapper(wrappersDir, tool.command, engine, digestRef);
    lockTools[tool.name] = { source: tool.source, requestedVersion: tool.version, command: tool.command, provisioning: "container", image: configuredImage, digestRef };
    containers.push(`${tool.name}:${digestRef}`);
  }

  if (!options.skipProjectDependencies) {
    const env = { PATH: `${[wrappersDir, ...binPaths].join(path.delimiter)}${path.delimiter}${process.env.PATH ?? ""}` };
    for (const command of projectDependencyCommands) {
      const result = await runProcess(command, { cwd: root, timeoutMs: 1_800_000, env, toolchain: false });
      if (result.exitCode !== 0) throw new Error(`Project dependency setup failed (${command}): ${result.stderr || result.stdout}`);
    }
  }

  const finalLock: ToolchainLock = { version: 1, generatedAt: new Date().toISOString(), profile: resolved.profile, tools: lockTools };
  await writeJsonFile(path.resolve(root, lockFile), finalLock);
  const state: ToolchainState = { version: 1, generatedAt: new Date().toISOString(), manager: { provider: toolchain.manager.provider, command: adapter?.command ?? "system", version: adapter?.version }, binPaths: [...new Set([wrappersDir, ...binPaths])], wrappersDir, projectDependencyCommands };
  await writeJsonFile(path.resolve(root, stateFile), state);
  clearToolchainEnvCache();
  return { profile: resolved.profile, generatedConfig, lockFile, stateFile, installed, containers, systemMissing, projectDependencyCommands, dryRun: false };
}

export async function compileToolchain(root: string, project: HarnessProjectConfig, options: { profile?: string; updateLock?: boolean } = {}): Promise<string> {
  const toolchain = await loadToolchainConfig(root, project); const lock = await loadToolchainLock(root, project, toolchain);
  const resolved = await resolveToolchain(root, project, toolchain, { profile: options.profile, containerAvailable: false });
  const target = generatedMisePath(project, toolchain); await writeMiseConfig(root, target, toolchain, resolved, lock, options.updateLock ?? false); return target;
}

async function resolveProjectDependencyCommands(root: string, autoDetect: boolean, configured: string[]): Promise<string[]> {
  const commands = [...configured]; if (!autoDetect) return unique(commands);
  if (await exists(path.join(root, "package-lock.json"))) commands.push("npm ci");
  else if (await exists(path.join(root, "pnpm-lock.yaml"))) commands.push("corepack pnpm install --frozen-lockfile");
  else if (await exists(path.join(root, "bun.lock")) || await exists(path.join(root, "bun.lockb"))) commands.push("bun install --frozen-lockfile");
  else if (await exists(path.join(root, "yarn.lock"))) {
    const packageManager = await packageManagerDeclaration(root);
    commands.push(packageManager?.startsWith("yarn@1.") ? "corepack yarn install --frozen-lockfile" : "corepack yarn install --immutable");
  }
  if (await exists(path.join(root, "uv.lock"))) commands.push("uv sync --frozen");
  const entries = await fs.readdir(root).catch(() => [] as string[]);
  if (entries.some((name) => name.endsWith(".sln") || name.endsWith(".slnx") || name.endsWith(".csproj")) || await exists(path.join(root, "global.json"))) commands.push("dotnet restore");
  return unique(commands);
}

async function packageManagerDeclaration(root: string): Promise<string | undefined> {
  try { const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { packageManager?: unknown }; return typeof pkg.packageManager === "string" ? pkg.packageManager : undefined; }
  catch { return undefined; }
}
async function writeContainerWrapper(dir: string, command: string, engine: string, image: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true }); const file = path.join(dir, command);
  const script = `#!/bin/sh\nset -eu\nexec ${engine} run --rm -i -v "$PWD:/workspace" -w /workspace ${shellLiteral(image)} "$@"\n`;
  await fs.writeFile(file, script, { mode: 0o755 }); await fs.chmod(file, 0o755);
}
async function inspectDigest(root: string, engine: string, image: string): Promise<string> {
  const inspect = await runProcess(`${engine} image inspect --format '{{index .RepoDigests 0}}' ${quote(image)}`, { cwd: root, timeoutMs: 60_000, toolchain: false });
  if (inspect.exitCode !== 0 || !inspect.stdout.trim()) throw new Error(`Could not resolve immutable digest for ${image}: ${inspect.stderr || inspect.stdout}`);
  return inspect.stdout.trim();
}
async function commandVersion(root: string, command: string): Promise<string | undefined> { const result = await runProcess(`${command} --version`, { cwd: root, timeoutMs: 15_000, toolchain: false }); return result.exitCode === 0 ? (result.stdout || result.stderr).split(/\r?\n/)[0]?.trim() : undefined; }
async function rawCommandExists(root: string, command: string): Promise<boolean> { return (await runProcess(`command -v ${quote(command)}`, { cwd: root, timeoutMs: 10_000, toolchain: false })).exitCode === 0; }
async function exists(file: string): Promise<boolean> { try { await fs.access(file); return true; } catch { return false; } }
function unique(values: string[]): string[] { return [...new Set(values)]; }
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function shellLiteral(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
