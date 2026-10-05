import { describe, expect, it } from "vitest";
import {
  buildExplorerPrompt,
  buildPlannerPrompt,
  buildSpecManagerPrompt,
  buildSpecManagerMismatchRetryNote,
  buildSpecManagerIncompleteRetryNote,
  isSpecManagerChangeMismatch,
  isSpecManagerIncompleteResult,
  shouldRetrySpecManagerChangeMismatch,
  shouldRetrySpecManagerIncomplete,
  SPEC_MANAGER_CHANGE_MISMATCH_MAX_RETRIES,
  SPEC_MANAGER_INCOMPLETE_MAX_RETRIES,
  validateSpecAuthoringResult,
} from "../src/operations/change.js";
import { outputJsonSchema, specAuthoringOutputSchema } from "../src/agents/outputContracts.js";
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

describe("spec-manager change echo (CHANGE-20261005T033416Z-be9f5ac1 rev57)", () => {
  function readyPayload(change: string) {
    return {
      change,
      status: "READY" as const,
      artifacts: {
        proposal: "proposal",
        tasks: "- [ ] do",
        specs: [{
          capability: "greeting",
          content: "## ADDED Requirements\n### Requirement: Greet\nThe system SHALL greet.\n#### Scenario: greet\n- **GIVEN** a user\n- **WHEN** greeted\n- **THEN** hello"
        }]
      },
      requirements: [],
      unresolvedDecisions: [],
      decisionRequests: [],
      validationReady: true
    };
  }

  it("prompt echoes the exact OpenSpec change ID into output field change", () => {
    const prompt = buildSpecManagerPrompt(payload, "change-test-1", undefined, undefined, []);
    expect(prompt).toContain('Set output field "change" to exactly');
    expect(prompt).toContain("'change-test-1'");
    expect(prompt).toContain("it is an identifier, not a title");
  });

  it("schema rejects title-shaped change at the durable-handoff gate", () => {
    expect(specAuthoringOutputSchema.safeParse(readyPayload("Formal greeting boundary change")).success).toBe(false);
    expect(specAuthoringOutputSchema.safeParse(readyPayload("My Title String")).success).toBe(false);
    expect(specAuthoringOutputSchema.safeParse(readyPayload("change-test-1")).success).toBe(true);
    const changeJson = (outputJsonSchema("spec-authoring")?.properties as Record<string, unknown> | undefined)?.["change"] as
      | { pattern?: string }
      | undefined;
    expect(changeJson?.pattern).toBe("^[a-z0-9]+(?:-[a-z0-9]+)*$");
  });

  it("retry-once cures a first mismatch then throws exact-equality on second", () => {
    expect(SPEC_MANAGER_CHANGE_MISMATCH_MAX_RETRIES).toBe(1);
    // Exact-equality checker is preserved (no normalization/fuzzy-match).
    expect(() => validateSpecAuthoringResult("change-test-1", readyPayload("change-test-1") as never)).not.toThrow();
    const firstMismatch = (() => {
      try {
        validateSpecAuthoringResult("change-test-1", readyPayload("other-slug") as never);
      } catch (error) {
        return error;
      }
      throw new Error("expected SPEC_MANAGER_CHANGE_MISMATCH");
    })();
    expect(isSpecManagerChangeMismatch(firstMismatch)).toBe(true);
    expect(String((firstMismatch as Error).message)).toContain("SPEC_MANAGER_CHANGE_MISMATCH");
    expect(String((firstMismatch as Error).message)).toContain("expected 'change-test-1'");
    expect(isSpecManagerChangeMismatch(new Error("SPEC_MANAGER_READY_INVALID: nope"))).toBe(false);

    // Deterministic counter-bounded gate: exactly one retry.
    expect(shouldRetrySpecManagerChangeMismatch(firstMismatch, 0)).toBe(true);
    expect(shouldRetrySpecManagerChangeMismatch(firstMismatch, 1)).toBe(false);
    expect(shouldRetrySpecManagerChangeMismatch(new Error("SPEC_MANAGER_READY_INVALID: nope"), 0)).toBe(false);

    // Retry note re-asserts the expected ID deterministically.
    const note = buildSpecManagerMismatchRetryNote("change-test-1");
    expect(note).toContain("SPEC_MANAGER_CHANGE_MISMATCH");
    expect(note).toContain("'change-test-1'");
    expect(note).toContain("it is an identifier, not a title");

    // Simulate the production retry loop: first mismatch retries and cures.
    let retriesSoFar = 0;
    const attempts = ["other-slug", "change-test-1"];
    let cured: unknown;
    for (const change of attempts) {
      try {
        validateSpecAuthoringResult("change-test-1", readyPayload(change) as never);
        cured = change;
        break;
      } catch (error) {
        if (!shouldRetrySpecManagerChangeMismatch(error, retriesSoFar)) throw error;
        retriesSoFar += 1;
      }
    }
    expect(cured).toBe("change-test-1");
    expect(retriesSoFar).toBe(1);

    // A second mismatch still throws the exact-equality error.
    let secondRetries = 0;
    expect(() => {
      for (const change of ["other-slug", "another-slug"]) {
        try {
          validateSpecAuthoringResult("change-test-1", readyPayload(change) as never);
        } catch (error) {
          if (!shouldRetrySpecManagerChangeMismatch(error, secondRetries)) throw error;
          secondRetries += 1;
        }
      }
    }).toThrow(/SPEC_MANAGER_CHANGE_MISMATCH: expected 'change-test-1', received 'another-slug'/);
    expect(secondRetries).toBe(1);
  });
});

