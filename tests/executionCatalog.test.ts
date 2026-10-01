import { describe, expect, it } from "vitest";
import { compileExecutionCatalog } from "../src/architecture/executionCatalog.js";
import { defaultRoleProfiles, defaultSkillSeed } from "../src/participants/index.js";

describe("execution catalog", () => {
  it("freezes runtime/model ingredients and canonical role/skill references", () => {
    const catalog = compileExecutionCatalog({
      runtimes: { opencode: { adapter: "opencode", paseoProvider: "opencode", capabilities: { structuredOutput: true } }, codex: { adapter: "codex" } },
      models: { workhorse: { runtime: "opencode", provider: "opencode-go", model: "MiMo-V2.6-Flash" }, brain: { runtime: "codex", provider: "openai", model: "gpt-test", variant: "max" } },
      roleBindings: { Implementer: { runtimeId: "opencode", modelAlias: "workhorse", transport: "paseo" } },
      routeRuleIds: ["default", "default"]
    });
    expect(catalog.roleProfiles.map((profile) => profile.role)).toEqual(defaultRoleProfiles().map((profile) => profile.role));
    expect(catalog.skillRefs).toEqual(defaultSkillSeed().skills.map((skill) => skill.id).sort());
    expect(catalog.routeRuleIds).toEqual(["default"]);
    expect(catalog.roleBindings.Implementer).toMatchObject({ runtimeId: "opencode", modelAlias: "workhorse", transport: "paseo" });
    expect(catalog.digest).toMatch(/^[a-f0-9]{64}$/);
  });
});
