import { describe, expect, it } from "vitest";
import { discoverProjectStackProfile } from "../src/participants/stack.js";
import { canonicalRoleValues, selectCanonicalRole } from "../src/participants/types.js";
import { defaultRoleProfiles } from "../src/participants/roles.js";
import { defaultSkillSeed } from "../src/participants/skills.js";
import { compileSkillSet } from "../src/participants/skillCompiler.js";
import { authorizeToolPack } from "../src/participants/toolRegistry.js";

describe("canonical participant foundation", () => {
  it("contains exactly the finite canonical role families", () => {
    expect(canonicalRoleValues).toEqual([
      "Lead/Director",
      "Operation Supervisor",
      "Explorer",
      "Librarian",
      "Planner",
      "Spec Manager",
      "Implementer",
      "Reviewer",
      "Repairer"
    ]);
    expect(defaultRoleProfiles().map((profile) => profile.role)).toEqual(canonicalRoleValues);
  });

  it("covers cross-cutting and the requested technology skills", () => {
    const skills = defaultSkillSeed().skills;
    expect(skills.map((skill) => skill.id)).toEqual([...new Set(skills.map((skill) => skill.id))]);
    expect(skills.filter((skill) => skill.kind === "role")).not.toHaveLength(0);
    expect(skills.map((skill) => skill.id)).toEqual(expect.arrayContaining(["cross-cutting", "typescript-node", "dotnet-csharp", "postgresql", "intent-analysis", "independent-review"]));
  });

  it("requires model-first stack discovery and exposes no deterministic detector surface", async () => {
    const stackModule = await import("../src/participants/stack.js");
    for (const absent of ["inferProjectStackProfile", "createDefaultStackDetectorRegistry", "StackDetectorRegistryV1", "defaultStackDetectors"]) {
      expect(Object.keys(stackModule)).not.toContain(absent);
    }
    await expect(discoverProjectStackProfile(process.cwd())).rejects.toMatchObject({ code: "STACK_ASSESSMENT_INVALID" });
  });

  it("selects only a canonical role and never assigns a concrete agent name", () => {
    const selection = selectCanonicalRole("Implementer");
    expect(selection).toEqual({ version: 1, role: "Implementer", profileVersion: 1 });
    expect(Object.keys(selection)).not.toContain("agentId");
    expect(defaultRoleProfiles().every((profile) => !Object.hasOwn(profile, "agentId"))).toBe(true);
  });

  it("compiles only the role, specialization and competency skills needed by a participant", () => {
    const compiled = compileSkillSet({ role: "Implementer", specializations: ["typescript"], competencies: ["typescript"] });
    expect(compiled.skillIds).toEqual(expect.arrayContaining(["implementation-discipline", "typescript-node"]));
    expect(compiled.skillIds).not.toContain("independent-review");
    expect(compiled.capabilities).toContain("implement");
    expect(compiled.skills.every((skill) => skill.proceduralSteps.length > 0)).toBe(true);
  });

  it("rejects unknown competency and cannot expose forbidden or unavailable tools", () => {
    expect(() => compileSkillSet({ role: "Reviewer", competencies: ["made-up competency"] })).toThrow(/unknown competencies/);
    const authorization = authorizeToolPack({
      role: "Reviewer",
      toolPack: { version: 1, required: ["repository-read"], optional: ["test-runner", "repository-write"], forbidden: ["repository-write"] },
      availableTools: [
        { id: "repository-read", source: "aeh", available: true },
        { id: "test-runner", source: "project", available: true },
        { id: "repository-write", source: "aeh", available: true }
      ]
    });
    expect(authorization.exposed).toEqual(["repository-read", "test-runner"]);
    expect(authorization.exposed).not.toContain("repository-write");
    expect(authorization.denied).toContain("repository-write");
  });
});
