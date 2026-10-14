import { describe, expect, it } from "vitest";
import {
  classifyTurnOutcome,
  managedTurnDeadlineMs,
  participantTurnDeadlineMs,
  permissionWaitMsForSession,
  permissionWaitTimeoutMs,
  reviewerTurnDeadlineMs,
  workerTurnTerminalDetail,
} from "../src/workers/agentPrompt.js";
import { classifyReviewerTurnOutcome, reviewerPermissionWaitEvidence, reviewerPermissionWaitMs } from "../src/agents/reviewLifecycle.js";
import { effectivePaseoTurnTimeoutMs } from "../src/paseo/launchSpec.js";
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

function participant(id: string, lastActivityAt: string, progressLeaseExpiresAt?: string) {
  const now = Date.now();
  return {
    id,
    status: "RUNNING",
    startedAt: new Date(now - 60 * 60_000).toISOString(),
    registeredAt: new Date(now - 60 * 60_000).toISOString(),
    executionLiveness: {
      state: "ACTIVE",
      startedAt: new Date(now - 60 * 60_000).toISOString(),
      lastActivityAt,
      lastMeaningfulProgressAt: new Date(now - 60 * 60_000).toISOString(),
      providerTurns: 1,
      currentProviderTurnBudget: 8,
      progressLease: {
        version: 1,
        leaseId: `progress-lease:${id}`,
        operationId: "LIVE-TURN-BOUNDS",
        issuedAt: new Date(now - 60 * 60_000).toISOString(),
        expiresAt: progressLeaseExpiresAt ?? new Date(now + 30 * 60_000).toISOString(),
        renewalCount: 0,
      },
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

  it("(P1a) 6-min simulated approval wait yields PERMISSION_WAIT_EXHAUSTED, not reviewer-deadline behavior", () => {
    const now = Date.now();
    const permissionTimeout = permissionWaitTimeoutMs(baseConfig);
    const reviewerDeadline = reviewerTurnDeadlineMs(baseConfig);
    // Provider-reported wait-start evidence: the prompt appeared 6 min ago.
    const session = {
      exitCode: 1,
      status: "permission",
      stderr: "waiting for approval",
      stdout: "",
      finishedAt: new Date(now).toISOString(),
      permissionStopDiagnostic: { scopeRelation: "OUTSIDE" },
      permissionWaitStartedAt: new Date(now - 6 * 60_000).toISOString(),
    } as never;
    const elapsedMs = 6 * 60_000 + 5_000;
    expect(elapsedMs).toBeLessThan(reviewerDeadline);
    expect(permissionWaitMsForSession(session, elapsedMs)).toBeGreaterThanOrEqual(6 * 60_000);
    expect(reviewerPermissionWaitMs(session, elapsedMs)).toBeGreaterThanOrEqual(6 * 60_000);
    expect(classifyReviewerTurnOutcome(session, elapsedMs, reviewerDeadline, permissionTimeout)).toBe("PERMISSION_WAIT_EXHAUSTED");
    expect(classifyTurnOutcome({ session, elapsedMs, deadlineMs: reviewerDeadline, permissionTimeoutMs: permissionTimeout })).toBe("PERMISSION_WAIT_EXHAUSTED");
  });

  it("(P1a) brief late-turn prompt is classified by wait duration, not whole-turn elapsed", () => {
    const now = Date.now();
    const permissionTimeout = permissionWaitTimeoutMs(baseConfig);
    const reviewerDeadline = reviewerTurnDeadlineMs(baseConfig);
    // Whole turn ran 16 min (past the reviewer deadline) but the approval
    // prompt appeared only 2 min before settlement: this is a turn-deadline
    // kill, not an exhausted permission wait.
    const session = {
      exitCode: 124,
      status: "permission",
      stderr: "timed out after steady output; waiting for approval",
      stdout: "",
      finishedAt: new Date(now).toISOString(),
      permissionStopDiagnostic: { scopeRelation: "OUTSIDE" },
      permissionWaitStartedAt: new Date(now - 2 * 60_000).toISOString(),
    } as never;
    const elapsedMs = 16 * 60_000;
    expect(classifyReviewerTurnOutcome(session, elapsedMs, reviewerDeadline, permissionTimeout)).toBe("TURN_DEADLINE_EXCEEDED");
    expect(classifyTurnOutcome({ session, elapsedMs, deadlineMs: reviewerDeadline, permissionTimeoutMs: permissionTimeout })).toBe("TURN_DEADLINE_EXCEEDED");
  });

  it("(R2-i) 6-min approval wait WITH pending prompt (gate evidence) exhausts the short timer while fenced", () => {
    const now = Date.now();
    const permissionTimeout = permissionWaitTimeoutMs(baseConfig);
    const reviewerDeadline = reviewerTurnDeadlineMs(baseConfig);
    // Production-shaped session: the permission-gate producer stamped the
    // pending-observed marker 6 min ago; the settled session is the actual
    // fenced provider session (real session id, BLOCKED fail-closed).
    const session = {
      id: "paseo-review-1",
      exitCode: 1,
      status: "permission",
      stderr: "waiting for approval",
      stdout: "",
      finishedAt: new Date(now).toISOString(),
      permissionStopDiagnostic: {
        name: "shell",
        scopeRelation: "OUTSIDE",
        sessionId: "paseo-review-1",
        waitStartedAt: new Date(now - 6 * 60_000).toISOString(),
      },
    } as never;
    const elapsedMs = 6 * 60_000 + 5_000;
    expect(elapsedMs).toBeLessThan(reviewerDeadline);
    const evidence = reviewerPermissionWaitEvidence(session, elapsedMs);
    expect(evidence.source).toBe("evidence");
    expect(evidence.waitMs).toBeGreaterThanOrEqual(6 * 60_000);
    expect(reviewerPermissionWaitMs(session, elapsedMs)).toBeGreaterThanOrEqual(6 * 60_000);
    expect(classifyReviewerTurnOutcome(session, elapsedMs, reviewerDeadline, permissionTimeout)).toBe("PERMISSION_WAIT_EXHAUSTED");
  });

  it("(R2-ii) 6-min reviewer turn with NO pending prompt is never cut at 5 min", () => {
    const permissionTimeout = permissionWaitTimeoutMs(baseConfig);
    const reviewerDeadline = reviewerTurnDeadlineMs(baseConfig);
    // Steady-output reviewer turn, 6 min elapsed (past the short timer) but
    // no approval prompt pending: the short timer must not fire — only the
    // 15-min reviewer deadline applies.
    const session = {
      exitCode: 0,
      status: "finished",
      stderr: "",
      stdout: "review evidence",
      finishedAt: new Date().toISOString(),
    } as never;
    const elapsedMs = 6 * 60_000;
    expect(elapsedMs).toBeGreaterThan(permissionTimeout);
    expect(elapsedMs).toBeLessThan(reviewerDeadline);
    expect(reviewerPermissionWaitEvidence(session, elapsedMs).source).toBe("fallback");
    expect(classifyReviewerTurnOutcome(session, elapsedMs, reviewerDeadline, permissionTimeout)).toBe("OTHER");
    // Same guarantee via the shared worker classifier: a non-permission stop
    // past the short timer is not an exhausted wait.
    expect(classifyTurnOutcome({ session, elapsedMs, deadlineMs: reviewerDeadline, permissionTimeoutMs: permissionTimeout })).toBe("OTHER");
  });

  it("(R2-iii) classifier uses gate wait-start evidence, not whole-turn elapsed", () => {
    const now = Date.now();
    const permissionTimeout = permissionWaitTimeoutMs(baseConfig);
    const reviewerDeadline = reviewerTurnDeadlineMs(baseConfig);
    // Whole turn ran 16 min (past the reviewer deadline) but the gate
    // marker shows the prompt went pending only 2 min before settlement:
    // this is a turn-deadline kill, not an exhausted permission wait.
    const session = {
      exitCode: 124,
      status: "permission",
      stderr: "timed out after steady output; waiting for approval",
      stdout: "",
      finishedAt: new Date(now).toISOString(),
      permissionStopDiagnostic: {
        name: "shell",
        scopeRelation: "OUTSIDE",
        waitStartedAt: new Date(now - 2 * 60_000).toISOString(),
      },
    } as never;
    const elapsedMs = 16 * 60_000;
    const evidence = reviewerPermissionWaitEvidence(session, elapsedMs);
    expect(evidence.source).toBe("evidence");
    expect(evidence.waitMs).toBeLessThan(permissionTimeout);
    expect(reviewerPermissionWaitMs(session, elapsedMs)).toBeLessThan(permissionTimeout);
    expect(classifyReviewerTurnOutcome(session, elapsedMs, reviewerDeadline, permissionTimeout)).toBe("TURN_DEADLINE_EXCEEDED");
  });

  it("(P1b) recent heartbeat + expired lease is NOT stalled", () => {
    const now = Date.now();
    const policy = operationLivenessPolicy(baseConfig);
    const freshAt = new Date(now - 1_000).toISOString();
    const expiredLeaseAt = new Date(now - 60_000).toISOString();
    const operation = operationWith({
      "heartbeat-child": participant("heartbeat-child", freshAt, expiredLeaseAt),
    });
    operation.lastProgressAt = freshAt;
    const decision = evaluateOperationWake(operation, policy, now);
    expect(decision.reason).not.toBe("stalled");
    expect(decision.target).toBe("none");
  });

  it("(P2a) lowered participant key shortens the managed turn bound", () => {
    const config = {
      version: 1,
      project: { name: "test" },
      orchestration: { operations: { liveness: { providerTurnDeadlineMs: 30 * 60_000, participantTurnDeadlineMs: 5 * 60_000 } } },
    } as never;
    // Explicit managed bound wins over the provider default/ceiling.
    expect(participantTurnDeadlineMs(config)).toBe(5 * 60_000);
    expect(managedTurnDeadlineMs(config, {})).toBe(5 * 60_000);
    expect(managedTurnDeadlineMs(config, { phase: "work" })).toBe(5 * 60_000);
    // Provider deadline remains the ceiling/fallback: a tighter explicit
    // provider value still caps, and an explicit participant value threads.
    expect(managedTurnDeadlineMs(config, { providerTurnDeadlineMs: 2 * 60_000 })).toBe(2 * 60_000);
    expect(managedTurnDeadlineMs(config, { participantTurnDeadlineMs: 10 * 60_000 })).toBe(10 * 60_000);
    // launchSpec prefers the managed bound the same way.
    expect(effectivePaseoTurnTimeoutMs({}, config, undefined, "work")).toBe(5 * 60_000);
    expect(effectivePaseoTurnTimeoutMs({ providerTurnDeadlineMs: 30 * 60_000 }, config, undefined, "work")).toBe(5 * 60_000);
    // Reviewer override stays the effective bound for review phase.
    const reviewConfig = {
      version: 1,
      project: { name: "test" },
      orchestration: { operations: { liveness: { providerTurnDeadlineMs: 30 * 60_000, reviewerTurnDeadlineMs: 15 * 60_000 } } },
    } as never;
    expect(managedTurnDeadlineMs(reviewConfig, { phase: "review" })).toBe(15 * 60_000);
    expect(effectivePaseoTurnTimeoutMs({}, reviewConfig, undefined, "review")).toBe(15 * 60_000);
  });

  it("(P2b) timed-out worker turn maps to the typed TURN_DEADLINE_EXCEEDED terminal", () => {
    const deadline = participantTurnDeadlineMs(baseConfig);
    const permissionTimeout = permissionWaitTimeoutMs(baseConfig);
    const detail = workerTurnTerminalDetail({
      session: { exitCode: 124, status: "timeout", stderr: "timeout after steady output", stdout: "partial tokens" },
      elapsedMs: deadline + 1_000,
      deadlineMs: deadline,
      permissionTimeoutMs: permissionTimeout,
    });
    expect(detail).toContain("TURN_DEADLINE_EXCEEDED");
    expect(detail).toContain(`deadlineMs=${deadline}`);
    // A settled turn within bounds maps to no typed terminal.
    expect(workerTurnTerminalDetail({
      session: { exitCode: 124, status: "timeout", stderr: "timeout", stdout: "" },
      elapsedMs: 1_000,
      deadlineMs: deadline,
      permissionTimeoutMs: permissionTimeout,
    })).toBeUndefined();
  });
});
