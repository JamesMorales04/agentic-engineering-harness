import { describe, expect, it } from "vitest";
import {
  classifyTurnOutcome,
  participantTurnDeadlineMs,
  permissionWaitTimeoutMs,
  reviewerTurnDeadlineMs,
} from "../src/workers/agentPrompt.js";
import { classifyParticipantStall, evaluateOperationWake, operationLivenessPolicy } from "../src/operations/livenessV2.js";
import type { OperationRecordV2 } from "../src/operations/state.js";

const baseConfig = { version: 1, project: { name: "test" } } as never;

function operationWith(participants: OperationRecordV2["participants"]): OperationRecordV2 {
  const now = new Date().toISOString();
  return {
    version: 2,
    id: "LIVE-TURN-BOUNDS",
    kind: "change",
    status: "RUNNING",
    phase: "working",
    root: "/tmp",
    payload: { request: "x" },
    revision: 1,
    createdAt: now,
    updatedAt: now,
    lastProgressAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    supervision: { required: false, materialized: false, generations: [] },
    stages: {},
    participants,
    progress: { expected: 2, registered: 2, running: 2, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 },
  } as OperationRecordV2;
}

function participant(id: string, lastActivityAt: string) {
  return {
    id,
    status: "RUNNING",
    startedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    registeredAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    executionLiveness: {
      state: "ACTIVE",
      startedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      lastActivityAt,
      lastMeaningfulProgressAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      providerTurns: 1,
      currentProviderTurnBudget: 8,
    },
  } as never;
}

describe("live turn bounds (FAM-LIVE gaps 1,2,3,5)", () => {
  it("(a) fake steady-output reviewer exceeding reviewer deadline yields TURN_DEADLINE_EXCEEDED", () => {
    const deadline = reviewerTurnDeadlineMs(baseConfig);
    expect(deadline).toBe(15 * 60_000);
    expect(participantTurnDeadlineMs(baseConfig)).toBe(30 * 60_000);
    const outcome = classifyTurnOutcome({
      session: { exitCode: 124, status: "timeout", stderr: "timeout after steady output", stdout: "partial tokens", permissionStopDiagnostic: undefined as never },
      elapsedMs: deadline + 1_000,
      deadlineMs: deadline,
      permissionTimeoutMs: permissionWaitTimeoutMs(baseConfig),
    });
    expect(outcome).toBe("TURN_DEADLINE_EXCEEDED");
  });

  it("(b) one stalled + one progressing child wakes for stalled only", () => {
    const now = Date.now();
    const policy = operationLivenessPolicy(baseConfig);
    const stalledAt = new Date(now - policy.stallThresholdMs - 60_000).toISOString();
    const freshAt = new Date(now - 1_000).toISOString();
    expect(classifyParticipantStall({ lastActivityAt: stalledAt }, now, policy.stallThresholdMs)).toBe("STALLED");
    expect(classifyParticipantStall({ lastActivityAt: freshAt }, now, policy.stallThresholdMs)).toBe("PROGRESSING");
    const operation = operationWith({
      "stalled-child": participant("stalled-child", stalledAt),
      "busy-child": participant("busy-child", freshAt),
    });
    const decision = evaluateOperationWake(operation, policy, now);
    expect(decision.reason).toBe("stalled");
    expect(decision.message).toContain("stalled-child");
    expect(decision.message).not.toContain("busy-child");
  });

  it("(c) permission-prompt fixture yields PERMISSION_WAIT_EXHAUSTED within the short timer", () => {
    const timeout = permissionWaitTimeoutMs(baseConfig);
    expect(timeout).toBe(5 * 60_000);
    const outcome = classifyTurnOutcome({
      session: { exitCode: 1, status: "permission", stderr: "waiting for approval", stdout: "", permissionStopDiagnostic: { name: "shell", scopeRelation: "outside-roots" } as never },
      elapsedMs: timeout + 500,
      deadlineMs: participantTurnDeadlineMs(baseConfig),
      permissionTimeoutMs: timeout,
    });
    expect(outcome).toBe("PERMISSION_WAIT_EXHAUSTED");
    // Below the short timer the same stop is not yet exhausted.
    const pending = classifyTurnOutcome({
      session: { exitCode: 1, status: "permission", stderr: "waiting for approval", stdout: "", permissionStopDiagnostic: { name: "shell", scopeRelation: "outside-roots" } as never },
      elapsedMs: timeout - 60_000,
      deadlineMs: participantTurnDeadlineMs(baseConfig),
      permissionTimeoutMs: timeout,
    });
    expect(pending).toBe("OTHER");
  });
});
