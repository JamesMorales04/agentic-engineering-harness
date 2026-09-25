import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const runtime = vi.hoisted(() => ({
  continueManagedPaseoAgent: vi.fn(),
  launchManagedPaseoAgent: vi.fn(),
  materializeManagedPaseoAgent: vi.fn(),
  stopManagedPaseoAgent: vi.fn(async () => ({ exitCode: 0, stderr: "" }))
}));
const artifacts = vi.hoisted(() => ({ persistOperationAgentArtifact: vi.fn() }));
const state = vi.hoisted(() => ({
  currentOperationContext: vi.fn(() => ({ id: "AUDIT-1", kind: "audit" })),
  operation: undefined as Record<string, any> | undefined,
  activeOperationSupervisor: vi.fn(() => undefined),
  loadOperation: vi.fn(async () => state.operation),
  resolveOperationStateRoot: vi.fn((root: string) => root),
  currentControllerEpoch: vi.fn((operation: Record<string, any>) => operation.controller?.epoch ?? 0),
  bindResolvedOperationPolicy: vi.fn(async (_root: string, _operationId: string, policy: Record<string, any>) => {
    state.operation!.resolvedOperationPolicy = policy;
    return state.operation;
  }),
  bindOperationParticipantExecution: vi.fn(async (_root: string, _operationId: string, input: { participantId: string; binding: Record<string, any> }) => {
    state.operation!.participants[input.participantId].executionBinding = input.binding;
    return state.operation;
  }),
  recordParticipantReceipt: vi.fn(async (_root: string, _operationId: string, receipt: Record<string, any>) => {
    state.operation!.participantReceipts ??= {};
    state.operation!.participantReceipts[receipt.participantId] = receipt;
    return state.operation;
  }),
  registerOperationAgent: vi.fn(async () => undefined),
  updateOperationParticipant: vi.fn(async () => undefined)
}));
const results = vi.hoisted(() => ({
  activateStructuredResultTurnForAgent: vi.fn(async () => undefined),
  acceptedStructuredResultForAgent: vi.fn(async () => undefined),
  structuredResultProvenanceForAgent: vi.fn(async () => undefined),
  reconcileStructuredResult: vi.fn()
}));

vi.mock("../src/paseo/runtime.js", () => runtime);
vi.mock("../src/operations/artifacts.js", () => artifacts);
vi.mock("../src/operations/state.js", () => state);
vi.mock("../src/workers/resultGateway.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/workers/resultGateway.js")>(),
  ...results
}));
vi.mock("../src/core/controlPlane.js", () => ({ loadFrozenSkillContext: vi.fn(async () => undefined) }));

import { outputJsonSchema, validateAgentOutput } from "../src/agents/outputContracts.js";
import { extractMarkedJson, StructuredOutputError } from "../src/agents/structuredOutput.js";
import { sha256Canonical } from "../src/core/digest.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { createStructuredResultProvenance } from "../src/workers/resultGateway.js";
import { dispatchMaterializedAgentPrompt, prepareAgentExecutionBinding } from "../src/workers/agentPrompt.js";

const selection = {
  logicalAgent: "code-quality-reviewer",
  role: "Reviewer",
  description: "Review code quality.",
  transport: "paseo",
  runtimeAdapter: "opencode",
  runtimeName: "opencode",
  modelName: "reviewer-model",
  modelId: "reviewer-model",
  nativeAgent: "reviewer",
  profile: "test",
  permissions: {},
  mcps: [],
  skills: [],
  args: []
} as never;
const config = { version: 1, project: { name: "demo" }, orchestration: { provider: "paseo", worker: { timeoutSeconds: 60 } } } as never;
let testRoot = "";
const contract = {
  version: 1,
  task: { id: "AUDIT-1", title: "Audit" },
  routing: { route: "DELEGATED", assurance: "STANDARD", intent: "Audit the repository" },
  scope: { allowed: ["src/**", "tests/**"], forbidden: ["docs/CORE_ARCHITECTURE_V2.md"] },
  requirements: [],
  verification: {}
} as never;
const materialized = { id: "reviewer-1", provider: "opencode", model: "reviewer-model", logicalAgent: "code-quality-reviewer", exitCode: 0, stdout: "", stderr: "", transport: "paseo-sdk", operationId: "AUDIT-1", operationKind: "audit", phase: "review", status: "idle", startedAt: new Date(0).toISOString() } as never;

