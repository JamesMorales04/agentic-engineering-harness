import { beforeEach, describe, expect, it, vi } from "vitest";
import { objectiveParticipantAccountingV1 } from "../src/core/run.js";
import { sha256Canonical } from "../src/core/digest.js";
import { createCandidateRevisionV1, type CandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import type { OperationRecordV2 } from "../src/operations/state.js";
import { DirectWorkerExecutor } from "../src/workers/direct.js";
import { PaseoWorkerExecutor } from "../src/workers/paseo.js";
import { PodmanWorkerExecutor } from "../src/workers/podman.js";

const mocks = vi.hoisted(() => ({ executeAgentPrompt: vi.fn(), prepareExecutionAuthority: vi.fn() }));
vi.mock("../src/workers/agentPrompt.js", () => ({ executeAgentPrompt: mocks.executeAgentPrompt }));
vi.mock("../src/security/executionLease.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/security/executionLease.js")>()),
  prepareExecutionAuthority: mocks.prepareExecutionAuthority,
}));

const digest = (value: unknown) => sha256Canonical(value);

function candidate(): CandidateRevisionV1 {
  return createCandidateRevisionV1({ operationId: "OP-RETRY", candidateId: "candidate:OP-RETRY:r1", projectId: "project-retry", taskId: "TASK-RETRY", revision: 1, sourceDigest: digest("source-retry") });
}

function operation(current: CandidateRevisionV1, participants: Record<string, unknown>, receipts: Record<string, unknown>): OperationRecordV2 {
  return {
    version: 2,
    id: current.operationId,
    kind: "change",
    status: "RUNNING",
    phase: "repair",
    root: "/tmp/aeh-retry",
    payload: { request: "retry fixture", taskId: current.taskId },
    revision: 5,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastProgressAt: "2026-01-01T00:00:00.000Z",
    supervision: { required: false, materialized: false, generations: [] },
    stages: {},
    participants,
    participantReceipts: receipts,
    progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 },
    candidateRevision: current,
    candidateAssemblyReceipts: {},
    operationExecutionRevision: 1,
  } as unknown as OperationRecordV2;
}

const selection = {
  logicalAgent: "repairer",
  role: "Repairer",
  domains: [],
  runtimeName: "test",
  modelAlias: "test",
  skills: [],
  mcps: [],
  permissions: {},
  outputContract: "implementer",
} as never;
const contract = { task: { id: "TASK-RETRY", title: "retry fixture" }, source: {}, requirements: [] } as never;
const config = {} as never;
const packet = { version: 1, taskId: "TASK-RETRY", attempt: 1, createdAt: "2026-01-01T00:00:00.000Z", failures: [{ id: "validation:retry", category: "validation", message: "focused check failed" }] } as never;
const failedSession = { provider: "test", id: "session-failed-1", participantId: "participant:failed-1", exitCode: 1, stdout: "", stderr: "boom" } as never;

const executors = [
  ["paseo", new PaseoWorkerExecutor()],
  ["direct", new DirectWorkerExecutor()],
  ["podman", new PodmanWorkerExecutor()],
] as const;

describe("AEH-V2-0133 P1 controller retry-spawn path records the retry-parent edge", () => {
  beforeEach(() => {
    mocks.executeAgentPrompt.mockReset();
    mocks.prepareExecutionAuthority.mockReset();
    mocks.prepareExecutionAuthority.mockResolvedValue({ participantId: "participant:retry-new" });
    mocks.executeAgentPrompt.mockImplementation(async (_root: string, _config: unknown, _contract: unknown, _selection: unknown, _prompt: string, options: { parentAgentId?: string }) => ({
      provider: "test",
      id: "session-retry-1",
      participantId: "participant:retry-new",
      exitCode: 0,
      stdout: "",
      stderr: "",
      parentAgentId: options.parentAgentId,
    }));
  });

  for (const [name, executor] of executors) {
    it(`${name} repair() threads the prior failed identity as parentAgentId`, async () => {
      await executor.repair("/tmp/aeh-retry", config, contract, failedSession, packet, selection);
      expect(mocks.executeAgentPrompt).toHaveBeenCalledTimes(1);
      const options = mocks.executeAgentPrompt.mock.calls[0]?.[5] as { parentAgentId?: string };
      expect(options.parentAgentId).toBe("session-failed-1");
    });
  }

  it("omits the edge fail-closed when the prior session carries no identity", async () => {
    await new PaseoWorkerExecutor().repair("/tmp/aeh-retry", config, contract, { provider: "test", exitCode: 1, stdout: "", stderr: "boom" } as never, packet, selection);
    const options = mocks.executeAgentPrompt.mock.calls[0]?.[5] as { parentAgentId?: string };
    expect(options.parentAgentId).toBeUndefined();
  });

  it("the controller-recorded edge feeds the resolver: the failed attempt is superseded", async () => {
    await new PaseoWorkerExecutor().repair("/tmp/aeh-retry", config, contract, failedSession, packet, selection);
    const options = mocks.executeAgentPrompt.mock.calls[0]?.[5] as { parentAgentId?: string };
    expect(options.parentAgentId).toBe("session-failed-1");
    // Mirror the durable writes the controller path performs with that edge: the retry
    // participant record carries parentAgentId and the settled receipt carries
    // parentParticipantId (agentPrompt receipt-writer sites, already threading
    // options.parentAgentId). The failed attempt identity is the prior session id, exactly
    // as updateOperationParticipant keys it on the live path.
    const retryId = "participant:retry-new";
    const current = candidate();
    const baseParticipants = {
      "session-failed-1": { id: "session-failed-1", role: "Repairer", status: "FAILED", registeredAt: "2026-01-01T00:00:00.000Z" },
      [retryId]: { id: retryId, role: "Repairer", status: "COMPLETED", registeredAt: "2026-01-01T00:00:01.000Z" },
    };
    const retryReceipt = {
      receiptId: `receipt:${retryId}`,
      operationId: current.operationId,
      participantId: retryId,
      sessionId: "session-retry-1",
      outcome: "SUCCEEDED",
      settled: true,
      candidate: current,
    };
    // Control: without the retry-parent edge the failed identity still blocks (pre-fix behavior).
    const unlinked = operation(current, baseParticipants, { "receipt:retry": retryReceipt });
    expect(objectiveParticipantAccountingV1(unlinked, current).find((item) => item.id === "session-failed-1")).toEqual({
      id: "session-failed-1",
      required: true,
      status: "FAILED",
    });
    // With the controller-recorded edge, supersede resolves through the real resolver.
    const linked = operation(current, {
      "session-failed-1": baseParticipants["session-failed-1"],
      [retryId]: { ...baseParticipants[retryId], parentAgentId: options.parentAgentId },
    }, {
      "receipt:retry": { ...retryReceipt, parentParticipantId: options.parentAgentId },
    });
    expect(objectiveParticipantAccountingV1(linked, current).find((item) => item.id === "session-failed-1")).toEqual({
      id: "session-failed-1",
      required: true,
      status: "COMPLETED",
      supersededBy: retryId,
    });
  });
});
