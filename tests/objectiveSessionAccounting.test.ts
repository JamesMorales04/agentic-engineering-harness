import { describe, expect, it } from "vitest";
import { createCandidateRevisionV1, type CandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { sha256Canonical } from "../src/core/digest.js";
import { resolveAccountedWorkUnitIds } from "../src/core/run.js";

function candidate(revision: number, digest: string): CandidateRevisionV1 {
  return createCandidateRevisionV1({
    operationId: "OP-ACCT",
    candidateId: `candidate:OP-ACCT:r${revision}`,
    projectId: "project-acct",
    taskId: "TASK-ACCT",
    revision,
    sourceDigest: sha256Canonical(`source-${digest}`)
  });
}

function waveResult(id: string, status: "PASS" | "FAIL", session?: { id?: string; participantId?: string; exitCode: number }) {
  return { task: { id }, status, ...(session ? { session } : {}) };
}

function receipt(sessionId: string | undefined, participantId: string | undefined, candidate: CandidateRevisionV1 | undefined, outcome: "SUCCEEDED" | "FAILED" = "SUCCEEDED") {
  return { sessionId, participantId, candidate, outcome } as const;
}

const current = candidate(2, "cur");

describe("resolveAccountedWorkUnitIds (objective DoD work-unit accounting)", () => {
  it("accounts wave-passed units without receipts", () => {
    const result = resolveAccountedWorkUnitIds(
      ["wu-1", "wu-2"],
      [waveResult("wu-1", "PASS", { id: "s1", exitCode: 0 }), waveResult("wu-2", "PASS", { id: "s2", exitCode: 0 })],
      [],
      current,
      true
    );
    expect(result.accountedWorkUnitIds.sort()).toEqual(["wu-1", "wu-2"]);
    expect(result.sessionAccountedWorkUnitIds).toEqual([]);
  });

  it("accounts a barrier-flaked unit via its current-candidate success receipt once green", () => {
    const result = resolveAccountedWorkUnitIds(
      ["wu-1"],
      [waveResult("wu-1", "FAIL", { id: "s1", participantId: "participant:wu-1", exitCode: 0 })],
      [receipt("s1", "participant:wu-1", current)],
      current,
      true
    );
    expect(result.accountedWorkUnitIds).toEqual(["wu-1"]);
    expect(result.sessionAccountedWorkUnitIds).toEqual(["wu-1"]);
  });

  it("refuses replay: a prior-candidate receipt never credits a rerun unit", () => {
    const stale = candidate(1, "old");
    const result = resolveAccountedWorkUnitIds(
      ["wu-1"],
      [waveResult("wu-1", "FAIL", { id: "s2", participantId: "participant:wu-1", exitCode: 0 })],
      [receipt("s1", "participant:wu-1", stale)],
      current,
      true
    );
    expect(result.accountedWorkUnitIds).toEqual([]);
    expect(result.sessionAccountedWorkUnitIds).toEqual([]);
  });

  it("refuses receipts without a candidate binding", () => {
    const result = resolveAccountedWorkUnitIds(
      ["wu-1"],
      [waveResult("wu-1", "FAIL", { id: "s1", exitCode: 0 })],
      [receipt("s1", "participant:wu-1", undefined)],
      current,
      true
    );
    expect(result.accountedWorkUnitIds).toEqual([]);
  });

  it("does not session-account when the final report is red", () => {
    const result = resolveAccountedWorkUnitIds(
      ["wu-1"],
      [waveResult("wu-1", "FAIL", { id: "s1", exitCode: 0 })],
      [receipt("s1", "participant:wu-1", current)],
      current,
      false
    );
    expect(result.accountedWorkUnitIds).toEqual([]);
  });

  it("ignores failed-outcome receipts (vacuous or crashed work earns no credit)", () => {
    const result = resolveAccountedWorkUnitIds(
      ["wu-1"],
      [waveResult("wu-1", "FAIL", { id: "s1", exitCode: 0 })],
      [receipt("s1", "participant:wu-1", current, "FAILED")],
      current,
      true
    );
    expect(result.accountedWorkUnitIds).toEqual([]);
  });

  it("leaves receipt-less units unaccounted even when green elsewhere", () => {
    const result = resolveAccountedWorkUnitIds(
      ["wu-1", "wu-2"],
      [waveResult("wu-1", "PASS", { id: "s1", exitCode: 0 }), waveResult("wu-2", "FAIL", { id: "s2", exitCode: 1 })],
      [receipt("s1", "participant:wu-1", current)],
      current,
      true
    );
    expect(result.accountedWorkUnitIds).toEqual(["wu-1"]);
  });

  it("leaves undispatched units with no result unaccounted", () => {
    const result = resolveAccountedWorkUnitIds(
      ["wu-1", "wu-2"],
      [waveResult("wu-1", "PASS", { id: "s1", exitCode: 0 })],
      [receipt("s1", "participant:wu-1", current)],
      current,
      true
    );
    expect(result.accountedWorkUnitIds).toEqual(["wu-1"]);
  });
});
