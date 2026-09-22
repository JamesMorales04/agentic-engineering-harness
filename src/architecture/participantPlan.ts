import { z } from "zod";
import type { AssuranceLevel, ImplementationRoute } from "./contracts.js";
import type { WorkGraphV1, WorkRisk, WorkUnitV1 } from "./workGraph.js";
import { canonicalRoleValues, compileSkillSet, defaultSkillSeed, roleProfile, type CanonicalRole, type ProjectStackProfileV1, type ToolPackV1 } from "../participants/index.js";
import { sha256Canonical } from "../core/digest.js";
import { AehError } from "../core/errors.js";
import { validateAcceptedEphemeralSkill, validateKnowledgePack, type AcceptedEphemeralSkillV1, type KnowledgeResolutionV1 } from "../knowledge/index.js";
import type { ExecutionCatalogV1 } from "./executionCatalog.js";
import { assertCandidateRevisionV1, type CandidateRevisionV1 } from "../operations/v2Contracts.js";
import type { ValidationResolutionV1, ValidationRequirementV1 } from "./validationRequirements.js";
import { assertResolvedOperationPolicyV1, createExecutionBlueprintV2, compileRoleInvocationPolicy, compileSkillManifest, recompileSkillManifestScope, type ExecutionBlueprintV2, type ResolvedOperationPolicyV1, type RoleInvocationPolicyV1, type SkillManifestExecutionIdentityV1, type SkillManifestV1 } from "./executionIdentity.js";

export const participantRoleValues = canonicalRoleValues;
export type ParticipantRole = CanonicalRole;
export const participantRoleSchema = z.enum(participantRoleValues);

export interface ParticipantBudgetV1 {
  maxTokens: number;
  reservedTokens: number;
  maxConcurrent: number;
}

export interface ParticipantAssignmentV1 {
  participantId: string;
  role: ParticipantRole;
  specialization: string;
  competencies: string[];
  skills: string[];
  toolPack: ToolPackV1;
  budget: ParticipantBudgetV1;
  workUnitIds: string[];
  skillManifest: SkillManifestV1;
  roleInvocationPolicy?: RoleInvocationPolicyV1;
}

export interface ParticipantPlanV1 {
  version: 1;
  taskId: string;
  route: ImplementationRoute;
  assurance: AssuranceLevel;
  assignments: ParticipantAssignmentV1[];
  reviewDimensions: string[];
  knowledgeRefs: string[];
  executionCatalogDigest?: string;
  compilerDigest: string;
}

export type ExecutionBlueprint = ExecutionBlueprintV2 & { taskId: string; plan: ParticipantPlanV1; waves: string[][]; deterministicGates: string[]; executionCatalog: ExecutionCatalogV1; validationRequirements: ValidationRequirementV1[]; candidate: CandidateRevisionV1 };

export interface ParticipantCompilerInputV1 {
  graph: WorkGraphV1;
  executionIdentity: SkillManifestExecutionIdentityV1;
  availableCompetencies?: string[];
  availableSkills?: string[];
  knowledgeRefs?: string[];
  maxTokens?: number;
  defaultToolPack?: ToolPackV1;
  projectStack?: ProjectStackProfileV1;
  knowledgeResolution?: KnowledgeResolutionV1;
  knowledgeResolutions?: readonly KnowledgeResolutionV1[];
  executionCatalog?: ExecutionCatalogV1;
  validationRequirements?: readonly ValidationRequirementV1[];
  validationResolution?: ValidationResolutionV1;
  maxParticipants?: number;
  maxConcurrent?: number;
}

const roleForRisk = (_risk: WorkRisk): ParticipantRole => "Implementer";

