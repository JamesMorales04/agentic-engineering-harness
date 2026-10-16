import { describe, expect, it } from "vitest";
import { resolveAccountedWorkUnitIds } from "../src/core/run.js";

function waveResult(id: string, status: "PASS" | "FAIL", session?: { id?: string; participantId?: string; exitCode: number }) {
  return { task: { id }, status, ...(session ? { session } : {}) };
}

function receipt(sessionId: string | undefined, participantId: string | undefined, outcome: "SUCCEEDED" | "FAILED" = "SUCCEEDED") {
  return { sessionId, participantId, outcome } as const;
}

describe("resolveAccountedWorkUnitIds (objective DoD work-unit accounting)", () => {
  it("accounts wave-passed units without receipts", () => {
    const result = resolveAccountedWorkUnitIds(
      ["wu-1", "wu-2"],
      [waveResult("wu-1", "PASS", { id: "s1", exitCode: 0 }), waveResult("wu-2", "PASS", { id: "s2", exitCode: 0 })],
      [],
      true
    );
    expect(result.accountedWorkUnitIds.sort()).toEqual(["wu-1", "wu-2"]);
    expect(result.sessionAccountedWorkUnitIds).toEqual([]);
  });

  it("accounts a barrier-flaked unit via its success receipt once the final report is green", () => {
    const result = resolveAccountedWorkUnitIds(
      ["wu-1"],
      [waveResult("wu-1", "FAIL", { id: "s1", participantId: "participant:wu-1", exitCode: 0 })],
      [receipt("s1", "participant:wu-1")],
      true
    );
    expect(result.accountedWorkUnitIds).toEqual(["wu-1"]);
    expect(result.sessionAccountedWorkUnitIds).toEqual(["wu-1"]);
  });

  it("matches receipts by participant id when the session id is absent", () => {
    const result = resolveAccountedWorkUnitIds(
      ["wu-1"],
      [waveResult("wu-1", "FAIL", { participantId: "participant:wu-1", exitCode: 0 })],
      [receipt(undefined, "participant:wu-1")],
      true
    );
    expect(result.accountedWorkUnitIds).toEqual(["wu-1"]);
  });

  it("does not session-account when the final report is red", () => {
    const result = resolveAccountedWorkUnitIds(
      ["wu-1"],
      [waveResult("wu-1", "FAIL", { id: "s1", exitCode: 0 })],
      [receipt("s1", "participant:wu-1")],
      false
    );
    expect(result.accountedWorkUnitIds).toEqual([]);
  });

  it("ignores failed-outcome receipts (vacuous or crashed work earns no credit)", () => {
    const result = resolveAccountedWorkUnitIds(
      ["wu-1"],
      [waveResult("wu-1", "FAIL", { id: "s1", exitCode: 0 })],
      [receipt("s1", "participant:wu-1", "FAILED")],
      true
    );
    expect(result.accountedWorkUnitIds).toEqual([]);
  });

  it("leaves receipt-less units unaccounted even when green elsewhere", () => {
    const result = resolveAccountedWorkUnitIds(
      ["wu-1", "wu-2"],
      [waveResult("wu-1", "PASS", { id: "s1", exitCode: 0 }), waveResult("wu-2", "FAIL", { id: "s2", exitCode: 1 })],
      [receipt("s1", "participant:wu-1")],
      true
    );
    expect(result.accountedWorkUnitIds).toEqual(["wu-1"]);
  });

  it("leaves undispatched units with no result unaccounted", () => {
    const result = resolveAccountedWorkUnitIds(
      ["wu-1", "wu-2"],
      [waveResult("wu-1", "PASS", { id: "s1", exitCode: 0 })],
      [receipt("s1", "participant:wu-1")],
      true
    );
    expect(result.accountedWorkUnitIds).toEqual(["wu-1"]);
  });
});
