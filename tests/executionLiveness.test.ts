import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileExecutionBinding, compileResolvedOperationPolicy, compileRoleInvocationPolicy } from "../src/architecture/executionIdentity.js";
import { sha256Canonical } from "../src/core/digest.js";
import {
  hardDeadlineFor,
  initialParticipantLivenessV1,
  progressLevelForEvidenceV1,
  readExecutionActivityEventsV1,
  recordParticipantExecutionActivityV1,
  renewParticipantProgressLeaseV1,
  decideParticipantRecoveryV1,
  requireOwnerEconomicBoundaryBeforeExternalEffectV1,
  type EconomicEnvelopeV1,
  type ExecutionLivenessPolicyV1
} from "../src/operations/executionLiveness.js";
import {
  bindOperationCandidate,
  bindOperationParticipantExecution,
  bindOperationLead,
  bindResolvedOperationPolicy,
  currentControllerEpoch,
  loadOperation,
  registerOperationAgent,
  registerSupervisorGeneration,
  saveOperation,
  updateOperationParticipant,
  type OperationRecordV2
} from "../src/operations/state.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { startDetachedOperation, terminalizeOperation } from "../src/operations/controller.js";
import { createIntentDecision } from "../src/audit/intentDecision.js";
import { compileOperationOriginV1 } from "../src/operations/operationProvenance.js";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import { handleSupervisorMcpRequest } from "../src/operations/supervisorMcp.js";
import { dispatchSameSessionResumeV1 } from "../src/operations/supervisorMcp.js";
import { handleOperationMcpRequest } from "../src/operations/mcp.js";
import { evaluateOperationWake, operationLivenessPolicy, runOperationLivenessCheck } from "../src/operations/liveness.js";
import { bindPaseoSession } from "../src/paseo/sessionBinding.js";
import { persistOperationCapabilityRegistryV1, type CapabilityRegistryV1 } from "../src/capabilities/registry.js";

const roots: string[] = [];
const originalEnvironment = Object.fromEntries(
  ["AEH_OPERATION_ID", "AEH_CONTROL_ROOT", "AEH_OPERATION_STATE_REDIRECT", "AEH_CONTROLLER_EPOCH", "AEH_CONTROLLER_TOKEN"].map((key) => [key, process.env[key]])
);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const digest = (value: unknown) => sha256Canonical(value);

const livenessPolicy = (overrides: Partial<ExecutionLivenessPolicyV1> = {}): Partial<ExecutionLivenessPolicyV1> => ({
  hardDeadlineMs: 8 * 60 * 60_000,
  progressLeaseMs: 15 * 60_000,
  stallWindowMs: 15 * 60_000,
  providerTurnDeadlineMs: 30 * 60_000,
  defaultToolDeadlineMs: 30 * 60_000,
  maxNoProgressRenewals: 2,
  maxParticipantRestarts: 2,
  maxLocalRetriesPerFailure: 1,
  softBudgetThreshold: 0.8,
  toolDeadlinesMs: {},
  ...overrides
});

const economicEnvelope = (overrides: Partial<EconomicEnvelopeV1> = {}): Partial<EconomicEnvelopeV1> => ({
  initialProviderTurns: 8,
  supervisorProviderTurns: 12,
  hardProviderTurns: 16,
  maxLocalRetries: 1,
  maxParticipantRestarts: 2,
  softThreshold: 0.8,
  ...overrides
});

async function makeFixture(options: {
  operationId?: string;
  liveness?: Partial<ExecutionLivenessPolicyV1>;
  economic?: Partial<EconomicEnvelopeV1>;
  supervisor?: boolean;
  capabilityRegistry?: boolean;
  userTurnId?: string;
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-execution-liveness-"));
  roots.push(root);
  const operationId = options.operationId ?? `LIVENESS-${roots.length}`;
  const now = new Date();
  const timestamp = now.toISOString();
  const record: OperationRecordV2 = {
    version: 2,
    id: operationId,
    kind: "audit",
    status: "RUNNING",
    phase: "reviewing",
    root,
    payload: { request: "exercise execution liveness" },
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastProgressAt: timestamp,
    ...(options.userTurnId ? { origin: compileOperationOriginV1({
      kind: "USER_REQUEST", userTurnId: options.userTurnId, authorizationDigest: digest(`auth:${options.userTurnId}`),
      triggerEventId: `user.turn:${options.userTurnId}`, requestDigest: digest(`request:${options.userTurnId}`), recoveryDepth: 0,
      rootHardDeadlineAt: new Date(now.getTime() + 8 * 60 * 60_000).toISOString(), reason: "liveness test Owner request", createdAt: timestamp
    }) } : {}),
    supervision: { required: true, materialized: false, generations: [] },
    stages: {},
    participants: {},
    progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 }
  };
  await saveOwnedOperation(root, record);
  let operation = await loadOperation(root, operationId);
  const candidate = operation.candidateRevision!;
  let capabilityRegistry: CapabilityRegistryV1 | undefined;
  if (options.capabilityRegistry) {
    const body = { version: 1 as const, operationId, capabilities: [{
      id: "aeh:paseo-participant-lifecycle", kind: "HARNESS_INTERNAL" as const, provider: "paseo", toolService: "Paseo session lifecycle",
      sourceOfTruth: "src/paseo/runtimeCore.ts", availability: "CONFIGURED" as const, availabilityReason: "Paseo is enabled for this fixture.",
      audience: "CONTROLLER_ONLY" as const, authorityRequired: "controller session recovery", sideEffectClass: "CONTROLLER_INTERNAL" as const,
      inputs: ["frozen execution binding"], outputs: ["session state"], failureClasses: ["TIMEOUT"], roles: [], skillRefs: ["paseo-runtime-diagnostics"]
    }] };
    capabilityRegistry = { ...body, digest: digest(body) };
    await persistOperationCapabilityRegistryV1(root, capabilityRegistry);
  }
  const policy = compileResolvedOperationPolicy({
    projectId: candidate.projectId!, operationId,
    operationExecutionRevision: operation.operationExecutionRevision!, candidateRevision: candidate.revision,
    candidateDigest: candidate.identityDigest, controllerEpoch: currentControllerEpoch(operation),
    intent: "exercise participant progress and recovery", route: "DIRECT", minimumAssurance: "STANDARD",
    policyVersions: { resolvedOperationPolicy: "2" }, policyDigests: {}, validationPolicy: {}, reviewPolicy: {},
    deliveryPolicy: {}, knowledgePolicy: {}, contextPolicy: {}, allowedExternalEffects: [], humanDecisionRequirements: [],
    ...(capabilityRegistry ? { capabilityRegistryDigest: capabilityRegistry.digest } : {}),
    executionLiveness: livenessPolicy(options.liveness), economicEnvelope: economicEnvelope(options.economic)
  });
  await bindResolvedOperationPolicy(root, operationId, policy);
  await bindOperationLead(root, operationId, "session:lead-current");
  const participantId = "participant:implementer";
  await registerOperationAgent(root, operationId, { id: participantId, logicalAgent: "implementer", role: "Implementer", phase: "implementation" });
  const participantRole = compileRoleInvocationPolicy({
    operationId, operationPolicyDigest: policy.digest, participantId, role: "Implementer", workUnitIds: ["implement"],
    scope: ["src/**"], competencies: ["implementation"], toolPack: { version: 1, required: [], optional: [], forbidden: [] },
    resourceClaims: [], outputContract: "implementer", constraints: {}
  });
  const participantBinding = compileExecutionBinding({
    operationId, operationExecutionRevision: operation.operationExecutionRevision!, candidateRevision: candidate.revision,
    candidateDigest: candidate.identityDigest, controllerEpoch: currentControllerEpoch(operation),
    executionBlueprintDigest: digest("blueprint"), operationPolicyDigest: policy.digest, participantId,
    participantGeneration: "generation:implementer:1", roleInvocationPolicyDigest: participantRole.digest,
    skillManifestDigest: digest("skill-manifest"), runtime: { runtimeId: "codex", provider: "test-provider", modelId: "test/model", model: "test-model", sessionId: "session:implementer:1" },
    contextManifestDigest: digest("context"), promptManifestDigest: digest("prompt"), outputContract: "implementer", leaseIdentities: []
  });
  await bindOperationParticipantExecution(root, operationId, { participantId, logicalAgent: "implementer", role: "Implementer", binding: participantBinding });
  operation = await loadOperation(root, operationId);
  const startedAt = new Date(operation.createdAt);
  const executionStartedAt = new Date(startedAt.getTime() + 1_000);
  const { initializeParticipantLivenessV1 } = await import("../src/operations/executionLiveness.js");
  await initializeParticipantLivenessV1(root, operationId, participantId, participantBinding, executionStartedAt);
  await updateOperationParticipant(root, operationId, participantId, { status: "RUNNING" });

  let supervisorId: string | undefined;
  if (options.supervisor) {
    supervisorId = "session:supervisor:1";
    await registerOperationAgent(root, operationId, { id: supervisorId, logicalAgent: "supervisor", role: "Operation Supervisor", phase: "supervision" });
    await registerSupervisorGeneration(root, operationId, { agentId: supervisorId, materialized: true, status: "ACTIVE" });
    const supervisorRole = compileRoleInvocationPolicy({
      operationId, operationPolicyDigest: policy.digest, participantId: supervisorId, role: "Operation Supervisor", workUnitIds: ["supervise"],
      scope: ["operation/**"], competencies: ["recovery"], toolPack: { version: 1, required: [], optional: [], forbidden: [] },
      resourceClaims: [], outputContract: "supervisor", constraints: {}
    });
    const supervisorBinding = compileExecutionBinding({
      operationId, operationExecutionRevision: operation.operationExecutionRevision!, candidateRevision: candidate.revision,
      candidateDigest: candidate.identityDigest, controllerEpoch: currentControllerEpoch(operation), executionBlueprintDigest: digest("supervisor-blueprint"),
      operationPolicyDigest: policy.digest, participantId: supervisorId, participantGeneration: "generation:supervisor:1",
      roleInvocationPolicyDigest: supervisorRole.digest, skillManifestDigest: digest("supervisor-skills"),
      runtime: { runtimeId: "codex", provider: "test-provider", modelId: "test/model", model: "test-model", sessionId: "session:supervisor:1" },
      contextManifestDigest: digest("supervisor-context"), promptManifestDigest: digest("supervisor-prompt"), outputContract: "supervisor", leaseIdentities: []
    });
    await bindOperationParticipantExecution(root, operationId, { participantId: supervisorId, logicalAgent: "supervisor", role: "Operation Supervisor", binding: supervisorBinding });
  }

  return { root, operationId, participantId, participantBinding, policy, startedAt, executionStartedAt, supervisorId, capabilityRegistry };
}

