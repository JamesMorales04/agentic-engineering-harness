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
import { awaitReviewerRunWithPermissionWatch, classifyReviewerTurnOutcome, reviewerPermissionWaitEvidence, reviewerPermissionWaitMs } from "../src/agents/reviewLifecycle.js";
import { earliestTrackedPendingStartMs, hasTrackedPendingPrompt, runPaseoSdkAgentWithClient } from "../src/paseo/sdk.js";
import * as paseoSdk from "../src/paseo/sdk.js";
import { effectivePaseoTurnTimeoutMs } from "../src/paseo/launchSpec.js";
import { classifyParticipantStall, evaluateOperationWake, operationLivenessPolicy } from "../src/operations/livenessV2.js";
import type { OperationRecordV2 } from "../src/operations/state.js";

const baseConfig = { version: 1, project: { name: "test" } } as never;

// R7: matcher for production __test-hook exports. Must catch multiline forms
// (e.g. `export {\n  __testHook,\n}`), which a single-line regex misses.
// Comments are stripped first so commented-out seams do not false-positive.
function hasTestHookExport(source: string): boolean {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  return (
    /export\s+(?:const|let|var|function|async\s+function|class|abstract\s+class|enum|interface|type)\s+__test/.test(
      stripped,
    ) || /export\s*\{[^}]*__test/.test(stripped)
  );
}

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

  it("(R3-i) IN-FLIGHT: 6-min-old pending prompt interrupts mid-wait at the 5-min timer, not the 15-min deadline", async () => {
    const permissionTimeout = permissionWaitTimeoutMs(baseConfig);
    const reviewerDeadline = reviewerTurnDeadlineMs(baseConfig);
    expect(permissionTimeout).toBe(5 * 60_000);
    // In-flight run that never settles (approval wait hangs the provider
    // turn); the pending prompt went pending 6 min ago — older than the
    // short timer — so the watchdog must fire immediately mid-wait instead
    // of riding the 15-min reviewer deadline.
    let settled = false;
    const hangingRun = new Promise<string>(() => {});
    void hangingRun.then(() => { settled = false; }, () => { settled = false; });
    const startedAt = Date.now();
    const result = await awaitReviewerRunWithPermissionWatch(hangingRun, {
      permissionTimeoutMs: permissionTimeout,
      isPending: () => true,
      pendingStartedAtMs: Date.now() - 6 * 60_000,
      pollMs: 10,
    });
    const wallMs = Date.now() - startedAt;
    expect(settled).toBe(false);
    expect(result.kind).toBe("permission-wait-exhausted");
    if (result.kind === "permission-wait-exhausted") {
      expect(result.pendingWaitMs).toBeGreaterThanOrEqual(6 * 60_000);
    }
    // Fired mid-wait on the pending-start watch, far short of the reviewer deadline.
    expect(wallMs).toBeLessThan(reviewerDeadline);
    expect(wallMs).toBeLessThan(permissionTimeout);
  });

  it("(R3-ii) IN-FLIGHT: clean turn past the short timer is never cut (no pending prompt, no arm)", async () => {
    // Clean reviewer turn: no approval prompt ever pending. Even with a tiny
    // short timer (far below the 6-min production magnitude asserted via
    // elapsedMs), the watch must stay disarmed and the run settles normally.
    const run = new Promise<string>((resolve) => setTimeout(() => resolve("review-evidence"), 60));
    const result = await awaitReviewerRunWithPermissionWatch(run, {
      permissionTimeoutMs: 20,
      isPending: () => false,
      pollMs: 5,
    });
    expect(result).toEqual({ kind: "settled", value: "review-evidence" });
  });

  it("(R3-iii) IN-FLIGHT: prompt clearing before the timer disarms the watch", async () => {
    // Pending at first, then cleared (grant/deny/resume) before the short
    // timer: the run settles normally instead of exhausting.
    const flapEnd = Date.now() + 30;
    const run = new Promise<string>((resolve) => setTimeout(() => resolve("late-evidence"), 120));
    const result = await awaitReviewerRunWithPermissionWatch(run, {
      permissionTimeoutMs: 200,
      isPending: () => Date.now() < flapEnd,
      pollMs: 5,
    });
    expect(result).toEqual({ kind: "settled", value: "late-evidence" });
  });

  it("(R3-iv) IN-FLIGHT: fresh mid-turn pending fires on elapsed-since-pending-start", async () => {
    // Prompt goes pending mid-turn with no externally observed start: the
    // watch stamps first-seen pending and fires one short-timer later —
    // proving the watchdog runs on pending-start, not whole-turn elapsed.
    const hangingRun = new Promise<string>(() => {});
    const startedAt = Date.now();
    const result = await awaitReviewerRunWithPermissionWatch(hangingRun, {
      permissionTimeoutMs: 80,
      isPending: () => true,
      pollMs: 5,
    });
    const wallMs = Date.now() - startedAt;
    expect(result.kind).toBe("permission-wait-exhausted");
    if (result.kind === "permission-wait-exhausted") {
      expect(result.pendingWaitMs).toBeGreaterThanOrEqual(80);
    }
    expect(wallMs).toBeLessThan(5_000);
  });

  it("(R4-i) REGRESSION: pending held through the SDK run() path is stamped at first-seen, not conversion", async () => {
    // The atomic run() path previously never called notePendingStart, so a
    // prompt pending for the whole run measured ~0ms at conversion. The
    // pending entry carries no provider waitStartedAt marker: the ONLY
    // source of the marker is the mid-run poll capture.
    const pending = [{ name: "shell", input: {}, id: "pending-1" }];
    const handle = {
      id: "agent-sdk-run-pending",
      pendingPermissions: pending,
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { status: "failed", final: { pendingPermissions: pending } };
      },
    };
    const client = { agents: { ref: () => handle } };
    const result = await runPaseoSdkAgentWithClient(client as never, "agent-sdk-run-pending", "work", 10_000, undefined, undefined, { firstActivityMs: 5_000, pollMs: 10 });
    const marker = result.permission?.waitStartedAt;
    expect(marker).toBeDefined();
    const ageMs = Date.now() - Date.parse(marker!);
    // First-seen at run start (~150ms before conversion), not ~0ms.
    expect(ageMs).toBeGreaterThanOrEqual(100);
    // Terminal settlement clears the handle marker (clear-on-settle).
    expect(hasTrackedPendingPrompt()).toBe(false);
  });

  it("(R4-ii) REGRESSION: prompt appearing AFTER first activity is still captured on the waitForFinish path", async () => {
    // The waitForFinish poll previously stopped after first activity, so a
    // later-appearing prompt missed capture (marker ~0ms/absent). Timeline
    // grows early (activity observed), the prompt flips pending afterwards.
    const pending = [{ name: "shell", input: {}, id: "pending-2" }];
    const startedAt = Date.now();
    const handle = {
      id: "agent-sdk-late-pending",
      pendingPermissions: [] as unknown[],
      send: async () => undefined,
      waitForFinish: async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return { status: "failed", final: { pendingPermissions: pending } };
      },
      timeline: {
        refetch: async () => ({
          entries: Date.now() - startedAt >= 30
            ? [{ item: { type: "tool_call", status: "running", callId: "late-activity-1", name: "read", detail: { type: "read" } } }]
            : [],
        }),
      },
    };
    const client = { agents: { ref: () => handle } };
    setTimeout(() => { handle.pendingPermissions = pending as unknown[]; }, 60);
    const result = await runPaseoSdkAgentWithClient(client as never, "agent-sdk-late-pending", "work", 10_000, undefined, undefined, { firstActivityMs: 5_000, pollMs: 10 });
    const marker = result.permission?.waitStartedAt;
    expect(marker).toBeDefined();
    const ageMs = Date.now() - Date.parse(marker!);
    // First-seen at the ~60ms flip, well before the ~250ms conversion.
    expect(ageMs).toBeGreaterThanOrEqual(100);
    // Terminal settlement clears the handle marker (clear-on-settle).
    expect(hasTrackedPendingPrompt()).toBe(false);
  });

  it("(R4-iii) WIRING: live SDK pending signal + 6-min-old start takes the exhaustion path, cleared signal settles", async () => {
    // Production wiring: runReviewer arms the watchdog with
    // isPending: () => hasTrackedPendingPrompt() and the tracked earliest
    // start. The live tracker is armed here through the public SDK run path
    // (a hanging pending turn holds first-seen state mid-run), never through
    // a hook: a genuinely pending prompt (6-min-old start) must exhaust
    // mid-wait; once the live turn settles the marker clears and a clean
    // signal settles normally.
    let releasePending!: (turn: unknown) => void;
    const gate = new Promise<unknown>((resolve) => { releasePending = resolve; });
    const pending = [{ name: "shell", input: {}, id: "pending-3" }];
    const liveHandle = {
      id: "agent-sdk-live-pending",
      pendingPermissions: pending,
      run: () => gate,
    };
    const liveClient = { agents: { ref: () => liveHandle } };
    const liveRun = runPaseoSdkAgentWithClient(liveClient as never, "agent-sdk-live-pending", "work", 10_000, undefined, undefined, { firstActivityMs: 5_000, pollMs: 5 });
    try {
      // Wait until the mid-run poll observes the pending prompt (first-seen stamp).
      const armDeadline = Date.now() + 2_000;
      while (!hasTrackedPendingPrompt() && Date.now() < armDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(hasTrackedPendingPrompt()).toBe(true);
      const hangingRun = new Promise<string>(() => {});
      const exhausted = await awaitReviewerRunWithPermissionWatch(hangingRun, {
        permissionTimeoutMs: permissionWaitTimeoutMs(baseConfig),
        isPending: () => hasTrackedPendingPrompt(),
        pendingStartedAtMs: Date.now() - 6 * 60_000,
        pollMs: 5,
      });
      expect(exhausted.kind).toBe("permission-wait-exhausted");
      if (exhausted.kind === "permission-wait-exhausted") {
        expect(exhausted.pendingWaitMs).toBeGreaterThanOrEqual(6 * 60_000);
      }
    } finally {
      releasePending({ status: "failed", final: { pendingPermissions: pending } });
    }
    // Settling the live pending turn consumes the marker AND clears it
    // (clear-on-settle): no stale state survives into the clean run below.
    const liveResult = await liveRun;
    expect(liveResult.permission?.waitStartedAt).toBeDefined();
    expect(hasTrackedPendingPrompt()).toBe(false);
    expect(earliestTrackedPendingStartMs()).toBeUndefined();
    const cleanRun = new Promise<string>((resolve) => setTimeout(() => resolve("review-evidence"), 20));
    const settled = await awaitReviewerRunWithPermissionWatch(cleanRun, {
      permissionTimeoutMs: 20,
      isPending: () => hasTrackedPendingPrompt(),
      pendingStartedAtMs: earliestTrackedPendingStartMs(),
      pollMs: 5,
    });
    expect(settled).toEqual({ kind: "settled", value: "review-evidence" });
  });

  it("(R5-i) REGRESSION: settled pending turn clears the marker — immediate clean run must NOT exhaust", async () => {
    // P1: a settled 6-min marker previously remained tracked, so a LATER
    // clean reviewer run immediately returned permission-wait-exhausted
    // (marker came through correctly, then contaminated the next run).
    const pending = [{ name: "shell", input: {}, id: "pending-r5i", waitStartedAt: new Date(Date.now() - 6 * 60_000).toISOString() }];
    const handle = {
      id: "agent-sdk-settled-pending",
      pendingPermissions: pending,
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return { status: "failed", final: { pendingPermissions: pending } };
      },
    };
    const client = { agents: { ref: () => handle } };
    const settledTurn = await runPaseoSdkAgentWithClient(client as never, "agent-sdk-settled-pending", "work", 10_000, undefined, undefined, { firstActivityMs: 5_000, pollMs: 5 });
    const marker = settledTurn.permission?.waitStartedAt;
    expect(marker).toBeDefined();
    // The provider-stamped 6-min prompt age comes through correctly.
    expect(Date.now() - Date.parse(marker!)).toBeGreaterThanOrEqual(6 * 60_000);
    // Terminal settlement cleared the handle: no live pending survives.
    // (Fails pre-fix: the settled marker stays tracked.)
    expect(hasTrackedPendingPrompt()).toBe(false);
    expect(earliestTrackedPendingStartMs()).toBeUndefined();
    // The immediate clean reviewer run must settle, not exhaust (fails pre-fix).
    const cleanRun = new Promise<string>((resolve) => setTimeout(() => resolve("review-evidence"), 20));
    const watched = await awaitReviewerRunWithPermissionWatch(cleanRun, {
      permissionTimeoutMs: 20,
      isPending: () => hasTrackedPendingPrompt(),
      pendingStartedAtMs: earliestTrackedPendingStartMs(),
      pollMs: 5,
    });
    expect(watched).toEqual({ kind: "settled", value: "review-evidence" });
  });

  it("(R5-ii) REGRESSION: handle A pending never arms handle B — per-handle isolation", async () => {
    // P1 cross-handle: while handle A holds a live pending prompt, a clean
    // turn on handle B must convert without any permission marker (tracking
    // is keyed per handle — B must neither observe nor disturb A's marker),
    // and settling A afterwards must clear the global signal entirely.
    let releaseA!: (turn: unknown) => void;
    const gateA = new Promise<unknown>((resolve) => { releaseA = resolve; });
    const pendingA = [{ name: "shell", input: {}, id: "pending-r5ii-a" }];
    const handleA = { id: "agent-sdk-handle-a", pendingPermissions: pendingA, run: () => gateA };
    const clientA = { agents: { ref: () => handleA } };
    const runA = runPaseoSdkAgentWithClient(clientA as never, "agent-sdk-handle-a", "work", 10_000, undefined, undefined, { firstActivityMs: 5_000, pollMs: 5 });
    try {
      const armDeadline = Date.now() + 2_000;
      while (!hasTrackedPendingPrompt() && Date.now() < armDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(hasTrackedPendingPrompt()).toBe(true);
      // Clean turn on a DIFFERENT handle while A is still pending.
      const handleB = {
        id: "agent-sdk-handle-b",
        pendingPermissions: [] as unknown[],
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return { status: "completed", lastMessage: "clean-evidence", final: {} };
        },
      };
      const clientB = { agents: { ref: () => handleB } };
      const resultB = await runPaseoSdkAgentWithClient(clientB as never, "agent-sdk-handle-b", "work", 10_000, undefined, undefined, { firstActivityMs: 5_000, pollMs: 5 });
      expect(resultB.status).toBe("completed");
      expect(resultB.permission).toBeUndefined();
      // B's settle disturbed nothing: A is still the live pending handle.
      expect(hasTrackedPendingPrompt()).toBe(true);
    } finally {
      releaseA({ status: "failed", final: { pendingPermissions: pendingA } });
    }
    const resultA = await runA;
    expect(resultA.permission?.waitStartedAt).toBeDefined();
    expect(hasTrackedPendingPrompt()).toBe(false);
    expect(earliestTrackedPendingStartMs()).toBeUndefined();
  });

  it("(R6-i) REGRESSION: rejected second stop still clears the marker — stalled run, first stop ok", async () => {
    // P1: the stalled run() path stops the handle inside
    // runWithFirstActivityWatch, then attempts ANOTHER stop before the
    // stall early-return clears the marker. When the second stop rejects,
    // the call must still drop the tracked pending marker instead of
    // rejecting with the marker armed for later clean reviewers.
    const pending = [{ name: "shell", input: {}, id: "pending-r6i" }];
    let stops = 0;
    const handle = {
      id: "agent-sdk-stall-stop-rejects",
      pendingPermissions: pending,
      cancel: async () => {
        stops += 1;
        if (stops > 1) throw new Error("cancel already settled");
      },
      run: () => new Promise<unknown>(() => {}),
    };
    const client = { agents: { ref: () => handle } };
    await expect(
      runPaseoSdkAgentWithClient(client as never, "agent-sdk-stall-stop-rejects", "work", 10_000, undefined, undefined, { firstActivityMs: 60, pollMs: 5 })
    ).rejects.toThrow("cancel already settled");
    expect(stops).toBe(2);
    // Fails pre-fix: the rejected second stop skips the clear.
    expect(hasTrackedPendingPrompt()).toBe(false);
    expect(earliestTrackedPendingStartMs()).toBeUndefined();
  });

  it("(R5-iii) BUILD HYGIENE: production SDK module exposes no __test hooks", () => {
    // P2: test seams must not ship in production exports (or the build).
    const leaked = Object.keys(paseoSdk).filter((key) => key.startsWith("__test"));
    expect(leaked).toEqual([]);
  });

  it("(R6-ii) BUILD HYGIENE: no production module under src/ exposes __test hooks", async () => {
    // P2 widened: the native.ts seam survived because the assertion checked
    // only the sdk module object. Grep every production source file instead.
    // R7: the matcher must also catch multiline export forms.
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { join } = await import("node:path");
    const srcRoot = fileURLToPath(new URL("../src/", import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!full.endsWith(".ts")) continue;
        if (hasTestHookExport(readFileSync(full, "utf8"))) offenders.push(full);
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });

  it("(R7) BUILD HYGIENE matcher catches single-line and multiline __test exports", () => {
    expect(hasTestHookExport(`export const __testHook = 1;`)).toBe(true);
    expect(hasTestHookExport(`export function __testHook() {}`)).toBe(true);
    expect(hasTestHookExport(`export {\n  __testHook,\n};`)).toBe(true);
    expect(hasTestHookExport(`export\nconst __testHook = 1;`)).toBe(true);
    expect(hasTestHookExport(`export const hook = 1;\nexport function helper() {}`)).toBe(false);
    expect(hasTestHookExport(`// export const __testHook = 1;\nexport const hook = 1;`)).toBe(false);
    expect(hasTestHookExport(`/* export {\n  __testHook,\n} */\nexport const hook = 1;`)).toBe(false);
  });

  it("(P1b) recent heartbeat + expired lease is NOT stalled", () => {    const now = Date.now();
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
