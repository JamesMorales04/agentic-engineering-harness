import { describe, expect, it, vi } from "vitest";
import type { TaskContract } from "../src/core/types.js";
import { outputJsonSchema, plannerOutputSchema, type PlannerOutput } from "../src/agents/outputContracts.js";
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

function uncheckedPlan(objectives: string[]): PlannerOutput {
  return {
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
  } as PlannerOutput;
}

describe("Planner WorkGraph bounded correction", () => {
  const root = process.cwd();
  it("accepts an objective at exactly 500 characters without retry", async () => {
    const requestCorrection = vi.fn();
    const result = await compilePlannerWorkGraphWithOneCorrection({
      contract,
      plan: plan(["x".repeat(500)]),
      root,
      requestCorrection
    });

    expect(result.graph.units[0]?.objective).toHaveLength(500);
    expect(result.correctionAttempts).toBe(0);
    expect(requestCorrection).not.toHaveBeenCalled();
  });

  it("exposes the same 500-character objective bound in deterministic and provider schemas", () => {
    expect(() => plannerOutputSchema.parse({ workUnits: [{ ...plan(["x"]).workUnits[0], objective: "x".repeat(501) }] }))
      .toThrow();
    const schema = outputJsonSchema("planner") as { properties?: { workUnits?: { items?: { properties?: { objective?: { maxLength?: number } } } } } };
    expect(schema.properties?.workUnits?.items?.properties?.objective?.maxLength).toBe(500);
  });

  it("recovers an overlong first objective with one concise, evidence-bound correction", async () => {
    const initial = uncheckedPlan(["x".repeat(501)]);
    let correctionPrompt = "";
    const result = await compilePlannerWorkGraphWithOneCorrection({
      contract,
      plan: initial,
      root,
      requestCorrection: async (prompt) => {
        correctionPrompt = prompt;
        return plan(["rewrite the objective within the schema"]);
      }
    });

    expect(correctionPrompt).toContain("objective exceeds maximum 500 characters (received 501)");
    expect(correctionPrompt).toContain("rewrite it concisely so it is at most 500 characters");
    expect(correctionPrompt).toContain(JSON.stringify(initial));
    expect(correctionPrompt).not.toContain(contract.task.title);
    expect(result.correctionAttempts).toBe(1);
    expect(result.graph.units[0]?.objective).toBe("rewrite the objective within the schema");
    expect(initial.workUnits[0]?.objective).toHaveLength(501);
  });

  it("fails closed when the single corrective output is still overlong", async () => {
    const requestCorrection = vi.fn(async () => uncheckedPlan(["y".repeat(501)]));

    await expect(compilePlannerWorkGraphWithOneCorrection({
      contract,
      plan: uncheckedPlan(["x".repeat(501)]),
      root,
      requestCorrection
    })).rejects.toMatchObject({
      name: "PlannerWorkGraphCorrectionError",
      correctionAttempts: 1,
      validationIssues: [expect.stringContaining("corrective Planner output did not satisfy plannerOutputSchema")]
    });

    expect(requestCorrection).toHaveBeenCalledTimes(1);
  });

  it("preserves the invalid plan and fails closed when one correction still violates output bounds", async () => {
    const invalid = uncheckedPlan(["x".repeat(501), "y".repeat(900)]);
    let correctionPrompt = "";
    let failure: unknown;
    try {
      await compilePlannerWorkGraphWithOneCorrection({
        contract,
        plan: invalid,
        root,
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
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("workUnits");
    expect(issues[0]).toContain("500 characters");
    expect(correctionPrompt).toContain("rewrite it concisely so it is at most 500 characters");
    expect(correctionPrompt).toContain(JSON.stringify(invalid));
    expect(invalid.workUnits.map((unit) => unit.objective.length)).toEqual([501, 900]);
  });

  it("does not issue an unbounded second retry when corrective validation fails", async () => {
    const requestCorrection = vi.fn(async () => uncheckedPlan(["z".repeat(700)]));

    try {
      await compilePlannerWorkGraphWithOneCorrection({
        contract,
        plan: uncheckedPlan(["x".repeat(501), "y".repeat(501)]),
        root,
        requestCorrection
      });
      throw new Error("expected correction to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PlannerWorkGraphCorrectionError);
      expect((error as PlannerWorkGraphCorrectionError).validationIssues).toHaveLength(1);
      expect((error as PlannerWorkGraphCorrectionError).validationIssues[0]).toContain("corrective Planner output did not satisfy plannerOutputSchema");
    }

    expect(requestCorrection).toHaveBeenCalledTimes(1);
  });
});
