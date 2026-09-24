import { sha256Canonical } from "../core/digest.js";
import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";
import type { AssuranceLevel, ImplementationRoute } from "./contracts.js";
import type { ResourceClaimV1, WorkGraphV1 } from "./workGraph.js";
import { roleProfile, type CanonicalRole, type ToolPackV1 } from "../participants/index.js";
import type { GroundedProcedureStepV1 } from "../knowledge/index.js";
import { TOOL_ACTION_KINDS_V1, type ToolActionKindV1 } from "../security/actionKinds.js";

export interface HumanDecisionRequirementV1 {
  kind: "ACTION_AUTHORIZATION";
  action: ToolActionKindV1;
}

export interface ResolvedOperationPolicyV1 {
  version: 1;
  projectId: string;
  operationId: string;
  operationExecutionRevision: number;
  candidateRevision: number;
  candidateDigest: string;
  controllerEpoch: number;
  intent: string;
  route: ImplementationRoute;
  minimumAssurance: AssuranceLevel;
  policyVersions: Record<string, string>;
  policyDigests: Record<string, string>;
  validationPolicy: unknown;
  reviewPolicy: unknown;
  deliveryPolicy: unknown;
  knowledgePolicy: unknown;
  contextPolicy: unknown;
  allowedExternalEffects: string[];
  humanDecisionRequirements: HumanDecisionRequirementV1[];
  digest: string;
}

export interface RoleInvocationPolicyV1 {
  version: 1;
  operationId: string;
  operationPolicyDigest: string;
  participantId: string;
  role: CanonicalRole;
  workUnitIds: string[];
  scope: string[];
  competencies: string[];
  toolPack: ToolPackV1;
  resourceClaims: Array<{ workUnitId: string; claim: ResourceClaimV1 }>;
  outputContract: string;
  constraints: Record<string, unknown>;
  digest: string;
}

export interface SkillManifestEntryV1 {
  skillId: string;
  competency: string;
  kind: "role" | "cross-cutting" | "technology" | "project" | "ephemeral";
  procedure: string[];
  procedureDigest: string;
  sourcePackDigest?: string;
  trustDecisionDigest?: string;
  provenance: { kind: "skill-catalog"; digest: string } | { kind: "accepted-knowledge"; groundedProcedure: GroundedProcedureStepV1[] };
}

export interface SkillManifestScopeV1 {
  operationId: string;
  operationExecutionRevision: number;
  candidateRevision: number;
  candidateDigest: string;
  controllerEpoch: number;
  participantId: string;
  workUnitIds: string[];
  competencies: string[];
}

export type SkillManifestExecutionIdentityV1 = Pick<SkillManifestScopeV1, "operationId" | "operationExecutionRevision" | "candidateRevision" | "candidateDigest" | "controllerEpoch">;

export interface SkillManifestV1 {
  version: 1;
  lifetime: { kind: "operation"; operationId: string };
  scope: SkillManifestScopeV1;
  entries: SkillManifestEntryV1[];
  digest: string;
}

export interface ExecutionBlueprintV2 {
  version: 2;
  projectId: string;
  operationId: string;
  operationExecutionRevision: number;
  candidateRevision: number;
  candidateDigest: string;
  controllerEpoch: number;
  resolvedOperationPolicy: ResolvedOperationPolicyV1;
  workGraph: WorkGraphV1;
  participantPlan: unknown;
  executionCatalog: unknown;
  participants: Array<{
    participantId: string;
    role: CanonicalRole;
    specialization: string;
    roleInvocationPolicy: RoleInvocationPolicyV1;
    toolPack: ToolPackV1;
    resourceClaims: Array<{ workUnitId: string; claim: ResourceClaimV1 }>;
    validationResolution: unknown;
    outputContract: string;
    skillManifestDigest: string;
  }>;
  validationResolution: unknown;
  digest: string;
}

export interface ExecutionBindingV2 {
  version: 2;
  operationId: string;
  operationExecutionRevision: number;
  candidateRevision: number;
  candidateDigest: string;
  controllerEpoch: number;
  executionBlueprintDigest: string;
  operationPolicyDigest: string;
  participantId: string;
  participantGeneration: string;
  roleInvocationPolicyDigest: string;
  skillManifestDigest: string;
  runtime: { runtimeId: string; provider: string; modelId: string; model: string; sessionId: string };
  contextManifestDigest: string;
  promptManifestDigest: string;
  outputContract: string;
  leaseIdentities: string[];
  digest: string;
}

