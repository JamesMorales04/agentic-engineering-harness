import { describe, expect, it } from "vitest";
import { compileExecutionBinding } from "../src/architecture/executionIdentity.js";
import { sha256Canonical } from "../src/core/digest.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { createStructuredResultProvenance } from "../src/workers/resultGateway.js";
import { assertResultProvenanceMatchesExecution, type AgentPromptOptions } from "../src/workers/agentPrompt.js";

const OPERATION_ID = "AUDIT-SUPERVISOR-EVENT";
const CANDIDATE = createCandidateRevisionV1({
  operationId: OPERATION_ID,
  candidateId: `candidate:${OPERATION_ID}:r1`,
  projectId: "project:test",
  taskId: OPERATION_ID,
  revision: 1,
  sourceDigest: "a".repeat(64),
  createdAt: new Date(0).toISOString()
});

function binding(overrides: Partial<Parameters<typeof compileExecutionBinding>[0]> = {}) {
  return compileExecutionBinding({
    operationId: OPERATION_ID,
    operationExecutionRevision: 1,
    candidateRevision: CANDIDATE.revision,
    candidateDigest: CANDIDATE.identityDigest,
    controllerEpoch: 1,
    executionBlueprintDigest: "b".repeat(64),
    operationPolicyDigest: "c".repeat(64),
    participantId: `participant:${OPERATION_ID}:supervision`,
    participantGeneration: "generation-1",
    roleInvocationPolicyDigest: "d".repeat(64),
    skillManifestDigest: "e".repeat(64),
    runtime: { runtimeId: "opencode", provider: "opencode", modelId: "opencode-go/muse-spark-1.3-contributor", model: "muse-spark-1.3-contributor", sessionId: "11111111-1111-4111-8111-111111111111" },
    contextManifestDigest: "f".repeat(64),
    promptManifestDigest: "0".repeat(64),
    outputContract: "supervisor",
    leaseIdentities: [],
    ...overrides
  });
}

function operationFor(executionBinding: ReturnType<typeof binding>) {
  return {
    id: OPERATION_ID,
    candidateRevision: CANDIDATE,
    participants: {},
    agents: [{ id: executionBinding.participantId, role: "Operation Supervisor", executionBinding }]
  } as never;
}

function provenanceFor(executionBinding: ReturnType<typeof binding>, candidate = CANDIDATE) {
  return createStructuredResultProvenance({
    projectId: "project:test",
    operationId: OPERATION_ID,
    operationRevision: 7,
    operationExecutionRevision: executionBinding.operationExecutionRevision,
    participantId: executionBinding.participantId,
    participantGeneration: executionBinding.participantGeneration,
    logicalAgent: "operation-supervisor",
    role: "Operation Supervisor",
    taskId: OPERATION_ID,
    candidate,
    controllerEpoch: executionBinding.controllerEpoch,
    runtime: { provider: executionBinding.runtime.provider, model: executionBinding.runtime.modelId, runtimeId: executionBinding.runtime.runtimeId, sessionId: executionBinding.runtime.sessionId },
    outputContract: "supervisor",
    outputSchemaDigest: sha256Canonical({ schema: "supervisor" }),
    executionBlueprintDigest: executionBinding.executionBlueprintDigest,
    resolvedOperationPolicyDigest: executionBinding.operationPolicyDigest,
    executionBinding,
    skillManifestDigest: executionBinding.skillManifestDigest,
    contextManifestDigest: executionBinding.contextManifestDigest,
    promptManifestDigest: executionBinding.promptManifestDigest,
    unsupported: []
  });
}

const selection = { logicalAgent: "operation-supervisor", role: "Operation Supervisor", transport: "paseo" } as never;
const contract = { task: { id: OPERATION_ID } } as never;

function options(overrides: Partial<AgentPromptOptions> = {}): AgentPromptOptions {
  return { outputContract: "supervisor", participantId: `participant:${OPERATION_ID}:supervision`, contextManifestDigest: "1".repeat(64), promptManifestDigest: "2".repeat(64), ...overrides };
}

