import { describe, expect, it } from "vitest";
import { analyzeQualityState, calculateQuality, evaluateFinalQualityGate } from "../src/agents/qualityConvergence.js";
import type { NormalizedFinding } from "../src/agents/outputContracts.js";
import type { HarnessProjectConfig } from "../src/core/types.js";

const config: HarnessProjectConfig = { version: 1, project: { name: "test" } };
function finding(severity: NormalizedFinding["severity"], id: string): NormalizedFinding { return { id, severity, category: `category-${id}`, location: { file: `${id}.ts`, startLine: 1 }, evidence: `evidence ${id}`, impact: "impact", recommendedFix: "fix", suggestedAgent: "implementation-worker" }; }
function many(severity: NormalizedFinding["severity"], count: number, prefix = severity): NormalizedFinding[] { return Array.from({ length: count }, (_, index) => finding(severity, `${prefix}-${index}`)); }

describe("quality convergence scoring", () => {
  it("makes three notes equal exactly one low", () => {
    expect(calculateQuality(many("note", 3), config).debtPoints).toBe(3);
    expect(calculateQuality(many("note", 3), config).debtScore).toBe(1);
    expect(calculateQuality(many("low", 1), config).debtPoints).toBe(3);
  });
  it("accepts nine notes but rejects ten", () => {
    expect(evaluateFinalQualityGate(many("note", 9), config).pass).toBe(true);
    expect(evaluateFinalQualityGate(many("note", 10), config).pass).toBe(false);
  });
  it("accepts at most three lows and no medium-or-higher finding", () => {
    expect(evaluateFinalQualityGate(many("low", 3), config).pass).toBe(true);
    expect(evaluateFinalQualityGate(many("low", 4), config).pass).toBe(false);
    expect(evaluateFinalQualityGate(many("medium", 1), config).pass).toBe(false);
    expect(evaluateFinalQualityGate(many("high", 1), config).pass).toBe(false);
    expect(evaluateFinalQualityGate(many("critical", 1), config).pass).toBe(false);
  });
  it("rejects three lows plus one note through the aggregate debt budget", () => {
    expect(evaluateFinalQualityGate([...many("low", 3), ...many("note", 1)], config).pass).toBe(false);
  });
});

describe("quality convergence state", () => {
  it("detects regression when debt increases", () => {
    const first = analyzeQualityState(many("low", 4, "a"), [], config);
    const second = analyzeQualityState(many("low", 5, "b"), [first], config);
    expect(second.convergence).toBe("REGRESSING");
  });
  it("detects exact finding cycles", () => {
    const findings = many("low", 4, "cycle");
    const first = analyzeQualityState(findings, [], config);
    const second = analyzeQualityState(findings, [first], config);
    expect(second.convergence).toBe("CYCLING");
  });
  it("detects stagnation without a repeated fingerprint", () => {
    const first = analyzeQualityState(many("low", 4, "first"), [], config);
    const second = analyzeQualityState(many("low", 4, "second"), [first], config);
    expect(second.convergence).toBe("STAGNATING");
  });
});