export function compileResolvedOperationPolicy(input: Omit<ResolvedOperationPolicyV1, "version" | "digest">): ResolvedOperationPolicyV1 {
  assertRevision(input.operationExecutionRevision, "operationExecutionRevision");
  assertRevision(input.candidateRevision, "candidateRevision");
  assertRevision(input.controllerEpoch, "controllerEpoch");
  required(input.projectId, "projectId"); required(input.operationId, "operationId"); required(input.intent, "intent");
  requiredDigest(input.candidateDigest, "candidateDigest");
  const body = {
    version: 1 as const,
    ...input,
    policyVersions: sortRecord(input.policyVersions),
    policyDigests: sortRecord(input.policyDigests),
    allowedExternalEffects: [...new Set(input.allowedExternalEffects)].sort(),
    humanDecisionRequirements: canonicalArray(input.humanDecisionRequirements)
  };
  return deepFreeze({ ...body, digest: sha256Canonical(body) });
}

export function compileRoleInvocationPolicy(input: Omit<RoleInvocationPolicyV1, "version" | "digest">): RoleInvocationPolicyV1 {
  required(input.operationId, "operationId"); required(input.participantId, "participantId"); required(input.outputContract, "outputContract");
  requiredDigest(input.operationPolicyDigest, "operationPolicyDigest");
  assertRoleToolCeiling(input.role, input.toolPack);
  const body = {
    version: 1 as const,
    ...input,
    workUnitIds: [...new Set(input.workUnitIds)].sort(),
    scope: [...new Set(input.scope)].sort(),
    competencies: [...new Set(input.competencies)].sort(),
    toolPack: normalizeToolPack(input.toolPack),
    resourceClaims: [...input.resourceClaims].sort((a, b) => a.workUnitId.localeCompare(b.workUnitId) || a.claim.resource.localeCompare(b.claim.resource)),
    constraints: sortRecord(input.constraints)
  };
  return deepFreeze({ ...body, digest: sha256Canonical(body) });
}

export function compileSkillManifest(input: { scope: SkillManifestScopeV1; skills: readonly { id: string; kind: SkillManifestEntryV1["kind"]; competencies: readonly { id: string }[]; proceduralSteps: readonly string[]; sourcePackDigest?: string; trustDecisionDigest?: string; groundedProcedure?: GroundedProcedureStepV1[]; skillCatalogDigest?: string }[] }): SkillManifestV1 {
  validateSkillManifestScope(input.scope);
  const entries = input.skills.map((skill) => {
    const procedure = [...skill.proceduralSteps];
    const competency = skill.competencies[0]?.id ?? skill.id;
    if (skill.kind === "ephemeral" && (!procedure.length || !skill.sourcePackDigest || !skill.trustDecisionDigest || !skill.groundedProcedure || skill.groundedProcedure.length !== procedure.length || skill.groundedProcedure.some((step, index) => step.stepIndex !== index || step.procedureDigest !== sha256Canonical(procedure[index]) || !step.claims.length))) throw new Error("SKILL_MANIFEST_INVALID: accepted ephemeral skills require exact procedure content, per-step pack evidence, scope, and trust-decision provenance; an ID-only assignment is unsupported.");
    if (skill.kind !== "ephemeral" && (skill.sourcePackDigest || skill.trustDecisionDigest || skill.groundedProcedure)) throw new Error("SKILL_MANIFEST_INVALID: only a trust-gated ephemeral skill may carry accepted-knowledge provenance.");
    if (skill.sourcePackDigest) requiredDigest(skill.sourcePackDigest, "sourcePackDigest");
    if (skill.trustDecisionDigest) requiredDigest(skill.trustDecisionDigest, "trustDecisionDigest");
    return {
      skillId: required(skill.id, "skillId"),
      competency,
      kind: skill.kind,
      procedure,
      procedureDigest: sha256Canonical(procedure),
      ...(skill.sourcePackDigest ? { sourcePackDigest: skill.sourcePackDigest } : {}),
      ...(skill.trustDecisionDigest ? { trustDecisionDigest: skill.trustDecisionDigest } : {}),
      provenance: skill.kind === "ephemeral"
        ? { kind: "accepted-knowledge" as const, groundedProcedure: structuredClone(skill.groundedProcedure!) }
        : { kind: "skill-catalog" as const, digest: skill.skillCatalogDigest ?? sha256Canonical({ skillId: skill.id, competency, kind: skill.kind, procedure }) }
    };
  }).sort((a, b) => a.skillId.localeCompare(b.skillId));
  const scope = normalizeSkillManifestScope(input.scope);
  const body = { version: 1 as const, lifetime: { kind: "operation" as const, operationId: scope.operationId }, scope, entries };
  return deepFreeze({ ...body, digest: sha256Canonical(body) });
}

