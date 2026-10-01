import { describe, expect, it } from "vitest";
import { evaluateFinalQualityGate } from "../src/agents/qualityConvergence.js";
import { remediationBudgetReached, remediationBudgetRounds, replaceSupersededReviewerChecksV1 } from "../src/agents/reviewLifecycle.js";
import { operationFailureDetail, validationFailureDetail } from "../src/core/run.js";
import type { NormalizedFinding } from "../src/agents/outputContracts.js";
import type { HarnessProjectConfig, ValidationCheck, ValidationReport } from "../src/core/types.js";
const config: HarnessProjectConfig = { version: 1, project: { name: "test" } };
function finding(severity: NormalizedFinding["severity"]): NormalizedFinding { return { id: `F-${severity}`, severity, category: "test", location: { file: "x.ts" }, evidence: severity, impact: "i", recommendedFix: "f", requiredCompetencies: ["testing"], reviewDimensions: ["correctness"] }; }
describe("review lifecycle final quality policy", () => {
  it("requires medium and above to reach zero", () => { expect(evaluateFinalQualityGate([finding("critical")], config).pass).toBe(false); expect(evaluateFinalQualityGate([finding("medium")], config).pass).toBe(false); });
  it("permits a bounded residual low budget", () => expect(evaluateFinalQualityGate([finding("low")], config).pass).toBe(true));
});

describe("bounded remediation execution budget (AEH-V2-0119)", () => {
  it("defaults to six rounds and honors an explicit escalation budget", () => {
    expect(remediationBudgetRounds(config)).toBe(6);
    expect(remediationBudgetReached(5, config)).toBe(false);
    expect(remediationBudgetReached(6, config)).toBe(true);
    const bounded: HarnessProjectConfig = { ...config, workflow: { reviews: { escalation: { maxRounds: 2 } } } };
    expect(remediationBudgetReached(1, bounded)).toBe(false);
    expect(remediationBudgetReached(2, bounded)).toBe(true);
  });

  it("terminalizes a failed run with the owning failing checks instead of a null error (AEH-V2-0118)", () => {
    const report = {
      version: 1,
      taskId: "T",
      status: "FAIL",
      checks: [
        { id: "candidate.assurance.recompiled", category: "candidate-assurance", status: "FAIL", message: "Candidate assurance is BLOCKED by fail-closed recompilation: VALIDATION_REQUIREMENT_ID_CONFLICT" },
        { id: "command.fixture-greeting", category: "command", status: "PASS", message: "ok" }
      ]
    } as ValidationReport;
    expect(validationFailureDetail(report)).toBe("candidate.assurance.recompiled: Candidate assurance is BLOCKED by fail-closed recompilation: VALIDATION_REQUIREMENT_ID_CONFLICT");
    expect(operationFailureDetail({ status: "FAIL", report, review: { status: "FAIL", finalState: "SYSTEM_FAILURE", humanRequired: false } as never })).toContain("review=SYSTEM_FAILURE");
  });
});

describe("review round check reconciliation", () => {
  const check = (id: string, status: "PASS" | "FAIL"): ValidationCheck => ({ id, category: "candidate-assurance", status, message: id });

  it("replaces a superseded failed round with the current round's evidence", () => {
    const checks = [check("candidate.assurance.reviewer.0.reviewer", "FAIL")];
    replaceSupersededReviewerChecksV1(checks, 1, "reviewer", check("candidate.assurance.reviewer.1.reviewer", "PASS"));
    expect(checks.map((item) => [item.id, item.status])).toEqual([["candidate.assurance.reviewer.1.reviewer", "PASS"]]);
  });

  it("keeps other reviewers and non-reviewer checks intact", () => {
    const checks = [
      check("candidate.assurance.reviewer.0.reviewer", "FAIL"),
      check("candidate.assurance.reviewer.0.reviewer-2", "PASS"),
      check("candidate.workspace-identity.review-entry", "PASS")
    ];
    replaceSupersededReviewerChecksV1(checks, 1, "reviewer", check("candidate.assurance.reviewer.1.reviewer", "PASS"));
    expect(checks.map((item) => item.id).sort()).toEqual([
      "candidate.assurance.reviewer.0.reviewer-2",
      "candidate.assurance.reviewer.1.reviewer",
      "candidate.workspace-identity.review-entry"
    ]);
  });

  it("never removes a newer round check when replaying an older round", () => {
    const checks = [check("candidate.assurance.reviewer.1.reviewer", "PASS")];
    replaceSupersededReviewerChecksV1(checks, 0, "reviewer", check("candidate.assurance.reviewer.0.reviewer", "FAIL"));
    expect(checks.map((item) => item.id).sort()).toEqual(["candidate.assurance.reviewer.0.reviewer", "candidate.assurance.reviewer.1.reviewer"]);
  });
});
