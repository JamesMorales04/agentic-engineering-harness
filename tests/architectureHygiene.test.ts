import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalRoleValues, defaultRoleProfiles, defaultSkillSeed } from "../src/participants/index.js";

const root = path.resolve(".");

describe("Core-v2 architecture hygiene", () => {
  it("keeps role profiles and default skill references internally complete", () => {
    expect(new Set(canonicalRoleValues).size).toBe(canonicalRoleValues.length);
    const skills = new Set(defaultSkillSeed().skills.map((skill) => skill.id));
    for (const profile of defaultRoleProfiles()) for (const skill of profile.defaultSkills) expect(skills.has(skill), `${profile.role} references missing skill ${skill}`).toBe(true);
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
    const lock = JSON.parse(await fs.readFile(path.join(root, "package-lock.json"), "utf8")) as { packages?: Record<string, { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }> };
    expect(pkg.dependencies?.[pkg.name]).toBeUndefined();
    expect(pkg.devDependencies?.[pkg.name]).toBeUndefined();
    expect(pkg.optionalDependencies?.[pkg.name]).toBeUndefined();
    const rootPackage = lock.packages?.[""];
    expect(rootPackage?.dependencies?.[pkg.name]).toBeUndefined();
    expect(rootPackage?.devDependencies?.[pkg.name]).toBeUndefined();
  });
});
