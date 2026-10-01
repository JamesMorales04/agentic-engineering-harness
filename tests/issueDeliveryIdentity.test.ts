import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessProjectConfig } from "../src/core/types.js";
import { loadDeliveryRecord } from "../src/delivery/handoff.js";
import { prepareGithubIssueTask, type IssueIntakePlan } from "../src/issues/intake.js";
import { createSemanticAssessmentServiceV1, semanticCapabilityPolicyRevisionV1 } from "../src/semantic/assessment.js";
import { semanticTestAssessor, semanticPayload } from "./semanticAssessmentSupport.js";

const config: HarnessProjectConfig = {
  version: 1,
  project: { name: "identity-test" },
      workflow: { issueIntake: { enabled: true, requireOpen: true, verifyDriftOnRun: true } },
  delivery: { stateDir: ".harness/delivery", github: { enabled: false, repository: "owner/repo" }, paseo: { enabled: false } },
  sdd: { specsDir: "specs", contractsDir: ".harness/contracts" },
  validation: { baseRef: "main", requireSeal: true }
};

afterEach(() => vi.unstubAllGlobals());

function issueDependencies() {
  const plan = {
    classification: "ready" as const,
    rationale: "The fixture is a bounded semantic assessment.",
    problem: "The label is incorrect.",
    desiredOutcome: "Fix label",
    requirements: [{ text: "Label reads Save", source: "explicit" as const, validators: ["gherkin"] }],
    acceptance: [{ title: "Label", requirementIndexes: [1], given: "the button is rendered", when: "the issue is implemented", then: "the label reads Save" }],
    scope: { allowed: ["src/Button.tsx"], forbidden: [], domains: ["frontend"] },
    risk: "low" as const,
    flags: [],
    constraints: { breakingApiChanges: false, newDependencies: false, schemaChanges: false },
    design: { currentState: "Incorrect label", proposedDesign: "Use Save", risks: [] },
    tasks: [{ title: "Fix label", requirementIndexes: [1], scope: ["src/Button.tsx"] }],
    nonGoals: [], unresolved: []
  };
  const assessor = semanticTestAssessor();
  const semanticRuntime = {
    assessor,
    policyRevision: semanticCapabilityPolicyRevisionV1,
    service: createSemanticAssessmentServiceV1({ assessor, policyRevision: semanticCapabilityPolicyRevisionV1, runner: { assess: async ({ request }) => ({
      payload: request.assessmentType === "ISSUE"
        ? { judgment: { type: "ISSUE", classification: "ready", requestedOutcome: "Fix label", explicitRequirements: [{ statement: "Label reads Save", evidenceRefs: [request.evidenceRefs[0]!] }], evidenceRefs: [request.evidenceRefs[0]!], unknowns: [] }, claims: [], assumptions: [], unknowns: [], recommendations: [], knowledgeGaps: [] }
        : semanticPayload(request),
      paseoSession: { provider: "opencode", agentId: `issue-identity-${request.assessmentType}`, transport: "sdk" }
    }) } })
  };
  return { semanticRuntime, planner: { plan: async (): Promise<IssueIntakePlan> => plan } };
}

describe("issue delivery identity", () => {
  it("re-seeds the existing issue when ephemeral delivery state is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-identity-"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ number: 31, html_url: "https://github.com/owner/repo/issues/31", title: "Fix label", body: "## Acceptance Criteria\n- Label reads Save\n\n## Files\n- `src/Button.tsx`", state: "open", labels: [{ name: "frontend" }], created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-11T00:00:00Z" }), { status: 200 })));

    await prepareGithubIssueTask(root, config, 31, issueDependencies());
    await fs.rm(path.join(root, ".harness", "delivery", "GH-31.json"));
    await prepareGithubIssueTask(root, config, 31);

    expect((await loadDeliveryRecord(root, config, "GH-31"))?.github).toMatchObject({ repository: "owner/repo", issueNumber: 31, issueUrl: "https://github.com/owner/repo/issues/31" });
  });
});
