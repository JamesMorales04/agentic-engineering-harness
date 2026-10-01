import type { CanonicalRole } from "./types.js";
export type CompetencyLevel = "FOUNDATIONAL" | "WORKING" | "PROFICIENT" | "EXPERT";
export type SkillKind = "role" | "cross-cutting" | "technology" | "project" | "ephemeral";
export interface CompetencyV1 {
    id: string;
    description: string;
    level: CompetencyLevel;
}
export interface SkillDefinitionV1 {
    version: 1;
    id: string;
    name: string;
    description: string;
    kind: SkillKind;
    roles?: readonly CanonicalRole[];
    specializations?: readonly string[];
    requiredTools?: readonly string[];
    forbiddenTools?: readonly string[];
    proceduralSteps: readonly string[];
    competencies: readonly CompetencyV1[];
}
export interface SkillSeedV1 {
    version: 1;
    skills: readonly SkillDefinitionV1[];
}
export declare const DEFAULT_SKILL_SEED_V1: {
    version: 1;
    skills: SkillDefinitionV1[];
};
export declare function defaultSkillSeed(): SkillSeedV1;
export declare function skillDefinition(id: string): SkillDefinitionV1;
