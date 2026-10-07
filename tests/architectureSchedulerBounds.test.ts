import { describe, expect, it } from "vitest";
import { planWorkUnitWaves } from "../src/architecture/workGraph.js";

const units = () => [
  { id: "A", objective: "objective A", scope: ["src/a.ts"], dependencies: [] as string[] },
  { id: "B", objective: "objective B", scope: ["src/b.ts"], dependencies: [] as string[] },
];

describe("planWorkUnitWaves blueprint-bound validation", () => {
  it("rejects an Infinity bound fail-closed instead of emitting empty waves forever", () => {
    // Post-fix this throws synchronously before the scheduling loop, so the
    // direct call terminates via the throw (pre-fix it hung: RED-1).
    expect(() => planWorkUnitWaves(units(), { blueprintWaveIndex: () => Infinity }))
      .toThrow(/Cannot schedule delegation plan \[INVALID_SCHEDULING_BOUND\]: 'A' declares invalid blueprint wave bound Infinity/);
  });

  it("rejects non-finite, negative, and out-of-range bounds before allocation", () => {
    for (const bound of [Number.NaN, Number.NEGATIVE_INFINITY, -1, 3, 1e9]) {
      expect(() => planWorkUnitWaves(units(), { blueprintWaveIndex: () => bound as number }))
        .toThrow(new RegExp(`\\[INVALID_SCHEDULING_BOUND\\]: 'A' declares invalid blueprint wave bound ${String(bound)}`));
    }
  });

  it("accepts finite bounds in [0, unitCount], including the unitCount boundary", () => {
    expect(planWorkUnitWaves(units())).toEqual([["A", "B"]]);
    expect(planWorkUnitWaves(units(), { blueprintWaveIndex: () => 0 })).toEqual([["A", "B"]]);
    // Monotonic delay still works: B held to wave 1 while A runs in wave 0.
    expect(planWorkUnitWaves(units(), { blueprintWaveIndex: (id) => (id === "B" ? 1 : 0) }))
      .toEqual([["A"], ["B"]]);
    // Boundary bound == unitCount terminates (empty waves advance to it).
    expect(planWorkUnitWaves(units(), { blueprintWaveIndex: (id) => (id === "B" ? 2 : 0) }))
      .toEqual([["A"], [], ["B"]]);
  });
});
