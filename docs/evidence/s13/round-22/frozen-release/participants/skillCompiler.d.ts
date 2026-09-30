import type { CanonicalRole, ParticipantCapability, ToolPackV1 } from "./types.js";
import { type AcceptedEphemeralSkillV1 } from "../knowledge/index.js";
import { type SkillDefinitionV1 } from "./skills.js";
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
export declare function compileSkillSet(input: SkillCompilationInputV1): CompiledSkillSetV1;
