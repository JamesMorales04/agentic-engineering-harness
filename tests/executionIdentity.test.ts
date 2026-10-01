import { describe, expect, it } from "vitest";
import {
  assertExecutionBindingV2,
  assertExecutionBlueprintV2,
  assertResolvedOperationPolicyV1,
  assertRoleInvocationPolicyV1,
  assertSkillManifestV1,
  compileExecutionBinding,
  compileResolvedOperationPolicy,
  compileRoleInvocationPolicy,
  compileSkillManifest,
  createExecutionBlueprintV2
} from "../src/architecture/executionIdentity.js";
import { createWorkGraph } from "../src/architecture/workGraph.js";
import { sha256Canonical } from "../src/core/digest.js";
import { applySkillTrustGate, knowledgePack } from "../src/knowledge/index.js";

const digest = (value: string) => sha256Canonical(value);

function fixture() {
  const policy = compileResolvedOperationPolicy({
    projectId: "project:test", operationId: "RUN-IDENTITY", operationExecutionRevision: 1, candidateRevision: 1,
    candidateDigest: digest("candidate"), controllerEpoch: 2, intent: "review current candidate", route: "DIRECT", minimumAssurance: "STANDARD",
    policyVersions: { resolvedOperationPolicy: "1" }, policyDigests: { validation: digest("validation") },
    validationPolicy: { required: ["unit"] }, reviewPolicy: { independent: false }, deliveryPolicy: {}, knowledgePolicy: {}, contextPolicy: {},
    allowedExternalEffects: [], humanDecisionRequirements: []
  });
  const rolePolicy = compileRoleInvocationPolicy({
    operationId: policy.operationId, operationPolicyDigest: policy.digest, participantId: "participant:reviewer", role: "Reviewer",
    workUnitIds: ["review"], scope: ["src/**"], competencies: ["review"],
    toolPack: { version: 1, required: ["repository-read"], optional: [], forbidden: ["repository-write"] },
    resourceClaims: [], outputContract: "reviewer", constraints: { readOnly: true }
  });
  const skillManifest = compileSkillManifest({ scope: { operationId: policy.operationId, operationExecutionRevision: policy.operationExecutionRevision, candidateRevision: policy.candidateRevision, candidateDigest: policy.candidateDigest, controllerEpoch: policy.controllerEpoch, participantId: "participant:reviewer", workUnitIds: ["review"], competencies: ["review"] }, skills: [] });
  const validationResolution = { version: 1 as const, requirements: [], actions: [], blocked: [], digest: digest("resolution") };
  const blueprint = createExecutionBlueprintV2({
    projectId: policy.projectId, operationId: policy.operationId, operationExecutionRevision: 1, candidateRevision: 1,
    candidateDigest: policy.candidateDigest, controllerEpoch: 2, resolvedOperationPolicy: policy,
    workGraph: createWorkGraph({ taskId: "TASK-IDENTITY", objective: "review", route: "DIRECT", assurance: "STANDARD", requirementRefs: [], acceptanceRefs: [], units: [] }),
    participantPlan: { version: 1, taskId: "TASK-IDENTITY", assignments: ["participant:reviewer"] }, executionCatalog: { version: 1 },
    participants: [{ participantId: "participant:reviewer", role: "Reviewer", specialization: "review", roleInvocationPolicy: rolePolicy,
      toolPack: rolePolicy.toolPack, resourceClaims: [], validationResolution, outputContract: "reviewer", skillManifestDigest: skillManifest.digest }],
    validationResolution
  });
  const binding = compileExecutionBinding({
    operationId: policy.operationId, operationExecutionRevision: 1, candidateRevision: 1, candidateDigest: policy.candidateDigest,
    controllerEpoch: 2, executionBlueprintDigest: blueprint.digest, operationPolicyDigest: policy.digest,
    participantId: "participant:reviewer", participantGeneration: "generation:1", roleInvocationPolicyDigest: rolePolicy.digest,
    skillManifestDigest: skillManifest.digest, runtime: { runtimeId: "codex", provider: "openai", modelId: "test/model", model: "test-model", sessionId: "session:1" },
    contextManifestDigest: digest("context"), promptManifestDigest: digest("prompt"), outputContract: "reviewer", leaseIdentities: ["lease:1"]
  });
  return { policy, rolePolicy, skillManifest, blueprint, binding };
}