describe("bound supervisor event continuation identity", () => {
  it("accepts a changed event prompt/context only as an explicit continuation of the bound generation", () => {
    const executionBinding = binding();
    const provenance = provenanceFor(executionBinding);
    expect(() => assertResultProvenanceMatchesExecution(provenance, operationFor(executionBinding), contract, selection, options()))
      .toThrow(/EXECUTION_BINDING_STALE: ContextManifest changed after session materialization/);
    expect(() => assertResultProvenanceMatchesExecution(provenance, operationFor(executionBinding), contract, selection, options(), true)).not.toThrow();
  });

  it("treats the freshly compiled event blueprint as turn-scoped on a continuation while still requiring the bound generation blueprint", () => {
    const executionBinding = binding();
    const provenance = provenanceFor(executionBinding);
    const eventBlueprint = "9".repeat(64);
    const matchingManifests = { contextManifestDigest: "f".repeat(64), promptManifestDigest: "0".repeat(64) };
    expect(() => assertResultProvenanceMatchesExecution(provenance, operationFor(executionBinding), contract, selection, options({ ...matchingManifests, executionBlueprintDigest: eventBlueprint })))
      .toThrow(/result channel belongs to a different execution blueprint/);
    expect(() => assertResultProvenanceMatchesExecution(provenance, operationFor(executionBinding), contract, selection, options({ ...matchingManifests, executionBlueprintDigest: eventBlueprint }), true)).not.toThrow();
    const staleGeneration = binding({ executionBlueprintDigest: eventBlueprint });
    const staleProvenance = provenanceFor(staleGeneration);
    expect(() => assertResultProvenanceMatchesExecution(staleProvenance, operationFor(executionBinding), contract, selection, options(), true))
      .toThrow(/AEH_RESULT_STALE_EXECUTION/);
  });

  it("still rejects a continuation that changes participant, candidate, epoch, or generation identity", () => {
    const executionBinding = binding();
    const provenance = provenanceFor(executionBinding);
    expect(() => assertResultProvenanceMatchesExecution(provenance, operationFor(executionBinding), contract, selection, options({ participantId: "participant:other" }), true))
      .toThrow(/AEH_RESULT_PROVENANCE: result channel belongs to a different participant identity/);
    const otherCandidate = createCandidateRevisionV1({ ...CANDIDATE, candidateId: `${CANDIDATE.candidateId}-other`, revision: 2, sourceDigest: CANDIDATE.sourceDigest, parentCandidateId: CANDIDATE.candidateId });
    const staleCandidateProvenance = provenanceFor(executionBinding, otherCandidate);
    expect(() => assertResultProvenanceMatchesExecution(staleCandidateProvenance, operationFor(executionBinding), contract, selection, options(), true))
      .toThrow(/AEH_RESULT_STALE_CANDIDATE/);
    const rotated = binding({ participantGeneration: "generation-2" });
    const rotatedProvenance = provenanceFor(rotated);
    expect(() => assertResultProvenanceMatchesExecution(rotatedProvenance, operationFor(executionBinding), contract, selection, options(), true))
      .toThrow(/AEH_RESULT_STALE_EXECUTION/);
    expect(() => assertResultProvenanceMatchesExecution(provenance, operationFor(executionBinding), contract, selection, options({ capabilityAuthority: { candidateDigest: CANDIDATE.identityDigest, controllerEpoch: 2 } as never }), true))
      .toThrow(/AEH_RESULT_PROVENANCE: result channel does not match the current execution authority/);
  });

  it("requires actual manifests on a continuation turn", () => {
    const executionBinding = binding();
    const provenance = provenanceFor(executionBinding);
    expect(() => assertResultProvenanceMatchesExecution(provenance, operationFor(executionBinding), contract, selection, options({ contextManifestDigest: undefined, promptManifestDigest: undefined }), true))
      .toThrow(/EXECUTION_BINDING_REQUIRED: a continuation turn must carry actual ContextManifest and PromptManifest digests/);
  });
});
