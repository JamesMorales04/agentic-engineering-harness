import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { HarnessProjectConfig } from "../core/types.js";
import type { ToolchainConfig, ToolchainLock, ToolchainState } from "./types.js";

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
  tools.python ??= { kind: "mise", command: "python", source: "python", version: "3.13", required: true, activateWhen: ["semantic-retrieval:serena", "compression:headroom"] };
  tools.uv ??= { kind: "mise", command: "uv", source: "uv", version: "latest", activateWhen: ["semantic-retrieval:serena", "compression:headroom"] };
  tools.serena ??= { kind: "mise", command: "serena", source: "pipx:serena", version: "1.5.3", required: true, dependsOn: ["uv", "python"], activateWhen: ["semantic-retrieval:serena"] };
  tools.headroom ??= { kind: "mise", command: "headroom", source: "pipx:headroom-ai[all]", version: "0.27.0", required: true, dependsOn: ["uv", "python"], activateWhen: ["compression:headroom"] };
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

export async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
