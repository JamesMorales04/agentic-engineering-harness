import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { TaskContract } from "../src/core/types.js";
import { plannerOutputSchema, type PlannerOutput } from "../src/agents/outputContracts.js";
import { compilePlannerWorkGraphWithOneCorrection } from "../src/agents/plannerWorkGraphCorrection.js";

const contract: TaskContract = {
  version: 1,
  task: { id: "TASK-SCOPE-SHAPE", title: "Validate plan scope shape" },
  routing: { route: "DELEGATED", assurance: "STANDARD" },
  requirements: []
};

function planWithScopes(scopes: string[][]): PlannerOutput {
  return plannerOutputSchema.parse({
    workUnits: scopes.map((scope, index) => ({
      id: `unit-${index + 1}`,
      objective: `Work unit ${index + 1}`,
      scope,
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

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-plan-scope-"));
  await fs.mkdir(path.join(root, "docs", "evidence", "s9"), { recursive: true });
  await fs.writeFile(path.join(root, "docs", "evidence", "s9", "evidence.md"), "# evidence\n");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
  return root;
}

describe("plan-time scope-shape validation (fail-closed, no broadening)", () => {
  it("rejects a bare directory scope that exists on disk", async () => {
    const root = await makeRoot();
    try {
      const plan = planWithScopes([["docs/evidence/s9"]]);
      await expect(
        compilePlannerWorkGraphWithOneCorrection({
          contract,
          plan,
          root
        })
      ).rejects.toThrow(/WORK_GRAPH_INVALID.*'unit-1'.*bare directory scope.*docs\/evidence\/s9.*exact file path.*s9\/\*\*/is);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("accepts explicit recursive and exact-file scopes", async () => {
    const root = await makeRoot();
    try {
      const plan = planWithScopes([["docs/evidence/s9/**", "src/value.ts", "**"]]);
      const result = await compilePlannerWorkGraphWithOneCorrection({
        contract,
        plan,
        root
      });
      expect(result.graph.units).toHaveLength(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
