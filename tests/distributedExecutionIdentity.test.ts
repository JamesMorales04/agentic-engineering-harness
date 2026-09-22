import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  runExecutable: vi.fn(),
  submitDistributedJob: vi.fn(),
  claimDistributedJob: vi.fn(),
  completeDistributedJob: vi.fn(),
  waitForDistributedResult: vi.fn(),
  waitForDistributedSessionReady: vi.fn(),
  releaseDistributedExecutionBinding: vi.fn(),
  publishDistributedSessionReady: vi.fn(),
  waitForDistributedExecutionRelease: vi.fn(),
  assertWorkspaceMatchesCandidate: vi.fn(),
  enforceSandboxPolicy: vi.fn(),
  sandboxPolicyDigest: vi.fn(),
  executeAgentPrompt: vi.fn(),
  materializeAgentPrompt: vi.fn(),
  prepareRuntimeSession: vi.fn(),
  submittedJob: undefined as unknown,
  released: undefined as unknown
}));

vi.mock("../src/utils/process.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/utils/process.js")>()), runExecutable: state.runExecutable }));
vi.mock("../src/distributed/queue.js", () => ({
  claimDistributedJob: state.claimDistributedJob, completeDistributedJob: state.completeDistributedJob,
  submitDistributedJob: state.submitDistributedJob,
  waitForDistributedResult: state.waitForDistributedResult,
  waitForDistributedSessionReady: state.waitForDistributedSessionReady,
  releaseDistributedExecutionBinding: state.releaseDistributedExecutionBinding,
  publishDistributedSessionReady: state.publishDistributedSessionReady,
  waitForDistributedExecutionRelease: state.waitForDistributedExecutionRelease
}));
vi.mock("../src/workers/agentPrompt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/workers/agentPrompt.js")>()),
  executeAgentPrompt: state.executeAgentPrompt,
  materializeAgentPrompt: state.materializeAgentPrompt,
  prepareRuntimeSession: state.prepareRuntimeSession
}));
vi.mock("../src/candidates/identity.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/candidates/identity.js")>()), assertWorkspaceMatchesCandidate: state.assertWorkspaceMatchesCandidate }));
vi.mock("../src/security/sandbox.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/security/sandbox.js")>()),
  enforceSandboxPolicy: state.enforceSandboxPolicy,
  sandboxPolicyDigest: state.sandboxPolicyDigest
}));

import type { AgentExecutionSelection } from "../src/agents/types.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import { sha256Canonical } from "../src/core/digest.js";
import { createExecutionBlueprintV2, compileResolvedOperationPolicy, compileRoleInvocationPolicy, compileSkillManifest, type SkillManifestV1 } from "../src/architecture/executionIdentity.js";
import { createWorkGraph } from "../src/architecture/workGraph.js";
import { applySkillTrustGate, knowledgePack } from "../src/knowledge/index.js";
import { bindResolvedOperationPolicy, loadOperation, registerOperationAgent, saveOperation } from "../src/operations/state.js";
import { dispatchDistributedDelegation, runDistributedWorkerOnce, validateDistributedSandboxPolicy } from "../src/distributed/worker.js";
import { prepareAgentExecutionIdentity } from "../src/workers/agentPrompt.js";
import type { WorkUnitOutput } from "../src/agents/outputContracts.js";
import type { DistributedDelegationJob, DistributedDelegationResult } from "../src/distributed/types.js";
import { prepareExecutionAuthority } from "../src/security/executionLease.js";

const roots: string[] = [];
const originalEnv = {
  AEH_OPERATION_ID: process.env.AEH_OPERATION_ID,
  AEH_OPERATION_KIND: process.env.AEH_OPERATION_KIND,
  AEH_CONTROL_ROOT: process.env.AEH_CONTROL_ROOT
};