describe("spec-manager incomplete READY retry (CHANGE-20261005T053426Z-be9f5ac1 rev57)", () => {
  const canonicalSpecs = [{
    capability: "greeting",
    content: "## ADDED Requirements\n### Requirement: Greet\nThe system SHALL greet.\n#### Scenario: greet\n- **GIVEN** a user\n- **WHEN** greeted\n- **THEN** hello"
  }];

  function readyWithArtifacts(change: string, artifacts: Record<string, unknown>) {
    return {
      change,
      status: "READY" as const,
      artifacts: { specs: [], ...artifacts },
      requirements: [],
      unresolvedDecisions: [],
      decisionRequests: [],
      validationReady: true
    };
  }

  function blockedWithoutArtifacts(change: string) {    return {
      change,
      status: "BLOCKED" as const,
      artifacts: { specs: [] },
      requirements: [],
      unresolvedDecisions: [],
      decisionRequests: [{
        issue: "A genuine product decision is required.",
        whatTried: ["derived everything derivable from inputs"],
        whyUnresolvable: "Two viable options remain with different consequences.",
        choices: [{ choiceId: "a", label: "Option A", description: "First option.", consequences: ["ships A"] }],
        workThatCanContinue: []
      }],
      validationReady: false
    };
  }

  it("prompt states the explicit READY proposal/tasks requirement", () => {
    const prompt = buildSpecManagerPrompt(payload, "change-test-1", undefined, undefined, []);
    expect(prompt).toContain("proposal.md");
    expect(prompt).toContain("tasks.md");
    expect(prompt).toContain("SPEC_MANAGER_INCOMPLETE_RESULT");
    expect(prompt).toContain("are REQUIRED");
  });

  it("schema rejects READY without proposal/tasks but accepts BLOCKED without them", () => {
    // Exact failed-op shape: proposal + design present, tasks key absent, specs empty.
    const missingTasks = readyWithArtifacts("change-test-1", { proposal: "# Proposal" });
    const missingTasksParse = specAuthoringOutputSchema.safeParse(missingTasks);
    expect(missingTasksParse.success).toBe(false);
    if (!missingTasksParse.success) {
      expect(JSON.stringify(missingTasksParse.error.issues)).toContain("SPEC_MANAGER_INCOMPLETE_RESULT");
    }
    const missingProposal = readyWithArtifacts("change-test-1", { tasks: "- [ ] work" });
    expect(specAuthoringOutputSchema.safeParse(missingProposal).success).toBe(false);
    const whitespaceTasks = readyWithArtifacts("change-test-1", { proposal: "# Proposal", tasks: "   " });
    expect(specAuthoringOutputSchema.safeParse(whitespaceTasks).success).toBe(false);
    // BLOCKED shape is unchanged: no proposal/tasks required.
    expect(specAuthoringOutputSchema.safeParse(blockedWithoutArtifacts("change-test-1")).success).toBe(true);
  });

  it("validator still rejects READY without tasks with the exact INCOMPLETE error (no weakening)", () => {
    const missingTasks = readyWithArtifacts("change-test-1", { proposal: "# Proposal" });
    expect(() => validateSpecAuthoringResult("change-test-1", missingTasks as never))
      .toThrow("SPEC_MANAGER_INCOMPLETE_RESULT: READY spec authoring must identify proposal.md and tasks.md artifacts.");
  });

  it("retry-once cures a first incomplete then throws on second", () => {
    expect(SPEC_MANAGER_INCOMPLETE_MAX_RETRIES).toBe(1);
    const firstIncomplete = (() => {
      try {
        validateSpecAuthoringResult("change-test-1", readyWithArtifacts("change-test-1", { proposal: "# Proposal" }) as never);
      } catch (error) {
        return error;
      }
      throw new Error("expected SPEC_MANAGER_INCOMPLETE_RESULT");
    })();
    expect(isSpecManagerIncompleteResult(firstIncomplete)).toBe(true);
    expect(isSpecManagerIncompleteResult(new Error("SPEC_MANAGER_READY_INVALID: nope"))).toBe(false);
    expect(isSpecManagerIncompleteResult(new Error("SPEC_MANAGER_CHANGE_MISMATCH: expected 'a', received 'b'"))).toBe(false);

    // Deterministic counter-bounded gate: exactly one retry.
    expect(shouldRetrySpecManagerIncomplete(firstIncomplete, 0)).toBe(true);
    expect(shouldRetrySpecManagerIncomplete(firstIncomplete, 1)).toBe(false);
    expect(shouldRetrySpecManagerIncomplete(new Error("SPEC_MANAGER_READY_INVALID: nope"), 0)).toBe(false);

    // Retry note re-asserts both required artifacts deterministically.
    const note = buildSpecManagerIncompleteRetryNote("change-test-1");
    expect(note).toContain("SPEC_MANAGER_INCOMPLETE_RESULT");
    expect(note).toContain("artifacts.proposal");
    expect(note).toContain("artifacts.tasks");
    expect(note).toContain("proposal.md");
    expect(note).toContain("tasks.md");

    // Simulate the production retry loop: first incomplete retries and cures.
    let retriesSoFar = 0;
    const attempts = [
      readyWithArtifacts("change-test-1", { proposal: "# Proposal" }),
      readyWithArtifacts("change-test-1", { proposal: "# Proposal", tasks: "- [ ] work", specs: canonicalSpecs })
    ];
    let cured = false;
    for (const attempt of attempts) {
      try {
        validateSpecAuthoringResult("change-test-1", attempt as never);
        cured = true;
        break;
      } catch (error) {
        if (!shouldRetrySpecManagerIncomplete(error, retriesSoFar)) throw error;
        retriesSoFar += 1;
      }
    }
    expect(cured).toBe(true);
    expect(retriesSoFar).toBe(1);

    // A second incomplete still throws the exact error.
    let secondRetries = 0;
    expect(() => {
      for (const attempt of [
        readyWithArtifacts("change-test-1", { proposal: "# Proposal" }),
        readyWithArtifacts("change-test-1", { proposal: "# Proposal" })
      ]) {
        try {
          validateSpecAuthoringResult("change-test-1", attempt as never);
        } catch (error) {
          if (!shouldRetrySpecManagerIncomplete(error, secondRetries)) throw error;
          secondRetries += 1;
        }
      }
    }).toThrow(/SPEC_MANAGER_INCOMPLETE_RESULT: READY spec authoring must identify proposal\.md and tasks\.md artifacts\./);
    expect(secondRetries).toBe(1);
  });

  it("recognizes the handoff-wrapped incomplete but not unrelated handoff rejections", () => {
    const wrapped = new Error(
      "SPEC_MANAGER_RESULT_INVALID: Error: [{ path: artifacts.tasks, message: 'SPEC_MANAGER_INCOMPLETE_RESULT: READY spec authoring must identify proposal.md and tasks.md artifacts.' }]"
    );
    expect(isSpecManagerIncompleteResult(wrapped)).toBe(true);
    expect(shouldRetrySpecManagerIncomplete(wrapped, 0)).toBe(true);
    expect(shouldRetrySpecManagerIncomplete(wrapped, 1)).toBe(false);
    const unrelated = new Error("SPEC_MANAGER_RESULT_INVALID: Error: [{ path: change, message: 'Invalid string' }]");
    expect(isSpecManagerIncompleteResult(unrelated)).toBe(false);
    expect(shouldRetrySpecManagerIncomplete(unrelated, 0)).toBe(false);
  });

  it("keeps mismatch and incomplete retry budgets independent", () => {
    expect(SPEC_MANAGER_CHANGE_MISMATCH_MAX_RETRIES).toBe(1);
    expect(SPEC_MANAGER_INCOMPLETE_MAX_RETRIES).toBe(1);
    const mismatch = new Error("SPEC_MANAGER_CHANGE_MISMATCH: expected 'change-test-1', received 'other-slug'.");
    const incomplete = new Error("SPEC_MANAGER_INCOMPLETE_RESULT: READY spec authoring must identify proposal.md and tasks.md artifacts.");
    expect(shouldRetrySpecManagerChangeMismatch(mismatch, 1)).toBe(false);
    expect(shouldRetrySpecManagerIncomplete(incomplete, 0)).toBe(true);
    expect(isSpecManagerChangeMismatch(incomplete)).toBe(false);
    expect(isSpecManagerIncompleteResult(mismatch)).toBe(false);
  });
});
