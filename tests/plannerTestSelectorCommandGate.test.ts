import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TaskContract } from "../src/core/types.js";
import {
  buildPlannerCommandForbiddenSelectors,
  compilePlannerWorkGraphWithOneCorrection,
  findPlannerCommandNameSelectorIssues,
  PLANNER_TEST_SELECTOR_IS_COMMAND,
  PlannerWorkGraphCorrectionError,
} from "../src/agents/plannerWorkGraphCorrection.js";
import type { PlannerOutput } from "../src/agents/outputContracts.js";

const contract: TaskContract = {
  version: 1,
  task: { id: "TASK-D28", title: "D28 gate" },
  routing: { route: "DELEGATED", assurance: "STANDARD" },
  requirements: [],
};

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) {
    const root = roots.pop()!;
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function makeRoot(scripts: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-d28-"));
  roots.push(root);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts }));
  return root;
}

function planWithSelectors(selectors: string[]): PlannerOutput {
  return {
    workUnits: [
      {
        id: "WU-1",
        objective: "Do bounded work",
        scope: ["src/**"],
        dependencies: [],
        requirementRefs: [],
        acceptanceRefs: [],
        competencies: [],
        riskTags: [],
        changeKinds: ["source"],
        risk: "low",
      },
    ],
    affectedAreas: [],
    reviewDimensions: [],
    validationRequirements: [
      {
        version: 1,
        id: "VR-1",
        property: "npm test passes",
        kind: "command",
        scope: ["src/tasks.js"],
        evidenceNeeded: ["passing run"],
        requirementRefs: [],
        acceptanceRefs: [],
        testSelectors: selectors,
      },
    ],
    outOfScopeImprovements: [],
    filesNeededOutsideScope: [],
  } as unknown as PlannerOutput;
}

describe("D28 planner testSelector==command fail-fast gate", () => {
  it("(a) command-equal selector fails with the precise diagnostic", async () => {
    const root = await makeRoot({ test: "playwright test --reporter=json" });
    const bad = planWithSelectors(["npm test"]);
    const scripts = { test: "playwright test --reporter=json" };

    // Pure routing decision: exact command names are issues.
    const issues = findPlannerCommandNameSelectorIssues(bad, scripts);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain(PLANNER_TEST_SELECTOR_IS_COMMAND);
    expect(issues[0]).toContain("VR-1");
    expect(issues[0]).toContain("npm test");
    expect(issues[0]).toContain("use test titles or file paths as they will appear in reporter output, never command names");

    // Compile boundary rejects fail-fast (no correction turn available).
    await expect(
      compilePlannerWorkGraphWithOneCorrection({ contract, plan: bad, root })
    ).rejects.toMatchObject({
      name: "PlannerWorkGraphCorrectionError",
      correctionAttempts: 0,
    });
    try {
      await compilePlannerWorkGraphWithOneCorrection({ contract, plan: bad, root });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(PlannerWorkGraphCorrectionError);
      const err = error as PlannerWorkGraphCorrectionError;
      expect(err.validationIssues.join("; ")).toContain(PLANNER_TEST_SELECTOR_IS_COMMAND);
      expect(err.validationIssues.join("; ")).toContain("VR-1");
      expect(err.validationIssues.join("; ")).toContain("npm test");
    }

    // Whitespace-padded, `npm run test`, and raw script-body forms also reject.
    expect(
      findPlannerCommandNameSelectorIssues(planWithSelectors(["  npm test  "]), scripts)
    ).toHaveLength(1);
    expect(
      findPlannerCommandNameSelectorIssues(planWithSelectors(["npm run test"]), scripts)
    ).toHaveLength(1);
    expect(
      findPlannerCommandNameSelectorIssues(
        planWithSelectors(["playwright test --reporter=json"]),
        scripts
      )
    ).toHaveLength(1);
  });

  it("(a-extra) custom script bare and body forms reject", () => {
    const scripts = { lint: "eslint src/**", test: "playwright test" };
    expect(
      findPlannerCommandNameSelectorIssues(planWithSelectors(["npm run lint"]), scripts)
    ).toHaveLength(1);
    expect(
      findPlannerCommandNameSelectorIssues(planWithSelectors(["eslint src/**"]), scripts)
    ).toHaveLength(1);
    expect(buildPlannerCommandForbiddenSelectors(scripts).has("npm run lint")).toBe(true);
  });

  it("(b) file-path and title selectors pass compile unchanged", async () => {
    const root = await makeRoot({ test: "playwright test --reporter=json" });
    const good = planWithSelectors(["tests/tasks.unit.spec.js", "blank-title rejection"]);
    const scripts = { test: "playwright test --reporter=json" };
    expect(findPlannerCommandNameSelectorIssues(good, scripts)).toEqual([]);

    // Near-misses are NOT rejected (narrow exact-match scope).
    expect(
      findPlannerCommandNameSelectorIssues(planWithSelectors(["npm test passing"]), scripts)
    ).toEqual([]);
    expect(
      findPlannerCommandNameSelectorIssues(planWithSelectors(["NPM TEST"]), scripts)
    ).toEqual([]);

    const result = await compilePlannerWorkGraphWithOneCorrection({
      contract,
      plan: good,
      root,
      requestCorrection: vi.fn(),
    });
    expect(result.correctionAttempts).toBe(0);
    expect(result.plan.validationRequirements[0]?.testSelectors).toEqual([
      "tests/tasks.unit.spec.js",
      "blank-title rejection",
    ]);
  });

  it("(c) the failure class routes to the one-correction budget, not terminal", async () => {
    const root = await makeRoot({ test: "playwright test --reporter=json" });
    const bad = planWithSelectors(["npm test"]);
    const fixed = planWithSelectors(["blank-title rejection"]);
    let prompt = "";
    const requestCorrection = vi.fn(async (p: string) => {
      prompt = p;
      return fixed;
    });

    const result = await compilePlannerWorkGraphWithOneCorrection({
      contract,
      plan: bad,
      root,
      requestCorrection,
    });
    expect(requestCorrection).toHaveBeenCalledTimes(1);
    expect(result.correctionAttempts).toBe(1);
    expect(result.plan.validationRequirements[0]?.testSelectors).toEqual([
      "blank-title rejection",
    ]);
    expect(prompt).toContain(PLANNER_TEST_SELECTOR_IS_COMMAND);
    expect(prompt).toContain("VR-1");

    // A still-bad correction exhausts the single budget fail-closed.
    const stillBad = vi.fn(async () => bad);
    await expect(
      compilePlannerWorkGraphWithOneCorrection({
        contract,
        plan: bad,
        root,
        requestCorrection: stillBad,
      })
    ).rejects.toMatchObject({
      name: "PlannerWorkGraphCorrectionError",
      correctionAttempts: 1,
    });
    expect(stillBad).toHaveBeenCalledTimes(1);
  });
});