beforeEach(() => {
  state.runExecutable.mockImplementation(async (_command: string, args: string[]) => {
    if (args[0] === "remote" && args[1] === "get-url") return { exitCode: 0, stdout: "https://example.test/repo.git\n", stderr: "", durationMs: 1 };
    if (args[0] === "rev-parse") return { exitCode: 0, stdout: `${"a".repeat(40)}\n`, stderr: "", durationMs: 1 };
    return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
  });
  state.assertWorkspaceMatchesCandidate.mockResolvedValue({ observedSourceDigest: "source" });
  state.enforceSandboxPolicy.mockImplementation((selection: AgentExecutionSelection) => ({ selection, required: false }));
  state.sandboxPolicyDigest.mockReturnValue("sandbox-policy");
  state.submitDistributedJob.mockImplementation(async (_root: string, _config: unknown, job: unknown) => { state.submittedJob = job; });
  state.waitForDistributedSessionReady.mockImplementation(async (_root: string, _config: unknown, jobId: string) => {
    const job = state.submittedJob as DistributedDelegationJob;
    return { version: 1, jobId, workerId: "worker-test", leaseId: "lease-test", preparedAt: new Date().toISOString(), runtime: { runtimeId: job.selection.runtimeName, provider: job.selection.modelProvider ?? job.selection.paseoProvider ?? job.selection.runtimeAdapter, modelId: job.selection.modelId, model: job.selection.modelName, sessionId: "worker-session" }, contextManifestDigest: job.sessionPreparation.contextManifestDigest, promptManifestDigest: job.sessionPreparation.promptManifestDigest, sessionPreparation: "RUNTIME_MATERIALIZED" };
  });
  state.releaseDistributedExecutionBinding.mockImplementation(async (_root: string, _config: unknown, release: unknown) => { state.released = release; });
  state.waitForDistributedResult.mockImplementation(async () => {
    const release = state.released as { executionBinding: unknown } | undefined;
    return result(release?.executionBinding);
  });
  state.prepareRuntimeSession.mockResolvedValue("worker-session");
  state.materializeAgentPrompt.mockResolvedValue({ provider: "codex", model: "test-model", logicalAgent: "distributed-implementer", runtime: "codex", id: "paseo-materialized-agent", exitCode: 0, stdout: "", stderr: "", transport: "paseo-sdk", status: "idle" });
});

