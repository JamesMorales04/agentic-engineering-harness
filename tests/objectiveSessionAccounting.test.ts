import { describe, expect, it } from "vitest";
import { resolveAccountedWorkUnitIds } from "../src/core/run.js";

function waveResult(id: string, status: "PASS" | "FAIL", exitCode: number) {
  return { task: { id }, status, session: { exitCode } } as never;
}

describe("resolveAccountedWorkUnitIds (objective DoD work-unit accounting)", () => {
  it("accounts wave-passed units", () => {
    const result = resolveAccountedWorkUnitIds(["wu-1", "wu-2"], [waveResult("wu-1", "PASS", 0), waveResult("wu-2", "PASS", 0)], true);
    expect(result.accountedWorkUnitIds.sort()).toEqual(["wu-1", "wu-2"]);
    expect(result.sessionAccountedWorkUnitIds).toEqual([]);
  });

  it("accounts a barrier-flaked unit with a successful worker session once the final report is green", () => {
    const result = resolveAccountedWorkUnitIds(["wu-1"], [waveResult("wu-1", "FAIL", 0)], true);
    expect(result.accountedWorkUnitIds).toEqual(["wu-1"]);
    expect(result.sessionAccountedWorkUnitIds).toEqual(["wu-1"]);
  });

  it("does not session-account when the final report is red", () => {
    const result = resolveAccountedWorkUnitIds(["wu-1"], [waveResult("wu-1", "FAIL", 0)], false);
    expect(result.accountedWorkUnitIds).toEqual([]);
    expect(result.sessionAccountedWorkUnitIds).toEqual([]);
  });

  it("leaves crashed units with no successful session unaccounted even when green elsewhere", () => {
    const result = resolveAccountedWorkUnitIds(["wu-1", "wu-2"], [waveResult("wu-1", "PASS", 0), waveResult("wu-2", "FAIL", 1)], true);
    expect(result.accountedWorkUnitIds).toEqual(["wu-1"]);
    expect(result.sessionAccountedWorkUnitIds).toEqual([]);
  });

  it("leaves undispatched units with no result unaccounted", () => {
    const result = resolveAccountedWorkUnitIds(["wu-1", "wu-2"], [waveResult("wu-1", "PASS", 0)], true);
    expect(result.accountedWorkUnitIds).toEqual(["wu-1"]);
  });
});