export function compileParticipantPlan(input: ParticipantCompilerInputV1): ParticipantPlanV1 {
  const knowledgeResolutions = [...(input.knowledgeResolutions ?? []), ...(input.knowledgeResolution ? [input.knowledgeResolution] : [])];
  const operationSkills = validatedOperationSkills(knowledgeResolutions);
  const availableCompetencies = new Set([...(input.availableCompetencies ?? []), ...operationSkills.map((skill) => skill.competency)]);
  const availableSkills = new Set(input.availableSkills ?? input.executionCatalog?.skillRefs ?? []);
  const assignments: ParticipantAssignmentV1[] = [];
  for (const unit of input.graph.units) {
    const validated = assignmentForUnit(unit, input, availableCompetencies, availableSkills, operationSkills);
    const compatible = assignments.find((assignment) => canBundle(assignment, validated, unit));
    if (compatible) compatible.workUnitIds.push(unit.id);
    else assignments.push(validated);
  }
  if (input.maxParticipants !== undefined && assignments.length > input.maxParticipants) throw new AehError("PARTICIPANT_PLAN_BUDGET_EXCEEDED", `${assignments.length} participants exceed the maximum of ${input.maxParticipants}.`);
  for (const assignment of assignments) assignment.skillManifest = recompileSkillManifestScope(assignment.skillManifest, { ...assignment.skillManifest.scope, workUnitIds: assignment.workUnitIds });
  const reviewDimensions = [...new Set(input.graph.units.flatMap((unit) => [
    ...unit.changeKinds.map((kind) => `change:${kind}`),
    ...unit.riskTags.map((tag) => `risk:${tag}`)
  ]))].sort();
  const knowledgeRefs = [...new Set([...(input.knowledgeRefs ?? []), ...knowledgeResolutions.flatMap((resolution) => resolution.pack?.packDigest ? [resolution.pack.packDigest] : [])])].sort();
  const planWithoutDigest = { version: 1 as const, taskId: input.graph.taskId, route: input.graph.route, assurance: input.graph.assurance, assignments, reviewDimensions, knowledgeRefs, ...(input.executionCatalog ? { executionCatalogDigest: input.executionCatalog.digest } : {}) };
  return { ...planWithoutDigest, compilerDigest: digest(planWithoutDigest) };
}

