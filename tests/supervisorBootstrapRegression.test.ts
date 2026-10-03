import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const workers = vi.hoisted(() => ({
  materializeAgentPrompt: vi.fn(),
  dispatchMaterializedAgentPrompt: vi.fn(),
  executeAgentPrompt: vi.fn()
}));
vi.mock("../src/workers/agentPrompt.js", () => workers);
const runtimeMocks = vi.hoisted(() => ({ archivePaseoSdkAgent: vi.fn(async () => undefined) }));
vi.mock("../src/paseo/sdk.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/paseo/sdk.js")>()), archivePaseoSdkAgent: runtimeMocks.archivePaseoSdkAgent }));
vi.mock("../src/paseo/context.js", () => ({ statusLeadContext: vi.fn(async () => ({ usage: { ratio: 0.01 }, state: "OK" })) }));
vi.mock("../src/workers/resultGateway.js", () => ({ structuredResultProvenanceForAgent: vi.fn(async () => ({ status: "BOUND", candidate: { identityDigest: "candidate:OLD" } })) }));

import { ensureOperationSupervisor, maybeRotateOperationSupervisor, operationSupervisorInitializationTimeoutSeconds } from "../src/operations/supervisor.js";
import { activeOperationSupervisor, bindOperationLead, bindResolvedOperationPolicy, initializingOperationSupervisor, loadOperation, saveOperation, type OperationRecordV2 } from "../src/operations/state.js";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { computeWorktreeDigest } from "../src/core/git.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import type { AgentExecutionSelection } from "../src/agents/types.js";

let root = "";
const originalEnv = snapshotEnv(["AEH_OPERATION_ID", "AEH_CONTROL_ROOT", "AEH_PARENT_OPERATION_ID"]);
beforeEach(() => clearEnv(Object.keys(originalEnv)));
afterEach(async () => {
  restoreEnv(originalEnv);
  workers.materializeAgentPrompt.mockReset();
  workers.dispatchMaterializedAgentPrompt.mockReset();
  workers.executeAgentPrompt.mockReset();
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = "";
});

const config = { version: 1, project: { name: "demo" }, orchestration: { provider: "paseo" } } as never;
const contract = { task: { id: "AUDIT-BOOT" }, routing: { intent: "audit" } } as never;
const supervisorSelection: AgentExecutionSelection = {
  logicalAgent: "operation-supervisor",
  role: "Operation Supervisor",
  domains: ["operations"],
  runtimeName: "opencode",
  runtimeAdapter: "opencode",
  paseoProvider: "opencode",
  modelAlias: "test",
  modelId: "test/supervisor",
  modelName: "supervisor",
  transport: "paseo",
  skills: ["finding-dedup", "acceptance-traceability", "recovery-classifier", "verification-planning"],
  mcps: [],
  permissions: {},
  args: [],
  runtimeCapabilities: {}
};

