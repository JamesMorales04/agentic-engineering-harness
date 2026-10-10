import { describe, expect, it } from "vitest";
import { evaluateFinalQualityGate } from "../src/agents/qualityConvergence.js";
import { assertReviewerSelectionAuthority, remediationBudgetReached, remediationBudgetRounds, replaceSupersededReviewerChecksV1 } from "../src/agents/reviewLifecycle.js";
import type { AgentExecutionSelection } from "../src/agents/types.js";
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

describe("reviewer selection authority (reviewer shell=allow regression)", () => {
  // CHANGE-20261010T063726Z-873e30d9: harness-reviewer carried shell=allow,
  // requested the execute capability, and died at the Reviewer role ceiling
  // mid-review. Reviewers are read-only by canonical definition
  // (canExecute:false, command-execute forbidden); fail fast at assignment.
  function selection(overrides: Record<string, unknown> = {}, logicalAgent = "reviewer"): AgentExecutionSelection {
    return {
      logicalAgent,
      role: "Reviewer",
      permissions: { read: "allow", write: "deny", shell: "deny", network: "deny", ...overrides },
    } as AgentExecutionSelection;
  }
  it("admits a read-only reviewer selection", () => {
    expect(() => assertReviewerSelectionAuthority(selection(), "reviewer", "implementer")).not.toThrow();
  });
  it("rejects a reviewer with source-write authority", () => {
    expect(() => assertReviewerSelectionAuthority(selection({ write: "allow" }), "reviewer", "implementer")).toThrow(
      /REVIEW_AUTHORITY_REQUIRED/,
    );
  });
  it("rejects a reviewer with shell authority (execute exceeds the Reviewer ceiling)", () => {
    expect(() => assertReviewerSelectionAuthority(selection({ shell: "allow" }), "harness-reviewer", "implementer")).toThrow(
      /REVIEW_AUTHORITY_REQUIRED/,
    );
  });
  it("rejects self-review", () => {
    expect(() => assertReviewerSelectionAuthority(selection({}, "implementer"), "implementer", "implementer")).toThrow(
      /REVIEW_INDEPENDENCE_REQUIRED/,
    );
  });

  it("ships harness-reviewer without shell authority (read-only Reviewer ceiling)", async () => {
    // The shipped topology is the production source of reviewer selections;
    // a shell=allow Reviewer dies mid-review at the capability ceiling.
    const { readFile } = await import("node:fs/promises");
    const { default: path } = await import("node:path");
    const raw = await readFile(path.resolve(import.meta.dirname, "..", ".harness", "agents.source.jsonc"), "utf8");
    const parsed = JSON.parse(raw.replace(/\/\/.*/g, "")) as {
      agents: Record<string, { role?: string; permissions?: { shell?: string } }>;
    };
    expect(parsed.agents["harness-reviewer"]?.role).toBe("Reviewer");
    expect(parsed.agents["harness-reviewer"]?.permissions?.shell).toBe("deny");
  });
});
