import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { minimatch } from "minimatch";
import { canonicalRoleValues, defaultRoleProfiles, defaultSkillSeed } from "../src/participants/index.js";

const root = path.resolve(".");

function matchAgentPattern(pattern: string, name: string): boolean {
  if (pattern === name) return true;
  // Same matcher production uses for profile agent patterns (config.ts).
  // A pattern that matches nothing is the config loader's error, not this
  // test's concern; here it simply contributes no skills.
  try {
    return minimatch(name, pattern);
  } catch {
    return false;
  }
}

interface TopologyAgentShape {
  role?: string;
  skills?: string[];
}

function wildcardCount(value: string): number {
  return [...value].filter((char) => char === "*" || char === "?").length;
}

function effectiveAgentSkills(
  agents: Record<string, TopologyAgentShape>,
  overlays: Array<[string, TopologyAgentShape]>,
): Map<string, TopologyAgentShape> {
  // Mirror production merge order (config.ts): overlays sorted by wildcard
  // count descending; each overlay REPLACES base skills/role when present.
  const effective = new Map<string, TopologyAgentShape>(
    Object.entries(agents).map(([name, agent]) => [name, { ...agent }]),
  );
  const ordered = [...overlays].sort(([a], [b]) => wildcardCount(b) - wildcardCount(a));
  for (const [pattern, overlay] of ordered) {
    for (const [name, base] of effective) {
      if (!matchAgentPattern(pattern, name)) continue;
      effective.set(name, {
        role: overlay.role ?? base.role,
        skills: overlay.skills ?? base.skills,
      });
    }
  }
  return effective;
}

function isLeadAgent(name: string, agent: TopologyAgentShape): boolean {
  return agent.role === "Lead/Director" || name === "lead";
}

async function collectNonLeadTopologySkills(files: string[], baseDir = root): Promise<Set<string>> {
  const referenced = new Set<string>();
  const stripComments = (text: string): string =>
    text.split("\n").map((line) => line.replace(/^\s*\/\/.*$/, "")).join("\n");
  for (const file of files) {
    const text = stripComments(await fs.readFile(path.join(baseDir, file), "utf8"));
    const parsed = JSON.parse(text) as {
      agents?: Record<string, { role?: string; skills?: string[] }>;
      profiles?: Record<string, { agents?: Record<string, { role?: string; skills?: string[] }> }>;
    };
    const agents = parsed.agents ?? {};
    for (const [name, agent] of Object.entries(agents)) {
      if (isLeadAgent(name, agent)) continue;
      for (const id of agent.skills ?? []) referenced.add(id);
    }
    // Each profile: effective skills after overlay REPLACEMENT (production
    // mergeAgentLayer: sorted by wildcard count desc, overlay skills/role
    // replace base when present), so an overlay-added skill resolves exactly
    // like a base one and a replaced base skill is not falsely required.
    for (const profile of Object.values(parsed.profiles ?? {})) {
      const effective = effectiveAgentSkills(agents, Object.entries(profile.agents ?? {}));
      for (const [name, agent] of effective) {
        if (isLeadAgent(name, agent)) continue;
        for (const id of agent.skills ?? []) referenced.add(id);
      }
    }
  }
  return referenced;
}

function assertSeedResolves(referenced: Set<string>): void {
  const skills = new Set(defaultSkillSeed().skills.map((skill) => skill.id));
  for (const id of [...referenced].sort()) expect(skills.has(id), `topology references missing seed skill ${id}`).toBe(true);
}

