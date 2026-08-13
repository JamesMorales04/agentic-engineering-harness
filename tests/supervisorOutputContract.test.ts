import { describe, expect, it } from "vitest";
import { supervisorOutputSchema } from "../src/agents/outputContracts.js";

describe("operation supervisor output contract", () => {
  it("accepts semantic consolidation with explicit raw finding provenance", () => {
    const parsed = supervisorOutputSchema.parse({
      summary: "Two reviewer reports describe one boundary violation.",
      consolidatedFindings: [
        {
          id: "ARCH-1",
          severity: "high",
          category: "architecture",
          location: { file: "src/a.ts", startLine: 10, endLine: 12 },
          evidence: "Both reviewers identify the same dependency inversion.",
          impact: "Layer boundary can be bypassed.",
          recommendedFix: "Move the dependency behind the application boundary.",
          suggestedAgent: "backend-implementer",
          exceptionType: "IMPLEMENTATION_DEFECT"
        }
      ],
      sourceFindingIds: ["architecture-reviewer:F1", "code-quality-reviewer:F7"],
      conflicts: [],
      missingEvidence: [],
      unresolved: [],
      finalizationSafety: "BLOCKED"
    });
    expect(parsed.sourceFindingIds).toHaveLength(2);
    expect(parsed.consolidatedFindings).toHaveLength(1);
  });

  it("rejects an invalid finalization safety value", () => {
    expect(() => supervisorOutputSchema.parse({
      summary: "bad",
      consolidatedFindings: [],
      sourceFindingIds: [],
      conflicts: [],
      missingEvidence: [],
      unresolved: [],
      finalizationSafety: "MAYBE"
    })).toThrow();
  });
});
