import { describe, expect, it } from "vitest";
import { nextEscalationIndex, resumeAfterReplan } from "../src/agents/escalation.js";
import type { QualityState } from "../src/agents/qualityConvergence.js";
import type { HarnessProjectConfig } from "../src/core/types.js";
const config: HarnessProjectConfig = { version: 1, project: { name: "test" } };
function state(convergence: QualityState["convergence"], critical = 0, round = 1): QualityState { return { round, counts: { critical, high: 0, medium: 1, low: 0, note: 0 }, debtPoints: 24 + critical * 300, debtScore: 8 + critical * 100, fingerprint: "x", findingFingerprints: [], resolved: [], persistent: [], introduced: [], convergence, gate: { pass: false, reasons: ["not ready"], counts: { critical, high: 0, medium: 1, low: 0, note: 0 }, debtPoints: 24 + critical * 300, debtScore: 8 + critical * 100 } }; }
describe("quality escalation", () => {
  it("escalates stagnation to the next strategy", () => expect(nextEscalationIndex(state("STAGNATING"), 0, config)).toBe(1));
  it("starts a first-round critical finding at the senior stage", () => expect(nextEscalationIndex(state("INITIAL", 1, 0), 0, config)).toBe(2));
  it("resumes one slot before senior so the next convergence decision selects senior", () => expect(resumeAfterReplan(config)).toBe(1));
});