export function compileExecutionBinding(input: Omit<ExecutionBindingV2, "version" | "digest">): ExecutionBindingV2 {
  for (const field of ["executionBlueprintDigest", "operationPolicyDigest", "roleInvocationPolicyDigest", "skillManifestDigest", "contextManifestDigest", "promptManifestDigest"] as const) requiredDigest(input[field], field);
  assertRevision(input.operationExecutionRevision, "operationExecutionRevision");
  assertRevision(input.candidateRevision, "candidateRevision");
  assertRevision(input.controllerEpoch, "controllerEpoch");
  required(input.operationId, "operationId"); required(input.participantId, "participantId"); required(input.participantGeneration, "participantGeneration"); required(input.outputContract, "outputContract");
  if (!input.runtime.runtimeId || !input.runtime.provider || !input.runtime.modelId || !input.runtime.model || !isActualSessionIdentity(input.runtime.sessionId)) throw new Error("EXECUTION_BINDING_SESSION_REQUIRED: approved runtime, model, and actual durable session identity are required; synthetic launch identities are unsupported.");
  const body = { version: 2 as const, ...input, leaseIdentities: [...new Set(input.leaseIdentities)].sort() };
  return deepFreeze({ ...body, digest: sha256Canonical(body) });
}

export function assertExecutionBlueprintV2(value: unknown): asserts value is ExecutionBlueprintV2 {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 2) throw new Error(`UNSUPPORTED_EXECUTION_BLUEPRINT_VERSION: expected version 2; migrate and recompile this blueprint.`);
  const blueprint = value as ExecutionBlueprintV2;
  assertResolvedOperationPolicyV1(blueprint.resolvedOperationPolicy);
  if (!Number.isSafeInteger(blueprint.operationExecutionRevision) || blueprint.operationExecutionRevision < 1 || !Number.isSafeInteger(blueprint.candidateRevision) || blueprint.candidateRevision < 1 || !Number.isSafeInteger(blueprint.controllerEpoch) || blueprint.controllerEpoch < 0 || !blueprint.projectId || !blueprint.operationId || !/^[a-f0-9]{64}$/.test(blueprint.candidateDigest)) throw new Error("EXECUTION_BLUEPRINT_INVALID: blueprint execution identity is incomplete.");
  if (blueprint.resolvedOperationPolicy.operationId !== blueprint.operationId || blueprint.resolvedOperationPolicy.projectId !== blueprint.projectId || blueprint.resolvedOperationPolicy.operationExecutionRevision !== blueprint.operationExecutionRevision || blueprint.resolvedOperationPolicy.candidateRevision !== blueprint.candidateRevision || blueprint.resolvedOperationPolicy.candidateDigest !== blueprint.candidateDigest || blueprint.resolvedOperationPolicy.controllerEpoch !== blueprint.controllerEpoch) throw new Error("EXECUTION_BLUEPRINT_INVALID: blueprint policy does not bind the same operation, candidate, execution revision, project, and epoch.");
  if (!Array.isArray(blueprint.participants) || !blueprint.participants.length) throw new Error("EXECUTION_BLUEPRINT_INVALID: blueprint must bind at least one compiled participant.");
  for (const participant of blueprint.participants) {
    assertRoleInvocationPolicyV1(participant.roleInvocationPolicy);
    if (participant.roleInvocationPolicy.operationId !== blueprint.operationId || participant.roleInvocationPolicy.operationPolicyDigest !== blueprint.resolvedOperationPolicy.digest || participant.roleInvocationPolicy.participantId !== participant.participantId || participant.roleInvocationPolicy.role !== participant.role || sha256Canonical(participant.toolPack) !== sha256Canonical(participant.roleInvocationPolicy.toolPack) || sha256Canonical(participant.resourceClaims) !== sha256Canonical(participant.roleInvocationPolicy.resourceClaims) || participant.outputContract !== participant.roleInvocationPolicy.outputContract || !/^[a-f0-9]{64}$/.test(participant.skillManifestDigest)) throw new Error("EXECUTION_BLUEPRINT_INVALID: participant role, tool/resource ceiling, output, policy, or skill identity is inconsistent.");
  }
  const { digest, ...body } = blueprint;
  if (!/^[a-f0-9]{64}$/.test(digest) || sha256Canonical(body) !== digest) throw new Error("EXECUTION_BLUEPRINT_INVALID: blueprint digest is inconsistent.");
}

