import { afterEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  continueManagedPaseoAgent: vi.fn(),
  launchManagedPaseoAgent: vi.fn(),
  materializeManagedPaseoAgent: vi.fn()
}));
const artifacts = vi.hoisted(() => ({ persistOperationAgentArtifact: vi.fn() }));
const state = vi.hoisted(() => ({
  currentOperationContext: vi.fn(() => ({ id: "AUDIT-1", kind: "audit" })),
  loadOperation: vi.fn(async () => ({
    participants: {
      "reviewer-1": {
        id: "reviewer-1",
        status: "RUNNING",
        registeredAt: new Date(0).toISOString(),
        parentSupervisorGeneration: 1,
        parentAgentId: "supervisor-1"
      }
    }
  })),
  registerOperationAgent: vi.fn(async () => undefined),
  updateOperationParticipant: vi.fn(async () => undefined)
}));

vi.mock("../src/paseo/runtime.js", () => runtime);
vi.mock("../src/operations/artifacts.js", () => artifacts);
vi.mock("../src/operations/state.js", () => state);
vi.mock("../src/core/controlPlane.js", () => ({
  loadFrozenSkillContext: vi.fn(async () => undefined)
}));

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
const config = {
  version: 1,
  project: { name: "demo" },
  orchestration: { provider: "paseo", worker: { timeoutSeconds: 60 } }
} as never;
const contract = { version: 1, task: { id: "AUDIT-1", title: "Audit" } } as never;
const materialized = {
  id: "reviewer-1",
  provider: "opencode",
  model: "reviewer-model",
  logicalAgent: "code-quality-reviewer",
  exitCode: 0,
  stdout: "",
  stderr: "",
  transport: "paseo-sdk",
  operationId: "AUDIT-1",
  operationKind: "audit",
  phase: "review",
  status: "idle",
  startedAt: new Date(0).toISOString()
} as never;

const validReviewerJson = JSON.stringify({
  verdict: "PASS",
  findings: [],
  finalizationSafety: "SAFE",
  followUp: []
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("reviewer structured delivery recovery", () => {
  it("persists the invalid raw turn then performs exactly one serialization-only retry", async () => {
    runtime.continueManagedPaseoAgent
      .mockResolvedValueOnce({
        id: "reviewer-1",
        exitCode: 0,
        stdout: 'AEH_RESULT_JSON={“verdict”:“PASS”,“findings”:[],“finalizationSafety”:“SAFE”,“followUp”:[]}',
        stderr: "",
        status: "idle",
        transport: "sdk"
      })
      .mockResolvedValueOnce({
        id: "reviewer-1",
        exitCode: 0,
        stdout: validReviewerJson,
        stderr: "",
        status: "idle",
        transport: "sdk"
      });
    artifacts.persistOperationAgentArtifact
      .mockResolvedValueOnce("first.json")
      .mockResolvedValueOnce("repair.json");

    const result = await dispatchMaterializedAgentPrompt(
      "/repo",
      config,
      contract,
      selection,
      materialized,
      "perform the audit",
      { outputContract: "reviewer", phase: "review", operationKind: "audit" }
    );

    expect(runtime.continueManagedPaseoAgent).toHaveBeenCalledTimes(2);
    expect(runtime.continueManagedPaseoAgent.mock.calls[1]?.[2]).toContain(
      "Only repair delivery for the 'reviewer' output contract"
    );
    expect(runtime.continueManagedPaseoAgent.mock.calls[1]?.[2]).toContain(
      "Do not inspect files, run tools, repeat the task, add new findings, or change conclusions."
    );
    expect(result.stdout).toBe(validReviewerJson);
    expect(result.phase).toBe("review-contract-repair");
    expect(artifacts.persistOperationAgentArtifact).toHaveBeenCalledTimes(2);
    expect(artifacts.persistOperationAgentArtifact.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({
        contractDelivery: expect.objectContaining({
          ok: false,
          failure: expect.stringContaining("MARKER_INVALID_JSON")
        })
      })
    );
    expect(artifacts.persistOperationAgentArtifact.mock.calls[1]?.[3]).toEqual(
      expect.objectContaining({ contractDelivery: { ok: true } })
    );
  });

  it("does not recurse when the serialization retry is still invalid", async () => {
    runtime.continueManagedPaseoAgent
      .mockResolvedValueOnce({
        id: "reviewer-1",
        exitCode: 0,
        stdout: "not-json",
        stderr: "",
        status: "idle",
        transport: "sdk"
      })
      .mockResolvedValueOnce({
        id: "reviewer-1",
        exitCode: 0,
        stdout: "still-not-json",
        stderr: "",
        status: "idle",
        transport: "sdk"
      });
    artifacts.persistOperationAgentArtifact.mockResolvedValue("artifact.json");

    const result = await dispatchMaterializedAgentPrompt(
      "/repo",
      config,
      contract,
      selection,
      materialized,
      "perform the audit",
      { outputContract: "reviewer", phase: "review", operationKind: "audit" }
    );

    expect(runtime.continueManagedPaseoAgent).toHaveBeenCalledTimes(2);
    expect(result.stdout).toBe("still-not-json");
    expect(result.phase).toBe("review-contract-repair");
  });
});
