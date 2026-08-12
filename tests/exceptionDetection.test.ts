import { describe, expect, it } from "vitest";
import { detectHumanException, diagnosisToException, exceptionDiagnosisSchema } from "../src/agents/exceptionDetection.js";
import type { NormalizedFinding } from "../src/agents/outputContracts.js";
function finding(category: string, exceptionType?: NormalizedFinding["exceptionType"]): NormalizedFinding { return { id: category, severity: "medium", category, location: { file: "x.ts" }, evidence: `evidence ${category}`, impact: "impact", recommendedFix: "fix", suggestedAgent: "implementation-worker", exceptionType }; }
describe("human-on-exception", () => {
  it("escalates explicit spec contradictions to a human decision", () => { const result = detectHumanException([finding("spec-contradiction")]); expect(result?.type).toBe("SPEC_CONTRADICTION"); expect(result?.humanRequired).toBe(true); });
  it("does not treat implementation defects as a human exception", () => expect(detectHumanException([finding("correctness", "IMPLEMENTATION_DEFECT")])).toBeUndefined());
  it("keeps system failures autonomous", () => { const diagnosis = exceptionDiagnosisSchema.parse({ classification: "SYSTEM_FAILURE", rationale: "tool failed", recommendedAction: "retry" }); const result = diagnosisToException(diagnosis); expect(result?.humanRequired).toBe(false); });
});