export function assertExecutionBindingV2(value: unknown): asserts value is ExecutionBindingV2 {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 2) throw new Error(`UNSUPPORTED_EXECUTION_BINDING_VERSION: expected version 2; relaunch this participant with a current binding.`);
  const binding = value as ExecutionBindingV2;
  if (!Number.isSafeInteger(binding.operationExecutionRevision) || binding.operationExecutionRevision < 1 || !Number.isSafeInteger(binding.candidateRevision) || binding.candidateRevision < 1 || !Number.isSafeInteger(binding.controllerEpoch) || binding.controllerEpoch < 0 || !binding.operationId || !binding.participantId || !binding.participantGeneration || !binding.outputContract) throw new Error("EXECUTION_BINDING_INVALID: binding identity is incomplete.");
  for (const digest of [binding.candidateDigest, binding.executionBlueprintDigest, binding.operationPolicyDigest, binding.roleInvocationPolicyDigest, binding.skillManifestDigest, binding.contextManifestDigest, binding.promptManifestDigest]) requiredDigest(digest, "binding identity digest");
  if (!binding.runtime?.runtimeId || !binding.runtime.provider || !binding.runtime.modelId || !binding.runtime.model || !isActualSessionIdentity(binding.runtime.sessionId) || !Array.isArray(binding.leaseIdentities) || binding.leaseIdentities.some((id) => typeof id !== "string" || !id.trim())) throw new Error("EXECUTION_BINDING_SESSION_REQUIRED: approved runtime/model, actual durable session identity, and lease identity list are required.");
  const { digest, ...body } = binding;
  if (!/^[a-f0-9]{64}$/.test(digest) || sha256Canonical(body) !== digest) throw new Error("EXECUTION_BINDING_INVALID: binding digest is inconsistent.");
}

export function createExecutionBlueprintV2(input: Omit<ExecutionBlueprintV2, "version" | "digest">): ExecutionBlueprintV2 {
  assertResolvedOperationPolicyV1(input.resolvedOperationPolicy);
  for (const participant of input.participants) assertRoleInvocationPolicyV1(participant.roleInvocationPolicy);
  const body = { version: 2 as const, ...input };
  return deepFreeze({ ...body, digest: sha256Canonical(body) });
}

export function assertResolvedOperationPolicyV1(value: unknown): asserts value is ResolvedOperationPolicyV1 {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1) throw new Error("UNSUPPORTED_RESOLVED_OPERATION_POLICY_VERSION: expected version 1; recompile the operation policy.");
  const policy = value as ResolvedOperationPolicyV1;
  if (!policy.projectId || !policy.operationId || !policy.intent || !Number.isSafeInteger(policy.operationExecutionRevision) || policy.operationExecutionRevision < 1 || !Number.isSafeInteger(policy.candidateRevision) || policy.candidateRevision < 1 || !Number.isSafeInteger(policy.controllerEpoch) || policy.controllerEpoch < 0) throw new Error("RESOLVED_OPERATION_POLICY_INVALID: frozen policy identity is incomplete.");
  requiredDigest(policy.candidateDigest, "candidateDigest");
  if (!Array.isArray(policy.allowedExternalEffects) || policy.allowedExternalEffects.some((action) => typeof action !== "string" || !TOOL_ACTION_KINDS_V1.includes(action as ToolActionKindV1))) throw new Error("RESOLVED_OPERATION_POLICY_INVALID: allowedExternalEffects must contain only registered tool action kinds.");
  if (!Array.isArray(policy.humanDecisionRequirements) || policy.humanDecisionRequirements.some((requirement) => !requirement || requirement.kind !== "ACTION_AUTHORIZATION" || !TOOL_ACTION_KINDS_V1.includes(requirement.action))) throw new Error("RESOLVED_OPERATION_POLICY_INVALID: humanDecisionRequirements must be typed exact action authorizations.");
  const { digest, ...body } = policy;
  if (!/^[a-f0-9]{64}$/.test(digest) || sha256Canonical(body) !== digest) throw new Error("RESOLVED_OPERATION_POLICY_INVALID: frozen policy digest is inconsistent.");
}

