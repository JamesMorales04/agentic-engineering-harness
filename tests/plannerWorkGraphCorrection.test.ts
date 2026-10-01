import { describe, expect, it, vi } from "vitest";
import type { TaskContract } from "../src/core/types.js";
import { plannerOutputSchema, type PlannerOutput } from "../src/agents/outputContracts.js";
import {
  compilePlannerWorkGraphWithOneCorrection,
  PlannerWorkGraphCorrectionError
} from "../src/agents/plannerWorkGraphCorrection.js";

const contract: TaskContract = {
  version: 1,
  task: { id: "TASK-PLANNER-LIMIT", title: "Build bounded WorkGraph" },
  routing: { route: "DELEGATED", assurance: "STANDARD" },
  requirements: []
};

function plan(objectives: string[]): PlannerOutput {
  return plannerOutputSchema.parse({
    workUnits: objectives.map((objective, index) => ({
      id: `unit-${index + 1}`,
      objective,
      scope: ["src/**"],
      dependencies: [],
      requirementRefs: [],
      acceptanceRefs: [],
      competencies: [],
      riskTags: [],
      changeKinds: ["source"],
      risk: "low"
    }))
  });
}

describe("Planner WorkGraph bounded correction", () => {
  it("accepts an objective at exactly 500 characters without retry", async () => {
    const requestCorrection = vi.fn();
    const result = await compilePlannerWorkGraphWithOneCorrection({
      contract,
      plan: plan(["x".repeat(500)]),
      requestCorrection
    });

    expect(result.graph.units[0]?.objective).toHaveLength(500);
    expect(result.correctionAttempts).toBe(0);
    expect(requestCorrection).not.toHaveBeenCalled();
  });

  it("recovers an overlong first objective with one concise, evidence-bound correction", async () => {
    const initial = plan(["x".repeat(501)]);
    let correctionPrompt = "";
    const result = await compilePlannerWorkGraphWithOneCorrection({
      contract,
      plan: initial,
      requestCorrection: async (prompt) => {
        correctionPrompt = prompt;
        return plan(["rewrite the objective within the schema"]);
      }
    });

    expect(correctionPrompt).toContain("objective exceeds maximum 500 characters (received 501)");
    expect(correctionPrompt).toContain(JSON.stringify(initial));
    expect(correctionPrompt).not.toContain(contract.task.title);
    expect(result.correctionAttempts).toBe(1);
    expect(result.graph.units[0]?.objective).toBe("rewrite the objective within the schema");
    expect(initial.workUnits[0]?.objective).toHaveLength(501);
  });

  it("fails closed when the single corrective output is still overlong", async () => {
    const requestCorrection = vi.fn(async () => plan(["y".repeat(501)]));

    await expect(compilePlannerWorkGraphWithOneCorrection({
      contract,
      plan: plan(["x".repeat(501)]),
      requestCorrection
    })).rejects.toMatchObject({
      name: "PlannerWorkGraphCorrectionError",
      correctionAttempts: 1,
      validationIssues: [expect.stringContaining("objective exceeds maximum 500 characters")]
    });

    expect(requestCorrection).toHaveBeenCalledTimes(1);
  });

  it("reports every invalid WorkUnit and never silently truncates", async () => {
    const invalid = plan(["x".repeat(501), "y".repeat(900)]);
    let correctionPrompt = "";
    let failure: unknown;
    try {
      await compilePlannerWorkGraphWithOneCorrection({
        contract,
        plan: invalid,
        requestCorrection: async (prompt) => {
          correctionPrompt = prompt;
          return invalid;
        }
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(PlannerWorkGraphCorrectionError);
    const issues = (failure as PlannerWorkGraphCorrectionError).validationIssues;
    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain("workUnits[0]");
    expect(issues[0]).toContain("received 501");
    expect(issues[1]).toContain("workUnits[1]");
    expect(issues[1]).toContain("received 900");
    expect(correctionPrompt).toContain(JSON.stringify(invalid));
    expect(invalid.workUnits.map((unit) => unit.objective.length)).toEqual([501, 900]);
  });

  it("does not issue an unbounded second retry when corrective validation fails", async () => {
    const requestCorrection = vi.fn(async () => plan(["z".repeat(700)]));

    try {
      await compilePlannerWorkGraphWithOneCorrection({
        contract,
        plan: plan(["x".repeat(501), "y".repeat(501)]),
        requestCorrection
      });
      throw new Error("expected correction to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PlannerWorkGraphCorrectionError);
      expect((error as PlannerWorkGraphCorrectionError).validationIssues).toHaveLength(1);
      expect((error as PlannerWorkGraphCorrectionError).validationIssues[0]).toContain("maximum 500");
    }

    expect(requestCorrection).toHaveBeenCalledTimes(1);
  });
});
