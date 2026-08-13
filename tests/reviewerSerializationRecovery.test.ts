import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  continueManagedPaseoAgent: vi.fn(),
  launchManagedPaseoAgent: vi.fn(),
  materializeManagedPaseoAgent: vi.fn()
}));
const artifacts = vi.hoisted(() => ({ persistOperationAgentArtifact: vi.fn() }));
const state = vi.hoisted(() => ({
  currentOperationContext: vi.fn(() => ({ id: "AUDIT-1", kind: "audit" })),
  loadOperation: vi.fn(async () => ({ participants: { "reviewer-1": { id: "reviewer-1", status: "RUNNING", registeredAt: new Date(0).toISOString(), parentSupervisorGeneration: 1, parentAgentId: "supervisor-1" } } })),
  registerOperationAgent: vi.fn(async () => undefined),
  updateOperationParticipant: vi.fn(async () => undefined)
}));
const results = vi.hoisted(() => ({
  activateStructuredResultTurnForAgent: vi.fn(async () => undefined),
  reconcileStructuredResult: vi.fn()
}));

vi.mock("../src/paseo/runtime.js", () => runtime);
vi.mock("../src/operations/artifacts.js", () => artifacts);
vi.mock("../src/operations/state.js", () => state);
vi.mock("../src/workers/resultGateway.js", () => results);
vi.mock("../src/core/controlPlane.js", () => ({ loadFrozenSkillContext: vi.fn(async () => undefined) }));

import { validateAgentOutput } from "../src/agents/outputContracts.js";
import { extractMarkedJson, StructuredOutputError } from "../src/agents/structuredOutput.js";
import { dispatchMaterializedAgentPrompt } from "../src/workers/agentPrompt.js";

const selection = {
  logicalAgent: "code-quality-reviewer",
  role: "reviewer",
  description: "Review code quality.",
  transport: "paseo",
  runtimeAdapter: "opencode",
  runtimeName: "opencode",
  modelName: "reviewer-model",
  modelId: "reviewer-model",
  nativeAgent: "reviewer",
  profile: "test",
  permissions: {},
  skills: [],
  args: []
} as never;
const config = { version: 1, project: { name: "demo" }, orchestration: { provider: "paseo", worker: { timeoutSeconds: 60 } } } as never;
const contract = { version: 1, task: { id: "AUDIT-1", title: "Audit" } } as never;
const materialized = { id: "reviewer-1", provider: "opencode", model: "reviewer-model", logicalAgent: "code-quality-reviewer", exitCode: 0, stdout: "", stderr: "", transport: "paseo-sdk", operationId: "AUDIT-1", operationKind: "audit", phase: "review", status: "idle", startedAt: new Date(0).toISOString() } as never;

const validReviewer = { verdict: "PASS", findings: [], finalizationSafety: "SAFE", followUp: [] };
const validReviewerJson = JSON.stringify(validReviewer);
const validSupervisor = { summary: "Consolidated", consolidatedFindings: [], sourceFindingIds: [], conflicts: [], missingEvidence: [], unresolved: [], finalizationSafety: "SAFE" };
const validSupervisorJson = JSON.stringify(validSupervisor);

beforeEach(() => {
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

afterEach(() => { vi.clearAllMocks(); });

describe("structured delivery recovery", () => {
  it("normalizes typographic JSON quotes without spending a repair turn", async () => {
    runtime.continueManagedPaseoAgent.mockResolvedValueOnce({ id: "reviewer-1", exitCode: 0, stdout: 'AEH_RESULT_JSON={\u201cverdict\u201d:\u201cPASS\u201d,\u201cfindings\u201d:[],\u201cfinalizationSafety\u201d:\u201cSAFE\u201d,\u201cfollowUp\u201d:[]}', stderr: "", status: "idle", transport: "sdk" });
    artifacts.persistOperationAgentArtifact.mockResolvedValue("first.json");

    const result = await dispatchMaterializedAgentPrompt("/repo", config, contract, selection, materialized, "perform the audit", { outputContract: "reviewer", phase: "review", operationKind: "audit" });

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

  it("repairs an empty captured structured turn exactly once and accepts the repaired result", async () => {
    runtime.continueManagedPaseoAgent
      .mockResolvedValueOnce({ id: "reviewer-1", exitCode: 0, stdout: "", stderr: "", status: "idle", transport: "sdk" })
      .mockResolvedValueOnce({ id: "reviewer-1", exitCode: 0, stdout: `AEH_RESULT_JSON=${validReviewerJson}`, stderr: "", status: "idle", transport: "sdk" });
    artifacts.persistOperationAgentArtifact.mockResolvedValueOnce("first.json").mockResolvedValueOnce("repair.json");

    const result = await dispatchMaterializedAgentPrompt("/repo", config, contract, selection, materialized, "perform the audit", { outputContract: "reviewer", phase: "review", operationKind: "audit" });

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

    const result = await dispatchMaterializedAgentPrompt("/repo", config, contract, selection, materialized, "perform the audit", { outputContract: "reviewer", phase: "review", operationKind: "audit" });

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

    const result = await dispatchMaterializedAgentPrompt(
      "/repo",
      config,
      contract,
      { ...selection, logicalAgent: "operation-supervisor", role: "coordinator" } as never,
      { ...materialized, id: "supervisor-1", logicalAgent: "operation-supervisor", phase: "consolidating" } as never,
      "consolidate findings",
      { outputContract: "supervisor", phase: "consolidating", operationKind: "audit", supervisorAgent: true }
    );

    expect(runtime.continueManagedPaseoAgent).toHaveBeenCalledTimes(2);
    expect(runtime.continueManagedPaseoAgent.mock.calls[0]?.[2]).toContain("AEH output contract: supervisor.");
    expect(runtime.continueManagedPaseoAgent.mock.calls[1]?.[5]).toBeUndefined();
    expect(result.stdout).toBe(validSupervisorJson);
    expect(result.phase).toBe("consolidating-contract-repair");
  });
});