export function assertRoleInvocationPolicyV1(value: unknown): asserts value is RoleInvocationPolicyV1 {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1) throw new Error("UNSUPPORTED_ROLE_INVOCATION_POLICY_VERSION: expected version 1; recompile the participant role policy.");
  const policy = value as RoleInvocationPolicyV1;
  if (!policy.operationId || !policy.participantId || !policy.outputContract) throw new Error("ROLE_INVOCATION_POLICY_INVALID: role policy identity is incomplete.");
  assertRoleToolCeiling(policy.role, policy.toolPack);
  requiredDigest(policy.operationPolicyDigest, "operationPolicyDigest");
  const { digest, ...body } = policy;
  if (!/^[a-f0-9]{64}$/.test(digest) || sha256Canonical(body) !== digest) throw new Error("ROLE_INVOCATION_POLICY_INVALID: role policy digest is inconsistent.");
}

export function assertSkillManifestV1(value: unknown): asserts value is SkillManifestV1 {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1) throw new Error("UNSUPPORTED_SKILL_MANIFEST_VERSION: expected version 1; recompile the participant skill manifest.");
  const manifest = value as SkillManifestV1;
  if (!manifest.lifetime || manifest.lifetime.kind !== "operation" || manifest.lifetime.operationId !== manifest.scope?.operationId || !Array.isArray(manifest.entries)) throw new Error("SKILL_MANIFEST_INVALID: operation lifetime, scope, or entries are missing.");
  validateSkillManifestScope(manifest.scope);
  for (const entry of manifest.entries) {
    if (!entry.skillId || !entry.competency || !Array.isArray(entry.procedure) || sha256Canonical(entry.procedure) !== entry.procedureDigest) throw new Error("SKILL_MANIFEST_INVALID: procedure content does not match its recorded digest.");
    if (entry.kind === "ephemeral" && (!entry.procedure.length || !entry.sourcePackDigest || !entry.trustDecisionDigest || entry.provenance?.kind !== "accepted-knowledge" || entry.provenance.groundedProcedure.length !== entry.procedure.length || entry.provenance.groundedProcedure.some((step, index) => step.stepIndex !== index || step.procedureDigest !== sha256Canonical(entry.procedure[index]) || !step.claims.length || step.claims.some((claim) => !/^[a-f0-9]{64}$/.test(claim.claimDigest) || !claim.sourceUris.length)))) throw new Error("SKILL_MANIFEST_INVALID: accepted ephemeral skill lacks exact procedure content, per-step pack evidence, or trust provenance.");
    if (entry.kind !== "ephemeral" && (entry.provenance?.kind !== "skill-catalog" || !/^[a-f0-9]{64}$/.test(entry.provenance.digest))) throw new Error("SKILL_MANIFEST_INVALID: catalog skill lacks exact content provenance.");
    if (entry.sourcePackDigest) requiredDigest(entry.sourcePackDigest, "sourcePackDigest");
    if (entry.trustDecisionDigest) requiredDigest(entry.trustDecisionDigest, "trustDecisionDigest");
    if (entry.kind === "ephemeral" && !manifest.scope.competencies.includes(entry.competency)) throw new Error("SKILL_MANIFEST_INVALID: accepted ephemeral skill competency exceeds the assigned manifest scope.");
  }
  const { digest, ...body } = manifest;
  if (!/^[a-f0-9]{64}$/.test(digest) || sha256Canonical(body) !== digest) throw new Error("SKILL_MANIFEST_INVALID: manifest digest is inconsistent.");
}

