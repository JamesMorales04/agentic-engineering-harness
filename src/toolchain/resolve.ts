import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessProjectConfig } from "../core/types.js";
import { loadResolvedAgentTopology } from "../agents/config.js";
import type { ResolvedToolchain, ToolchainConfig, ToolchainToolDefinition } from "./types.js";

export async function resolveToolchain(
  root: string,
  project: HarnessProjectConfig,
  toolchain: ToolchainConfig,
  options: { profile?: string; preferContainers?: boolean; containerAvailable?: boolean } = {}
): Promise<ResolvedToolchain> {
  const profile = options.profile ?? "auto";
  const selected = new Map<string, string[]>();

  if (profile !== "auto") {
    for (const name of profileTools(toolchain, profile)) select(selected, name, `profile:${profile}`);
  } else {
    const capabilities = await activeCapabilities(root, project);
    for (const [name, definition] of Object.entries(toolchain.tools)) {
      const rules = definition.activateWhen ?? [];
      if (rules.includes("always")) select(selected, name, "activation:always");
      for (const rule of rules) if (capabilities.has(rule)) select(selected, name, `activation:${rule}`);
    }
  }

  expandDependencies(toolchain, selected);
  const preferContainers = options.preferContainers ?? toolchain.strategy?.validators === "prefer-container";
  const tools = [...selected.entries()].map(([name, selectedBy]) => {
    const definition = requireTool(toolchain, name);
    const provisioning = definition.kind === "system" ? "system" as const
      : preferContainers && options.containerAvailable && definition.container ? "container" as const
      : "mise" as const;
    return { name, ...definition, selectedBy, provisioning };
  });
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return { profile, tools };
}

export function profileTools(toolchain: ToolchainConfig, profile: string): string[] {
  const visiting = new Set<string>(); const result = new Set<string>();
  const visit = (name: string): void => {
    if (visiting.has(name)) throw new Error(`Toolchain profile cycle detected at '${name}'.`);
    const value = toolchain.profiles?.[name]; if (!value) throw new Error(`Unknown toolchain profile '${name}'.`);
    visiting.add(name); for (const parent of value.extends ?? []) visit(parent); for (const tool of value.tools ?? []) result.add(tool); visiting.delete(name);
  };
  visit(profile); return [...result];
}

async function activeCapabilities(root: string, project: HarnessProjectConfig): Promise<Set<string>> {
  const result = new Set<string>();
  if (project.agents) {
    try {
      const topology = await loadResolvedAgentTopology(root, project, project.agents.activeProfile);
      for (const agent of Object.values(topology.agents)) if (!agent.disabled) result.add(`runtime:${agent.runtime.name}`);
    } catch { /* doctor/setup will surface topology problems independently */ }
  }
  if (project.orchestration?.provider) result.add(`orchestration:${project.orchestration.provider}`);
  if (project.delivery?.paseo?.enabled) result.add("delivery:paseo");
  if (project.delivery?.github?.enabled) result.add("delivery:github");
  if (project.memory?.provider) result.add(`memory:${project.memory.provider}`);
  if (project.codeIntelligence?.provider) result.add(`code-intelligence:${project.codeIntelligence.provider}`);
  if (project.validation?.opa?.enabled) result.add("validation:opa");
  if (project.security?.sandbox?.provider) result.add(`sandbox:${project.security.sandbox.provider}`);
  for (const name of project.security?.tools ?? []) result.add(`security-tool:${name}`);
  for (const validator of project.validation?.validators ?? []) result.add(`validator:${validator.adapter}`);
  await addProjectCapabilities(root, result);
  return result;
}

async function addProjectCapabilities(root: string, result: Set<string>): Promise<void> {
  const files = new Set(await fs.readdir(root).catch(() => [] as string[]));
  if (files.has("package.json")) result.add("project:node");
  if (files.has("bun.lock") || files.has("bun.lockb")) result.add("project:bun");
  if (files.has("pnpm-lock.yaml")) result.add("project:pnpm");
  if (files.has("yarn.lock")) result.add("project:yarn");
  if (files.has("uv.lock") || files.has("pyproject.toml")) result.add("project:python");
  if ([...files].some((name) => name.endsWith(".sln") || name.endsWith(".slnx") || name.endsWith(".csproj")) || files.has("global.json")) result.add("project:dotnet");
  if (files.has("go.mod")) result.add("project:go");
  if (files.has("Cargo.toml")) result.add("project:rust");
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { packageManager?: unknown };
    const manager = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : undefined;
    if (manager) result.add(`project:${manager}`);
  } catch { /* package.json is optional */ }
}

function expandDependencies(toolchain: ToolchainConfig, selected: Map<string, string[]>): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of [...selected.keys()]) {
      const tool = requireTool(toolchain, name);
      for (const dependency of tool.dependsOn ?? []) if (!selected.has(dependency)) { select(selected, dependency, `dependency:${name}`); changed = true; }
    }
  }
}
function select(selected: Map<string, string[]>, name: string, reason: string): void { const reasons = selected.get(name) ?? []; if (!reasons.includes(reason)) reasons.push(reason); selected.set(name, reasons); }
function requireTool(toolchain: ToolchainConfig, name: string): ToolchainToolDefinition { const tool = toolchain.tools[name]; if (!tool) throw new Error(`Toolchain references unknown tool '${name}'.`); return tool; }
