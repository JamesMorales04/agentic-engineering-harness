import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTaskContract } from "../src/core/config.js";
import { verifyTaskSeal } from "../src/core/seal.js";
import type { HarnessProjectConfig } from "../src/core/types.js";
import { loadDeliveryRecord } from "../src/delivery/handoff.js";
import { inspectGithubIssue, issueContentSha256, prepareGithubIssueTask, verifyGithubIssueDrift, type IssueIntakePlan } from "../src/issues/intake.js";
import { createSemanticAssessmentServiceV1, semanticCapabilityPolicyRevisionV1, type SemanticAssessmentRuntimeV1 } from "../src/semantic/assessment.js";
import { semanticTestAssessor, semanticPayload } from "./semanticAssessmentSupport.js";

const config: HarnessProjectConfig = {
  version: 1,
  project: { name: "issue-test" },
  workflow: { issueIntake: { enabled: true, snapshotDir: ".harness/issues", verifyDriftOnRun: true, requireOpen: true, autoHandoff: false } },
  delivery: { stateDir: ".harness/delivery", github: { enabled: false, repository: "owner/repo", tokenEnv: "GH_TOKEN", branchPattern: "feature/gh-{issue}-{slug}" }, paseo: { enabled: false } },
  sdd: { specsDir: "specs", contractsDir: ".harness/contracts", reportsDir: ".harness/reports" },
  validation: { baseRef: "main", requireSeal: true },
  orchestration: { provider: "none", worker: { maxRepairAttempts: 2 } }
};

