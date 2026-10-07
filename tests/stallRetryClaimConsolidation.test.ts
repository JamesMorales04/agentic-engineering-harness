import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  executeAgentPrompt: vi.fn(),
  loadOperation: vi.fn(),
  patchOperation: vi.fn(),
  provenanceForAgent: vi.fn(),
  persistConsolidation: vi.fn(),
}));

vi.mock("../src/workers/agentPrompt.js", () => ({
  executeAgentPrompt: mocks.executeAgentPrompt,
  materializeAgentPrompt: vi.fn(),
  dispatchMaterializedAgentPrompt: vi.fn(),
}));

vi.mock("../src/operations/state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/operations/state.js")>();
  return {
    ...actual,
    loadOperation: mocks.loadOperation,
    patchOperation: mocks.patchOperation,
    withOperationCoordinationLock: vi.fn(async (_root: string, _op: string, action: () => Promise<unknown>) => action()),
  };
});

vi.mock("../src/workers/resultGateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/workers/resultGateway.js")>();
  return { ...actual, structuredResultProvenanceForAgent: mocks.provenanceForAgent };
});

vi.mock("../src/operations/artifacts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/operations/artifacts.js")>();
  return { ...actual, persistOperationConsolidation: mocks.persistConsolidation };
});

import { consolidateWithOperationSupervisor } from "../src/operations/supervisor.js";
import { resolveOperationStateRoot } from "../src/operations/state.js";
import { loadStallRetryStalls, stallRetryPendingFile } from "../src/operations/stallRetryBudget.js";
import type { TaskContract, WorkerSession } from "../src/core/types.js";

/**
 * RED for Luna B1 consolidation leg (round 6): supervisor.ts consolidation
 * (~L392-395) loads count, runs the supervisor turn, then records after the
 * stall — same crash window as discovery/planning/spec-manager. The counted
 * consolidation turn must run claimed; success/non-stall reconciles.
 */
const contract = {
  version: 1,
  task: { id: "CHANGE-STALL-CONSOL-1", title: "t" },
  scope: { allowed: ["**"], forbidden: [], frozen: [] },
  routing: { intent: "implement", domains: [], risk: "low", route: "FORMAL_SDD", assurance: "ELEVATED" },
  constraints: { breakingApiChanges: false, newDependencies: false, schemaChanges: false },
  requirements: [],
} as unknown as TaskContract;

const supervisorSelection = { role: "Supervisor", logicalAgent: "operation-supervisor", transport: "paseo" } as never;

const finding = {
  id: "F-1",
  severity: "low",
  category: "correctness",
  location: { file: "src/a.ts" },
  evidence: "unit test",
  impact: "low",
  recommendedFix: "fix it",
  requiredCompetencies: ["general"],
} as never;

function supervisorOutputStdout(): string {
  return `AEH_RESULT_JSON=${JSON.stringify({ summary: "ok", sourceFindingIds: ["F-1"], finalizationSafety: "SAFE" })}`;
}

function okTurnSession(id: string): WorkerSession {
  return {
    id,
    exitCode: 0,
    stdout: supervisorOutputStdout(),
    stderr: "",
    status: "idle",
    transport: "paseo-sdk",
  } as unknown as WorkerSession;
}

function operationRecord(operationId: string): Record<string, unknown> {
  return {
    operationId,
    id: operationId,
    revision: 1,
    kind: "change",
    status: "RUNNING",
    phase: "consolidating",
    intent: "test",
    stages: [],
    participants: {},
    progress: { expected: 1, completed: 0, failed: 0, blocked: 0 },
    lead: { generation: 1, acknowledgedRevision: 1 },
    candidateRevision: { identityDigest: "d1" },
    supervision: {
      required: true,
      activeGeneration: 1,
      generations: [{ generation: 1, agentId: "sup-agent-1", status: "ACTIVE" }],
    },
  };
}

describe("stall-retry consolidation claim-before-attempt (Luna B1)", () => {
  const priorOperationId = process.env.AEH_OPERATION_ID;

  beforeEach(() => {
    mocks.executeAgentPrompt.mockReset();
    mocks.loadOperation.mockReset();
    mocks.patchOperation.mockReset();
    mocks.provenanceForAgent.mockReset();
    mocks.persistConsolidation.mockReset();
  });

  afterEach(() => {
    if (priorOperationId === undefined) delete process.env.AEH_OPERATION_ID;
    else process.env.AEH_OPERATION_ID = priorOperationId;
  });

  it("consolidation claims BEFORE running the counted supervisor turn", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-consol-"));
    const operationId = "CONSOL-CLAIM-1";
    process.env.AEH_OPERATION_ID = operationId;
    const stateRoot = resolveOperationStateRoot(root);
    let markerSeenAtTurn: boolean | undefined;
    try {
      mocks.loadOperation.mockResolvedValue(operationRecord(operationId));
      mocks.patchOperation.mockImplementation(async (_r: string, _o: string, patch: Record<string, unknown>) => ({
        ...operationRecord(operationId),
        ...patch,
      }));
      mocks.provenanceForAgent.mockResolvedValue({
        status: "BOUND",
        participantId: "participant-1",
        candidate: { identityDigest: "d1" },
        executionBinding: { digest: "b1" },
        provenanceDigest: "b1",
      });
      mocks.executeAgentPrompt.mockImplementation(async () => {
        try {
          await fs.stat(stallRetryPendingFile(stateRoot, operationId, "consolidation"));
          markerSeenAtTurn = true;
        } catch {
          markerSeenAtTurn = false;
        }
        return okTurnSession("turn-1");
      });
      mocks.persistConsolidation.mockResolvedValue("artifact-1");
      const result = await consolidateWithOperationSupervisor(root, {} as never, contract, supervisorSelection, {
        key: "k1",
        purpose: "test",
        findings: [finding],
      });
      expect(result.artifact).toBe("artifact-1");
      // No attempt runs unclaimed: the marker must already be durable when the
      // counted supervisor turn executes.
      expect(markerSeenAtTurn).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("consolidation success reconciles the claim without consuming budget", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-stall-consol-"));
    const operationId = "CONSOL-CLAIM-OK";
    process.env.AEH_OPERATION_ID = operationId;
    const stateRoot = resolveOperationStateRoot(root);
    try {
      mocks.loadOperation.mockResolvedValue(operationRecord(operationId));
      mocks.patchOperation.mockImplementation(async (_r: string, _o: string, patch: Record<string, unknown>) => ({
        ...operationRecord(operationId),
        ...patch,
      }));
      mocks.provenanceForAgent.mockResolvedValue({
        status: "BOUND",
        participantId: "participant-1",
        candidate: { identityDigest: "d1" },
        executionBinding: { digest: "b1" },
        provenanceDigest: "b1",
      });
      mocks.executeAgentPrompt.mockResolvedValue(okTurnSession("turn-1"));
      mocks.persistConsolidation.mockResolvedValue("artifact-1");
      await consolidateWithOperationSupervisor(root, {} as never, contract, supervisorSelection, {
        key: "k1",
        purpose: "test",
        findings: [finding],
      });
      await expect(fs.stat(stallRetryPendingFile(stateRoot, operationId, "consolidation"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await loadStallRetryStalls(stateRoot, operationId, "consolidation")).toBe(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