const validReviewer = { verdict: "PASS", findings: [], finalizationSafety: "SAFE", followUp: [] };
const validReviewerJson = JSON.stringify(validReviewer);
const validSupervisor = { summary: "Consolidated", consolidatedFindings: [], sourceFindingIds: [], conflicts: [], missingEvidence: [], unresolved: [], roadmap: [], finalizationSafety: "SAFE" };
const validSupervisorJson = JSON.stringify(validSupervisor);

async function prepareMaterializedIdentity(
  selected: typeof selection,
  contractName: "reviewer" | "supervisor",
  phase: string,
  prompt: string,
  participantId: string,
  supervisorAgent = false
) {
  const prepared = await prepareAgentExecutionBinding(testRoot, config, contract, selected as never, prompt, {
    outputContract: contractName,
    phase,
    operationKind: "audit",
    participantId,
    executionSessionId: `fixture-session:${participantId}`,
    supervisorAgent
  });
  const options = {
    outputContract: contractName,
    phase,
    operationKind: "audit",
    participantId,
    supervisorAgent,
    resumeSessionId: prepared.binding.runtime.sessionId,
    capabilityAuthority: prepared.authority,
    executionBinding: prepared.binding,
    executionBlueprint: prepared.executionBlueprint,
    roleInvocationPolicy: prepared.roleInvocationPolicy,
    skillManifest: prepared.skillManifest,
    contextManifestDigest: prepared.binding.contextManifestDigest,
    promptManifestDigest: prepared.binding.promptManifestDigest,
    preparedPrompt: prepared.prompt,
    contextManifest: prepared.contextManifest
  };
  const launch = {
    materializedSession: { ...materialized, id: prepared.binding.runtime.sessionId },
    provenance: createStructuredResultProvenance({
      projectId: "demo",
      operationId: "AUDIT-1",
      operationRevision: state.operation!.revision,
      operationExecutionRevision: prepared.binding.operationExecutionRevision,
      participantId,
      participantGeneration: prepared.binding.participantGeneration,
      logicalAgent: selected.logicalAgent,
      role: selected.role,
      taskId: "AUDIT-1",
      candidate: state.operation!.candidateRevision,
      controllerEpoch: prepared.binding.controllerEpoch,
      runtime: { provider: prepared.binding.runtime.provider, model: prepared.binding.runtime.modelId, runtimeId: prepared.binding.runtime.runtimeId, sessionId: prepared.binding.runtime.sessionId },
      outputContract: contractName,
      outputSchemaDigest: sha256Canonical(outputJsonSchema(contractName)),
      executionBlueprintDigest: prepared.binding.executionBlueprintDigest,
      resolvedOperationPolicyDigest: prepared.binding.operationPolicyDigest,
      executionBinding: prepared.binding,
      skillManifestDigest: prepared.binding.skillManifestDigest,
      contextManifestDigest: prepared.binding.contextManifestDigest,
      promptManifestDigest: prepared.binding.promptManifestDigest,
      unsupported: []
    }),
    options
  };
  results.structuredResultProvenanceForAgent.mockResolvedValue(launch.provenance);
  await persistAcceptedResultFixture(contractName);
  return launch;
}

async function persistAcceptedResultFixture(contractName: "reviewer" | "supervisor"): Promise<void> {
  const resultsDirectory = path.join(testRoot, "results");
  await mkdir(resultsDirectory, { recursive: true });
  await writeFile(path.join(resultsDirectory, `${contractName}.json`), JSON.stringify(contractName === "reviewer" ? validReviewer : validSupervisor));
}