export function compileExecutionBlueprint(input: Omit<ParticipantCompilerInputV1, "executionIdentity"> & { candidate: CandidateRevisionV1; executionCatalog: ExecutionCatalogV1; controllerEpoch: number; operationExecutionRevision: number; resolvedOperationPolicy: ResolvedOperationPolicyV1 }): ExecutionBlueprint {
  if (!input.candidate) throw new AehError("EXECUTION_BLUEPRINT_INVALID", "ExecutionBlueprint requires an immutable CandidateRevision.");
  if (!input.executionCatalog) throw new AehError("EXECUTION_BLUEPRINT_INVALID", "ExecutionBlueprint requires a compiled ExecutionCatalog.");
  if (!Number.isSafeInteger(input.controllerEpoch) || input.controllerEpoch < 0) {
    throw new AehError("EXECUTION_BLUEPRINT_INVALID", "ExecutionBlueprint requires a valid controller epoch.");
  }
  if (!Number.isSafeInteger(input.operationExecutionRevision) || input.operationExecutionRevision < 1) throw new AehError("EXECUTION_BLUEPRINT_INVALID", "ExecutionBlueprint requires a supported operation execution revision.");
  assertResolvedOperationPolicyV1(input.resolvedOperationPolicy);
  if (input.resolvedOperationPolicy.operationId !== input.candidate.operationId || input.resolvedOperationPolicy.projectId !== (input.candidate.projectId ?? input.resolvedOperationPolicy.projectId) || input.resolvedOperationPolicy.candidateDigest !== input.candidate.identityDigest || input.resolvedOperationPolicy.candidateRevision !== input.candidate.revision || input.resolvedOperationPolicy.controllerEpoch !== input.controllerEpoch || input.resolvedOperationPolicy.operationExecutionRevision !== input.operationExecutionRevision) throw new AehError("EXECUTION_BLUEPRINT_INVALID", "ExecutionBlueprint policy does not bind the current operation, candidate, execution revision, and epoch.");
  try { assertCandidateRevisionV1(input.candidate); }
  catch (error) { throw new AehError("EXECUTION_BLUEPRINT_INVALID", "ExecutionBlueprint requires a valid immutable CandidateRevision.", { cause: error }); }
  if (input.candidate.taskId && input.candidate.taskId !== input.graph.taskId) throw new AehError("EXECUTION_BLUEPRINT_INVALID", "ExecutionBlueprint candidate belongs to a different task.");
  const { digest: catalogDigest, ...catalogBody } = input.executionCatalog;
  if (input.executionCatalog.version !== 1 || !/^[a-f0-9]{64}$/.test(catalogDigest) || sha256Canonical(catalogBody) !== catalogDigest) {
    throw new AehError("EXECUTION_BLUEPRINT_INVALID", "ExecutionBlueprint execution catalog digest is invalid.");
  }
  const initialPlan = compileParticipantPlan({ ...input, executionIdentity: { operationId: input.candidate.operationId, operationExecutionRevision: input.operationExecutionRevision, candidateRevision: input.candidate.revision, candidateDigest: input.candidate.identityDigest, controllerEpoch: input.controllerEpoch } });
  const planAssignments = initialPlan.assignments.map((assignment) => {
    const units = input.graph.units.filter((unit) => assignment.workUnitIds.includes(unit.id));
    const workUnitIds = assignment.workUnitIds;
    const outputContract = roleProfile(assignment.role).outputContract;
    const roleInvocationPolicy = compileRoleInvocationPolicy({
      operationId: input.candidate.operationId,
      operationPolicyDigest: input.resolvedOperationPolicy.digest,
      participantId: assignment.participantId,
      role: assignment.role,
      workUnitIds,
      scope: [...new Set(units.flatMap((unit) => unit.scope))],
      competencies: assignment.competencies,
      toolPack: assignment.toolPack,
      resourceClaims: units.flatMap((unit) => unit.resourceClaims.map((claim) => ({ workUnitId: unit.id, claim }))),
      outputContract,
      constraints: { reviewerReadOnly: assignment.role === "Reviewer", workUnitIds }
    });
    return { ...assignment, roleInvocationPolicy };
  });
  const planWithoutDigest = { ...initialPlan, assignments: planAssignments };
  const { compilerDigest: _oldCompilerDigest, ...planBody } = planWithoutDigest;
  const plan = { ...planBody, compilerDigest: sha256Canonical(planBody) } as ParticipantPlanV1;
  const remaining = new Map(input.graph.units.map((unit) => [unit.id, unit]));
  const completed = new Set<string>();
  const waves: string[][] = [];
  while (remaining.size) {
    const wave = [...remaining.values()].filter((unit) => unit.dependencies.every((dependency) => completed.has(dependency))).map((unit) => unit.id);
    if (!wave.length) throw new AehError("EXECUTION_BLUEPRINT_INVALID", "work graph cannot be scheduled.");
    waves.push(wave.sort());
    wave.forEach((id) => { completed.add(id); remaining.delete(id); });
  }
  const deterministicGates = ["work-graph-valid", "participant-plan-valid", "candidate-revision-bound", ...(input.graph.assurance === "CRITICAL" ? ["deterministic-evidence", "review-required"] : [])];
  const executionCatalog = input.executionCatalog;
  const validationRequirements = [...(input.validationRequirements ?? [])];
  const validationResolution = input.validationResolution ?? { version: 1 as const, requirements: validationRequirements, actions: [], blocked: [], digest: sha256Canonical({ version: 1 as const, requirements: validationRequirements, actions: [], blocked: [] }) };
  if (planAssignments.some((assignment) => assignment.roleInvocationPolicy?.participantId !== assignment.participantId || assignment.skillManifest.scope.participantId !== assignment.participantId || assignment.skillManifest.scope.operationId !== input.candidate.operationId || assignment.skillManifest.scope.operationExecutionRevision !== input.operationExecutionRevision || assignment.skillManifest.scope.candidateDigest !== input.candidate.identityDigest || assignment.skillManifest.scope.candidateRevision !== input.candidate.revision || assignment.skillManifest.scope.controllerEpoch !== input.controllerEpoch || sha256Canonical(assignment.skillManifest.scope.workUnitIds) !== sha256Canonical(assignment.workUnitIds))) throw new AehError("EXECUTION_BLUEPRINT_INVALID", "Participant policy or SkillManifest is assigned outside its frozen operation, candidate, epoch, or work-unit scope.");
  const participants = planAssignments.map((assignment) => ({
    participantId: assignment.participantId,
    role: assignment.role,
    specialization: assignment.specialization,
    roleInvocationPolicy: assignment.roleInvocationPolicy,
    toolPack: assignment.toolPack,
    resourceClaims: assignment.roleInvocationPolicy.resourceClaims,
    validationResolution,
    outputContract: assignment.roleInvocationPolicy.outputContract,
    skillManifestDigest: assignment.skillManifest.digest
  }));
  const v2 = createExecutionBlueprintV2({
    projectId: input.candidate.projectId ?? input.resolvedOperationPolicy.projectId,
    operationId: input.candidate.operationId,
    operationExecutionRevision: input.operationExecutionRevision,
    candidateRevision: input.candidate.revision,
    candidateDigest: input.candidate.identityDigest,
    controllerEpoch: input.controllerEpoch,
    resolvedOperationPolicy: input.resolvedOperationPolicy,
    workGraph: input.graph,
    participantPlan: plan,
    executionCatalog,
    participants,
    validationResolution
  });
  const { digest: _digest, ...v2Body } = v2;
  const expanded = { ...v2Body, taskId: input.graph.taskId, plan, waves, deterministicGates, validationRequirements, candidate: input.candidate };
  const digest = sha256Canonical(expanded);
  return deepFreeze({ ...expanded, digest }) as ExecutionBlueprint;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value;
}