afterEach(async () => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  state.runExecutable.mockReset();
  state.submitDistributedJob.mockReset();
  state.claimDistributedJob.mockReset();
  state.completeDistributedJob.mockReset();
  state.waitForDistributedResult.mockReset();
  state.waitForDistributedSessionReady.mockReset();
  state.releaseDistributedExecutionBinding.mockReset();
  state.publishDistributedSessionReady.mockReset();
  state.waitForDistributedExecutionRelease.mockReset();
  state.assertWorkspaceMatchesCandidate.mockReset();
  state.enforceSandboxPolicy.mockReset();
  state.sandboxPolicyDigest.mockReset();
  state.executeAgentPrompt.mockReset();
  state.materializeAgentPrompt.mockReset();
  state.prepareRuntimeSession.mockReset();
  state.submittedJob = undefined;
  state.released = undefined;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("distributed execution identity", () => {
  it("uses the worker session receipt to bind before release and rejects a result that changes the binding", async () => {
    const launch = await fixture();
    state.waitForDistributedResult.mockImplementation(async () => {
      const released = state.released as { executionBinding: { runtime: { sessionId: string } } };
      return result(released.executionBinding, released.executionBinding.runtime.sessionId);
    });
    const matching = await dispatchDistributedDelegation(launch.input);
    expect(matching.status).toBe("PASS");
    expect(state.submittedJob).toEqual(expect.objectContaining({ version: 2, executionBlueprint: launch.blueprint, roleInvocationPolicy: launch.rolePolicy, skillManifest: launch.skillManifest, sessionPreparation: { contextManifest: launch.identity.contextManifest, contextManifestDigest: launch.identity.contextManifestDigest, promptManifestDigest: launch.identity.promptManifestDigest } }));
    expect(state.submittedJob).not.toHaveProperty("executionBinding");
    expect(state.released).toEqual(expect.objectContaining({ version: 1, executionBinding: expect.objectContaining({ runtime: expect.objectContaining({ sessionId: "worker-session" }) }) }));

    const released = state.released as { executionBinding: { runtime: { sessionId: string }; digest: string } };
    const mismatched = result({ ...released.executionBinding, digest: "f".repeat(64) }, "different-session");
    state.waitForDistributedResult.mockResolvedValue(mismatched);
    await expect(dispatchDistributedDelegation(launch.input)).rejects.toThrow("DISTRIBUTED_EXECUTION_BINDING_MISMATCH");
  });

  it("prepares the worker runtime first, waits for the controller binding, and executes only that session", async () => {
    const launch = await fixture();
    state.waitForDistributedResult.mockImplementation(async () => {
      const released = state.released as { executionBinding: { runtime: { sessionId: string } } };
      return result(released.executionBinding, released.executionBinding.runtime.sessionId);
    });
    await dispatchDistributedDelegation(launch.input);
    const job = state.submittedJob as DistributedDelegationJob;
    state.claimDistributedJob.mockResolvedValue({ job, leaseId: "lease-test" });
    state.waitForDistributedExecutionRelease.mockImplementation(async () => state.released);
    state.executeAgentPrompt.mockImplementation(async (_root: string, _config: unknown, _contract: unknown, _selection: unknown, _prompt: string, options: { executionBinding: { runtime: { sessionId: string } }; executionSessionId: string }) => ({
      provider: "codex", model: "test-model", logicalAgent: "distributed-implementer", runtime: "codex", id: options.executionSessionId, exitCode: 0, stdout: "", stderr: "", executionBinding: options.executionBinding
    }));

    const workerResult = await runDistributedWorkerOnce(launch.root, launch.config, "worker-test");
    expect(workerResult?.status, workerResult?.message).toBe("PASS");
    expect(state.prepareRuntimeSession).toHaveBeenCalledOnce();
    expect(state.publishDistributedSessionReady).toHaveBeenCalledWith(launch.root, launch.config, expect.objectContaining({ runtime: expect.objectContaining({ sessionId: "worker-session" }) }));
    expect(state.waitForDistributedExecutionRelease).toHaveBeenCalledWith(launch.root, launch.config, job.id, "worker-test", "lease-test");
    expect(state.executeAgentPrompt.mock.calls[0]?.[5]).toEqual(expect.objectContaining({ executionSessionId: "worker-session", executionBinding: expect.objectContaining({ runtime: expect.objectContaining({ sessionId: "worker-session" }) }) }));
    expect(state.publishDistributedSessionReady.mock.invocationCallOrder[0]).toBeLessThan(state.waitForDistributedExecutionRelease.mock.invocationCallOrder[0]!);
    expect(state.waitForDistributedExecutionRelease.mock.invocationCallOrder[0]).toBeLessThan(state.executeAgentPrompt.mock.invocationCallOrder[0]!);
  });

  it("materializes a distributed Paseo agent, binds its returned id, and only then dispatches its prompt", async () => {
    const launch = await fixture({ transport: "paseo" });
    state.waitForDistributedSessionReady.mockImplementation(async (_root: string, _config: unknown, jobId: string) => {
      const job = state.submittedJob as DistributedDelegationJob;
      return {
        version: 1, jobId, workerId: "worker-paseo", leaseId: "lease-paseo", preparedAt: new Date().toISOString(),
        runtime: { runtimeId: job.selection.runtimeName, provider: job.selection.modelProvider!, modelId: job.selection.modelId, model: job.selection.modelName, sessionId: "paseo-materialized-agent" },
        contextManifestDigest: job.sessionPreparation.contextManifestDigest, promptManifestDigest: job.sessionPreparation.promptManifestDigest, sessionPreparation: "RUNTIME_MATERIALIZED"
      };
    });
    state.waitForDistributedResult.mockImplementation(async () => {
      const released = state.released as { executionBinding: { runtime: { sessionId: string } } };
      return { ...result(released.executionBinding, released.executionBinding.runtime.sessionId), workerId: "worker-paseo" };
    });
    await dispatchDistributedDelegation(launch.input);
    const job = state.submittedJob as DistributedDelegationJob;
    state.claimDistributedJob.mockResolvedValue({ job, leaseId: "lease-paseo" });
    state.waitForDistributedExecutionRelease.mockImplementation(async () => state.released);
    state.executeAgentPrompt.mockImplementation(async (_root: string, _config: unknown, _contract: unknown, _selection: unknown, _prompt: string, options: { outputContract: string; executionBinding: { runtime: { sessionId: string } }; executionSessionId: string; materializedPaseoSession: { id: string } }) => {
      expect(options.materializedPaseoSession.id).toBe(options.executionBinding.runtime.sessionId);
      expect(options.outputContract).toBe(job.roleInvocationPolicy.outputContract);
      return { provider: "codex", model: "test-model", logicalAgent: "distributed-implementer", runtime: "codex", id: options.executionSessionId, exitCode: 0, stdout: "", stderr: "", executionBinding: options.executionBinding };
    });

    const workerResult = await runDistributedWorkerOnce(launch.root, launch.config, "worker-paseo");
    expect(workerResult?.status, workerResult?.message).toBe("PASS");
    expect(state.materializeAgentPrompt).toHaveBeenCalledOnce();
    expect(state.prepareRuntimeSession).not.toHaveBeenCalled();
    expect(state.publishDistributedSessionReady).toHaveBeenCalledWith(launch.root, launch.config, expect.objectContaining({ runtime: expect.objectContaining({ sessionId: "paseo-materialized-agent" }), sessionPreparation: "RUNTIME_MATERIALIZED" }));
    expect(state.materializeAgentPrompt.mock.invocationCallOrder[0]).toBeLessThan(state.publishDistributedSessionReady.mock.invocationCallOrder[0]!);
    expect(state.publishDistributedSessionReady.mock.invocationCallOrder[0]).toBeLessThan(state.waitForDistributedExecutionRelease.mock.invocationCallOrder[0]!);
    expect(state.waitForDistributedExecutionRelease.mock.invocationCallOrder[0]).toBeLessThan(state.executeAgentPrompt.mock.invocationCallOrder[0]!);
  });

  it("rejects stale candidate identity before a distributed job is submitted", async () => {
    const launch = await fixture();
    const altered = { ...launch.input, identity: { ...launch.identity, authority: { ...launch.identity.authority, candidateDigest: "d".repeat(64) } } };
    await expect(dispatchDistributedDelegation(altered as never)).rejects.toThrow("V2_AUTHORITY_INVALID");
    expect(state.submitDistributedJob).not.toHaveBeenCalled();
  });

  it("rejects each altered launch identity at the distributed production boundary", async () => {
    const launch = await fixture();
    const cases = [
      { name: "candidate digest", change: { authority: { ...launch.identity.authority, candidateDigest: "d".repeat(64) } } },
      { name: "blueprint", change: { executionBlueprint: { ...launch.blueprint, digest: "f".repeat(64) } } },
      { name: "role policy", change: { roleInvocationPolicy: { ...launch.rolePolicy, digest: "a".repeat(64) } } },
      { name: "skill manifest", change: { skillManifest: { ...launch.skillManifest, digest: "b".repeat(64) } } },
      { name: "context manifest", change: { contextManifestDigest: "c".repeat(64) } },
      { name: "prompt manifest", change: { promptManifestDigest: "d".repeat(64) } }
    ];
    for (const item of cases) {
      await expect(dispatchDistributedDelegation({ ...launch.input, identity: { ...launch.identity, ...item.change } } as never), `distributed launch must reject altered ${item.name}`).rejects.toThrow(/DISTRIBUTED_EXECUTION_IDENTITY_INVALID|EXECUTION_BINDING_|EXECUTION_BLUEPRINT_INVALID|ROLE_INVOCATION_POLICY_INVALID|SKILL_MANIFEST_INVALID|V2_AUTHORITY_INVALID/);
      expect(state.submitDistributedJob, `distributed launch must reject altered ${item.name} before submission`).not.toHaveBeenCalled();
    }
    state.waitForDistributedSessionReady.mockImplementation(async () => ({ version: 1, jobId: "wrong-job", workerId: "worker-test", leaseId: "lease-test", preparedAt: new Date().toISOString(), runtime: { runtimeId: "other", provider: "other", modelId: "other", model: "other", sessionId: "worker-session" }, contextManifestDigest: launch.identity.contextManifestDigest, promptManifestDigest: launch.identity.promptManifestDigest, sessionPreparation: "RUNTIME_MATERIALIZED" }));
    await expect(dispatchDistributedDelegation(launch.input)).rejects.toThrow("DISTRIBUTED_SESSION_READY_IDENTITY_MISMATCH");
  });

  it("propagates accepted ephemeral procedure bytes and the bound SkillManifest digest through the distributed job envelope", async () => {
    const launch = await fixture({ skills: [ephemeralSkill] });
    process.env.AEH_OPERATION_ID = launch.operationId;
    process.env.AEH_OPERATION_KIND = "run";
    process.env.AEH_CONTROL_ROOT = launch.root;
    const identity = await prepareAgentExecutionIdentity(launch.root, launch.config, launch.contract, launch.selection, "Implement the assigned change.", {
      participantId: launch.participantId,
      phase: "distributed",
      operationKind: "change",
      executionBlueprint: launch.blueprint,
      executionBlueprintDigest: launch.blueprint.digest,
      roleInvocationPolicy: launch.rolePolicy,
      skillManifest: launch.skillManifest
    });
    expect(launch.skillManifest.entries[0]?.procedure).toEqual(ephemeralProcedure);
    expect(launch.skillManifest.entries[0]?.procedureDigest).toBe(sha256Canonical(ephemeralProcedure));
    expect(identity.prompt).toContain(procedureProjection(launch.skillManifest));
    expect(identity.skillManifest.digest).toBe(launch.skillManifest.digest);
    state.waitForDistributedResult.mockImplementation(async () => {
      const released = state.released as { executionBinding: { runtime: { sessionId: string } } };
      return result(released.executionBinding, released.executionBinding.runtime.sessionId);
    });

    const dispatched = await dispatchDistributedDelegation({ ...launch.input, identity });
    expect(dispatched.status).toBe("PASS");
    expect(dispatched.session.executionBinding?.digest).toBe((state.released as { executionBinding: { digest: string } }).executionBinding.digest);

    const job = state.submittedJob as DistributedDelegationJob;
    expect(job.prompt).toBe(identity.prompt);
    expect(job.skillManifest).toEqual(launch.skillManifest);
    expect(job.skillManifest.entries[0]).toMatchObject({
      skillId: "ephemeral:distributed",
      procedure: ephemeralProcedure,
      procedureDigest: sha256Canonical(ephemeralProcedure),
      sourcePackDigest: launch.skillManifest.entries[0]?.sourcePackDigest,
      trustDecisionDigest: launch.skillManifest.entries[0]?.trustDecisionDigest
    });
    expect(job.sessionPreparation.promptManifestDigest).toBe(identity.promptManifestDigest);
    expect(job.executionBlueprint.participants[0]?.skillManifestDigest).toBe(launch.skillManifest.digest);
    expect(job.executionAuthority.participantId).toBe(job.roleInvocationPolicy.participantId);
    expect(validateDistributedSandboxPolicy(job, launch.config).selection).toEqual(job.selection);
  });

  it("rejects a foreign SkillManifest assignment before a distributed job is submitted", async () => {
    const launch = await fixture({ skills: [ephemeralSkill] });
    const foreignManifest = compileSkillManifest({ scope: { ...launch.skillManifest.scope, participantId: "participant:other-implementer" }, skills: [ephemeralSkill] });
    await expect(dispatchDistributedDelegation({ ...launch.input, identity: { ...launch.identity, skillManifest: foreignManifest } })).rejects.toThrow("DISTRIBUTED_EXECUTION_IDENTITY_INVALID");
    expect(state.submitDistributedJob).not.toHaveBeenCalled();
  });

  it("rejects missing or mismatched controller-issued authority before a distributed job is submitted", async () => {
    const launch = await fixture();
    await expect(dispatchDistributedDelegation({ ...launch.input, identity: { ...launch.identity, authority: undefined as never } })).rejects.toThrow("V2_AUTHORITY_REQUIRED");
    expect(state.submitDistributedJob).not.toHaveBeenCalled();
    await expect(dispatchDistributedDelegation({ ...launch.input, identity: { ...launch.identity, authority: { ...launch.authority, participantId: "participant:other-worker" } } })).rejects.toThrow(/V2_AUTHORITY_INVALID|DISTRIBUTED_EXECUTION_IDENTITY_INVALID/);
    expect(state.submitDistributedJob).not.toHaveBeenCalled();
  });

  it("rejects missing or wrong-participant worker authority and a foreign SkillManifest before the remote participant launches", async () => {
    const launch = await fixture({ skills: [ephemeralSkill] });
    process.env.AEH_OPERATION_ID = launch.operationId;
    process.env.AEH_OPERATION_KIND = "run";
    process.env.AEH_CONTROL_ROOT = launch.root;
    const identity = await prepareAgentExecutionIdentity(launch.root, launch.config, launch.contract, launch.selection, "Implement the assigned change.", {
      participantId: launch.participantId,
      phase: "distributed",
      operationKind: "change",
      executionBlueprint: launch.blueprint,
      executionBlueprintDigest: launch.blueprint.digest,
      roleInvocationPolicy: launch.rolePolicy,
      skillManifest: launch.skillManifest
    });
    state.waitForDistributedResult.mockImplementation(async () => {
      const released = state.released as { executionBinding: { runtime: { sessionId: string } } };
      return result(released.executionBinding, released.executionBinding.runtime.sessionId);
    });
    await dispatchDistributedDelegation({ ...launch.input, identity });
    const job = state.submittedJob as DistributedDelegationJob;
    const cases = [
      { name: "missing worker authority", job: { ...job, executionAuthority: undefined } },
      { name: "wrong-participant worker authority", job: { ...job, executionAuthority: { ...job.executionAuthority, participantId: "participant:other-worker" } } },
      { name: "foreign SkillManifest", job: { ...job, skillManifest: compileSkillManifest({ scope: { ...job.skillManifest.scope, participantId: "participant:other-worker" }, skills: [ephemeralSkill] }) } }
    ];
    for (const item of cases) {
      state.claimDistributedJob.mockResolvedValue({ job: item.job, leaseId: "lease:test" } as never);
      state.executeAgentPrompt.mockClear();
      const workerResult = await runDistributedWorkerOnce(launch.root, launch.config, "worker-test");
      expect(workerResult?.status, item.name).toBe("FAIL");
      expect(workerResult?.message, item.name).toMatch(/DISTRIBUTED_EXECUTION_(?:BINDING|IDENTITY)_INVALID/);
      expect(state.executeAgentPrompt, `${item.name} must be rejected before the remote participant launches`).not.toHaveBeenCalled();
    }
  });
});

const ephemeralProcedure = [
  "Inspect the frozen distributed candidate exactly.",
  "Record the accepted evidence digest before editing."
];
const distributedSkillSourceUri = "https://example.test/official/distributed-skill";
const distributedSkillPack = knowledgePack({ cacheKey: "distributed-skill-test", topic: "typescript", claims: ephemeralProcedure.map((statement, index) => ({ id: `claim-${index}`, statement, competency: "typescript", confidence: "high" as const })), sources: [{ uri: distributedSkillSourceUri, kind: "official", version: "1" }], retrievedAt: "2026-09-23T00:00:00.000Z" });
const distributedSkillGap = { version: 1 as const, cacheKey: distributedSkillPack.cacheKey, missingCompetencies: ["typescript"], mode: "DOCS_ONLY" as const, librarianRequired: true, reason: "distributed skill evidence test", status: "MISSING" as const };
const acceptedDistributedSkill = applySkillTrustGate({ version: 1, id: "ephemeral:distributed", competency: "typescript", procedure: ephemeralProcedure, sourcePackDigest: distributedSkillPack.packDigest, procedureEvidence: ephemeralProcedure.map((_step, stepIndex) => ({ stepIndex, claimIds: [`claim-${stepIndex}`], sourceUris: [distributedSkillSourceUri] })) }, distributedSkillPack, distributedSkillGap)!;
const ephemeralSkill = {
  id: acceptedDistributedSkill.id,
  kind: "ephemeral" as const,
  competencies: [{ id: acceptedDistributedSkill.competency }],
  proceduralSteps: acceptedDistributedSkill.procedure,
  sourcePackDigest: acceptedDistributedSkill.sourcePackDigest,
  trustDecisionDigest: acceptedDistributedSkill.trustDecision.decisionDigest,
  groundedProcedure: acceptedDistributedSkill.groundedProcedure
};

function procedureProjection(manifest: SkillManifestV1): string {
  return manifest.entries.map((entry) => `Skill ${entry.skillId} (${entry.competency})\n${entry.procedure.join("\n")}`).join("\n\n");
}

async function fixture(options: { skills?: Parameters<typeof compileSkillManifest>[0]["skills"]; transport?: AgentExecutionSelection["transport"] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-distributed-identity-"));
  roots.push(root);
  const now = new Date().toISOString();
  const operationId = "RUN-DISTRIBUTED-IDENTITY";
  process.env.AEH_OPERATION_ID = operationId;
  process.env.AEH_OPERATION_KIND = "run";
  process.env.AEH_CONTROL_ROOT = root;
  await saveOperation(root, { version: 2, id: operationId, kind: "run", status: "RUNNING", phase: "implementation", root,
    payload: { taskId: "TASK-DISTRIBUTED" }, revision: 1, operationExecutionRevision: 1, createdAt: now, updatedAt: now, lastProgressAt: now,
    supervision: { required: false, materialized: false, generations: [] }, stages: {}, participants: {}, progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 } });
  const operation = await loadOperation(root, operationId);
  const candidate = operation.candidateRevision!;
  const participantId = "participant:distributed-implementer";
  const selection: AgentExecutionSelection = { logicalAgent: "distributed-implementer", role: "Implementer", domains: [], runtimeName: "codex", runtimeAdapter: "codex", paseoProvider: "codex",
    modelAlias: "model", modelId: "model-id", modelName: "test-model", modelProvider: "openai", transport: options.transport ?? "direct", skills: [], mcps: [],
    permissions: { read: "allow", write: "allow", shell: "allow", network: "deny", delegate: "deny" }, outputContract: "implementer", args: [], runtimeCapabilities: {} };
  await registerOperationAgent(root, operationId, { id: participantId, logicalAgent: selection.logicalAgent, role: selection.role, phase: "implementation" });
  const policy = compileResolvedOperationPolicy({ projectId: candidate.projectId!, operationId, operationExecutionRevision: 1, candidateRevision: candidate.revision,
    candidateDigest: candidate.identityDigest, controllerEpoch: operation.controller?.epoch ?? 0, intent: "implement bounded change", route: "DELEGATED", minimumAssurance: "STANDARD",
    policyVersions: { resolvedOperationPolicy: "1" }, policyDigests: {}, validationPolicy: {}, reviewPolicy: {}, deliveryPolicy: {}, knowledgePolicy: {}, contextPolicy: {}, allowedExternalEffects: [], humanDecisionRequirements: [] });
  await bindResolvedOperationPolicy(root, operationId, policy);
  const rolePolicy = compileRoleInvocationPolicy({ operationId, operationPolicyDigest: policy.digest, participantId, role: "Implementer", workUnitIds: ["work"],
    scope: ["src/**"], competencies: ["typescript"], toolPack: { version: 1, required: ["repository-read"], optional: [], forbidden: [] }, resourceClaims: [], outputContract: "implementer", constraints: {} });
  const skillManifest = compileSkillManifest({ scope: { operationId, operationExecutionRevision: 1, candidateRevision: candidate.revision, candidateDigest: candidate.identityDigest, controllerEpoch: operation.controller?.epoch ?? 0, participantId, workUnitIds: ["work"], competencies: ["typescript"] }, skills: options.skills ?? [] });
  const validationResolution = { version: 1 as const, requirements: [], actions: [], blocked: [], digest: sha256Canonical({ version: 1, requirements: [], actions: [], blocked: [] }) };
  const graph = createWorkGraph({ taskId: "TASK-DISTRIBUTED", objective: "implement", route: "DELEGATED", assurance: "STANDARD", requirementRefs: [], acceptanceRefs: [], units: [] });
  const blueprint = createExecutionBlueprintV2({ projectId: candidate.projectId!, operationId, operationExecutionRevision: 1, candidateRevision: candidate.revision,
    candidateDigest: candidate.identityDigest, controllerEpoch: operation.controller?.epoch ?? 0, resolvedOperationPolicy: policy, workGraph: graph,
    participantPlan: { version: 1, taskId: "TASK-DISTRIBUTED", assignments: [participantId] }, executionCatalog: { version: 1 },
    participants: [{ participantId, role: "Implementer", specialization: "typescript", roleInvocationPolicy: rolePolicy, toolPack: rolePolicy.toolPack, resourceClaims: [],
      validationResolution, outputContract: "implementer", skillManifestDigest: skillManifest.digest }], validationResolution });
  const authority = await prepareExecutionAuthority(root, selection, { participantId, phase: "distributed", required: true });
  if (!authority) throw new Error("test fixture requires controller-issued distributed authority");
  const contract: TaskContract = { version: 1, task: { id: "TASK-DISTRIBUTED", title: "Implement distributed identity" }, routing: { route: "DELEGATED", assurance: "STANDARD", intent: "change" }, scope: { allowed: ["src/**"] } };
  const task = { id: "work", objective: "implement", scope: ["src/**"], dependencies: [], requirementRefs: [], acceptanceRefs: [], competencies: ["typescript"], riskTags: [], changeKinds: ["source"], risk: "low", resourceClaims: [] } as WorkUnitOutput;
  const config: HarnessProjectConfig = { version: 1, project: { name: "distributed-test" }, distributed: { enabled: true } };
  const prompt = "Implement the assigned change.";
  const identity = await prepareAgentExecutionIdentity(root, config, contract, selection, prompt, { participantId, phase: "distributed", operationKind: "change", capabilityAuthority: authority, executionBlueprint: blueprint, executionBlueprintDigest: blueprint.digest, roleInvocationPolicy: rolePolicy, skillManifest });
  return { root, operationId, config, contract, candidate, selection, participantId, policy, rolePolicy, skillManifest, blueprint, authority, identity,
    input: { root, config, contract, task, participantId, selection, waveBase: candidate, identity } };
}

function result(executionBinding: unknown, sessionId = "worker-session", jobId = (state.submittedJob as { id?: string } | undefined)?.id ?? "job"): DistributedDelegationResult {
  return { version: 2, jobId, workerId: "worker-test", startedAt: new Date(0).toISOString(), finishedAt: new Date(0).toISOString(), status: "PASS",
    session: { provider: "codex", model: "test-model", logicalAgent: "distributed-implementer", runtime: "codex", id: sessionId, exitCode: 0, stdout: "", stderr: "", executionBinding: executionBinding as never },
    changedFiles: [], patch: "" };
}