describe("supervisor bootstrap regression", () => {
  it("persists INITIALIZING before a compact skill-free turn barrier and activates only afterwards", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-supervisor-bootstrap-"));
    const now = new Date().toISOString();
    const record: OperationRecordV2 = {
      version: 2, id: "AUDIT-BOOT", kind: "audit", status: "RUNNING", phase: "supervision", root,
      payload: { request: "VERY_LONG_USER_INTENT_MUST_NOT_APPEAR_IN_INIT" }, revision: 1, createdAt: now, updatedAt: now, lastProgressAt: now,
      supervision: { required: true, materialized: false, generations: [] }, stages: {}, participants: {},
      progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
      notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 }
    };
    await saveOwnedOperation(root, record);
    await bindOperationLead(root, record.id, "lead-1", "test");
    process.env.AEH_OPERATION_ID = "AUDIT-BOOT";
    process.env.AEH_CONTROL_ROOT = root;

    workers.materializeAgentPrompt.mockResolvedValue({ id: "supervisor-1", exitCode: 0, stdout: "", stderr: "", status: "idle", transport: "paseo-sdk" });
    workers.dispatchMaterializedAgentPrompt.mockImplementation(async (_root, _effectiveConfig, _contract, selection, _materialized, prompt, options) => {
      const durable = await loadOperation(root, "AUDIT-BOOT");
      expect(durable.supervision.materialized).toBe(true);
      expect(durable.supervision.activeGeneration).toBeUndefined();
      expect(activeOperationSupervisor(durable)).toBeUndefined();
      expect(initializingOperationSupervisor(durable)).toEqual(expect.objectContaining({
        generation: 1,
        agentId: "supervisor-1",
        status: "INITIALIZING",
        initializationAttempt: 1,
        initializationDispatchedAt: expect.any(String)
      }));
      expect(options.providerTurnDeadlineMs).toBe(120_000);
      expect(selection.skills).toEqual([]);
      expect(String(prompt)).toContain("[AEH_SUPERVISOR_INITIALIZE]");
      expect(String(prompt)).toContain("session-readiness turn barrier");
      expect(String(prompt)).not.toContain("VERY_LONG_USER_INTENT_MUST_NOT_APPEAR_IN_INIT");
      expect(String(prompt)).not.toContain("OperationRecord snapshot");
      expect(String(prompt).length).toBeLessThan(700);
      expect(options.parentAgentId).toBeUndefined();
      return { id: "supervisor-1", exitCode: 0, stdout: "initialized", stderr: "", status: "idle", transport: "paseo-sdk" };
    });

    const handle = await ensureOperationSupervisor(root, config, contract, supervisorSelection, { required: true, forceMaterialize: true });
    expect(handle?.agentId).toBe("supervisor-1");
    expect(workers.materializeAgentPrompt.mock.calls[0]?.[4]).toEqual(expect.objectContaining({ parentAgentId: "lead-1" }));
    const durable = await loadOperation(root, "AUDIT-BOOT");
    expect(activeOperationSupervisor(durable)).toEqual(expect.objectContaining({
      generation: 1,
      agentId: "supervisor-1",
      status: "ACTIVE",
      initializationCompletedAt: expect.any(String),
      initializationEvidence: "paseo-sdk-turn-barrier"
    }));
    expect(initializingOperationSupervisor(durable)).toBeUndefined();
    expect(workers.executeAgentPrompt).not.toHaveBeenCalled();
  });

  it("uses a bounded supervisor initialization timeout", () => {
    expect(operationSupervisorInitializationTimeoutSeconds(config)).toBe(120);
    expect(operationSupervisorInitializationTimeoutSeconds({
      ...config,
      orchestration: { provider: "paseo", operations: { supervision: { initializationTimeoutSeconds: 25 } } }
    } as never)).toBe(25);
  });

  it("retries the candidate-drift replacement barrier once with a fresh session before failing closed", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-supervisor-rotation-"));
    const now = new Date().toISOString();
    const candidate = createCandidateRevisionV1({
      operationId: "AUDIT-ROTATE", candidateId: "candidate:AUDIT-ROTATE:r3", projectId: "project:demo", taskId: "AUDIT-ROTATE",
      revision: 3, parentCandidateId: "candidate:AUDIT-ROTATE:r2", sourceDigest: await computeWorktreeDigest(root), worktree: root, createdAt: now
    });
    const record: OperationRecordV2 = {
      version: 2, id: "AUDIT-ROTATE", kind: "audit", status: "RUNNING", phase: "consolidating", root,
      payload: { request: "rotation" }, revision: 1, createdAt: now, updatedAt: now, lastProgressAt: now,
      candidateRevision: candidate as never, operationExecutionRevision: 7,
      supervision: { required: true, materialized: true, activeGeneration: 1, generations: [{ generation: 1, agentId: "old-supervisor", status: "ACTIVE", createdAt: now }] },
      stages: {}, participants: {},
      progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
      notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 }
    };
    await saveOwnedOperation(root, record);
    process.env.AEH_OPERATION_ID = "AUDIT-ROTATE";
    process.env.AEH_CONTROL_ROOT = root;
    const owned = await loadOperation(root, "AUDIT-ROTATE");
    await bindResolvedOperationPolicy(root, "AUDIT-ROTATE", compileResolvedOperationPolicy({
      projectId: "project:demo", operationId: "AUDIT-ROTATE", operationExecutionRevision: 7, candidateRevision: 3, candidateDigest: candidate.identityDigest,
      controllerEpoch: owned.controller?.epoch ?? 1, intent: "rotation", route: "DELEGATED", minimumAssurance: "STANDARD",
      policyVersions: { resolvedOperationPolicy: "2", roleInvocationPolicy: "1", executionBlueprint: "3", executionBinding: "3", skillManifest: "1" },
      policyDigests: { validation: "v".repeat(64), delivery: "d".repeat(64), knowledge: "k".repeat(64), context: "c".repeat(64) },
      validationPolicy: {}, reviewPolicy: { minimumAssurance: "STANDARD", independentReviewRequired: false, leadAcceptance: false }, deliveryPolicy: { githubEnabled: false, paseoEnabled: false, allowedExternalEffects: [] },
      knowledgePolicy: { resolutions: [] }, contextPolicy: { mode: "disabled" }, allowedExternalEffects: [], humanDecisionRequirements: []
    }));

    workers.materializeAgentPrompt.mockResolvedValueOnce({ id: "replacement-1", exitCode: 0, stdout: "", stderr: "", status: "idle", transport: "paseo-sdk" });
    workers.materializeAgentPrompt.mockResolvedValueOnce({ id: "replacement-2", exitCode: 0, stdout: "", stderr: "", status: "idle", transport: "paseo-sdk" });
    workers.dispatchMaterializedAgentPrompt
      .mockResolvedValueOnce({ id: "replacement-1", exitCode: 1, stdout: "Handoff acknowledged. I'll remain idle until the next operation turn.", stderr: "", status: "failed", transport: "paseo-sdk" })
      .mockResolvedValueOnce({ id: "replacement-2", exitCode: 0, stdout: "ok", stderr: "", status: "idle", transport: "paseo-sdk" });

    const rotated = await maybeRotateOperationSupervisor(root, config, contract, supervisorSelection);
    expect(rotated?.agentId).toBe("replacement-2");
    expect(workers.materializeAgentPrompt).toHaveBeenCalledTimes(2);
    expect(workers.dispatchMaterializedAgentPrompt).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.archivePaseoSdkAgent).toHaveBeenCalledWith(root, "replacement-1");
    const durable = await loadOperation(root, "AUDIT-ROTATE");
    const generations = durable.supervision.generations;
    expect(generations.find((generation) => generation.agentId === "replacement-1")).toMatchObject({ status: "FAILED" });
    expect(generations.find((generation) => generation.agentId === "replacement-2")).toMatchObject({ status: "ACTIVE", initializationEvidence: "paseo-sdk-turn-barrier" });
    expect(durable.supervision.activeGeneration).toBe(generations.find((generation) => generation.agentId === "replacement-2")?.generation);
  });
});

function snapshotEnv(names: string[]): Record<string, string | undefined> {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}
function clearEnv(names: string[]): void {
  for (const name of names) delete process.env[name];
}
function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
