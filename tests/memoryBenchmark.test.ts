import { describe, expect, it } from "vitest";
import { scoreMemoryOutput } from "../src/memory/benchmark.js";

describe("memory benchmark scoring", () => {
  it("rewards expected evidence and penalizes stale contamination", () => {
    const clean = scoreMemoryOutput({ version: 1, id: "M1", query: "q", expectedTerms: ["alpha", "beta"], forbiddenTerms: ["stale"] }, true, 100, "alpha beta");
    const stale = scoreMemoryOutput({ version: 1, id: "M1", query: "q", expectedTerms: ["alpha", "beta"], forbiddenTerms: ["stale"] }, true, 100, "alpha stale");
    expect(clean.score).toBeGreaterThan(stale.score);
    expect(clean.recall).toBe(1);
  });
});
