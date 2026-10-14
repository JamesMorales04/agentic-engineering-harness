import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseJsonc } from "../src/agents/jsonc.js";
import { resolveAgentTopology } from "../src/agents/config.js";
import { validateAgentTopology } from "../src/agents/compiler.js";
import { roleProfile } from "../src/participants/roles.js";
import { isCanonicalSeedSkill, presetSkillCeilingIssue } from "../src/participants/skills.js";
import type { HarnessProjectConfig } from "../src/core/types.js";
import type { AgentTopologySource } from "../src/agents/types.js";

describe("agent topology", () => {
  it("parses JSONC comments and trailing commas", () => {
    expect(parseJsonc('{ // hi\n "a": 1, }')).toEqual({ a: 1 });
  });

  it("resolves model aliases, runtime and profile overrides", () => {
    const source: AgentTopologySource = {
      version: 1,
      activeProfile: "balanced",
      runtimes: { codex: { adapter: "codex" }, opencode: { adapter: "opencode", capabilities: { nativeAgent: true } } },
      models: { brain: { runtime: "codex", provider: "openai", model: "gpt-x", variant: "max" }, workhorse: { runtime: "opencode", provider: "local", model: "fast" } },
      agents: { lead: { role: "Lead/Director", execution: { model: "@brain" } }, worker: { role: "Implementer", execution: { model: "@workhorse", nativeAgent: "build" } } },
      profiles: { balanced: { agents: { worker: { temperature: 0.05 } } } }
    };
    const resolved = resolveAgentTopology(source);
    expect(resolved.agents.lead.model.id).toBe("openai/gpt-x");
    expect(resolved.agents.lead.execution.variant).toBe("max");
    expect(resolved.agents.worker.runtime.name).toBe("opencode");
    expect(resolved.agents.worker.execution.nativeAgent).toBe("build");
    expect(resolved.agents.worker.temperature).toBe(0.05);
  });
});

async function presetSource(): Promise<{ agents: Record<string, { role: string; skills?: string[]; specializations?: string[]; permissions?: Record<string, string> }>; routing: Array<{ id: string; select?: { role: string; specializations?: string[] }; review?: Array<{ role: string; specializations?: string[] }> }>; skillRoots: string[] }> {
  const raw = await fs.readFile(path.resolve("presets/agents/default.jsonc"), "utf8");
  return parseJsonc(raw) as never;
}

