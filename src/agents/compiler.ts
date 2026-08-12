import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessProjectConfig } from "../core/types.js";
import { loadAgentTopologySource, resolveAgentTopology } from "./config.js";
import type { ResolvedAgentTopology } from "./types.js";

export interface TopologyCheckResult { ok: boolean; issues: string[]; output?: string; }

export async function compileAgentTopology(root: string, config: HarnessProjectConfig, profile?: string, checkOnly = false): Promise<TopologyCheckResult> {
  const source = await loadAgentTopologySource(root, config);
  const topology = resolveAgentTopology(source, profile ?? config.agents?.activeProfile);
  const issues = await validateReferences(root, topology);
  if (issues.length) return { ok: false, issues };

  const agents: Record<string, unknown> = {};
  const promptHashes: Record<string, string> = {};
  for (const [name, agent] of Object.entries(topology.agents)) {
    let prompt: string | undefined;
    let orchestratorPrompt: string | undefined;
    if (agent.promptPath) { prompt = await fs.readFile(path.resolve(root, agent.promptPath), "utf8"); promptHashes[agent.promptPath] = sha(prompt); }
    if (agent.orchestratorPromptPath) { orchestratorPrompt = await fs.readFile(path.resolve(root, agent.orchestratorPromptPath), "utf8"); promptHashes[agent.orchestratorPromptPath] = sha(orchestratorPrompt); }
    agents[name] = { ...agent, prompt, orchestratorPrompt };
  }
  const runtime = { version: 1, profile: topology.profile, sourceHash: sha(JSON.stringify({ source, promptHashes })), models: topology.models, agents, routing: topology.routing, recovery: topology.recovery, councils: topology.councils };
  const generated = `${JSON.stringify(runtime, null, 2)}\n`;
  const output = path.resolve(root, config.agents?.generatedPath ?? ".harness/generated/agents.json");
  if (checkOnly) {
    try {
      const existing = await fs.readFile(output, "utf8");
      if (existing !== generated) return { ok: false, issues: ["Generated agent topology is stale. Run `aeh agents compile`."], output };
    } catch { return { ok: false, issues: ["Generated agent topology does not exist. Run `aeh agents compile`."], output }; }
    return { ok: true, issues: [], output };
  }
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, generated);
  return { ok: true, issues: [], output };
}

export async function validateAgentTopology(root: string, config: HarnessProjectConfig, profile?: string): Promise<TopologyCheckResult> {
  try {
    const topology = resolveAgentTopology(await loadAgentTopologySource(root, config), profile ?? config.agents?.activeProfile);
    const issues = await validateReferences(root, topology);
    return { ok: issues.length === 0, issues };
  } catch (error) { return { ok: false, issues: [String(error instanceof Error ? error.message : error)] }; }
}

async function validateReferences(root: string, topology: ResolvedAgentTopology): Promise<string[]> {
  const issues: string[] = [];
  const agentNames = new Set(Object.keys(topology.agents));
  for (const [name, agent] of Object.entries(topology.agents)) {
    for (const promptPath of [agent.promptPath, agent.orchestratorPromptPath].filter((value): value is string => Boolean(value))) {
      try { await fs.access(path.resolve(root, promptPath)); } catch { issues.push(`Agent ${name} references missing prompt ${promptPath}`); }
    }
    for (const skill of agent.skills ?? []) {
      if (skill === "*") continue;
      let found = false;
      for (const skillRoot of topology.skillRoots) {
        try { await fs.access(path.resolve(root, skillRoot, skill, "SKILL.md")); found = true; break; } catch { /* continue */ }
      }
      if (!found) issues.push(`Agent ${name} references missing skill ${skill}`);
    }
  }
  for (const rule of topology.routing) {
    if (rule.use && !agentNames.has(rule.use)) issues.push(`Routing rule ${rule.id} selects unknown agent ${rule.use}`);
    for (const reviewer of rule.reviewers ?? []) if (!agentNames.has(reviewer)) issues.push(`Routing rule ${rule.id} references unknown reviewer ${reviewer}`);
  }
  for (const [failure, steps] of Object.entries(topology.recovery)) for (const step of steps ?? []) if (step.action === "agent" && step.agent && !agentNames.has(step.agent)) issues.push(`Recovery ${failure} references unknown agent ${step.agent}`);
  return [...new Set(issues)];
}
function sha(value: string): string { return crypto.createHash("sha256").update(value).digest("hex"); }