beforeEach(async () => {
  testRoot = await mkdtemp(path.join(os.tmpdir(), "aeh-review-recovery-"));
  const candidateRevision = createCandidateRevisionV1({
    operationId: "AUDIT-1",
    candidateId: "candidate:AUDIT-1:r1",
    projectId: "demo",
    taskId: "AUDIT-1",
    revision: 1,
    sourceDigest: "a".repeat(64),
    createdAt: new Date(0).toISOString()
  });
  state.operation = {
    version: 2,
    id: "AUDIT-1",
    kind: "audit",
    status: "RUNNING",
    phase: "review",
    root: testRoot,
    payload: { request: "Audit the repository" },
    revision: 1,
    operationExecutionRevision: 1,
    candidateRevision,
    controller: { epoch: 0, ownerId: "controller:test", claimedAt: new Date(0).toISOString() },
    participants: {
      "reviewer-1": { id: "reviewer-1", role: "Reviewer", status: "RUNNING", registeredAt: new Date(0).toISOString(), parentSupervisorGeneration: 1, parentAgentId: "supervisor-1" },
      "supervisor-1": { id: "supervisor-1", role: "Operation Supervisor", status: "RUNNING", registeredAt: new Date(0).toISOString() }
    },
    agents: [],
    resolvedOperationPolicy: undefined
  };
  state.loadOperation.mockImplementation(async () => state.operation);
  state.currentControllerEpoch.mockImplementation((operation: Record<string, any>) => operation.controller?.epoch ?? 0);
  state.bindResolvedOperationPolicy.mockImplementation(async (_root: string, _operationId: string, policy: Record<string, any>) => {
    state.operation!.resolvedOperationPolicy = policy;
    return state.operation;
  });
  state.bindOperationParticipantExecution.mockImplementation(async (_root: string, _operationId: string, input: { participantId: string; binding: Record<string, any> }) => {
    state.operation!.participants[input.participantId].executionBinding = input.binding;
    return state.operation;
  });
  state.recordParticipantReceipt.mockImplementation(async (_root: string, _operationId: string, receipt: Record<string, any>) => {
    state.operation!.participantReceipts ??= {};
    state.operation!.participantReceipts[receipt.participantId] = receipt;
    return state.operation;
  });
  runtime.continueManagedPaseoAgent.mockReset();
  runtime.stopManagedPaseoAgent.mockReset().mockResolvedValue({ exitCode: 0, stderr: "" });
  results.acceptedStructuredResultForAgent.mockReset().mockResolvedValue(undefined);
  results.structuredResultProvenanceForAgent.mockReset().mockResolvedValue(undefined);
  results.reconcileStructuredResult.mockImplementation(async (_root: string, input: { contract: string; stdout: string; stderr?: string }) => {
    try {
      const payload = extractMarkedJson(input.stdout, input.stderr ?? "");
      const validation = validateAgentOutput(input.contract, payload);
      if (!validation.ok) return { ok: false, failure: `SCHEMA_VALIDATION_FAILED: ${validation.issues.join("; ")}` };
      return {
        ok: true,
        accepted: {
          artifact: `results/${input.contract}.json`,
          sha256: "abc123",
          payload: validation.value,
          source: "captured",
          turnId: "turn-1",
          channelId: "channel-1"
        }
      };
    } catch (error) {
      if (error instanceof StructuredOutputError) return { ok: false, failure: `${error.reason}: ${error.message}` };
      return { ok: false, failure: String(error) };
    }
  });
});

afterEach(async () => { vi.clearAllMocks(); await rm(testRoot, { recursive: true, force: true }); });

