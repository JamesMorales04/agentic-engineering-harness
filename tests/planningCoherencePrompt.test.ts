import { describe, expect, it } from "vitest";
import { buildPlannerPrompt } from "../src/operations/change.js";
import { buildCanonicalPlannerPromptV1, executePlannerWaves } from "../src/agents/waveExecutor.js";
import type { TaskContract } from "../src/core/types.js";
import type { ChangeOperationPayload } from "../src/operations/state.js";
import type { DurableAgentEvidence } from "../src/operations/changeHandoff.js";
import type { ExplorerOutput } from "../src/agents/outputContracts.js";

/**
 * FAM-PROMPT: dual planner-prompt unification. The canonical CHANGE prompt
 * (`buildPlannerPrompt`) and the `executePlannerWaves` fallback prompt must
 * carry equivalent normative content (operation id, frozen readRoots, explorer
 * evidence, competency allowlist, AEH_RESULT_JSON marker); planning without
 * frozen roots fails closed instead of launching an unbounded planner turn.
 */

const payload: ChangeOperationPayload = {
  request: "Add the FAREWELL export to the greeting fixture.",
  files: ["src/greeting.mjs"],
  domains: ["architecture"],
  risk: "low",
  acceptance: ["node scripts/validate.mjs passes"],
  title: "Formal greeting boundary change"
} as unknown as ChangeOperationPayload;

const contract: TaskContract = {
  version: 1,
  task: { id: "CHANGE-TEST-1", title: "Formal greeting boundary change" },
  scope: { allowed: ["src/greeting.mjs"], forbidden: [], frozen: [] },
  routing: { intent: "implement", domains: ["architecture"], risk: "low", route: "DELEGATED", assurance: "ELEVATED" },
  constraints: { breakingApiChanges: false, newDependencies: false, schemaChanges: false },
  requirements: [{ id: "CHANGE-TEST-1-R1", description: "FAREWELL is exported" }]
};

const explorerEvidence: DurableAgentEvidence<ExplorerOutput> = {
  artifact: ".harness/operations/CHANGE-TEST-1/explorer.json",
  sha256: "a".repeat(64),
  payload: { version: 1, summary: "greeting fixture discovered", files: [], symbols: [], tests: [], boundaries: [], findings: [] } as unknown as ExplorerOutput
};

const readRoots = ["/work/tree", "/work/tree/.git"];