describe("execution liveness model", () => {
  it("classifies durable progress HIGH/MEDIUM and heartbeat or repeated activity LOW", () => {
    for (const kind of ["SOURCE_MUTATION", "CANDIDATE_REVISION", "TEST_RESULT", "VALIDATION_RESULT", "ARTIFACT_PRODUCED", "BLOCKER_RESOLVED", "STRUCTURED_RESULT_ACCEPTED"] as const) {
      expect(progressLevelForEvidenceV1(kind)).toBe("HIGH");
    }
    for (const kind of ["NEW_RETRIEVAL", "TOOL_SUCCESS_NONREDUNDANT", "DEPENDENCY_DISCOVERY", "WORKGRAPH_ADVANCED"] as const) {
      expect(progressLevelForEvidenceV1(kind)).toBe("MEDIUM");
    }
    for (const kind of ["PROVIDER_HEARTBEAT", "REASONING_ACTIVITY", "REPEATED_READ", "EQUIVALENT_TOOL_CALL"] as const) {
      expect(progressLevelForEvidenceV1(kind)).toBe("LOW");
    }
  });

  it("caps the initial lease at the operation hard deadline and inherits an earlier root deadline", async () => {
    const { participantBinding, policy } = await makeFixture({ liveness: { hardDeadlineMs: 60_000, progressLeaseMs: 90_000 } });
    const operationCreatedAt = "2026-10-02T10:00:00.000Z";
    const at = new Date("2026-10-02T10:00:30.000Z");
    const liveness = initialParticipantLivenessV1(participantBinding, policy.executionLiveness, policy.economicEnvelope, at, operationCreatedAt, "2026-10-02T10:00:45.000Z");
    expect(liveness.progressLease?.expiresAt).toBe("2026-10-02T10:00:45.000Z");
    expect(hardDeadlineFor({ createdAt: operationCreatedAt, origin: { rootHardDeadlineAt: "2026-10-02T10:00:45.000Z" } as never }, 60_000)).toBe(Date.parse("2026-10-02T10:00:45.000Z"));
  });

  it("uses the frozen operation liveness deadline after project configuration changes", async () => {
    const fixture = await makeFixture({ liveness: { hardDeadlineMs: 60_000, stallWindowMs: 2_000 } });
    const operation = await loadOperation(fixture.root, fixture.operationId);
    const policy = operationLivenessPolicy({ version: 1, project: { name: "liveness-test" }, orchestration: { provider: "paseo", operations: { liveness: { hardDeadlineMs: 12 * 60 * 60_000, stallWindowMs: 60 * 60_000 } } } } as never, operation);
    expect(policy).toMatchObject({ hardDeadlineMs: 60_000, stallThresholdMs: 2_000 });
  });

  it("records a provider heartbeat without renewing meaningful progress", async () => {
    const fixture = await makeFixture();
    const before = (await loadOperation(fixture.root, fixture.operationId)).participants[fixture.participantId]!.executionLiveness!;
    const at = new Date(fixture.executionStartedAt.getTime() + 60_000);
    await recordParticipantExecutionActivityV1(fixture.root, fixture.operationId, fixture.participantId, {
      kind: "PROVIDER_HEARTBEAT", evidenceId: "heartbeat:1", evidenceDigest: digest("heartbeat"), observedAt: at
    });
    const after = (await loadOperation(fixture.root, fixture.operationId)).participants[fixture.participantId]!.executionLiveness!;
    expect(after.lastActivityAt).toBe(at.toISOString());
    expect(after.lastMeaningfulProgressAt).toBeUndefined();
    expect(after.progressLease?.digest).toBe(before.progressLease?.digest);
    expect(after.state).toBe("WAITING_PROVIDER");
  });

  it("continues beyond the former 30 minute global timeout when durable progress arrives", async () => {
    const fixture = await makeFixture();
    const at = new Date(fixture.executionStartedAt.getTime() + 31 * 60_000);
    const activity = await recordParticipantExecutionActivityV1(fixture.root, fixture.operationId, fixture.participantId, {
      kind: "SOURCE_MUTATION", evidenceId: "mutation:after-31m", evidenceDigest: digest("source-diff"), observedAt: at
    });
    const operation = await loadOperation(fixture.root, fixture.operationId);
    const liveness = operation.participants[fixture.participantId]!.executionLiveness!;
    expect(activity?.level).toBe("HIGH");
    expect(liveness.repositoryMutationCount).toBe(1);
    expect(Date.parse(liveness.progressLease!.expiresAt)).toBeGreaterThan(at.getTime());
    expect(liveness.progressLease?.renewedThroughEvidenceDigest).toBe(activity?.eventId);
  });

  it("uses a configured per-tool deadline and records wait state", async () => {
    const fixture = await makeFixture({ liveness: { defaultToolDeadlineMs: 10_000, toolDeadlinesMs: { "npm ci": 2_000 } } });
    const at = new Date(fixture.executionStartedAt.getTime() + 1_000);
    await recordParticipantExecutionActivityV1(fixture.root, fixture.operationId, fixture.participantId, {
      kind: "WAITING_TOOL", evidenceId: "tool:wait:npm", evidenceDigest: digest("npm"), toolName: "npm ci", observedAt: at
    });
    const liveness = (await loadOperation(fixture.root, fixture.operationId)).participants[fixture.participantId]!.executionLiveness!;
    expect(liveness.state).toBe("WAITING_TOOL");
    expect(liveness.waitingToolName).toBe("npm ci");
    expect(liveness.waitingDeadlineAt).toBe(new Date(at.getTime() + 2_000).toISOString());
  });

  it("allows controller authority to renew on progress, but bounds Supervisor turns and permits Lead delegation", async () => {
    const fixture = await makeFixture({ supervisor: true, economic: { initialProviderTurns: 1, supervisorProviderTurns: 1, hardProviderTurns: 2 } });
    const progressAt = new Date(fixture.executionStartedAt.getTime() + 20_000);
    await recordParticipantExecutionActivityV1(fixture.root, fixture.operationId, fixture.participantId, {
      kind: "NEW_RETRIEVAL", evidenceId: "retrieval:new", evidenceDigest: digest("retrieval"), observedAt: progressAt
    });
    const renewed = await renewParticipantProgressLeaseV1(fixture.root, {
      operationId: fixture.operationId, participantId: fixture.participantId, actorSessionId: "session:lead-current", at: new Date(progressAt.getTime() + 1_000)
    });
    expect(renewed.renewalCount).toBe(2);

    await recordParticipantExecutionActivityV1(fixture.root, fixture.operationId, fixture.participantId, {
      kind: "PROVIDER_TURN_STARTED", evidenceId: "turn:1", evidenceDigest: digest("turn-1"), observedAt: new Date(progressAt.getTime() + 2_000)
    });
    await expect(renewParticipantProgressLeaseV1(fixture.root, {
      operationId: fixture.operationId, participantId: fixture.participantId, actorSessionId: "session:supervisor:1",
      actorParticipantId: fixture.supervisorId, at: new Date(progressAt.getTime() + 3_000)
    })).rejects.toThrow(/SUPERVISOR_DELEGATION_EXHAUSTED/);
    const leadRenewed = await renewParticipantProgressLeaseV1(fixture.root, {
      operationId: fixture.operationId, participantId: fixture.participantId, actorSessionId: "session:lead-current", at: new Date(progressAt.getTime() + 4_000)
    });
    expect((await loadOperation(fixture.root, fixture.operationId)).participants[fixture.participantId]!.executionLiveness!.currentProviderTurnBudget).toBe(2);
    expect(leadRenewed.renewalCount).toBe(3);
  });

  it("rejects unauthenticated participants and stale Supervisor generations as lease authorities", async () => {
    const fixture = await makeFixture({ supervisor: true });
    const renewalAt = new Date(fixture.executionStartedAt.getTime() + 5_000);
    await expect(renewParticipantProgressLeaseV1(fixture.root, {
      operationId: fixture.operationId, participantId: fixture.participantId, actorSessionId: "session:implementer:1", actorParticipantId: fixture.participantId, at: renewalAt
    })).rejects.toThrow(/PROGRESS_LEASE_AUTHORITY_DENIED/);

    await registerOperationAgent(fixture.root, fixture.operationId, { id: "participant:supervisor:2", logicalAgent: "supervisor", role: "Operation Supervisor", phase: "supervision" });
    await registerSupervisorGeneration(fixture.root, fixture.operationId, { agentId: "participant:supervisor:2", materialized: true, status: "ACTIVE" });
    await expect(renewParticipantProgressLeaseV1(fixture.root, {
      operationId: fixture.operationId, participantId: fixture.participantId, actorSessionId: "session:supervisor:1", actorParticipantId: fixture.supervisorId, at: renewalAt
    })).rejects.toThrow(/PROGRESS_LEASE_AUTHORITY_DENIED/);
  });

  it("rejects stale participant bindings after candidate advancement", async () => {
    const fixture = await makeFixture();
    const operation = await loadOperation(fixture.root, fixture.operationId);
    const current = operation.candidateRevision!;
    const nextCandidate = createCandidateRevisionV1({
      operationId: fixture.operationId, candidateId: `${current.candidateId}:r2`, projectId: current.projectId, taskId: current.taskId,
      revision: current.revision + 1, parentCandidateId: current.candidateId, sourceDigest: current.sourceDigest,
      worktree: current.worktree, createdAt: new Date().toISOString()
    });
    await bindOperationCandidate(fixture.root, fixture.operationId, nextCandidate);
    const event = await recordParticipantExecutionActivityV1(fixture.root, fixture.operationId, fixture.participantId, {
      kind: "SOURCE_MUTATION", evidenceId: "stale:mutation", evidenceDigest: digest("stale"), observedAt: new Date(fixture.executionStartedAt.getTime() + 10_000)
    });
    expect(event).toBeUndefined();
    expect(await readExecutionActivityEventsV1(fixture.root, fixture.operationId)).toEqual([]);
    await expect(renewParticipantProgressLeaseV1(fixture.root, {
      operationId: fixture.operationId, participantId: fixture.participantId, actorSessionId: "session:lead-current", at: new Date(fixture.executionStartedAt.getTime() + 11_000)
    })).rejects.toThrow(/PROGRESS_LEASE_RENEWAL_REJECTED/);
  });

  it("enforces the hard tool-call boundary even when the Lead owns renewal", async () => {
    const fixture = await makeFixture({ economic: { hardToolCalls: 1 } });
    const at = new Date(fixture.executionStartedAt.getTime() + 1_000);
    await recordParticipantExecutionActivityV1(fixture.root, fixture.operationId, fixture.participantId, {
      kind: "TOOL_CALL_COMPLETED", evidenceId: "tool:completed:1", evidenceDigest: digest("tool-result"), toolName: "read", observedAt: at
    });
    await expect(renewParticipantProgressLeaseV1(fixture.root, {
      operationId: fixture.operationId, participantId: fixture.participantId, actorSessionId: "session:lead-current", at: new Date(at.getTime() + 1_000)
    })).rejects.toThrow(/OWNER_DECISION_REQUIRED/);
    expect(await loadOperation(fixture.root, fixture.operationId)).toMatchObject({ phase: "HUMAN_REQUIRED", ownerEconomicBoundary: { budget: "HARD_TOOL_CALLS", configuredLimit: 1, observed: 1 } });
  });

  it("lets the bound Supervisor record an evidence-backed decision and renew within frozen policy", async () => {
    const fixture = await makeFixture({ supervisor: true });
    const event = await recordParticipantExecutionActivityV1(fixture.root, fixture.operationId, fixture.participantId, {
      kind: "PROVIDER_HEARTBEAT", evidenceId: "provider:quiet", evidenceDigest: digest("heartbeat"), observedAt: new Date(fixture.executionStartedAt.getTime() + 20_000)
    });
    const before = await loadOperation(fixture.root, fixture.operationId);
    const result = await decideParticipantRecoveryV1(fixture.root, {
      operationId: fixture.operationId,
      participantId: fixture.participantId,
      actorRole: "SUPERVISOR",
      actorSessionId: "session:supervisor:1",
      action: "CONTINUE",
      expectedBindingDigest: fixture.participantBinding.digest,
      evidenceIds: [event!.eventId],
      reason: "The frozen binding is current and the Supervisor renewal remains inside the one-turn delegation.",
      at: new Date(fixture.executionStartedAt.getTime() + 21_000)
    });
    const after = await loadOperation(fixture.root, fixture.operationId);
    expect(result).toMatchObject({ action: "CONTINUE", participantId: fixture.participantId, actorRole: "SUPERVISOR", actorSessionId: "session:supervisor:1" });
    expect(after.participants[fixture.participantId]!.executionLiveness!.progressLease!.renewalCount).toBe(1);
    expect(after.resolvedOperationPolicy?.digest).toBe(before.resolvedOperationPolicy?.digest);
    expect(after.result).toBe(before.result);
  });

  it("projects only the recovery tool and defers WorkGraph recovery to controller cleanup", async () => {
    const fixture = await makeFixture({ supervisor: true });
    const event = await recordParticipantExecutionActivityV1(fixture.root, fixture.operationId, fixture.participantId, {
      kind: "PROVIDER_HEARTBEAT", evidenceId: "provider:quiet", evidenceDigest: digest("heartbeat"), observedAt: new Date(fixture.executionStartedAt.getTime() + 20_000)
    });
    const env = {
      AEH_CONTROL_ROOT: fixture.root,
      AEH_OPERATION_ID: fixture.operationId,
      AEH_OPERATION_SUPERVISOR: "1",
      AEH_SUPERVISOR_SESSION_ID: "session:supervisor:1",
      PASEO_AGENT_ID: "session:supervisor:1"
    } as NodeJS.ProcessEnv;
    const listed = await handleSupervisorMcpRequest({ method: "tools/list" }, env);
    expect(listed.tools).toEqual([expect.objectContaining({ name: "aeh_supervisor_recovery_decide" })]);
    const dispatch = vi.fn(async (_root: string, agentId: string) => ({ id: agentId, exitCode: 0, stdout: "", stderr: "", status: "working", transport: "sdk" as const }));
    const result = await handleSupervisorMcpRequest({
      method: "tools/call",
      params: { name: "aeh_supervisor_recovery_decide", arguments: {
        participantId: fixture.participantId,
        executionBindingDigest: fixture.participantBinding.digest,
        action: "REPLAN",
        evidenceIds: [event!.eventId],
        reason: "Changing the frozen WorkGraph requires the Lead to coordinate a bounded replan."
      } }
    }, env, { dispatch: dispatch as never });
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({ leadWake: "DEFERRED_TO_CONTROLLER", authority: "SUPERVISOR_WITHIN_FROZEN_POLICY", decision: { action: "REPLAN", application: "ESCALATE_TO_LEAD" } });
  });

  it("rejects stale bindings and a changed Supervisor generation before recording recovery", async () => {
    const fixture = await makeFixture({ supervisor: true });
    const event = await recordParticipantExecutionActivityV1(fixture.root, fixture.operationId, fixture.participantId, {
      kind: "PROVIDER_HEARTBEAT", evidenceId: "provider:quiet", evidenceDigest: digest("heartbeat"), observedAt: new Date(fixture.executionStartedAt.getTime() + 20_000)
    });
    await expect(decideParticipantRecoveryV1(fixture.root, {
      operationId: fixture.operationId, participantId: fixture.participantId, actorRole: "SUPERVISOR", actorSessionId: "session:supervisor:1", action: "CONTINUE",
      expectedBindingDigest: digest("stale-binding"), evidenceIds: [event!.eventId], reason: "stale"
    })).rejects.toThrow(/SUPERVISOR_RECOVERY_BINDING_STALE/);
    await registerOperationAgent(fixture.root, fixture.operationId, { id: "session:supervisor:2", logicalAgent: "supervisor", role: "Operation Supervisor", phase: "supervision" });
    await registerSupervisorGeneration(fixture.root, fixture.operationId, { agentId: "session:supervisor:2", materialized: true, status: "ACTIVE" });
    await expect(decideParticipantRecoveryV1(fixture.root, {
      operationId: fixture.operationId, participantId: fixture.participantId, actorRole: "SUPERVISOR", actorSessionId: "session:supervisor:1", action: "CONTINUE",
      expectedBindingDigest: fixture.participantBinding.digest, evidenceIds: [event!.eventId], reason: "stale Supervisor"
    })).rejects.toThrow(/SUPERVISOR_RECOVERY_AUTHORITY_DENIED/);
  });

  it("enforces the frozen local retry and participant restart budgets", async () => {
    const fixture = await makeFixture({ supervisor: true, liveness: { maxLocalRetriesPerFailure: 1, maxParticipantRestarts: 1 }, economic: { maxLocalRetries: 1, maxParticipantRestarts: 1 } });
    const first = await recordParticipantExecutionActivityV1(fixture.root, fixture.operationId, fixture.participantId, {
      kind: "TOOL_CALL_FAILED", evidenceId: "tool-failure:1", evidenceDigest: digest("first-failure"), toolName: "npm ci", observedAt: new Date(fixture.executionStartedAt.getTime() + 20_000)
    });
    await decideParticipantRecoveryV1(fixture.root, {
      operationId: fixture.operationId, participantId: fixture.participantId, actorRole: "SUPERVISOR", actorSessionId: "session:supervisor:1", action: "RETRY_PARTICIPANT",
      expectedBindingDigest: fixture.participantBinding.digest, evidenceIds: [first!.eventId], reason: "Use the single frozen participant retry after inspecting the command diagnostic."
    });
    const afterRetry = await loadOperation(fixture.root, fixture.operationId);
    expect(afterRetry.participants[fixture.participantId]!.executionLiveness!.localRetryCount).toBe(1);
    const second = await recordParticipantExecutionActivityV1(fixture.root, fixture.operationId, fixture.participantId, {
      kind: "TOOL_CALL_FAILED", evidenceId: "tool-failure:2", evidenceDigest: digest("second-failure"), toolName: "npm ci", observedAt: new Date(fixture.executionStartedAt.getTime() + 30_000)
    });
    await expect(decideParticipantRecoveryV1(fixture.root, {
      operationId: fixture.operationId, participantId: fixture.participantId, actorRole: "SUPERVISOR", actorSessionId: "session:supervisor:1", action: "RETRY_PARTICIPANT",
      expectedBindingDigest: fixture.participantBinding.digest, evidenceIds: [second!.eventId], reason: "Request a second retry outside the frozen envelope."
    })).rejects.toThrow(/PARTICIPANT_LOCAL_RETRY_BUDGET_EXHAUSTED/);
  });

  it("rejects same-session resume when the durable Paseo binding belongs to a changed candidate", async () => {
    const fixture = await makeFixture({ supervisor: true });
    const operation = await loadOperation(fixture.root, fixture.operationId);
    await updateOperationParticipant(fixture.root, fixture.operationId, fixture.participantId, { transport: "paseo-sdk" });
    await bindPaseoSession(fixture.root, {
      projectId: operation.candidateRevision!.projectId!,
      operationId: fixture.operationId,
      operationExecutionRevision: fixture.participantBinding.operationExecutionRevision,
      participantId: fixture.participantId,
      participantGeneration: fixture.participantBinding.participantGeneration,
      candidateRevision: fixture.participantBinding.candidateRevision,
      candidateDigest: digest("old-candidate"),
      executionBlueprintDigest: fixture.participantBinding.executionBlueprintDigest,
      operationPolicyDigest: fixture.participantBinding.operationPolicyDigest,
      contextManifestDigest: fixture.participantBinding.contextManifestDigest,
      promptManifestDigest: fixture.participantBinding.promptManifestDigest,
      controllerEpoch: fixture.participantBinding.controllerEpoch,
      paseoAgentId: fixture.participantBinding.runtime.sessionId
    });
    const event = await recordParticipantExecutionActivityV1(fixture.root, fixture.operationId, fixture.participantId, {
      kind: "PROVIDER_HEARTBEAT", evidenceId: "provider:quiet", evidenceDigest: digest("heartbeat"), observedAt: new Date(fixture.executionStartedAt.getTime() + 20_000)
    });
    const env = { AEH_CONTROL_ROOT: fixture.root, AEH_OPERATION_ID: fixture.operationId, AEH_OPERATION_SUPERVISOR: "1", AEH_SUPERVISOR_SESSION_ID: "session:supervisor:1" } as NodeJS.ProcessEnv;
    await expect(handleSupervisorMcpRequest({
      method: "tools/call",
      params: { name: "aeh_supervisor_recovery_decide", arguments: {
        participantId: fixture.participantId, executionBindingDigest: fixture.participantBinding.digest,
        action: "RESUME_SAME_SESSION", evidenceIds: [event!.eventId], reason: "Attempt same-session continuation after the provider became quiet."
      } }
    }, env)).rejects.toThrow(/SAME_SESSION_RESUME_REJECTED/);
  });

  it("does not permit a Supervisor to fail or resume an already completed participant", async () => {
    const fixture = await makeFixture({ supervisor: true });
    const event = await recordParticipantExecutionActivityV1(fixture.root, fixture.operationId, fixture.participantId, {
      kind: "STRUCTURED_RESULT_ACCEPTED", evidenceId: "result:accepted", evidenceDigest: digest("accepted result"), observedAt: new Date(fixture.executionStartedAt.getTime() + 20_000)
    });
    await updateOperationParticipant(fixture.root, fixture.operationId, fixture.participantId, { status: "COMPLETED" });
    await expect(decideParticipantRecoveryV1(fixture.root, {
      operationId: fixture.operationId, participantId: fixture.participantId, actorRole: "SUPERVISOR", actorSessionId: "session:supervisor:1", action: "FAIL",
      expectedBindingDigest: fixture.participantBinding.digest, evidenceIds: [event!.eventId], reason: "Attempt to rewrite terminal participant state."
    })).rejects.toThrow(/completed, cancelled, or blocked/);
  });

  it("resumes the exact compatible participant session with only the failure-relevant JIT skill", async () => {
    const fixture = await makeFixture({ supervisor: true, capabilityRegistry: true });
    const operation = await loadOperation(fixture.root, fixture.operationId);
    await updateOperationParticipant(fixture.root, fixture.operationId, fixture.participantId, { transport: "paseo-sdk" });
    await bindPaseoSession(fixture.root, {
      projectId: operation.candidateRevision!.projectId!,
      operationId: fixture.operationId,
      operationExecutionRevision: fixture.participantBinding.operationExecutionRevision,
      participantId: fixture.participantId,
      participantGeneration: fixture.participantBinding.participantGeneration,
      candidateRevision: fixture.participantBinding.candidateRevision,
      candidateDigest: fixture.participantBinding.candidateDigest,
      executionBlueprintDigest: fixture.participantBinding.executionBlueprintDigest,
      operationPolicyDigest: fixture.participantBinding.operationPolicyDigest,
      contextManifestDigest: fixture.participantBinding.contextManifestDigest,
      promptManifestDigest: fixture.participantBinding.promptManifestDigest,
      controllerEpoch: fixture.participantBinding.controllerEpoch,
      paseoAgentId: fixture.participantBinding.runtime.sessionId
    });
    const activity = await recordParticipantExecutionActivityV1(fixture.root, fixture.operationId, fixture.participantId, {
      kind: "TOOL_CALL_FAILED", evidenceId: "paseo-timeout:1", evidenceDigest: digest("provider-timeout"), toolName: "paseo", observedAt: new Date(fixture.executionStartedAt.getTime() + 20_000)
    });
    const env = { AEH_CONTROL_ROOT: fixture.root, AEH_OPERATION_ID: fixture.operationId, AEH_OPERATION_SUPERVISOR: "1", AEH_SUPERVISOR_SESSION_ID: "session:supervisor:1" } as NodeJS.ProcessEnv;
    let providerStatus = "running";
    const inspect = vi.fn(async (_root: string, id: string) => ({ id, status: providerStatus }));
    const stop = vi.fn(async () => { providerStatus = "idle"; return { exitCode: 0, stderr: "" }; });
    const dispatch = vi.fn(async (_root: string, id: string, _prompt: string) => ({ id, exitCode: 0, stdout: "", stderr: "", status: "working", transport: "sdk" as const }));
    const result = await handleSupervisorMcpRequest({
      method: "tools/call",
      params: { name: "aeh_supervisor_recovery_decide", arguments: {
        participantId: fixture.participantId,
        executionBindingDigest: fixture.participantBinding.digest,
        action: "RESUME_SAME_SESSION",
        evidenceIds: [activity!.eventId],
        observedFailure: { capabilityId: "aeh:paseo-participant-lifecycle", failureClass: "TIMEOUT" },
        skillId: "paseo-runtime-diagnostics",
        reason: "Resume the compatible session and inject the relevant runtime recovery procedure."
      } }
    }, env, { inspect: inspect as never, stop: stop as never, awaitProviderLeaseRelease: vi.fn(async () => true), dispatch: dispatch as never });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[1]).toBe(fixture.participantBinding.runtime.sessionId);
    expect(String(dispatch.mock.calls[0]?.[2])).toContain("paseo-runtime-diagnostics");
    expect(String(dispatch.mock.calls[0]?.[2])).toContain("CONTROLLER_GUIDANCE");
    expect(result.structuredContent).toMatchObject({ participantTurn: "ACCEPTED", skillProjection: "PROJECTED" });
  });

  it("rejects JIT skill role overrides and binds guidance to the participant's frozen role", async () => {
    const fixture = await makeFixture({ supervisor: true, capabilityRegistry: true });
    const activity = await recordParticipantExecutionActivityV1(fixture.root, fixture.operationId, fixture.participantId, {
      kind: "TOOL_CALL_FAILED", evidenceId: "role-override:failure", evidenceDigest: digest("failure"), toolName: "paseo", observedAt: new Date(fixture.executionStartedAt.getTime() + 20_000)
    });
    const env = { AEH_CONTROL_ROOT: fixture.root, AEH_OPERATION_ID: fixture.operationId, AEH_OPERATION_SUPERVISOR: "1", AEH_SUPERVISOR_SESSION_ID: "session:supervisor:1" } as NodeJS.ProcessEnv;
    await expect(handleSupervisorMcpRequest({ method: "tools/call", params: { name: "aeh_supervisor_recovery_decide", arguments: {
      participantId: fixture.participantId, executionBindingDigest: fixture.participantBinding.digest, action: "RETRIEVE_SKILL",
      evidenceIds: [activity!.eventId], observedFailure: { capabilityId: "aeh:paseo-participant-lifecycle", failureClass: "TIMEOUT" },
      recipientRole: "Operation Supervisor", skillId: "paseo-runtime-diagnostics", reason: "Attempt to project guidance as a different role."
    } } }, env)).rejects.toThrow(/SUPERVISOR_SKILL_ROLE_OVERRIDE_FORBIDDEN/);
  });

  it("allows the bound Lead to extend a participant within policy using exact current evidence", async () => {
    const fixture = await makeFixture({ supervisor: true, economic: { initialProviderTurns: 1, supervisorProviderTurns: 1, hardProviderTurns: 2 } });
    const progress = await recordParticipantExecutionActivityV1(fixture.root, fixture.operationId, fixture.participantId, {
      kind: "NEW_RETRIEVAL", evidenceId: "retrieval:lead-review", evidenceDigest: digest("lead-review"), observedAt: new Date(fixture.executionStartedAt.getTime() + 20_000)
    });
    const previous = { root: process.env.AEH_CONTROL_ROOT, agent: process.env.PASEO_AGENT_ID };
    process.env.AEH_CONTROL_ROOT = fixture.root;
    process.env.PASEO_AGENT_ID = "session:lead-current";
    try {
      const result = await handleOperationMcpRequest({
        method: "tools/call",
        params: { name: "aeh_operation_recover_participant", arguments: {
          operationId: fixture.operationId, participantId: fixture.participantId, executionBindingDigest: fixture.participantBinding.digest,
          action: "CONTINUE", evidenceIds: [progress!.eventId], reason: "Continue within the current Lead-delegated provider-turn envelope."
        } }
      });
      expect(result.structuredContent).toMatchObject({ action: "CONTINUE", participantTurn: "NOT_REQUESTED" });
      expect((await loadOperation(fixture.root, fixture.operationId)).participants[fixture.participantId]!.executionLiveness!.progressLease)
        .toMatchObject({ renewedBy: "LEAD", renewedBySessionId: "session:lead-current" });
    } finally {
      if (previous.root === undefined) delete process.env.AEH_CONTROL_ROOT; else process.env.AEH_CONTROL_ROOT = previous.root;
      if (previous.agent === undefined) delete process.env.PASEO_AGENT_ID; else process.env.PASEO_AGENT_ID = previous.agent;
    }
  });

  it("lets only the bound Lead request a linked WorkGraph recovery under current evidence", async () => {
    const fixture = await makeFixture({ supervisor: true });
    const progress = await recordParticipantExecutionActivityV1(fixture.root, fixture.operationId, fixture.participantId, {
      kind: "TOOL_CALL_FAILED", evidenceId: "tool-failure:lead-replan", evidenceDigest: digest("install diagnostics"), toolName: "npm ci", observedAt: new Date(fixture.executionStartedAt.getTime() + 20_000)
    });
    const previous = { root: process.env.AEH_CONTROL_ROOT, agent: process.env.PASEO_AGENT_ID };
    process.env.AEH_CONTROL_ROOT = fixture.root;
    process.env.PASEO_AGENT_ID = "session:lead-current";
    try {
      const result = await handleOperationMcpRequest({
        method: "tools/call",
        params: { name: "aeh_operation_recover_participant", arguments: {
          operationId: fixture.operationId, participantId: fixture.participantId, executionBindingDigest: fixture.participantBinding.digest,
          action: "REPLAN", evidenceIds: [progress!.eventId], reason: "The current WorkGraph cannot use the observed diagnostics to complete the assigned validation."
        } }
      });
      expect(result.structuredContent).toMatchObject({ action: "REPLAN", application: "REQUESTED", decision: { actorRole: "LEAD", action: "REPLAN", application: "REQUESTED" } });
      expect((await loadOperation(fixture.root, fixture.operationId)).participants[fixture.participantId]!.executionLiveness!.lastRecoveryDecision)
        .toMatchObject({ actorRole: "LEAD", action: "REPLAN", application: "REQUESTED" });
    } finally {
      if (previous.root === undefined) delete process.env.AEH_CONTROL_ROOT; else process.env.AEH_CONTROL_ROOT = previous.root;
      if (previous.agent === undefined) delete process.env.PASEO_AGENT_ID; else process.env.PASEO_AGENT_ID = previous.agent;
    }
  });

  it("requires the Owner when a configured hard cost ceiling cannot be verified from provider usage", async () => {
    const fixture = await makeFixture({ economic: { hardCostUsd: 1 }, userTurnId: "lead-session:turn-3" });
    const at = new Date(fixture.executionStartedAt.getTime() + 20_000);
    const before = (await loadOperation(fixture.root, fixture.operationId)).participants[fixture.participantId]!.executionLiveness!.progressLease!;
    await recordParticipantExecutionActivityV1(fixture.root, fixture.operationId, fixture.participantId, {
      kind: "NEW_RETRIEVAL", evidenceId: "retrieval:cost-check", evidenceDigest: digest("retrieval"), observedAt: at
    });
    const stalled = await loadOperation(fixture.root, fixture.operationId);
    expect(stalled.phase).not.toBe("HUMAN_REQUIRED");
    expect(stalled.participants[fixture.participantId]!.executionLiveness!.state).toBe("STALL_SUSPECTED");
    expect(stalled.participants[fixture.participantId]!.executionLiveness!.progressLease!.digest).toBe(before.digest);
    await expect(renewParticipantProgressLeaseV1(fixture.root, {
      operationId: fixture.operationId, participantId: fixture.participantId, actorSessionId: "session:lead-current", at: new Date(at.getTime() + 1_000)
    })).rejects.toThrow(/OWNER_DECISION_REQUIRED/);
    expect(await loadOperation(fixture.root, fixture.operationId)).toMatchObject({ phase: "HUMAN_REQUIRED", ownerEconomicBoundary: { budget: "HARD_COST_USD", configuredLimit: 1, observed: null, usageCoverage: "UNKNOWN", state: "WAITING" } });
  });

  it("blocks linked and same-Lead-turn operation creation after an Owner economic boundary", async () => {
    const fixture = await makeFixture({ economic: { hardCostUsd: 1 }, userTurnId: "lead-session:turn-3" });
    const at = new Date(fixture.executionStartedAt.getTime() + 20_000);
    await recordParticipantExecutionActivityV1(fixture.root, fixture.operationId, fixture.participantId, {
      kind: "NEW_RETRIEVAL", evidenceId: "retrieval:owner-boundary", evidenceDigest: digest("retrieval"), observedAt: at
    });
    await expect(renewParticipantProgressLeaseV1(fixture.root, {
      operationId: fixture.operationId, participantId: fixture.participantId, actorSessionId: "session:lead-current", at: new Date(at.getTime() + 1_000)
    })).rejects.toThrow(/OWNER_DECISION_REQUIRED/);
    const boundaryParent = await terminalizeOperation(fixture.root, fixture.operationId, { status: "FAILED", phase: "HUMAN_REQUIRED", error: "Owner boundary fixture", finishedAt: new Date().toISOString() }, { trace: vi.fn(async () => undefined) as never });
    expect(boundaryParent).toMatchObject({ status: "FAILED", phase: "HUMAN_REQUIRED", ownerEconomicBoundary: { state: "WAITING", budget: "HARD_COST_USD" } });

    const sameTurn = createIntentDecision("audit", "Continue after the configured owner boundary.", "lead-semantic", { userTurnId: "lead-session:turn-3" });
    await expect(startDetachedOperation(fixture.root, "audit", { request: "Continue without a new Owner turn.", intentDecision: sameTurn }, {
      nodeExecutable: process.execPath, entryFile: "/pkg/dist/main.js",
      initiator: { kind: "LEAD", agentId: "session:lead-current", userTurnId: "lead-session:turn-3", requestEventId: "jsonrpc:boundary-same-turn" },
      spawnProcess: vi.fn(() => ({ pid: 9192, unref: vi.fn() })) as never
    })).rejects.toThrow(/OPERATION_OWNER_BOUNDARY_STILL_WAITING/);

    const freshOwnerTurn = createIntentDecision("audit", "The Lead cannot infer that the Owner has resolved the boundary.", "lead-semantic", { userTurnId: "lead-session:turn-4" });
    await expect(startDetachedOperation(fixture.root, "audit", { request: "A new Lead turn still cannot silently resolve the Owner boundary.", intentDecision: freshOwnerTurn }, {
      nodeExecutable: process.execPath, entryFile: "/pkg/dist/main.js",
      initiator: { kind: "LEAD", agentId: "session:lead-current", userTurnId: "lead-session:turn-4", requestEventId: "jsonrpc:boundary-fresh-turn" },
      spawnProcess: vi.fn(() => ({ pid: 9194, unref: vi.fn() })) as never
    })).rejects.toThrow(/OPERATION_OWNER_BOUNDARY_STILL_WAITING/);

    await fs.mkdir(path.join(fixture.root, ".harness"), { recursive: true });
    const projectConfigPath = path.join(fixture.root, ".harness", "project.yaml");
    await fs.writeFile(projectConfigPath, "version: 1\nproject:\n  name: liveness-test\norchestration:\n  provider: paseo\n  operations:\n    economicEnvelope:\n      hardCostUsd: 1\n");
    await expect(startDetachedOperation(fixture.root, "audit", {
      request: "Try to resolve the Owner boundary without changing the economic envelope.", intentDecision: createIntentDecision("audit", "Keep the same budget.", "explicit-cli")
    }, { nodeExecutable: process.execPath, entryFile: "/pkg/dist/main.js", initiator: { kind: "CLI" }, ownerResolutionOperationIds: [fixture.operationId], spawnProcess: vi.fn(() => ({ pid: 9195, unref: vi.fn() })) as never }))
      .rejects.toThrow(/OWNER_POLICY_CHANGE_REQUIRED/);
    await fs.writeFile(projectConfigPath, "version: 1\nproject:\n  name: liveness-test\norchestration:\n  provider: paseo\n  operations:\n    economicEnvelope:\n      hardCostUsd: 2\n");
    const ownerAuthorized = await startDetachedOperation(fixture.root, "audit", { request: "Owner-authorized fresh operation after policy review." }, {
      nodeExecutable: process.execPath, entryFile: "/pkg/dist/main.js",
      initiator: { kind: "CLI" },
      ownerResolutionOperationIds: [fixture.operationId],
      spawnProcess: vi.fn(() => ({ pid: 9196, unref: vi.fn() })) as never
    });
    expect(ownerAuthorized.origin).toMatchObject({ kind: "EXPLICIT_CLI" });

    const linked = createIntentDecision("audit", "Continue under the old hard ceiling.", "lead-semantic", { userTurnId: "lead-session:turn-3", continuation: { operationId: fixture.operationId } });
    await expect(startDetachedOperation(fixture.root, "audit", { request: "Link a child to the Owner-boundary parent.", intentDecision: linked }, {
      nodeExecutable: process.execPath, entryFile: "/pkg/dist/main.js",
      initiator: { kind: "LEAD", agentId: "session:lead-current", userTurnId: "lead-session:turn-3", requestEventId: "jsonrpc:boundary-child" },
      spawnProcess: vi.fn(() => ({ pid: 9193, unref: vi.fn() })) as never
    })).rejects.toThrow(/OPERATION_RECOVERY_OWNER_BOUNDARY/);
  });

  it("keeps a cancellation from clearing a pending Owner economic authorization boundary", async () => {
    const fixture = await makeFixture({ economic: { hardCostUsd: 1 }, userTurnId: "lead-session:turn-cancel-boundary" });
    const at = new Date(fixture.executionStartedAt.getTime() + 20_000);
    await recordParticipantExecutionActivityV1(fixture.root, fixture.operationId, fixture.participantId, {
      kind: "NEW_RETRIEVAL", evidenceId: "retrieval:cancel-after-boundary", evidenceDigest: digest("retrieval"), observedAt: at
    });
    await expect(renewParticipantProgressLeaseV1(fixture.root, {
      operationId: fixture.operationId, participantId: fixture.participantId, actorSessionId: "session:lead-current", at: new Date(at.getTime() + 1_000)
    })).rejects.toThrow(/OWNER_DECISION_REQUIRED/);
    const cancelled = await terminalizeOperation(fixture.root, fixture.operationId, {
      status: "CANCELLED", phase: "cancelled", finishedAt: new Date(at.getTime() + 2_000).toISOString()
    }, { trace: vi.fn(async () => undefined) as never });
    expect(cancelled).toMatchObject({ status: "CANCELLED", ownerEconomicBoundary: { state: "WAITING", budget: "HARD_COST_USD" } });
    const sameTurn = createIntentDecision("audit", "Resume after cancellation without Owner authorization.", "lead-semantic", { userTurnId: "lead-session:turn-cancel-boundary" });
    await expect(startDetachedOperation(fixture.root, "audit", { request: "Resume under the same Owner turn.", intentDecision: sameTurn }, {
      nodeExecutable: process.execPath, entryFile: "/pkg/dist/main.js",
      initiator: { kind: "LEAD", agentId: "session:lead-current", userTurnId: "lead-session:turn-cancel-boundary", requestEventId: "jsonrpc:cancel-after-boundary" },
      spawnProcess: vi.fn(() => ({ pid: 9196, unref: vi.fn() })) as never
    })).rejects.toThrow(/OPERATION_OWNER_BOUNDARY_STILL_WAITING/);
  });

  it("materializes expired deadlines before new roots and ignores Lead-supplied turn ids as Owner authority", async () => {
    const fixture = await makeFixture({ userTurnId: "lead-session:turn-deadline", liveness: { hardDeadlineMs: 1_000 } });
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const sameTurn = createIntentDecision("audit", "Continue the same objective after its hard deadline.", "lead-semantic", { userTurnId: "lead-session:turn-deadline" });
    await expect(startDetachedOperation(fixture.root, "audit", { request: "Continue after deadline.", intentDecision: sameTurn }, {
      nodeExecutable: process.execPath, entryFile: "/pkg/dist/main.js",
      initiator: { kind: "LEAD", agentId: "session:lead-current", userTurnId: "lead-session:turn-deadline", requestEventId: "jsonrpc:deadline-same-turn" },
      spawnProcess: vi.fn(() => ({ pid: 9197, unref: vi.fn() })) as never
    })).rejects.toThrow(/OPERATION_OWNER_BOUNDARY_STILL_WAITING/);
    const expired = await loadOperation(fixture.root, fixture.operationId);
    expect(expired).toMatchObject({ status: "FAILED", phase: "HUMAN_REQUIRED", ownerContinuationBoundary: { reasonCode: "HARD_OPERATION_DEADLINE", userTurnId: "lead-session:turn-deadline", state: "WAITING" } });

    const fabricatedFreshTurn = createIntentDecision("audit", "Start a fresh request after reviewing the prior deadline.", "lead-semantic", { userTurnId: "lead-session:fabricated-turn-id" });
    await expect(startDetachedOperation(fixture.root, "audit", { request: "Lead-supplied turn ids do not authorize a fresh root.", intentDecision: fabricatedFreshTurn }, {
      nodeExecutable: process.execPath, entryFile: "/pkg/dist/main.js",
      initiator: { kind: "LEAD", agentId: "session:lead-current", userTurnId: "lead-session:fabricated-turn-id", requestEventId: "jsonrpc:deadline-fabricated-turn" },
      spawnProcess: vi.fn(() => ({ pid: 9198, unref: vi.fn() })) as never
    })).rejects.toThrow(/OPERATION_OWNER_BOUNDARY_STILL_WAITING/);

    const unrelatedOwner = await startDetachedOperation(fixture.root, "audit", {
      request: "Fresh explicitly Owner-authorized request.", intentDecision: createIntentDecision("audit", "Owner explicitly starts a new operation after reviewing the expired boundary.", "explicit-cli")
    }, {
      nodeExecutable: process.execPath, entryFile: "/pkg/dist/main.js", initiator: { kind: "CLI" },
      spawnProcess: vi.fn(() => ({ pid: 9199, unref: vi.fn() })) as never
    });
    expect(unrelatedOwner.origin).toMatchObject({ kind: "EXPLICIT_CLI" });
    await expect(startDetachedOperation(fixture.root, "audit", { request: "An unrelated CLI task does not resolve this boundary.", intentDecision: createIntentDecision("audit", "Review another request.", "lead-semantic") }, {
      nodeExecutable: process.execPath, entryFile: "/pkg/dist/main.js",
      initiator: { kind: "LEAD", agentId: "session:lead-current", requestEventId: "jsonrpc:unresolved-deadline" },
      spawnProcess: vi.fn(() => ({ pid: 9200, unref: vi.fn() })) as never
    })).rejects.toThrow(/OPERATION_OWNER_BOUNDARY_STILL_WAITING/);

    const ownerAuthorized = await startDetachedOperation(fixture.root, "audit", {
      request: "Owner explicitly resolves the expired operation boundary.", intentDecision: createIntentDecision("audit", "Resolve the expired operation and start a fresh root.", "explicit-cli")
    }, {
      nodeExecutable: process.execPath, entryFile: "/pkg/dist/main.js", initiator: { kind: "CLI" },
      ownerResolutionOperationIds: [fixture.operationId],
      spawnProcess: vi.fn(() => ({ pid: 9201, unref: vi.fn() })) as never
    });
    expect(ownerAuthorized.origin?.ownerResolutionRefs).toContainEqual(expect.objectContaining({ kind: "OWNER_HARD_DEADLINE", operationId: fixture.operationId }));
    const afterOwner = await startDetachedOperation(fixture.root, "audit", { request: "Continue under the latest explicit Owner root.", intentDecision: createIntentDecision("audit", "Review the authorized current request.", "lead-semantic") }, {
      nodeExecutable: process.execPath, entryFile: "/pkg/dist/main.js",
      initiator: { kind: "LEAD", agentId: "session:lead-current", requestEventId: "jsonrpc:after-owner-root" },
      spawnProcess: vi.fn(() => ({ pid: 9202, unref: vi.fn() })) as never
    });
    expect(afterOwner.origin).toMatchObject({ kind: "LEAD_ACTION", requestEventId: "jsonrpc:after-owner-root" });
  });

  it("does not automatically renew past a configured hard token boundary", async () => {
    const fixture = await makeFixture({ economic: { hardTotalTokens: 100 } });
    const originalLease = (await loadOperation(fixture.root, fixture.operationId)).participants[fixture.participantId]!.executionLiveness!.progressLease!;
    await recordParticipantExecutionActivityV1(fixture.root, fixture.operationId, fixture.participantId, {
      kind: "NEW_RETRIEVAL", evidenceId: "retrieval:token-budget", evidenceDigest: digest("token-budget"), observedAt: new Date(fixture.executionStartedAt.getTime() + 20_000)
    });
    const stalled = await loadOperation(fixture.root, fixture.operationId);
    expect(stalled.phase).not.toBe("HUMAN_REQUIRED");
    expect(stalled.participants[fixture.participantId]!.executionLiveness!.state).toBe("STALL_SUSPECTED");
    expect(stalled.participants[fixture.participantId]!.executionLiveness!.progressLease!.digest).toBe(originalLease.digest);
    await expect(renewParticipantProgressLeaseV1(fixture.root, {
      operationId: fixture.operationId, participantId: fixture.participantId, actorSessionId: "session:lead-current"
    })).rejects.toThrow(/OWNER_DECISION_REQUIRED/);
    expect(await loadOperation(fixture.root, fixture.operationId)).toMatchObject({ phase: "HUMAN_REQUIRED", ownerEconomicBoundary: { budget: "HARD_TOTAL_TOKENS", configuredLimit: 100, observed: null, usageCoverage: "UNKNOWN" } });
  });

  it("atomically converts a requested success into HUMAN_REQUIRED when hard provider cost is unknown", async () => {
    const fixture = await makeFixture({ economic: { hardCostUsd: 1 } });
    const transition = await terminalizeOperation(fixture.root, fixture.operationId, {
      status: "SUCCEEDED", phase: "finished", finishedAt: new Date().toISOString(), result: { status: "PASS" }
    }, { trace: vi.fn(async () => undefined) as never });
    expect(transition).toMatchObject({ status: "FAILED", phase: "HUMAN_REQUIRED", ownerEconomicBoundary: { budget: "HARD_COST_USD", configuredLimit: 1, observed: null, usageCoverage: "UNKNOWN" } });
  });

  it("blocks an external delivery effect when a configured hard cost ceiling is not verifiable", async () => {
    const fixture = await makeFixture({ economic: { hardCostUsd: 1 } });
    const operation = await loadOperation(fixture.root, fixture.operationId);
    await expect(requireOwnerEconomicBoundaryBeforeExternalEffectV1(fixture.root, operation)).rejects.toThrow(/OWNER_DECISION_REQUIRED/);
    expect(await loadOperation(fixture.root, fixture.operationId)).toMatchObject({ phase: "HUMAN_REQUIRED", ownerEconomicBoundary: { budget: "HARD_COST_USD", usageCoverage: "UNKNOWN" } });
  });

  it("expires and cleans an overdue operation before admitting an external effect", async () => {
    const fixture = await makeFixture({ liveness: { hardDeadlineMs: 1_000 } });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const current = await loadOperation(fixture.root, fixture.operationId);
    await expect(requireOwnerEconomicBoundaryBeforeExternalEffectV1(fixture.root, current)).rejects.toThrow(/OPERATION_HARD_DEADLINE_REACHED/);
    expect(await loadOperation(fixture.root, fixture.operationId)).toMatchObject({
      status: "FAILED", phase: "HUMAN_REQUIRED", ownerContinuationBoundary: { reasonCode: "HARD_OPERATION_DEADLINE", state: "WAITING" }
    });
  });

  it("stalls a participant at its per-participant hard turn ceiling for Supervisor or Lead recovery", async () => {
    const fixture = await makeFixture({ supervisor: true, economic: { initialProviderTurns: 1, supervisorProviderTurns: 1, hardProviderTurns: 1 } });
    const first = await recordParticipantExecutionActivityV1(fixture.root, fixture.operationId, fixture.participantId, {
      kind: "PROVIDER_TURN_STARTED", evidenceId: "provider-turn:one", evidenceDigest: digest("turn-one"), observedAt: fixture.executionStartedAt
    });
    expect(first).toBeDefined();
    const blockedTurn = await recordParticipantExecutionActivityV1(fixture.root, fixture.operationId, fixture.participantId, {
      kind: "PROVIDER_TURN_STARTED", evidenceId: "provider-turn:two", evidenceDigest: digest("turn-two"), observedAt: new Date(fixture.executionStartedAt.getTime() + 1_000)
    });
    expect(blockedTurn).toBeUndefined();
    const stalled = await loadOperation(fixture.root, fixture.operationId);
    expect(stalled).toMatchObject({ status: "RUNNING", phase: "reviewing", participants: { [fixture.participantId]: { executionLiveness: { state: "STALL_SUSPECTED", providerTurns: 1 } } } });
    const policy = operationLivenessPolicy({ version: 1, project: { name: "liveness-test" }, orchestration: { provider: "paseo" } } as never, stalled);
    expect(evaluateOperationWake(stalled, policy, fixture.executionStartedAt.getTime() + 2_000)).toMatchObject({ reason: "stalled", target: "supervisor" });
  });

  it("applies a Supervisor replan request as a cleaned failed parent before the Lead may start a linked recovery", async () => {
    const fixture = await makeFixture({ supervisor: true });
    const evidence = await recordParticipantExecutionActivityV1(fixture.root, fixture.operationId, fixture.participantId, {
      kind: "TOOL_CALL_FAILED", evidenceId: "tool:failed:replan", evidenceDigest: digest("unrecoverable-tool"), toolName: "npm-ci", observedAt: new Date(fixture.executionStartedAt.getTime() + 20_000)
    });
    const decision = await decideParticipantRecoveryV1(fixture.root, {
      operationId: fixture.operationId, participantId: fixture.participantId, actorRole: "SUPERVISOR", actorSessionId: fixture.supervisorId!,
      expectedBindingDigest: fixture.participantBinding.digest, action: "REPLAN", evidenceIds: [evidence!.eventId], reason: "The current WorkGraph cannot reach the assigned validation after the exact install failure."
    });
    expect(decision).toMatchObject({ action: "REPLAN", application: "ESCALATE_TO_LEAD" });
    expect((await loadOperation(fixture.root, fixture.operationId)).participants[fixture.participantId]!.executionLiveness).toBeDefined();

    const config = { version: 1, project: { name: "liveness-test" }, orchestration: { provider: "paseo" } } as never;
    const watchdog = await runOperationLivenessCheck(fixture.root, config, fixture.operationId, { trace: vi.fn(async () => undefined) as never });
    expect(watchdog.message).toContain("explicit linked recovery");
    const parent = await loadOperation(fixture.root, fixture.operationId);
    expect(parent).toMatchObject({ status: "FAILED", result: { recoveryRequest: { action: "REPLAN", application: "LEAD_LINKED_OPERATION_REQUIRED" } } });
    expect(parent.ownerEconomicBoundary).toBeUndefined();

    const continuation = createIntentDecision("audit", "Replan the failed review under its inherited authority.", "lead-semantic", {
      userTurnId: "lead-session:turn-8", continuation: { operationId: fixture.operationId }
    });
    const child = await startDetachedOperation(fixture.root, "audit", { request: "Continue the failed review with a revised plan.", intentDecision: continuation }, {
      nodeExecutable: process.execPath, entryFile: "/pkg/dist/main.js",
      initiator: { kind: "LEAD", agentId: "session:lead-current", userTurnId: "lead-session:turn-8", requestEventId: "jsonrpc:linked-replan" },
      spawnProcess: vi.fn(() => ({ pid: 9191, unref: vi.fn() })) as never
    });
    expect(child.origin).toMatchObject({ kind: "FAILED_OPERATION_RECOVERY", parentOperationId: fixture.operationId, parentTerminalRevision: parent.revision, userTurnId: "lead-session:turn-8" });
  });

  it("wakes the Supervisor for the configured soft economic threshold without requesting the Owner", async () => {
    const fixture = await makeFixture({ supervisor: true, economic: { initialProviderTurns: 8, supervisorProviderTurns: 12, hardProviderTurns: 16, softThreshold: 0.8 } });
    await updateOperationParticipant(fixture.root, fixture.operationId, fixture.participantId, { status: "RUNNING" });
    let latestEventAt = fixture.executionStartedAt.getTime();
    for (let index = 1; index <= 7; index += 1) {
      latestEventAt += 1_000;
      await recordParticipantExecutionActivityV1(fixture.root, fixture.operationId, fixture.participantId, {
        kind: "PROVIDER_TURN_STARTED", evidenceId: `provider-turn:${index}`, evidenceDigest: digest(index), observedAt: new Date(latestEventAt)
      });
    }
    const operation = await loadOperation(fixture.root, fixture.operationId);
    const policy = operationLivenessPolicy({ version: 1, project: { name: "liveness-test" }, orchestration: { provider: "paseo" } } as never, operation);
    expect(operation.participants[fixture.participantId]!.executionLiveness!.providerTurns).toBe(7);
    expect(evaluateOperationWake(operation, policy, latestEventAt + 1_000)).toMatchObject({ reason: "economic", target: "supervisor" });
  });

  it("dispatches a same-session continuation only after the exact Paseo session is quiescent", async () => {
    const fixture = await makeFixture({ supervisor: true });
    const operation = await loadOperation(fixture.root, fixture.operationId);
    await updateOperationParticipant(fixture.root, fixture.operationId, fixture.participantId, { transport: "paseo-sdk" });
    await bindPaseoSession(fixture.root, {
      projectId: operation.candidateRevision!.projectId!, operationId: fixture.operationId,
      operationExecutionRevision: fixture.participantBinding.operationExecutionRevision, participantId: fixture.participantId,
      participantGeneration: fixture.participantBinding.participantGeneration, candidateRevision: fixture.participantBinding.candidateRevision,
      candidateDigest: fixture.participantBinding.candidateDigest, executionBlueprintDigest: fixture.participantBinding.executionBlueprintDigest,
      operationPolicyDigest: fixture.participantBinding.operationPolicyDigest, contextManifestDigest: fixture.participantBinding.contextManifestDigest,
      promptManifestDigest: fixture.participantBinding.promptManifestDigest, controllerEpoch: fixture.participantBinding.controllerEpoch,
      paseoAgentId: fixture.participantBinding.runtime.sessionId
    });
    let status = "running";
    const inspect = vi.fn(async (_root: string, id: string) => ({ id, status }));
    const stop = vi.fn(async () => { status = "idle"; return { exitCode: 0, stderr: "" }; });
    const awaitProviderLeaseRelease = vi.fn(async () => true);
    const dispatch = vi.fn(async (_root: string, id: string) => ({ id, exitCode: 0, stdout: "", stderr: "", status: "working", transport: "sdk" as const }));
    const result = await dispatchSameSessionResumeV1(fixture.root, fixture.operationId, fixture.participantId, fixture.participantBinding.digest, [], {
      inspect: inspect as never, stop: stop as never, awaitProviderLeaseRelease, dispatch: dispatch as never
    }, "RESUME_SAME_SESSION", { role: "SUPERVISOR", sessionId: "session:supervisor:1" });
    expect(result).toBe("ACCEPTED");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(awaitProviderLeaseRelease).toHaveBeenCalledWith(fixture.root, fixture.operationId, fixture.participantId, fixture.participantBinding.runtime.sessionId);
    expect(dispatch.mock.calls[0]?.[1]).toBe(fixture.participantBinding.runtime.sessionId);
    expect(String(dispatch.mock.calls[0]?.[2])).toContain("Continue only your existing frozen WorkUnit");
  });

  it("aborts same-session dispatch if candidate identity changes during provider-lease release", async () => {
    const fixture = await makeFixture({ supervisor: true });
    const operation = await loadOperation(fixture.root, fixture.operationId);
    await updateOperationParticipant(fixture.root, fixture.operationId, fixture.participantId, { transport: "paseo-sdk" });
    await bindPaseoSession(fixture.root, {
      projectId: operation.candidateRevision!.projectId!, operationId: fixture.operationId,
      operationExecutionRevision: fixture.participantBinding.operationExecutionRevision, participantId: fixture.participantId,
      participantGeneration: fixture.participantBinding.participantGeneration, candidateRevision: fixture.participantBinding.candidateRevision,
      candidateDigest: fixture.participantBinding.candidateDigest, executionBlueprintDigest: fixture.participantBinding.executionBlueprintDigest,
      operationPolicyDigest: fixture.participantBinding.operationPolicyDigest, contextManifestDigest: fixture.participantBinding.contextManifestDigest,
      promptManifestDigest: fixture.participantBinding.promptManifestDigest, controllerEpoch: fixture.participantBinding.controllerEpoch,
      paseoAgentId: fixture.participantBinding.runtime.sessionId
    });
    const next = createCandidateRevisionV1({
      operationId: fixture.operationId, candidateId: `${operation.candidateRevision!.candidateId}:r2`, projectId: operation.candidateRevision!.projectId!,
      taskId: operation.candidateRevision!.taskId, revision: operation.candidateRevision!.revision + 1, parentCandidateId: operation.candidateRevision!.candidateId,
      sourceDigest: operation.candidateRevision!.sourceDigest, worktree: operation.candidateRevision!.worktree, createdAt: new Date().toISOString()
    });
    const inspect = vi.fn(async (_root: string, id: string) => ({ id, status: "idle" }));
    const dispatch = vi.fn(async (_root: string, id: string) => ({ id, exitCode: 0, stdout: "", stderr: "", status: "working", transport: "sdk" as const }));
    await expect(dispatchSameSessionResumeV1(fixture.root, fixture.operationId, fixture.participantId, fixture.participantBinding.digest, [], {
      inspect: inspect as never,
      awaitProviderLeaseRelease: async () => { await bindOperationCandidate(fixture.root, fixture.operationId, next); return true; },
      dispatch: dispatch as never
    }, "RESUME_SAME_SESSION", { role: "SUPERVISOR", sessionId: "session:supervisor:1" })).rejects.toThrow(/identity changed while waiting/);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