export function recompileSkillManifestScope(manifest: SkillManifestV1, scope: SkillManifestScopeV1): SkillManifestV1 {
  assertSkillManifestV1(manifest);
  if (manifest.scope.operationId !== scope.operationId || manifest.scope.operationExecutionRevision !== scope.operationExecutionRevision || manifest.scope.candidateRevision !== scope.candidateRevision || manifest.scope.candidateDigest !== scope.candidateDigest || manifest.scope.controllerEpoch !== scope.controllerEpoch || manifest.scope.participantId !== scope.participantId || sha256Canonical(manifest.scope.competencies) !== sha256Canonical(scope.competencies)) throw new Error("SKILL_MANIFEST_SCOPE_MISMATCH: assignment scope cannot change the frozen operation, candidate, epoch, participant, or competencies.");
  return compileSkillManifest({ scope, skills: manifest.entries.map((entry) => ({
    id: entry.skillId,
    kind: entry.kind,
    competencies: [{ id: entry.competency }],
    proceduralSteps: entry.procedure,
    ...(entry.sourcePackDigest ? { sourcePackDigest: entry.sourcePackDigest } : {}),
    ...(entry.trustDecisionDigest ? { trustDecisionDigest: entry.trustDecisionDigest } : {}),
    ...(entry.provenance.kind === "accepted-knowledge" ? { groundedProcedure: entry.provenance.groundedProcedure } : { skillCatalogDigest: entry.provenance.digest })
  })) });
}

function normalizeToolPack(input: ToolPackV1): ToolPackV1 {
  const requiredTools = [...new Set(input.required)].sort();
  const optional = [...new Set(input.optional)].filter((tool) => !requiredTools.includes(tool)).sort();
  const forbidden = [...new Set(input.forbidden)].filter((tool) => !requiredTools.includes(tool) && !optional.includes(tool)).sort();
  return { version: 1, required: requiredTools, optional, forbidden };
}
function assertRoleToolCeiling(role: CanonicalRole, toolPack: ToolPackV1): void {
  const profile = roleProfile(role);
  const allowed = new Set([...profile.toolPack.required, ...profile.toolPack.optional]);
  const requested = [...new Set([...toolPack.required, ...toolPack.optional])];
  const denied = requested.filter((tool) => !allowed.has(tool) || profile.toolPack.forbidden.includes(tool));
  if (denied.length) throw new Error(`ROLE_INVOCATION_POLICY_VIOLATION: ${role} ToolPack exceeds its compiled role ceiling: ${denied.sort().join(", ")}.`);
}
function sortRecord<T>(record: Record<string, T>): Record<string, T> { return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b))); }
function canonicalArray<T>(values: T[]): T[] { return [...values].sort((a, b) => sha256Canonical(a).localeCompare(sha256Canonical(b))); }
function required(value: string, name: string): string { if (!value?.trim()) throw new Error(`EXECUTION_IDENTITY_INVALID: ${name} is required.`); return value; }
function isActualSessionIdentity(value: unknown): value is string { return typeof value === "string" && Boolean(value.trim()) && !value.startsWith("launch:"); }
function requiredDigest(value: string, name: string): void { if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`EXECUTION_IDENTITY_INVALID: ${name} must be a SHA-256 digest.`); }
function assertRevision(value: number, name: string): void { if (!Number.isSafeInteger(value) || value < 0) throw new Error(`EXECUTION_IDENTITY_INVALID: ${name} must be a non-negative integer.`); }
function validateSkillManifestScope(scope: SkillManifestScopeV1): void {
  if (!scope || typeof scope !== "object" || !scope.operationId || !scope.participantId || !Array.isArray(scope.workUnitIds) || !scope.workUnitIds.length || !Array.isArray(scope.competencies) || !Number.isSafeInteger(scope.operationExecutionRevision) || scope.operationExecutionRevision < 1 || !Number.isSafeInteger(scope.candidateRevision) || scope.candidateRevision < 1 || !Number.isSafeInteger(scope.controllerEpoch) || scope.controllerEpoch < 0) throw new Error("SKILL_MANIFEST_INVALID: operation execution scope is incomplete.");
  requiredDigest(scope.candidateDigest, "candidateDigest");
  if (new Set(scope.workUnitIds).size !== scope.workUnitIds.length || new Set(scope.competencies).size !== scope.competencies.length) throw new Error("SKILL_MANIFEST_INVALID: manifest scope contains duplicate work units or competencies.");
}
function normalizeSkillManifestScope(scope: SkillManifestScopeV1): SkillManifestScopeV1 {
  validateSkillManifestScope(scope);
  return { ...scope, workUnitIds: [...new Set(scope.workUnitIds)].sort(), competencies: [...new Set(scope.competencies)].sort() };
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value;
}
