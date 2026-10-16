import { describe, expect, it } from "vitest";
import { resolveAccountedWorkUnitIds } from "../src/core/run.js";

describe("resolveAccountedWorkUnitIds (objective DoD work-unit accounting)", () => {
  it("accounts wave-passed units without repair", () => {
    const result = resolveAccountedWorkUnitIds(["wu-1", "wu-2"], ["wu-1", "wu-2"], 0);
    expect(result.accountedWorkUnitIds.sort()).toEqual(["wu-1", "wu-2"]);
    expect(result.repairAccountedWorkUnitIds).toEqual([]);
  });

  it("leaves wave-failed units unaccounted when no repair turn ran", () => {
    const result = resolveAccountedWorkUnitIds(["wu-1"], [], 0);
    expect(result.accountedWorkUnitIds).toEqual([]);
    expect(result.repairAccountedWorkUnitIds).toEqual([]);
  });

  it("accounts all planned units as repair-accounted after a repair-converged run", () => {
    const result = resolveAccountedWorkUnitIds(["wu-1", "wu-2"], ["wu-1"], 2);
    expect(result.accountedWorkUnitIds.sort()).toEqual(["wu-1", "wu-2"]);
    expect(result.repairAccountedWorkUnitIds.sort()).toEqual(["wu-1", "wu-2"]);
  });

  it("dedupes units accounted by both wave and repair", () => {
    const result = resolveAccountedWorkUnitIds(["wu-1"], ["wu-1"], 1);
    expect(result.accountedWorkUnitIds).toEqual(["wu-1"]);
    expect(result.repairAccountedWorkUnitIds).toEqual(["wu-1"]);
  });
});
