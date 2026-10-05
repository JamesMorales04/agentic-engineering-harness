import { describe, expect, it } from "vitest";
import {
  ControlCenterJourneyFixture,
  type ReleaseRecord,
} from "./fixture/controlCenterJourney.js";

/**
 * RED->GREEN for the genuine QUEUED polling race:
 * `operation start` persists QUEUED/dispatched and returns before the detached
 * controller flips to RUNNING, so the first polls can observe transient QUEUED.
 * Before the fix both pollers treated QUEUED as terminal/failure
 * (waitForProductChoice threw on any non-RUNNING; waitForPhase threw on any
 * non-RUNNING/non-CANCELLED). The fix tolerates QUEUED as non-terminal while
 * keeping fail-closed terminals and timeouts intact.
 */

function fixtureWithLoadSequence(records: ReleaseRecord[]): {
  fixture: ControlCenterJourneyFixture;
  calls: () => number;
} {
  const fixture = Object.create(
    ControlCenterJourneyFixture.prototype,
  ) as ControlCenterJourneyFixture;
  (fixture as unknown as Record<string, unknown>).consumerRoot =
    "/tmp/fake-consumer";
  let calls = 0;
  (fixture as unknown as Record<string, unknown>).api = async () => ({
    state: {
      loadOperation: async () => {
        const record = records[Math.min(calls, records.length - 1)];
        calls += 1;
        return record;
      },
    },
  });
  return { fixture, calls: () => calls };
}

function fixtureWithReadSequence(
  records: ReleaseRecord[],
): ControlCenterJourneyFixture {
  const { fixture } = fixtureWithLoadSequence(records);
  (fixture as unknown as Record<string, unknown>).durableCache = {
    operationId: "OP-1",
    choiceId: "choice-1",
    choiceLabel: "Choice 1",
    requestId: "request:fake",
    candidateId: "candidate:OP-1:r1",
    candidateRevision: 1,
    candidateDigest: "digest",
    policyDigest: "policy",
    controllerEpoch: 1,
    operationExecutionRevision: 1,
  };
  let calls = 0;
  (fixture as unknown as Record<string, unknown>).readOperation = async () => {
    const record = records[Math.min(calls, records.length - 1)];
    calls += 1;
    return record;
  };
  return fixture;
}

const queued = (extra: Record<string, unknown> = {}): ReleaseRecord =>
  ({ status: "QUEUED", phase: "queued", ...extra }) as ReleaseRecord;

const runningHumanRequired = (requestId: string): ReleaseRecord =>
  ({
    status: "RUNNING",
    phase: "HUMAN_REQUIRED",
    decisionRequest: { requestId },
  }) as ReleaseRecord;

describe("browser fixture QUEUED polling tolerance (genuine race)", () => {
  it("waitForProductChoice tolerates transient QUEUED then returns the suspension", async () => {
    const { fixture, calls } = fixtureWithLoadSequence([
      queued(),
      queued(),
      runningHumanRequired("request:second"),
    ]);
    const record = await fixture.waitForProductChoice("OP-1", undefined, 5_000);
    expect(record.status).toBe("RUNNING");
    expect(record.phase).toBe("HUMAN_REQUIRED");
    expect(calls()).toBeGreaterThanOrEqual(3);
  });

  it("waitForProductChoice still fails closed on terminal SUCCEEDED (no weakening)", async () => {
    const { fixture } = fixtureWithLoadSequence([
      { status: "SUCCEEDED", phase: "finished" } as ReleaseRecord,
    ]);
    await expect(
      fixture.waitForProductChoice("OP-1", undefined, 5_000),
    ).rejects.toThrow("reached SUCCEEDED");
  });

  it("waitForProductChoice still times out on stuck QUEUED (timeout intact)", async () => {
    const { fixture } = fixtureWithLoadSequence([queued()]);
    await expect(
      fixture.waitForProductChoice("OP-1", undefined, 600),
    ).rejects.toThrow("timed out");
  });

  it("waitForPhase tolerates transient QUEUED then satisfies the predicate", async () => {
    const fixture = fixtureWithReadSequence([
      queued(),
      { status: "RUNNING", phase: "working" } as ReleaseRecord,
      { status: "RUNNING", phase: "HUMAN_REQUIRED" } as ReleaseRecord,
    ]);
    const record = await fixture.waitForPhase(
      (entry) => entry.phase === "HUMAN_REQUIRED",
      5_000,
      "human suspension",
    );
    expect(record.phase).toBe("HUMAN_REQUIRED");
  });

  it("waitForPhase still fails closed on terminal FAILED (no weakening)", async () => {
    const fixture = fixtureWithReadSequence([
      { status: "FAILED", phase: "failed", error: "boom" } as ReleaseRecord,
    ]);
    await expect(
      fixture.waitForPhase(() => false, 5_000, "never"),
    ).rejects.toThrow("reached FAILED");
  });

  it("waitForPhase still times out on stuck QUEUED (timeout intact)", async () => {
    const fixture = fixtureWithReadSequence([queued()]);
    await expect(
      fixture.waitForPhase(() => false, 600, "never"),
    ).rejects.toThrow("timed out");
  });

  it("waitForPhase preserves CANCELLED tolerance for cancellation predicates", async () => {
    const fixture = fixtureWithReadSequence([
      queued(),
      { status: "CANCELLED", phase: "cancelled" } as ReleaseRecord,
    ]);
    const record = await fixture.waitForPhase(
      (entry) => entry.status === "CANCELLED",
      5_000,
      "cancellation",
    );
    expect(record.status).toBe("CANCELLED");
  });
});