function assignmentForUnit(unit: WorkUnitV1, input: ParticipantCompilerInputV1, availableCompetencies: Set<string>, availableSkills: Set<string>, operationSkills: AcceptedEphemeralSkillV1[]): ParticipantAssignmentV1 {
  const competencies = [...new Set(unit.competencies)];
  const knownCompetencies = new Set([...defaultSkillSeed().skills.flatMap((skill) => skill.competencies.map((competency) => competency.id)), ...operationSkills.map((skill) => skill.competency)]);
  const missing = competencies.filter((competency) => !knownCompetencies.has(competency) || (availableCompetencies.size > 0 && !availableCompetencies.has(competency)));
  if (missing.length) throw new AehError("PARTICIPANT_PLAN_INVALID", `missing competencies for '${unit.id}': ${missing.join(", ")}.`);
  const selectedSkills = compileSkillSet({
    role: roleForRisk(unit.risk),
    specializations: [...competencies, ...(input.projectStack?.frameworks ?? []), ...(input.projectStack?.databases ?? []), ...(input.projectStack?.toolchains ?? [])],
    competencies,
    availableSkillIds: availableSkills.size > 0 ? [...availableSkills] : undefined,
    operationSkills,
    toolPack: input.defaultToolPack
  });
  const budget = input.maxTokens ?? 8_000;
  return {
    participantId: `participant:${unit.id}`,
    role: roleForRisk(unit.risk),
    specialization: competencies[0] ?? "general-engineering",
    competencies,
    skills: selectedSkills.skillIds,
    toolPack: validatedToolPack(selectedSkills.toolPack),
    budget: { maxTokens: Math.max(1, budget), reservedTokens: Math.max(1, Math.floor(budget * 0.1)), maxConcurrent: Math.max(1, input.maxConcurrent ?? 1) },
    workUnitIds: [unit.id],
    skillManifest: compileSkillManifest({
      scope: { ...input.executionIdentity, participantId: `participant:${unit.id}`, workUnitIds: [unit.id], competencies },
      skills: selectedSkills.skills.map((skill) => {
        const accepted = operationSkills.find((candidate) => candidate.id === skill.id);
        return {
          id: skill.id,
          kind: skill.kind,
          competencies: skill.competencies,
          proceduralSteps: skill.proceduralSteps,
          ...(accepted ? { sourcePackDigest: accepted.sourcePackDigest, trustDecisionDigest: accepted.trustDecision.decisionDigest, groundedProcedure: accepted.groundedProcedure } : {})
        };
      })
    })
  };
}

function validatedOperationSkills(resolutions: readonly KnowledgeResolutionV1[]): AcceptedEphemeralSkillV1[] {
  const candidates: AcceptedEphemeralSkillV1[] = [];
  for (const resolution of resolutions) {
    if (!resolution.acceptedSkill) continue;
    if (resolution.gate !== "SUFFICIENT" || !resolution.pack || !resolution.gap) throw new AehError("PARTICIPANT_PLAN_INVALID", "operation-local skill is not backed by a sufficient knowledge resolution.");
    const pack = validateKnowledgePack(resolution.pack, resolution.gap);
    const skill = resolution.acceptedSkill;
    try { validateAcceptedEphemeralSkill(skill, pack, resolution.gap); }
    catch (error) { throw new AehError("PARTICIPANT_PLAN_INVALID", `operation-local skill '${skill.id}' is not bound to the deterministic trust-gate result.`, { cause: error }); }
    candidates.push(skill);
  }
  return candidates;
}

function canBundle(assignment: ParticipantAssignmentV1, candidate: ParticipantAssignmentV1, unit: WorkUnitV1): boolean {
  if (assignment.role !== candidate.role || assignment.specialization !== candidate.specialization) return false;
  if (assignment.competencies.join("\0") !== candidate.competencies.join("\0") || toolPackKey(assignment.toolPack) !== toolPackKey(candidate.toolPack)) return false;
  return unit.dependencies.some((dependency) => assignment.workUnitIds.includes(dependency));
}

function toolPackKey(toolPack: ToolPackV1): string { return JSON.stringify([toolPack.required, toolPack.optional, toolPack.forbidden]); }

function validatedToolPack(toolPack: ToolPackV1): ToolPackV1 {
  const required = [...new Set(toolPack.required)].sort();
  const optional = [...new Set(toolPack.optional)].filter((tool) => !required.includes(tool)).sort();
  const forbidden = [...new Set(toolPack.forbidden)].filter((tool) => !required.includes(tool) && !optional.includes(tool)).sort();
  if (!required.length || forbidden.some((tool) => required.includes(tool))) throw new AehError("PARTICIPANT_PLAN_INVALID", "tool pack has an invalid required/forbidden overlap.");
  return { version: 1, required, optional, forbidden };
}

function digest(value: unknown): string {
  return sha256Canonical(value);
}
