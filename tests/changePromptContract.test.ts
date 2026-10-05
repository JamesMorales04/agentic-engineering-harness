import { describe, expect, it } from "vitest";
import {
  buildExplorerPrompt,
  buildPlannerPrompt,
  buildSpecManagerPrompt,
  buildSpecManagerMismatchRetryNote,
  isSpecManagerChangeMismatch,
  shouldRetrySpecManagerChangeMismatch,
  SPEC_MANAGER_CHANGE_MISMATCH_MAX_RETRIES,
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