describe("preset ceiling coherence (L1-A1/A2/B)", () => {
  it("keeps the supervisor triple coherent under least privilege (preset deny, no command-execute, canExecute:false)", async () => {
    const preset = await presetSource();
    expect(preset.agents["operation-supervisor"].permissions?.shell).toBe("deny");
    const profile = roleProfile("Operation Supervisor");
    expect(profile.authority.canExecute).toBe(false);
    expect(profile.maxCapabilities).not.toContain("execute");
    expect([...profile.toolPack.required, ...profile.toolPack.optional]).not.toContain("command-execute");
    expect(profile.toolPack.forbidden).toContain("command-execute");
  });

  it("restricts every default preset skill grant to its role ceiling (shared seed primitive)", async () => {
    const preset = await presetSource();
    const violations: string[] = [];
    for (const [name, agent] of Object.entries(preset.agents)) {
      for (const skill of agent.skills ?? []) {
        if (skill === "*") continue;
        const issue = presetSkillCeilingIssue(skill, agent.role as Parameters<typeof presetSkillCeilingIssue>[1]);
        if (issue) violations.push(`${name}: ${issue}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("rejects cross-role seed grants and unknown ids through the shared primitive", () => {
    // acceptance-traceability is shared Spec Manager -> Reviewer verification
    // (proven audit/control-plane consumer); Planner stays excluded.
    expect(presetSkillCeilingIssue("acceptance-traceability", "Planner")).toMatch(/Spec Manager, Reviewer/);
    expect(presetSkillCeilingIssue("acceptance-traceability", "Reviewer")).toBeUndefined();
    expect(presetSkillCeilingIssue("operation-coordination", "Lead/Director")).toMatch(/Operation Supervisor/);
    expect(presetSkillCeilingIssue("acceptance-traceability", "Spec Manager")).toBeUndefined();
    expect(presetSkillCeilingIssue("cross-cutting", "Reviewer")).toBeUndefined();
    expect(isCanonicalSeedSkill("human-exception-handling")).toBe(true);
    expect(presetSkillCeilingIssue("does-not-exist", "Reviewer")).toMatch(/unknown skill/);
    expect(isCanonicalSeedSkill("does-not-exist")).toBe(false);
  });

  it("registers the high-assurance Reviewer specialization with closed routing", async () => {
    expect([...roleProfile("Reviewer").specializations]).toContain("high-assurance");
    const preset = await presetSource();
    const profile = [...roleProfile("Reviewer").specializations];
    expect(preset.agents["high-assurance-reviewer"].specializations?.every((spec) => profile.includes(spec))).toBe(true);
    const rule = preset.routing.find((item) => item.id === "high-risk-review");
    for (const selector of [...(rule?.review ?? [])]) {
      expect(selector.specializations?.every((spec) => profile.includes(spec))).toBe(true);
    }
  });

  it("grants review only to roles whose ceiling includes it (supervisor/planner deny)", async () => {
    // review/validate permissions mint no runtime capability today, so any
    // allow-grant above the role ceiling is latent drift of the same FAM-CEIL
    // class as the supervisor shell grant. Only Reviewer and Lead/Director
    // ceilings include review; every other default preset must deny it.
    const preset = await presetSource();
    const violations: string[] = [];
    for (const [name, agent] of Object.entries(preset.agents)) {
      if (agent.permissions?.review !== "allow") continue;
      const max = [...roleProfile(agent.role as Parameters<typeof roleProfile>[0]).maxCapabilities];
      if (!max.includes("review")) violations.push(`${name} (${agent.role}) grants review above ceiling [${max.join(", ")}]`);
    }
    expect(violations).toEqual([]);
    expect(preset.agents["operation-supervisor"].permissions?.review).toBe("deny");
    expect(preset.agents["planner"].permissions?.review).toBe("deny");
  });
});

describe("topology reference validation (seed registry + closed specializations)", () => {
  const config: HarnessProjectConfig = {
    version: 1,
    project: { name: "compiler-test" },
    agents: { configPath: ".harness/agents.source.jsonc" }
  };

  async function validateInRoot(source: string): Promise<{ ok: boolean; issues: string[] }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-compiler-"));
    try {
      await fs.mkdir(path.join(root, ".harness"), { recursive: true });
      await fs.writeFile(path.join(root, ".harness", "agents.source.jsonc"), source);
      return await validateAgentTopology(root, config);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  function minimalSource(agents: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
      version: 1,
      skillRoots: [],
      runtimes: { opencode: { adapter: "opencode" } },
      models: { workhorse: { runtime: "opencode", provider: "opencode-go", model: "muse-spark-1.3-contributor" } },
      agents,
      routing: [],
      ...extra
    });
  }

  const agentFor = (role: string, skills: string[], specializations?: string[]) => ({
    role,
    execution: { model: "@workhorse" },
    ...(specializations ? { specializations } : {}),
    skills
  });

  it("accepts canonical seed skills without filesystem SKILL.md", async () => {
    const result = await validateInRoot(minimalSource({ manager: agentFor("Spec Manager", ["acceptance-traceability", "openspec-authoring"]) }));
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("rejects seed skills outside the agent role ceiling fail-closed", async () => {
    const result = await validateInRoot(minimalSource({ planner: agentFor("Planner", ["acceptance-traceability"]) }));
    expect(result.ok).toBe(false);
    expect(result.issues.join("; ")).toMatch(/role ceiling/);
  });

  it("still resolves non-seed skills from filesystem SKILL.md and rejects unknown ids", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-compiler-fs-"));
    try {
      await fs.mkdir(path.join(root, ".harness"), { recursive: true });
      await fs.mkdir(path.join(root, "sk", "local-skill"), { recursive: true });
      await fs.writeFile(path.join(root, "sk", "local-skill", "SKILL.md"), "# local\n");
      const source = JSON.stringify({
        version: 1,
        skillRoots: ["sk"],
        runtimes: { opencode: { adapter: "opencode" } },
        models: { workhorse: { runtime: "opencode", provider: "opencode-go", model: "muse-spark-1.3-contributor" } },
        agents: { worker: agentFor("Implementer", ["local-skill"]), broken: agentFor("Implementer", ["missing-skill"]) },
        routing: []
      });
      await fs.writeFile(path.join(root, ".harness", "agents.source.jsonc"), source);
      const result = await validateAgentTopology(root, config);
      expect(result.ok).toBe(false);
      expect(result.issues).toEqual(["Agent broken references missing skill missing-skill"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unknown specializations fail-closed while accepting high-assurance review", async () => {
    const unknown = await validateInRoot(minimalSource(
      { reviewer: agentFor("Reviewer", [], ["no-such-spec"]) },
      { routing: [{ id: "r", when: { intent: "implement" }, review: [{ role: "Reviewer", specializations: ["no-such-spec"] }] }] }
    ));
    expect(unknown.ok).toBe(false);
    expect(unknown.issues.join("; ")).toMatch(/unknown specialization no-such-spec/);
    const known = await validateInRoot(minimalSource(
      { reviewer: agentFor("Reviewer", [], ["high-assurance"]) },
      { routing: [{ id: "high-risk-review", when: { intent: "implement" }, review: [{ role: "Reviewer", specializations: ["high-assurance"] }] }] }
    ));
    expect(known.issues).toEqual([]);
    expect(known.ok).toBe(true);
  });

  it("rejects a routing specialization with no enabled holder fail-closed (high-assurance)", async () => {
    // DETERMINISTIC regression (a): a routing rule demanding `high-assurance`
    // must fail closed naming the rule + missing specialization when no ENABLED
    // agent holds it — never silently downgrading to an ordinary reviewer.
    const missing = await validateInRoot(minimalSource(
      { reviewer: agentFor("Reviewer", [], ["cross-cutting"]) },
      { routing: [{ id: "high-risk-review", when: { intent: "implement", risk: "high" }, review: [{ role: "Reviewer", specializations: ["high-assurance"] }] }] }
    ));
    expect(missing.ok).toBe(false);
    expect(missing.issues.join("; ")).toMatch(/high-risk-review/);
    expect(missing.issues.join("; ")).toMatch(/high-assurance/);
    // A disabled holder does not satisfy the selector either.
    const disabled = await validateInRoot(minimalSource(
      {
        reviewer: agentFor("Reviewer", [], ["cross-cutting"]),
        "high-assurance-reviewer": { ...agentFor("Reviewer", [], ["high-assurance"]), disabled: true }
      },
      { routing: [{ id: "high-risk-review", when: { intent: "implement", risk: "high" }, review: [{ role: "Reviewer", specializations: ["high-assurance"] }] }] }
    ));
    expect(disabled.ok).toBe(false);
    expect(disabled.issues.join("; ")).toMatch(/high-assurance/);
    // An enabled holder satisfies the selector.
    const enabled = await validateInRoot(minimalSource(
      {
        reviewer: agentFor("Reviewer", [], ["cross-cutting"]),
        "high-assurance-reviewer": agentFor("Reviewer", [], ["high-assurance"])
      },
      { routing: [{ id: "high-risk-review", when: { intent: "implement", risk: "high" }, review: [{ role: "Reviewer", specializations: ["high-assurance"] }] }] }
    ));
    expect(enabled.issues).toEqual([]);
    expect(enabled.ok).toBe(true);
    // Role-only selectors keep current behavior (role presence only).
    const roleOnly = await validateInRoot(minimalSource(
      { reviewer: agentFor("Reviewer", [], ["cross-cutting"]) },
      { routing: [{ id: "r", when: { intent: "implement" }, review: [{ role: "Reviewer" }] }] }
    ));
    expect(roleOnly.ok).toBe(true);
  });

  it("derives the route-required review specialization for the assurance path", async () => {
    const { requiredReviewSpecializationsForRoute } = await import("../src/agents/routing.js");
    // High-risk default composition (high-assurance + cross-cutting): the
    // specific specialization dominates the generic fallback.
    expect(requiredReviewSpecializationsForRoute({
      review: [{ role: "Reviewer", specializations: ["high-assurance"] }, { role: "Reviewer", specializations: ["cross-cutting"] }]
    } as never)).toEqual(["high-assurance"]);
    // Ordinary cross-cutting route stays cross-cutting.
    expect(requiredReviewSpecializationsForRoute({ review: [{ role: "Reviewer", specializations: ["cross-cutting"] }] } as never)).toEqual(["cross-cutting"]);
    // Role-only selectors require nothing (current behavior).
    expect(requiredReviewSpecializationsForRoute({ review: [{ role: "Reviewer" }] } as never)).toEqual([]);
    expect(requiredReviewSpecializationsForRoute({ review: [] } as never)).toEqual([]);
  });

  it("compiles the shipped default preset clean under the strict validation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-compiler-default-"));
    try {
      await fs.mkdir(path.join(root, ".harness"), { recursive: true });
      await fs.writeFile(path.join(root, ".harness", "agents.source.jsonc"), '{"version":1,"extends":["aeh:default"]}');
      const result = await validateAgentTopology(root, config);
      expect(result.issues).toEqual([]);
      expect(result.ok).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