afterEach(() => { vi.unstubAllGlobals(); });
async function root(): Promise<string> { return fs.mkdtemp(path.join(os.tmpdir(), "aeh-issue-")); }
function mockIssue(input: { number: number; title: string; body: string; labels?: string[]; state?: string; updated?: string }): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ number: input.number, html_url: `https://github.com/owner/repo/issues/${input.number}`, title: input.title, body: input.body, state: input.state ?? "open", labels: (input.labels ?? []).map((name) => ({ name })), created_at: "2026-08-01T00:00:00Z", updated_at: input.updated ?? "2026-08-11T00:00:00Z" }), { status: 200, headers: { "content-type": "application/json" } })));
}
function issuePlan(input: { number: number; title: string; body: string; labels?: string[] }): IssueIntakePlan {
  const labels = input.labels ?? [];
  const paths = [...input.body.matchAll(/`([^`]+)`/g)].map((match) => match[1]!).filter((value) => value.includes("/") || value.includes("."));
  const requirementTexts = input.body.split(/\r?\n/).map((line) => line.match(/^\s*[-*+]\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/)?.[1]?.trim()).filter((value): value is string => Boolean(value));
  const requirements = (requirementTexts.length ? requirementTexts : [input.body || input.title]).map((text) => ({ text, source: "explicit" as const, validators: ["gherkin"] }));
  const requirementIndexes = requirements.map((_, index) => index + 1);
  const flags = labels.map((label) => label.toLowerCase()).filter((label): label is "security" | "migration" | "public-api" | "frontend" | "docs" => ["security", "migration", "public-api", "frontend", "docs"].includes(label)) as Array<"security" | "migration" | "public-api" | "frontend" | "docs">;
  const plan = {
    classification: "ready" as const,
    rationale: "Fixture represents a previously completed bounded semantic issue assessment.",
    problem: input.body || input.title,
    desiredOutcome: input.title,
    requirements,
    acceptance: [{ title: "Frozen issue outcome", requirementIndexes, given: "the frozen GitHub issue is available", when: "the implementation is completed", then: `${input.title} is satisfied` }],
    scope: { allowed: paths.length ? paths : ["**"], forbidden: [], domains: labels.map((label) => label.toLowerCase()).filter((label) => ["security", "frontend", "docs", "backend"].includes(label)) },
    risk: labels.some((label) => /high|severity:high|risk:high|security/i.test(label)) ? "high" as const : "low" as const,
    flags: flags.filter((flag): flag is "security" | "migration" | "public-api" => ["security", "migration", "public-api"].includes(flag)),
    constraints: { breakingApiChanges: labels.some((label) => label === "public-api"), newDependencies: false, schemaChanges: labels.some((label) => label === "migration") },
    design: { currentState: "Fixture semantic assessment", proposedDesign: "Implement the frozen issue", risks: [] },
    tasks: [{ title: "Implement frozen issue", requirementIndexes, scope: paths }],
    nonGoals: [], unresolved: []
  };
  return plan;
}

function semanticRuntime(input: { title: string; body: string }): SemanticAssessmentRuntimeV1 {
  const assessor = semanticTestAssessor();
  const service = createSemanticAssessmentServiceV1({
    assessor,
    policyRevision: semanticCapabilityPolicyRevisionV1,
    runner: { assess: async ({ request }) => {
      if (request.assessmentType !== "ISSUE") return { payload: semanticPayload(request), paseoSession: { provider: "opencode", agentId: "issue-test-route", transport: "sdk" } };
      const body = request.compactEvidence.map((item) => item.content).join("\n");
      const explicitRequirements = body.split(/\r?\n/).map((line) => line.match(/^\s*[-*+]\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/)?.[1]?.trim()).filter((value): value is string => Boolean(value)).map((statement) => ({ statement, evidenceRefs: [request.evidenceRefs[0]!] }));
      return {
        payload: {
          judgment: { type: "ISSUE", classification: "ready", requestedOutcome: input.title, explicitRequirements, evidenceRefs: [request.evidenceRefs[0]!], unknowns: ["unknown issue detail"] },
          claims: [], assumptions: [], unknowns: [], recommendations: [], knowledgeGaps: []
        },
        paseoSession: { provider: "opencode", agentId: "issue-test-session", transport: "sdk" }
      };
    } }
  });
  return { service, policyRevision: semanticCapabilityPolicyRevisionV1, assessor };
}

function planner(input: { number: number; title: string; body: string; labels?: string[] }) {
  return { plan: async () => issuePlan(input) };
}

describe("GitHub issue intake", () => {
  it("keeps inspection evidence-only and freezes a bounded issue after semantic normalization", async () => {
    const repo = await root();
    mockIssue({ number: 12, title: "Adjust save label", labels: ["frontend"], body: "## Acceptance Criteria\n- The save button displays Save changes\n\n## Files\n- `src/Button.tsx`" });
    const inspected = await inspectGithubIssue(repo, config, 12);
    expect(inspected).not.toHaveProperty("preliminaryRoute");
    expect(inspected).toMatchObject({ evidence: { files: ["src/Button.tsx"], domains: ["frontend"] } });
    const input = { number: 12, title: "Adjust save label", labels: ["frontend"], body: "## Acceptance Criteria\n- The save button displays Save changes\n\n## Files\n- `src/Button.tsx`" };
    const prepared = await prepareGithubIssueTask(repo, config, 12, { semanticRuntime: semanticRuntime(input), planner: planner(input) });
    expect(prepared.route).toBe("DIRECT");
    expect(prepared.contract.source?.issue).toBe(".harness/issues/GH-12.json");
    expect(prepared.contract.issue).toMatchObject({ provider: "github", repository: "owner/repo", number: 12 });
    expect((await loadDeliveryRecord(repo, config, "GH-12"))?.github?.issueNumber).toBe(12);
    expect((await verifyTaskSeal(repo, prepared.contract, true)).status).toBe("PASS");
  });

  it("keeps a security-sensitive issue delegated while preserving a CRITICAL assurance floor", async () => {
    const repo = await root();
    mockIssue({ number: 42, title: "Add organization permission check", labels: ["backend", "security"], body: "## Requirements\n- Requests from another organization are denied\n- Authorized organization members retain access\n\n## Acceptance Criteria\n- Cross-organization access returns 403\n- Same-organization access remains successful" });
    const input = { number: 42, title: "Add organization permission check", labels: ["backend", "security"], body: "## Requirements\n- Requests from another organization are denied\n- Authorized organization members retain access\n\n## Acceptance Criteria\n- Cross-organization access returns 403\n- Same-organization access remains successful" };
    const prepared = await prepareGithubIssueTask(repo, config, 42, { semanticRuntime: semanticRuntime(input), planner: planner(input) });
    expect(prepared.route).toBe("DELEGATED");
    expect(prepared.traceability).toBeUndefined();
    expect(prepared.contract.requirements?.length).toBeGreaterThanOrEqual(2);
    expect(prepared.contract.routing?.assurance).toBe("CRITICAL");
    expect(prepared.contract.routing?.risk).not.toBe("low");
    expect((await loadDeliveryRecord(repo, config, "GH-42"))?.github).toMatchObject({ repository: "owner/repo", issueNumber: 42 });
    expect((await verifyTaskSeal(repo, prepared.contract, true)).status).toBe("PASS");
  });

  it("detects normative issue drift after the TaskContract has been frozen", async () => {
    const repo = await root();
    mockIssue({ number: 77, title: "Update docs wording", labels: ["docs"], body: "## Acceptance Criteria\n- README uses the new wording\n\n## Files\n- `README.md`" });
    const input = { number: 77, title: "Update docs wording", labels: ["docs"], body: "## Acceptance Criteria\n- README uses the new wording\n\n## Files\n- `README.md`" };
    await prepareGithubIssueTask(repo, config, 77, { semanticRuntime: semanticRuntime(input), planner: planner(input) });
    const contract = await loadTaskContract(repo, "GH-77", config);
    mockIssue({ number: 77, title: "Update docs wording", labels: ["docs"], body: "## Acceptance Criteria\n- README uses a DIFFERENT required wording\n\n## Files\n- `README.md`", updated: "2026-08-12T00:00:00Z" });
    const drift = await verifyGithubIssueDrift(repo, config, contract);
    expect(drift.ok).toBe(false);
    expect(drift.message).toContain("ISSUE_DRIFT");
    await expect(prepareGithubIssueTask(repo, config, 77)).rejects.toThrow(/ISSUE_DRIFT/);
  });

  it("refreshes a changed issue before workspace creation without changing its delivery identity", async () => {
    const repo = await root();
    mockIssue({ number: 88, title: "Update copy", labels: ["docs"], body: "## Acceptance Criteria\n- README says Alpha\n\n## Files\n- `README.md`" });
    const firstInput = { number: 88, title: "Update copy", labels: ["docs"], body: "## Acceptance Criteria\n- README says Alpha\n\n## Files\n- `README.md`" };
    const first = await prepareGithubIssueTask(repo, config, 88, { semanticRuntime: semanticRuntime(firstInput), planner: planner(firstInput) });
    const originalHash = first.contract.issue!.contentSha256;
    const originalRecord = await loadDeliveryRecord(repo, config, "GH-88");

    mockIssue({ number: 88, title: "Update copy", labels: ["docs"], body: "## Acceptance Criteria\n- README says Beta\n\n## Files\n- `README.md`", updated: "2026-08-12T01:00:00Z" });
    const refreshedInput = { number: 88, title: "Update copy", labels: ["docs"], body: "## Acceptance Criteria\n- README says Beta\n\n## Files\n- `README.md`" };
    const refreshed = await prepareGithubIssueTask(repo, config, 88, { refresh: true, semanticRuntime: semanticRuntime(refreshedInput), planner: planner(refreshedInput) });
    const refreshedRecord = await loadDeliveryRecord(repo, config, "GH-88");

    expect(refreshed.contract.issue!.contentSha256).not.toBe(originalHash);
    expect(refreshedRecord?.github?.issueNumber).toBe(88);
    expect(refreshedRecord?.createdAt).toBe(originalRecord?.createdAt);
    expect((await verifyTaskSeal(repo, refreshed.contract, true)).status).toBe("PASS");
  });

  it("hashes only normative title/body content, not mutable labels", () => {
    expect(issueContentSha256("Title", "Body")).toBe(issueContentSha256("Title", "Body"));
    expect(issueContentSha256("Title", "Body")).not.toBe(issueContentSha256("Title", "Body changed"));
  });

  it("blocks issue preparation without semantic normalization and preserves the raw snapshot", async () => {
    const repo = await root();
    const body = "Explain the security role migration and the database schema used by the permission API.\n\n## Files\n- `README.md`";
    mockIssue({ number: 91, title: "Document permissions", body, labels: ["docs"] });
    await expect(prepareGithubIssueTask(repo, config, 91)).rejects.toMatchObject({ code: "ISSUE_NORMALIZATION_BLOCKED" });
    expect(JSON.parse(await fs.readFile(path.join(repo, ".harness/issues/GH-91.json"), "utf8"))).toMatchObject({ number: 91, title: "Document permissions", body });
  });

  it("rejects an invalid typed ISSUE judgment and preserves the raw snapshot", async () => {
    const repo = await root();
    const input = { number: 92, title: "Change access contract", body: "## Acceptance Criteria\n- Access is checked", labels: ["security"] };
    mockIssue(input);
    const assessor = semanticTestAssessor();
    const invalidRuntime: SemanticAssessmentRuntimeV1 = {
      assessor,
      policyRevision: semanticCapabilityPolicyRevisionV1,
      service: createSemanticAssessmentServiceV1({
        assessor,
        policyRevision: semanticCapabilityPolicyRevisionV1,
        runner: { assess: async ({ request }) => ({ payload: { not: "an ISSUE judgment" }, paseoSession: { provider: "opencode", agentId: "invalid-issue-session", transport: "sdk" } }) }
      })
    };
    await expect(prepareGithubIssueTask(repo, config, 92, { semanticRuntime: invalidRuntime })).rejects.toMatchObject({ code: "ISSUE_NORMALIZATION_BLOCKED" });
    expect(JSON.parse(await fs.readFile(path.join(repo, ".harness/issues/GH-92.json"), "utf8"))).toMatchObject({ number: 92, title: input.title });
  });
});
