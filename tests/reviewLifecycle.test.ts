import { describe, expect, it } from "vitest";
import { evaluateFinalQualityGate } from "../src/agents/qualityConvergence.js";
import type { NormalizedFinding } from "../src/agents/outputContracts.js";
import type { HarnessProjectConfig } from "../src/core/types.js";
const config: HarnessProjectConfig = { version: 1, project: { name: "test" } };
function finding(severity: NormalizedFinding["severity"]): NormalizedFinding { return { id: `F-${severity}`, severity, category: "test", location: { file: "x.ts" }, evidence: severity, impact: "i", recommendedFix: "f", suggestedAgent: "implementation-worker" }; }
describe("review lifecycle final quality policy", () => {
  it("requires medium and above to reach zero", () => { expect(evaluateFinalQualityGate([finding("critical")], config).pass).toBe(false); expect(evaluateFinalQualityGate([finding("medium")], config).pass).toBe(false); });
  it("permits a bounded residual low budget", () => expect(evaluateFinalQualityGate([finding("low")], config).pass).toBe(true));
});