describe("frozen execution identity contracts", () => {
  it("freezes policy, role, skill, blueprint, and binding contents with verifiable digests", () => {
    const identities = fixture();
    for (const value of Object.values(identities)) expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(identities.policy.validationPolicy)).toBe(true);
    expect(Object.isFrozen(identities.rolePolicy.toolPack.required)).toBe(true);
    expect(Object.isFrozen(identities.blueprint.participants[0])).toBe(true);
    expect(Object.isFrozen(identities.binding.runtime)).toBe(true);
    assertResolvedOperationPolicyV1(identities.policy);
    assertRoleInvocationPolicyV1(identities.rolePolicy);
    assertSkillManifestV1(identities.skillManifest);
    assertExecutionBlueprintV2(identities.blueprint);
    assertExecutionBindingV2(identities.binding);
  });

  it("retains accepted ephemeral procedure text and rejects ID-only assignments", () => {
    const procedure = ["Inspect the compiler output.", "Preserve the accepted public contract."];
    const gap = { version: 1 as const, cacheKey: digest("gap"), missingCompetencies: ["typescript"], mode: "DOCS_ONLY" as const, librarianRequired: true, reason: "versioned compiler details are missing", status: "MISSING" as const };
    const pack = knowledgePack({ cacheKey: gap.cacheKey, topic: "TypeScript compiler", claims: [{ id: "claim:typescript", statement: procedure.join(" "), competency: "typescript", confidence: "high" }],
      sources: [{ uri: "https://docs.example.test/typescript/1", kind: "official", version: "1" }], retrievedAt: "2026-01-01T00:00:00.000Z" });
    const accepted = applySkillTrustGate({ version: 1, id: "ephemeral:typescript", competency: "typescript", procedure, sourcePackDigest: pack.packDigest, procedureEvidence: procedure.map((_step, stepIndex) => ({ stepIndex, claimIds: ["claim:typescript"], sourceUris: ["https://docs.example.test/typescript/1"] })) }, pack, gap)!;
    const manifest = compileSkillManifest({
      scope: { operationId: "RUN-IDENTITY", operationExecutionRevision: 1, candidateRevision: 1, candidateDigest: digest("candidate"), controllerEpoch: 2, participantId: "participant:implementer", workUnitIds: ["implement"], competencies: ["typescript"] },
      skills: [{ id: accepted.id, kind: "ephemeral", competencies: [{ id: accepted.competency }], proceduralSteps: accepted.procedure,
        sourcePackDigest: accepted.sourcePackDigest, trustDecisionDigest: accepted.trustDecision.decisionDigest, groundedProcedure: accepted.groundedProcedure }]
    });
    expect(manifest.entries[0]).toMatchObject({
      skillId: "ephemeral:typescript", procedure, procedureDigest: sha256Canonical(procedure),
      sourcePackDigest: pack.packDigest, trustDecisionDigest: accepted.trustDecision.decisionDigest
    });
    expect(manifest).toMatchObject({ lifetime: { kind: "operation", operationId: "RUN-IDENTITY" }, scope: { participantId: "participant:implementer", operationExecutionRevision: 1, candidateRevision: 1, candidateDigest: digest("candidate"), controllerEpoch: 2, workUnitIds: ["implement"], competencies: ["typescript"] } });
    expect(manifest.entries[0]?.provenance).toEqual({ kind: "accepted-knowledge", groundedProcedure: accepted.groundedProcedure });
    expect(() => assertSkillManifestV1({ ...manifest, scope: { ...manifest.scope, candidateDigest: digest("another-candidate") } })).toThrow(/digest is inconsistent/);
    expect(() => compileSkillManifest({ scope: { operationId: "RUN-IDENTITY", operationExecutionRevision: 1, candidateRevision: 1, candidateDigest: digest("candidate"), controllerEpoch: 2, participantId: "participant:implementer", workUnitIds: ["implement"], competencies: ["typescript"] }, skills: [
      { id: "ephemeral:typescript", kind: "ephemeral", competencies: [{ id: "typescript" }], proceduralSteps: [], sourcePackDigest: digest("pack"), trustDecisionDigest: digest("trust") }
    ] })).toThrow(/ID-only assignment is unsupported/);
  });

  it("does not compile a RoleInvocation ToolPack beyond the canonical role ceiling", () => {
    const policy = fixture().policy;
    expect(() => compileRoleInvocationPolicy({ operationId: policy.operationId, operationPolicyDigest: policy.digest, participantId: "participant:reviewer",
      role: "Reviewer", workUnitIds: ["review"], scope: ["src/**"], competencies: ["review"],
      toolPack: { version: 1, required: ["repository-read", "repository-write"], optional: [], forbidden: [] }, resourceClaims: [], outputContract: "reviewer", constraints: {} }))
      .toThrow(/ROLE_INVOCATION_POLICY_VIOLATION/);
  });

  it("rejects obsolete identity versions with migration errors", () => {
    const value = fixture();
    expect(() => assertResolvedOperationPolicyV1({ ...value.policy, version: 0 })).toThrow(/UNSUPPORTED_RESOLVED_OPERATION_POLICY_VERSION/);
    expect(() => assertRoleInvocationPolicyV1({ ...value.rolePolicy, version: 0 })).toThrow(/UNSUPPORTED_ROLE_INVOCATION_POLICY_VERSION/);
    expect(() => assertSkillManifestV1({ ...value.skillManifest, version: 0 })).toThrow(/UNSUPPORTED_SKILL_MANIFEST_VERSION/);
    expect(() => assertExecutionBlueprintV2({ ...value.blueprint, version: 1 })).toThrow(/UNSUPPORTED_EXECUTION_BLUEPRINT_VERSION/);
    expect(() => assertExecutionBindingV2({ ...value.binding, version: 1 })).toThrow(/UNSUPPORTED_EXECUTION_BINDING_VERSION/);
  });
});