describe("Core-v2 architecture hygiene", () => {
  it("keeps role profiles and default skill references internally complete", () => {
    expect(new Set(canonicalRoleValues).size).toBe(canonicalRoleValues.length);
    const skills = new Set(defaultSkillSeed().skills.map((skill) => skill.id));
    for (const profile of defaultRoleProfiles()) for (const skill of profile.defaultSkills) expect(skills.has(skill), `${profile.role} references missing skill ${skill}`).toBe(true);
  });

  it("keeps topology-referenced skills present in the default seed (harness-reviewer regression)", async () => {
    // CHANGE-20261010T063726Z-873e30d9: shipped harness-reviewer references
    // skills absent from defaultSkillSeed, so review launch died with
    // SKILL_MANIFEST_INVALID. Every skill id named by a shipped topology
    // agent that can execute as a WorkGraph participant (all roles except
    // Lead/Director, whose bootstrap never compiles participant identity)
    // must resolve in the seed.
    const files = ["presets/agents/default.jsonc", "presets/agents/orchestration.jsonc", ".harness/agents.source.jsonc", "templates/agents.source.jsonc"];
    const referenced = await collectNonLeadTopologySkills(files);
    expect(referenced.size).toBeGreaterThan(0);
    assertSeedResolves(referenced);
  });

  it("covers profile-overlay-added skills with merge semantics", async () => {
    // Overlays REPLACE base skills arrays per mergeAgentLayer (sorted by
    // wildcard count desc): an overlay-added skill must resolve exactly like
    // a base one, and a replaced base skill must NOT be required. Synthetic
    // fixture exercises the overlay branch (no shipped overlay adds skills
    // today) with exact, wildcard, and lead-excluded patterns.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-topology-skills-"));
    try {
      await fs.writeFile(
        path.join(dir, "topology.jsonc"),
        JSON.stringify({
          agents: {
            lead: {},
            reviewer: { role: "Reviewer", skills: ["cross-cutting"] },
            implementer: { role: "Implementer" },
          },
          profiles: {
            p1: {
              agents: {
                reviewer: { skills: ["verification-planning"] },
                "impl*": { skills: ["no-such-seed-skill"] },
                lead: { skills: ["no-such-lead-skill"] },
              },
            },
          },
        }),
      );
      const referenced = await collectNonLeadTopologySkills(["topology.jsonc"], dir);
      // Base scan contributes cross-cutting; the profile replaces reviewer
      // skills (cross-cutting NOT re-required by the overlay) and the
      // wildcard overlay adds the missing skill; lead overlay ignored.
      expect([...referenced].sort()).toEqual(["cross-cutting", "no-such-seed-skill", "verification-planning"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("does not reintroduce concrete domain-agent or removed semantic participant authority", async () => {
    const files = ["presets/agents/default.jsonc", "presets/agents/orchestration.jsonc", ".harness/agents.source.jsonc", "templates/agents.source.jsonc"];
    const source = (await Promise.all(files.map(async (file) => fs.readFile(path.join(root, file), "utf8")))).join("\n");
    expect(source).not.toMatch(/backend-(?:implementer|reviewer)|security-reviewer|requirements-reviewer|quality-implementer|senior-implementer|environment-manager|\boracle\b/);
    expect(source).not.toMatch(/"role"\s*:\s*"(?:Validator|Oracle|Environment Manager|Integrator|Delivery Agent)"/);
  });

  it("keeps participant provenance digests on the shared SHA-256 path", async () => {
    const source = await fs.readFile(path.join(root, "src/participants/skillCompiler.ts"), "utf8");
    const tools = await fs.readFile(path.join(root, "src/participants/toolRegistry.ts"), "utf8");
    expect(`${source}\n${tools}`).not.toMatch(/2166136261|16777619/);
    expect(source).toContain("sha256Canonical");
    expect(tools).toContain("sha256Canonical");
  });

  it("does not let the candidate depend on a released copy of itself", async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { name: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
    const lock = JSON.parse(await fs.readFile(path.join(root, "package-lock.json"), "utf8")) as { packages?: Record<string, { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }> };
    expect(pkg.dependencies?.[pkg.name]).toBeUndefined();
    expect(pkg.devDependencies?.[pkg.name]).toBeUndefined();
    expect(pkg.optionalDependencies?.[pkg.name]).toBeUndefined();
    const rootPackage = lock.packages?.[""];
    expect(rootPackage?.dependencies?.[pkg.name]).toBeUndefined();
    expect(rootPackage?.devDependencies?.[pkg.name]).toBeUndefined();
    expect(rootPackage?.optionalDependencies?.[pkg.name]).toBeUndefined();
    expect(lock.packages?.[`node_modules/${pkg.name}`]).toBeUndefined();
  });
});