describe("planner prompt parity (FAM-PROMPT)", () => {
  it("delegates the canonical builder to the shared content (identical output)", () => {
    const canonical = buildPlannerPrompt("CHANGE-TEST-1", contract, payload, explorerEvidence, [], readRoots);
    const shared = buildCanonicalPlannerPromptV1({
      operationId: "CHANGE-TEST-1",
      operationKind: "CHANGE",
      contract,
      request: payload.request,
      explorerContext: [
        `Explorer durable result artifact: ${explorerEvidence.artifact}`,
        `Explorer evidence projection:\n${JSON.stringify(explorerEvidence.payload).slice(0, 12_000)}`
      ].join("\n"),
      inputsPrompt: "Controller-resolved durable inputs: none.",
      readRoots
    });
    // Same operation id, roots, requirement ids, competency allowlist and
    // marker whichever builder runs. The explorer projection is rendered by
    // the CHANGE wrapper (compactJson bound); the shared core carries it
    // through verbatim, so the artifact line must survive in both.
    for (const prompt of [canonical, shared]) {
      expect(prompt).toContain("Operation: CHANGE-TEST-1");
      expect(prompt).toContain("Frozen readable roots");
      expect(prompt).toContain("/work/tree");
      expect(prompt).toContain("/work/tree/.git");
      expect(prompt).toContain("Do not search prior or sibling worktrees");
      expect(prompt).toContain("Symlinks do not grant access");
      expect(prompt).toContain("CHANGE-TEST-1-R1");
      expect(prompt).toContain("Known competency ids");
      expect(prompt).toContain("hard-protected");
      expect(prompt).toContain("AEH_RESULT_JSON=");
      expect(prompt).toContain("PLANNER_RESULT_ARTIFACT_MISSING");
      expect(prompt).toContain(".harness/operations");
    }
    expect(canonical).toContain(explorerEvidence.artifact);
    expect(shared).toContain(explorerEvidence.artifact);
  });

  it("renders the disabled-explorer fallback through the shared builder", () => {
    const prompt = buildPlannerPrompt("CHANGE-TEST-1", contract, payload, undefined, [], readRoots);
    expect(prompt).toContain("Explorer is disabled/unavailable by topology; no explorer result was expected.");
    expect(prompt).toContain("AEH_RESULT_JSON=");
  });

  it("labels the operation kind truthfully per entry path (CHANGE vs RUN)", () => {
    // Luna LOW: the shared fallback serves RUN operations too; a hardcoded
    // "CHANGE operation" would mislabel them. The kind word is frozen caller
    // context, never model output.
    const changePrompt = buildCanonicalPlannerPromptV1({
      operationId: "RUN-TEST-1",
      operationKind: "CHANGE",
      contract,
      request: payload.request,
      explorerContext: "Explorer is disabled/unavailable by topology; no explorer result was expected.",
      inputsPrompt: "Controller-resolved durable inputs: none.",
      readRoots
    });
    expect(changePrompt).toContain("for this CHANGE operation");
    expect(changePrompt).not.toContain("for this RUN operation");
    const runPrompt = buildCanonicalPlannerPromptV1({
      operationId: "RUN-TEST-1",
      operationKind: "RUN",
      contract,
      request: payload.request,
      explorerContext: "Explorer is disabled/unavailable by topology; no explorer result was expected.",
      inputsPrompt: "Controller-resolved durable inputs: none.",
      readRoots
    });
    expect(runPrompt).toContain("for this RUN operation");
    expect(runPrompt).not.toContain("for this CHANGE operation");
    expect(runPrompt).toContain("AEH_RESULT_JSON=");
  });

  it("keeps the empty-roots fallback text in both builders (runPlanning lease semantics unchanged)", () => {
    // The shared builder still renders the canonical unavailable-roots lease
    // text; the fail-closed frozen-roots gate lives in the waveExecutor
    // fallback path (asserted below), not in runPlanning.
    for (const prompt of [
      buildCanonicalPlannerPromptV1({
        operationId: "CHANGE-TEST-1",
        operationKind: "CHANGE",
        contract,
        request: payload.request,
        explorerContext: "Explorer is disabled/unavailable by topology; no explorer result was expected.",
        inputsPrompt: "Controller-resolved durable inputs: none.",
        readRoots: []
      }),
      buildPlannerPrompt("CHANGE-TEST-1", contract, payload, undefined, [], [])
    ]) {
      expect(prompt).toContain("- unavailable; do not search outside the current repository root");
      expect(prompt).toContain("AEH_RESULT_JSON=");
    }
  });

  it("fails the wave fallback closed when no frozen roots are supplied (no planner session launches)", async () => {
    const result = await executePlannerWaves({
      root: "/work/tree",
      stateRoot: "/work/tree",
      config: { version: 1, project: { name: "fixture" } } as never,
      contract,
      plannerSelection: { logicalAgent: "planner" } as never,
      implementationSelection: { logicalAgent: "implementer" } as never,
      executionCatalog: {} as never,
      capabilityRegistry: {} as never,
      plannerPromptContext: { operationId: "CHANGE-TEST-1", readRoots: [] },
      revalidate: async () => { throw new Error("must not revalidate on pre-execution failure"); }
    });
    expect(result.used).toBe(true);
    expect(result.preExecutionFailure).toBe(true);
    expect(result.sessions).toEqual([]);
    expect(`${result.aggregateSession?.stdout ?? ""}\n${result.aggregateSession?.stderr ?? ""}`).toContain("PLANNER_FROZEN_ROOTS_REQUIRED");
  });
});