describe("structured delivery recovery", () => {
  it("reconciles a valid durable result when Paseo never returns its terminal event", async () => {
    runtime.continueManagedPaseoAgent.mockImplementation(() => new Promise(() => undefined));
    results.acceptedStructuredResultForAgent
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({
        artifact: "results/reviewer.json",
        sha256: "sink123",
        payload: validReviewer,
        source: "mcp",
        turnId: "turn-sink",
        channelId: "channel-sink"
      });
    artifacts.persistOperationAgentArtifact.mockResolvedValue("transcript.json");

    const prepared = await prepareMaterializedIdentity(selection, "reviewer", "review", "perform the audit", "reviewer-1");
    const result = await dispatchMaterializedAgentPrompt(testRoot, config, contract, selection, prepared.materializedSession as never, "perform the audit", prepared.options);

    expect(result.stdout).toBe(validReviewerJson);
    expect(runtime.stopManagedPaseoAgent).toHaveBeenCalledWith(testRoot, prepared.materializedSession.id);
    expect(state.updateOperationParticipant.mock.calls.at(-1)?.[3]).toEqual(expect.objectContaining({ status: "COMPLETED", resultArtifact: "results/reviewer.json" }));
    expect(results.reconcileStructuredResult).not.toHaveBeenCalled();
  });

  it("normalizes typographic JSON quotes without spending a repair turn", async () => {
    runtime.continueManagedPaseoAgent.mockResolvedValueOnce({ id: "reviewer-1", exitCode: 0, stdout: 'AEH_RESULT_JSON={\u201cverdict\u201d:\u201cPASS\u201d,\u201cfindings\u201d:[],\u201cfinalizationSafety\u201d:\u201cSAFE\u201d,\u201cfollowUp\u201d:[]}', stderr: "", status: "idle", transport: "sdk" });
    artifacts.persistOperationAgentArtifact.mockResolvedValue("first.json");

    const prepared = await prepareMaterializedIdentity(selection, "reviewer", "review", "perform the audit", "reviewer-1");
    const result = await dispatchMaterializedAgentPrompt(testRoot, config, contract, selection, prepared.materializedSession as never, "perform the audit", prepared.options);

    expect(runtime.continueManagedPaseoAgent).toHaveBeenCalledTimes(1);
    const prompt = String(runtime.continueManagedPaseoAgent.mock.calls[0]?.[2]);
    expect(prompt).toContain("AEH output contract: reviewer.");
    expect(prompt).toContain("supplied out-of-band");
    expect(prompt).toContain("aeh_submit_result");
    expect(runtime.continueManagedPaseoAgent.mock.calls[0]?.[5]).toEqual(expect.objectContaining({ type: "object" }));
    expect(result.stdout).toBe(validReviewerJson);
    expect(result.phase).toBe("review");
    expect(artifacts.persistOperationAgentArtifact).toHaveBeenCalledTimes(1);
    expect(artifacts.persistOperationAgentArtifact.mock.calls[0]?.[3]).toEqual(expect.objectContaining({ contractDelivery: { ok: true }, structuredResultArtifact: "results/reviewer.json" }));
  });

  it("treats an accepted durable sink result as authoritative even when captured stdout is empty", async () => {
    runtime.continueManagedPaseoAgent.mockResolvedValueOnce({ id: "reviewer-1", exitCode: 0, stdout: "", stderr: "", status: "idle", transport: "sdk" });
    results.reconcileStructuredResult.mockResolvedValueOnce({
      ok: true,
      accepted: { artifact: "results/reviewer.json", sha256: "sink123", payload: validReviewer, source: "mcp", turnId: "turn-sink", channelId: "channel-sink" }
    });
    artifacts.persistOperationAgentArtifact.mockResolvedValue("transcript.json");

    const prepared = await prepareMaterializedIdentity(selection, "reviewer", "review", "perform the audit", "reviewer-1");
    const result = await dispatchMaterializedAgentPrompt(testRoot, config, contract, selection, prepared.materializedSession as never, "perform the audit", prepared.options);

    expect(runtime.continueManagedPaseoAgent).toHaveBeenCalledTimes(1);
    expect(result.stdout).toBe(validReviewerJson);
    expect(artifacts.persistOperationAgentArtifact.mock.calls[0]?.[3]).toEqual(expect.objectContaining({ contractDelivery: { ok: true }, structuredResultArtifact: "results/reviewer.json" }));
    expect(state.updateOperationParticipant.mock.calls.at(-1)?.[3]).toEqual(expect.objectContaining({ status: "COMPLETED", resultArtifact: "results/reviewer.json" }));
  });

  it("repairs an empty captured structured turn exactly once and accepts the repaired result", async () => {
    runtime.continueManagedPaseoAgent
      .mockResolvedValueOnce({ id: "reviewer-1", exitCode: 0, stdout: "", stderr: "", status: "idle", transport: "sdk" })
      .mockResolvedValueOnce({ id: "reviewer-1", exitCode: 0, stdout: `AEH_RESULT_JSON=${validReviewerJson}`, stderr: "", status: "idle", transport: "sdk" });
    artifacts.persistOperationAgentArtifact.mockResolvedValueOnce("first.json").mockResolvedValueOnce("repair.json");

    const prepared = await prepareMaterializedIdentity(selection, "reviewer", "review", "perform the audit", "reviewer-1");
    const result = await dispatchMaterializedAgentPrompt(testRoot, config, contract, selection, prepared.materializedSession as never, "perform the audit", prepared.options);

    expect(runtime.continueManagedPaseoAgent).toHaveBeenCalledTimes(2);
    expect(runtime.continueManagedPaseoAgent.mock.calls[1]?.[2]).toContain("Only repair delivery for the 'reviewer' output contract");
    expect(runtime.continueManagedPaseoAgent.mock.calls[1]?.[2]).toContain("aeh_submit_result");
    expect(runtime.continueManagedPaseoAgent.mock.calls[1]?.[5]).toBeUndefined();
    expect(result.stdout).toBe(validReviewerJson);
    expect(result.phase).toBe("review-contract-repair");
    expect(artifacts.persistOperationAgentArtifact.mock.calls[0]?.[3]).toEqual(expect.objectContaining({ contractDelivery: expect.objectContaining({ ok: false, failure: expect.stringContaining("EMPTY_OUTPUT") }) }));
    expect(artifacts.persistOperationAgentArtifact.mock.calls[1]?.[3]).toEqual(expect.objectContaining({ contractDelivery: { ok: true } }));
  });

  it("does not recurse when the serialization retry is still invalid and leaves the participant failed", async () => {
    runtime.continueManagedPaseoAgent
      .mockResolvedValueOnce({ id: "reviewer-1", exitCode: 0, stdout: "not-json", stderr: "", status: "idle", transport: "sdk" })
      .mockResolvedValueOnce({ id: "reviewer-1", exitCode: 0, stdout: "still-not-json", stderr: "", status: "idle", transport: "sdk" });
    artifacts.persistOperationAgentArtifact.mockResolvedValue("artifact.json");

    const prepared = await prepareMaterializedIdentity(selection, "reviewer", "review", "perform the audit", "reviewer-1");
    const result = await dispatchMaterializedAgentPrompt(testRoot, config, contract, selection, prepared.materializedSession as never, "perform the audit", prepared.options);

    expect(runtime.continueManagedPaseoAgent).toHaveBeenCalledTimes(2);
    expect(result.stdout).toBe("still-not-json");
    expect(result.phase).toBe("review-contract-repair");
    const lastUpdate = state.updateOperationParticipant.mock.calls.at(-1)?.[3] as { status?: string; error?: string } | undefined;
    expect(lastUpdate).toEqual(expect.objectContaining({ status: "FAILED", error: expect.stringContaining("NO_MARKER") }));
  });

  it("applies the same bounded serialization repair to supervisor contracts", async () => {
    runtime.continueManagedPaseoAgent
      .mockResolvedValueOnce({ id: "supervisor-1", exitCode: 0, stdout: "", stderr: "", status: "idle", transport: "sdk" })
      .mockResolvedValueOnce({ id: "supervisor-1", exitCode: 0, stdout: `AEH_RESULT_JSON=${validSupervisorJson}`, stderr: "", status: "idle", transport: "sdk" });

    const supervisorSelection = { ...selection, logicalAgent: "operation-supervisor", role: "Operation Supervisor" } as never;
    const prepared = await prepareMaterializedIdentity(supervisorSelection, "supervisor", "consolidating", "consolidate findings", "supervisor-1", true);
    const result = await dispatchMaterializedAgentPrompt(
      testRoot,
      config,
      contract,
      supervisorSelection,
      { ...prepared.materializedSession, logicalAgent: "operation-supervisor", phase: "consolidating" } as never,
      "consolidate findings",
      prepared.options
    );

    expect(runtime.continueManagedPaseoAgent).toHaveBeenCalledTimes(2);
    expect(runtime.continueManagedPaseoAgent.mock.calls[0]?.[2]).toContain("AEH output contract: supervisor.");
    expect(runtime.continueManagedPaseoAgent.mock.calls[1]?.[5]).toBeUndefined();
    expect(result.stdout).toBe(validSupervisorJson);
    expect(result.phase).toBe("consolidating-contract-repair");
  });
});
