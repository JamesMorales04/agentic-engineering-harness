import { describe, expect, it } from "vitest";
import {
  explorerOutputSchema,
  implementerOutputSchema,
  plannerOutputSchema,
  reviewerOutputSchema,
  supervisorOutputSchema,
  validateAgentOutput,
} from "../src/agents/outputContracts.js";

const finding = (severity: "critical" | "high" | "medium" = "critical") => ({
  id: "F1",
  severity,
  category: "correctness",
  location: { file: "src/a.ts", startLine: 1, endLine: 2 },
  evidence: "ex",
  impact: "im",
  recommendedFix: "fix",
  requiredCompetencies: ["general-engineering"],
});

const workUnit = () => ({
  id: "wu-1",
  objective: "Do the thing",
  scope: ["src/**"],
  dependencies: [],
  requirementRefs: [],
  acceptanceRefs: [],
  competencies: ["general-engineering"],
  riskTags: [],
  changeKinds: ["source"] as const[],
  risk: "low" as const,
});

describe("H-NEW-2 cross-field gates (RED first)", () => {
  it("rejects reviewer PASS + critical finding + SAFE", () => {
    expect(
      validateAgentOutput("reviewer", { verdict: "PASS", findings: [finding()], finalizationSafety: "SAFE", followUp: [] }).ok,
    ).toBe(false);
  });
  it("rejects reviewer PASS_WITH_WARNINGS + high finding + SAFE", () => {
    expect(
      validateAgentOutput("reviewer", { verdict: "PASS_WITH_WARNINGS", findings: [finding("high")], finalizationSafety: "SAFE", followUp: [] }).ok,
    ).toBe(false);
  });
  it("rejects reviewer FAIL with zero findings", () => {
    expect(
      validateAgentOutput("reviewer", { verdict: "FAIL", findings: [], finalizationSafety: "BLOCKED", followUp: [] }).ok,
    ).toBe(false);
  });
  it("rejects supervisor SAFE with non-empty unresolved", () => {
    expect(
      validateAgentOutput("supervisor", { summary: "s", consolidatedFindings: [], sourceFindingIds: [], conflicts: [], missingEvidence: [], unresolved: ["open"], roadmap: [], finalizationSafety: "SAFE" }).ok,
    ).toBe(false);
  });
  it("rejects supervisor SAFE with non-empty missingEvidence", () => {
    expect(
      validateAgentOutput("supervisor", { summary: "s", consolidatedFindings: [], sourceFindingIds: [], conflicts: [], missingEvidence: ["no proof"], unresolved: [], roadmap: [], finalizationSafety: "SAFE" }).ok,
    ).toBe(false);
  });
  it("rejects fully-empty implementer result", () => {
    expect(
      validateAgentOutput("implementer", { filesChanged: [], behaviorImplemented: [], decisions: [], assumptions: [], risks: [], validationCommands: [], followUp: [] }).ok,
    ).toBe(false);
  });
  it("rejects fully-empty explorer result", () => {
    expect(
      validateAgentOutput("explorer", { summary: "done", relevantFiles: [], findings: [], moduleBoundaries: [], tests: [], dependencies: [], risks: [], openQuestions: [] }).ok,
    ).toBe(false);
  });
  it("rejects planner with empty workUnits", () => {
    expect(validateAgentOutput("planner", { workUnits: [] }).ok).toBe(false);
  });
  it("audit and change lanes agree on FAIL-empty reviewer output (shared schema gate)", () => {
    // Both src/agents/reviewLifecycle.ts (change lane) and src/audit/run.ts (audit lane)
    // parse via reviewerOutputSchema; the FAIL-empty gate must live in the schema.
    expect(
      reviewerOutputSchema.safeParse({ verdict: "FAIL", findings: [], finalizationSafety: "BLOCKED", followUp: [] }).success,
    ).toBe(false);
  });

  it("positive controls stay valid", () => {
    expect(validateAgentOutput("reviewer", { verdict: "PASS", findings: [], finalizationSafety: "SAFE", followUp: [] }).ok).toBe(true);
    expect(validateAgentOutput("reviewer", { verdict: "FAIL", findings: [finding()], finalizationSafety: "BLOCKED", followUp: [] }).ok).toBe(true);
    expect(validateAgentOutput("supervisor", { summary: "s", consolidatedFindings: [], sourceFindingIds: [], conflicts: [], missingEvidence: [], unresolved: [], roadmap: [], finalizationSafety: "SAFE" }).ok).toBe(true);
    expect(validateAgentOutput("supervisor", { summary: "s", consolidatedFindings: [], sourceFindingIds: [], conflicts: [], missingEvidence: [], unresolved: ["x"], roadmap: [], finalizationSafety: "BLOCKED" }).ok).toBe(true);
    expect(validateAgentOutput("implementer", { filesChanged: ["src/a.ts"], behaviorImplemented: [], decisions: [], assumptions: [], risks: [], validationCommands: [], followUp: [] }).ok).toBe(true);
    expect(explorerOutputSchema.safeParse({ summary: "s", relevantFiles: [{ path: "src/a.ts", symbols: [], reason: "r" }] }).success).toBe(true);
    expect(plannerOutputSchema.safeParse({ workUnits: [workUnit()] }).success).toBe(true);
  });
});
