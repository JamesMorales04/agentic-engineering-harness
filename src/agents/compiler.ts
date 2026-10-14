import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessProjectConfig } from "../core/types.js";
import { loadAgentTopologySource, resolveAgentTopology } from "./config.js";
import type { ResolvedAgentTopology } from "./types.js";
import { sha256Canonical, sha256Utf8 } from "../core/digest.js";
import { defaultRoleProfiles } from "../participants/roles.js";
import { isCanonicalSeedSkill, presetSkillCeilingIssue } from "../participants/skills.js";
import { matchesValues } from "./routing.js";

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
    if (agent.promptPath) { prompt = await fs.readFile(path.resolve(root, agent.promptPath), "utf8"); promptHashes[agent.promptPath] = sha256Utf8(prompt); }
    if (agent.orchestratorPromptPath) { orchestratorPrompt = await fs.readFile(path.resolve(root, agent.orchestratorPromptPath), "utf8"); promptHashes[agent.orchestratorPromptPath] = sha256Utf8(orchestratorPrompt); }
    agents[name] = { ...agent, prompt, orchestratorPrompt };
  }
  const runtime = { version: 1, profile: topology.profile, sourceHash: sha256Canonical({ source, promptHashes }), models: topology.models, agents, routing: topology.routing, recovery: topology.recovery, councils: topology.councils };
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
  const specializationsByRole = new Map<string, readonly string[]>(defaultRoleProfiles().map((profile) => [profile.role, profile.specializations]));
  const assertSpecializationsClosed = (scope: string, owner: string, role: string, specializations: readonly string[] | undefined): void => {
    const known = specializationsByRole.get(role);
    if (!known) return;
    for (const specialization of specializations ?? []) {
      if (!(known as readonly string[]).includes(specialization)) {
        issues.push(`${scope} ${owner} references unknown specialization ${specialization} for role ${role}`);
      }
    }
  };
  for (const [name, agent] of Object.entries(topology.agents)) {
    for (const promptPath of [agent.promptPath, agent.orchestratorPromptPath].filter((value): value is string => Boolean(value))) {
      try { await fs.access(path.resolve(root, promptPath)); } catch { issues.push(`Agent ${name} references missing prompt ${promptPath}`); }
    }
    assertSpecializationsClosed("Agent", name, agent.role, agent.specializations);
    for (const skill of agent.skills ?? []) {
      if (skill === "*") continue;
      // The canonical skill seed is the registry of record for preset skill
      // ids (role procedures project from the seed at launch); filesystem
      // SKILL.md covers non-seed OpenCode skills. A seed skill must also fit
      // the agent role's ceiling; anything in neither registry still fails.
      if (isCanonicalSeedSkill(skill)) {
        const ceilingIssue = presetSkillCeilingIssue(skill, agent.role as Parameters<typeof presetSkillCeilingIssue>[1]);
        if (ceilingIssue) issues.push(`Agent ${name} references skill outside its role ceiling: ${ceilingIssue}`);
        continue;
      }
      let found = false;
      for (const skillRoot of topology.skillRoots) {
        try { await fs.access(path.resolve(root, skillRoot, skill, "SKILL.md")); found = true; break; } catch { /* continue */ }
      }
      if (!found) issues.push(`Agent ${name} references missing skill ${skill}`);
    }
  }
  for (const rule of topology.routing) {
    for (const selector of [rule.select, ...(rule.review ?? [])].filter((value): value is NonNullable<typeof rule.select> => Boolean(value))) {
      if (!Object.values(topology.agents).some((agent) => agent.role === selector.role && !agent.disabled)) issues.push(`Routing rule ${rule.id} selects unavailable role ${selector.role}`);
      assertSpecializationsClosed("Routing rule", rule.id, selector.role, selector.specializations);
      // DETERMINISTIC fail-closed: a selector WITH specializations must match >=1
      // ENABLED agent with role AND specializations (same minimatch semantics as
      // selectAgentNames). Role-only selectors keep current behavior. A high-risk
      // rule demanding `high-assurance` with no enabled holder fails here naming
      // the rule, role, and missing specialization — never silently downgrading to
      // an ordinary reviewer downstream.
      const requiredSpecializations = selector.specializations ?? [];
      if (requiredSpecializations.length) {
        const specializationAvailable = Object.values(topology.agents).some(
          (agent) => !agent.disabled && agent.role === selector.role && matchesValues(agent.specializations ?? [], requiredSpecializations)
        );
        if (!specializationAvailable) issues.push(`Routing rule ${rule.id} selects unavailable specialization ${requiredSpecializations.join(",")} for role ${selector.role} (no enabled agent matches role and specializations)`);
      }
    }
  }
  return [...new Set(issues)];
}
