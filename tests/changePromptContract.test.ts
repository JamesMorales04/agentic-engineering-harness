import { describe, expect, it } from "vitest";
import { buildExplorerPrompt, buildPlannerPrompt, buildSpecManagerPrompt } from "../src/operations/change.js";
import type { ChangeOperationPayload } from "../src/operations/state.js";
import type { TaskContract } from "../src/core/types.js";
import type { DurableAgentEvidence } from "../src/operations/changeHandoff.js";
import type { ExplorerOutput } from "../src/agents/outputContracts.js";

/**
 * AEH-V2-0125 prompt-contract regression. The formal change-path Explorer/Planner prompts omitted
 * the explicit `AEH_RESULT_JSON=` marker line that every other structured handoff requires, and
 * the Spec Manager prompt omitted the canonical OpenSpec normative instruction; the formal lane
 * then rejected the turn as `PLANNER_RESULT_ARTIFACT_MISSING` (formal run 2, NO_MARKER). These
 * assertions pin the exact deterministic prompt contract without executing a provider.
 */

const payload: ChangeOperationPayload = {
  request: "Add the FAREWELL export to the greeting fixture.",
  files: ["src/greeting.mjs"],
  domains: ["architecture"],
  risk: "low",
  acceptance: ["node scripts/validate.mjs passes"],
  title: "Formal greeting boundary change"
};

const contract: TaskContract = {
  version: 1,
  task: { id: "CHANGE-TEST-1", title: "Formal greeting boundary change" },
  scope: { allowed: ["src/greeting.mjs"], forbidden: [], frozen: [] },
  routing: { intent: "implement", domains: ["architecture"], risk: "low", route: "FORMAL_SDD", assurance: "ELEVATED" },
  constraints: { breakingApiChanges: false, newDependencies: false, schemaChanges: false },
  requirements: [{ id: "CHANGE-TEST-1-R1", description: "FAREWELL is exported" }]
};

const explorerEvidence: DurableAgentEvidence<ExplorerOutput> = {
  artifact: ".harness/operations/CHANGE-TEST-1/explorer.json",
  sha256: "a".repeat(64),
  payload: { version: 1, summary: "greeting fixture discovered", files: [], symbols: [], tests: [], boundaries: [], findings: [] } as unknown as ExplorerOutput
};

describe("change prompt contracts (AEH-V2-0125)", () => {
  it("requires exactly one AEH_RESULT_JSON= final line in the Explorer prompt", () => {
    const prompt = buildExplorerPrompt("CHANGE-TEST-1", payload, [], ["/work/tree with spaces", "/work/tree/.git"]);
    const markerLines = prompt.split("\n").filter((line) => line.includes("AEH_RESULT_JSON="));
    expect(markerLines).toHaveLength(1);
    expect(markerLines[0]).toContain("exactly one line beginning AEH_RESULT_JSON=");
    expect(prompt).toContain("EXPLORER_RESULT_ARTIFACT_MISSING");
    expect(prompt).toContain("/work/tree with spaces");
    expect(prompt).toContain("/work/tree/.git");
    expect(prompt).toContain("Do not search prior or sibling worktrees");
    expect(prompt).toContain("Symlinks do not grant access");
    expect(prompt).toContain("Return BLOCKED");
    expect(prompt).not.toContain("/work/sibling");
  });

  it("requires exactly one AEH_RESULT_JSON= final line in the Planner prompt", () => {
    const prompt = buildPlannerPrompt("CHANGE-TEST-1", contract, payload, explorerEvidence, []);
    const markerLines = prompt.split("\n").filter((line) => line.includes("AEH_RESULT_JSON="));
    expect(markerLines).toHaveLength(1);
    expect(markerLines[0]).toContain("exactly one line beginning AEH_RESULT_JSON=");
    expect(prompt).toContain("PLANNER_RESULT_ARTIFACT_MISSING");
    expect(prompt).toContain("CHANGE-TEST-1-R1");
    expect(prompt).toContain("no longer than 500 characters");
  });

  it("keeps the Spec Manager canonical OpenSpec and normative-language instruction", () => {
    const prompt = buildSpecManagerPrompt(payload, "change-test-1", undefined, undefined, []);
    expect(prompt).toContain("## ADDED Requirements");
    expect(prompt).toContain("### Requirement:");
    expect(prompt).toContain("#### Scenario:");
    expect(prompt).toContain("SHALL or MUST");
    expect(prompt).toContain("openspec/changes/<change>/specs/<capability>/spec.md");
  });
});
