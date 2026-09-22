import type { CanonicalRole, ParticipantCapability, ToolPackV1 } from "./types.js";
import { sha256Canonical } from "../core/digest.js";
import { AehError } from "../core/errors.js";
import { assertSkillTrustDecision, type AcceptedEphemeralSkillV1 } from "../knowledge/index.js";
import { defaultRoleProfiles, roleProfile } from "./roles.js";
import { defaultSkillSeed, type SkillDefinitionV1 } from "./skills.js";

export interface SkillCompilationInputV1 {
  role: CanonicalRole;
  specializations?: readonly string[];
  competencies?: readonly string[];
  availableSkillIds?: readonly string[];
  projectSkillIds?: readonly string[];
  ephemeralSkillIds?: readonly string[];
  operationSkills?: readonly AcceptedEphemeralSkillV1[];
  toolPack?: ToolPackV1;
}

export interface CompiledSkillSetV1 {
  version: 1;
  role: CanonicalRole;
  skillIds: string[];
  skills: SkillDefinitionV1[];
  competencies: string[];
  capabilities: ParticipantCapability[];
  toolPack: ToolPackV1;
  digest: string;
}

const roleCapabilities: Record<CanonicalRole, readonly ParticipantCapability[]> = Object.fromEntries(
  defaultRoleProfiles().map((profile) => [profile.role, profile.maxCapabilities])
) as Record<CanonicalRole, readonly ParticipantCapability[]>;

export function compileSkillSet(input: SkillCompilationInputV1): CompiledSkillSetV1 {
  const profile = roleProfile(input.role);
  const seed = defaultSkillSeed();
  const byId = new Map(seed.skills.map((skill) => [skill.id, skill]));
  const operationSkills = [...new Map((input.operationSkills ?? []).map((skill) => [skill.id, skill])).values()];
  for (const skill of operationSkills) {
    try {
      if (!skill.id.startsWith("ephemeral:") || !/^[a-f0-9]{64}$/.test(skill.sourcePackDigest) || !skill.competency.trim() || !skill.procedure.length) throw new Error("skill shape is invalid");
      assertSkillTrustDecision(skill);
    } catch (error) { throw new AehError("SKILL_COMPILATION_REJECTED", `operation-local skill '${skill.id}' has no valid deterministic trust-gate decision.`, { cause: error }); }
    byId.set(skill.id, operationCandidateSkill(skill));
  }
  const explicit = new Set(input.availableSkillIds ?? []);
  const project = new Set(input.projectSkillIds ?? []);
  const ephemeral = new Set(input.ephemeralSkillIds ?? []);
  const requestedCompetencies = new Set(input.competencies ?? []);
  const specializations = new Set(input.specializations ?? []);
  const selected = new Map<string, SkillDefinitionV1>();

  for (const id of profile.defaultSkills) addSkill(id, "role");
  for (const skill of seed.skills) {
    if (skill.kind === "cross-cutting" && [...requestedCompetencies].some((competency) => skill.competencies.some((item) => item.id === competency))) addSkill(skill.id, "competency");
    if (skill.kind === "technology" && [...specializations].some((specialization) => skill.specializations?.includes(specialization))) addSkill(skill.id, "specialization");
  }
  for (const skill of operationSkills) {
    if (requestedCompetencies.has(skill.competency)) addSkill(skill.id, "operation knowledge");
  }
  for (const id of [...project, ...ephemeral]) addSkill(id, "project/ephemeral");

  const covered = new Set([...selected.values()].flatMap((skill) => skill.competencies.map((competency) => competency.id)));
  const missing = [...requestedCompetencies].filter((competency) => !covered.has(competency) && !seed.skills.some((skill) => skill.competencies.some((item) => item.id === competency)));
  if (missing.length) throw new AehError("SKILL_COMPILATION_REJECTED", `unknown competencies: ${missing.join(", ")}.`);
  const uncovered = [...requestedCompetencies].filter((competency) => !covered.has(competency));
  if (uncovered.length) throw new AehError("SKILL_COMPILATION_REJECTED", `no selected skill covers competencies: ${uncovered.join(", ")}.`);

  const roleToolPack = input.toolPack ?? profile.toolPack;
  const toolPack = normalizeToolPack(roleToolPack);
  for (const skill of selected.values()) {
    if (skill.roles && !skill.roles.includes(input.role)) throw new AehError("SKILL_COMPILATION_REJECTED", `skill '${skill.id}' is not valid for role '${input.role}'.`);
    if (skill.requiredTools?.some((tool) => toolPack.forbidden.includes(tool))) throw new AehError("SKILL_COMPILATION_REJECTED", `skill '${skill.id}' requires a forbidden tool.`);
    if (skill.requiredTools?.some((tool) => !toolPack.required.includes(tool) && !toolPack.optional.includes(tool))) throw new AehError("SKILL_COMPILATION_REJECTED", `skill '${skill.id}' cannot grant tool '${skill.requiredTools.find((tool) => !toolPack.required.includes(tool) && !toolPack.optional.includes(tool))}'.`);
    if (skill.forbiddenTools?.some((tool) => toolPack.required.includes(tool))) throw new AehError("SKILL_COMPILATION_REJECTED", `skill '${skill.id}' conflicts with a required tool.`);
  }

  const skillIds = [...selected.keys()].sort();
  const skills = skillIds.map((id) => selected.get(id)!);
  const resultWithoutDigest = { version: 1 as const, role: input.role, skillIds, skills, competencies: [...new Set(skills.flatMap((skill) => skill.competencies.map((item) => item.id)))].sort(), capabilities: [...roleCapabilities[input.role]].sort(), toolPack };
  return { ...resultWithoutDigest, digest: sha256Canonical(resultWithoutDigest) };

  function addSkill(id: string, reason: string): void {
    const skill = byId.get(id);
    if (!skill) throw new AehError("SKILL_COMPILATION_REJECTED", `unknown ${reason} skill '${id}'.`);
    if (input.availableSkillIds && input.availableSkillIds.length > 0 && skill.kind !== "role" && skill.kind !== "ephemeral" && !explicit.has(id) && !project.has(id) && !ephemeral.has(id)) return;
    selected.set(id, skill);
  }
}

function operationCandidateSkill(candidate: AcceptedEphemeralSkillV1): SkillDefinitionV1 {
  return {
    version: 1,
    id: candidate.id,
    name: `Operation-local ${candidate.competency}`,
    description: `Validated operation-local competency grounded by knowledge pack ${candidate.sourcePackDigest}.`,
    kind: "ephemeral",
    proceduralSteps: [...candidate.procedure],
    competencies: [{ id: candidate.competency, description: `Operation-local competency grounded by a validated knowledge pack.`, level: "WORKING" }]
  };
}

function normalizeToolPack(input: ToolPackV1): ToolPackV1 {
  const required = [...new Set(input.required)].sort();
  const optional = [...new Set(input.optional)].filter((tool) => !required.includes(tool)).sort();
  const forbidden = [...new Set(input.forbidden)].filter((tool) => !required.includes(tool) && !optional.includes(tool)).sort();
  if (required.some((tool) => forbidden.includes(tool))) throw new AehError("SKILL_COMPILATION_REJECTED", "required tool is forbidden.");
  return { version: 1, required, optional, forbidden };
}
