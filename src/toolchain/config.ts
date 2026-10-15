import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { HarnessProjectConfig } from "../core/types.js";
import type { ToolchainConfig, ToolchainLock, ToolchainState } from "./types.js";
import { providerVersions } from "../providers/versions.js";

const toolSchema = z.object({
  kind: z.enum(["system", "mise"]),
  command: z.string().min(1),
  source: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  required: z.boolean().optional(),
  dependsOn: z.array(z.string().min(1)).optional(),
  activateWhen: z.array(z.string().min(1)).optional(),
  container: z.object({ image: z.string().min(1), engine: z.string().min(1).optional() }).optional()
}).superRefine((value, ctx) => {
  if (value.kind === "mise" && !value.source) ctx.addIssue({ code: "custom", message: "mise tools require source" });
});

const schema = z.object({
  version: z.literal(1),
  manager: z.object({ provider: z.string().min(1), generatedConfig: z.string().optional(), lockFile: z.string().optional(), stateFile: z.string().optional(), minimumVersion: z.string().optional() }),
  strategy: z.object({ validators: z.enum(["local", "prefer-container"]).optional(), containerEngine: z.string().optional() }).optional(),
  profiles: z.record(z.string(), z.object({ extends: z.array(z.string()).optional(), tools: z.array(z.string()).optional() })).optional(),
  tools: z.record(z.string(), toolSchema),
  projectDependencies: z.object({ autoDetect: z.boolean().optional(), commands: z.array(z.string().min(1)).optional() }).optional()
});

export function toolchainConfigPath(config: HarnessProjectConfig): string { return config.toolchain?.configPath ?? ".harness/toolchain.yaml"; }
export function toolchainLockPath(config: HarnessProjectConfig, toolchain: ToolchainConfig): string { return config.toolchain?.lockPath ?? toolchain.manager.lockFile ?? ".harness/toolchain.lock.json"; }
export function toolchainStatePath(config: HarnessProjectConfig, toolchain: ToolchainConfig): string { return config.toolchain?.statePath ?? toolchain.manager.stateFile ?? ".harness/toolchain.state.json"; }
export function generatedMisePath(config: HarnessProjectConfig, toolchain: ToolchainConfig): string { return config.toolchain?.generatedMisePath ?? toolchain.manager.generatedConfig ?? ".config/mise/conf.d/aeh.toml"; }

export async function loadToolchainConfig(root: string, config: HarnessProjectConfig): Promise<ToolchainConfig> {
  const file = path.resolve(root, toolchainConfigPath(config));
  const parsed = schema.parse(YAML.parse(await fs.readFile(file, "utf8"))) as ToolchainConfig;
  return config.context ? addMandatoryContextTools(parsed) : parsed;
}

function addMandatoryContextTools(config: ToolchainConfig): ToolchainConfig {
  const tools = { ...config.tools };
  tools.python ??= { kind: "mise", command: "python", source: "python", version: "3.13.15", required: true, activateWhen: ["semantic-retrieval:serena", "compression:headroom"] };
  tools.uv ??= { kind: "mise", command: "uv", source: "uv", version: "0.12.18", activateWhen: ["semantic-retrieval:serena", "compression:headroom"] };
  tools.serena ??= { kind: "mise", command: "serena", source: "pipx:serena-agent", version: providerVersions.serena, required: true, dependsOn: ["uv", "python"], activateWhen: ["semantic-retrieval:serena"] };
  tools.headroom ??= { kind: "mise", command: "headroom", source: "pipx:headroom-ai[all]", version: providerVersions.headroom, required: true, dependsOn: ["uv", "python"], activateWhen: ["compression:headroom"] };
  return { ...config, tools };
}

export async function loadToolchainLock(root: string, config: HarnessProjectConfig, toolchain: ToolchainConfig): Promise<ToolchainLock | undefined> {
  try { return JSON.parse(await fs.readFile(path.resolve(root, toolchainLockPath(config, toolchain)), "utf8")) as ToolchainLock; }
  catch { return undefined; }
}

export async function loadToolchainState(root: string, config: HarnessProjectConfig, toolchain: ToolchainConfig): Promise<ToolchainState | undefined> {
  try { return JSON.parse(await fs.readFile(path.resolve(root, toolchainStatePath(config, toolchain)), "utf8")) as ToolchainState; }
  catch { return undefined; }
}

/**
 * Toolchain state propagation for isolated execution roots (MECHANISM:
 * DETERMINISTIC). Fresh worktrees/staging roots outside the operation
 * workspace cannot discover the sibling workspace through hermetic
 * resolution (which climbs toward the common worktree root), so live
 * provider probes fail without a pinned prefix even though the source
 * tree is fully provisioned. Copy the source root's resolved state file
 * when present so worker commands resolve the same pinned install
 * dirs. Best-effort: unresolvable declarations and absent state return
 * false, preserving current loud behavior (probes fail as before, never
 * silently). The file is gitignored, so baseline commits, ChangeSet
 * diffs, and candidate assembly are unaffected. Returns true when state
 * was materialized.
 */
export async function materializeToolchainStateForIsolatedRoot(sourceRoot: string, targetRoot: string, config: HarnessProjectConfig): Promise<boolean> {
  let toolchain: ToolchainConfig;
  try {
    toolchain = await loadToolchainConfig(sourceRoot, config);
  } catch {
    return false;
  }
  const relative = toolchainStatePath(config, toolchain);
  let content: string;
  try {
    content = await fs.readFile(path.resolve(sourceRoot, relative), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
  const destination = path.resolve(targetRoot, relative);
  const containment = path.relative(path.resolve(targetRoot), destination);
  if (!containment || containment.startsWith("..") || path.isAbsolute(containment)) return false;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, content, "utf8");
  return true;
}

export async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
