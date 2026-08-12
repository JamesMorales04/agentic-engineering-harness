import { describe, expect, it } from "vitest";
import { validateQuickTaskContract } from "../src/core/quick.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
const config: HarnessProjectConfig = { version: 1, project: { name: "test" }, workflow: { quick: { maxFiles: 3 } } };
function contract(): TaskContract { return { version: 1, mode: "quick", task: { id: "Q-1", title: "Padding" }, quick: { request: "Change button padding", acceptance: ["Button uses 16px padding"], triage: { mode: "quick", reasons: [], evaluatedAt: new Date().toISOString() } }, scope: { allowed: ["src/Button.tsx"] }, routing: { intent: "implement", domains: ["frontend"], risk: "low" }, constraints: { breakingApiChanges: false, newDependencies: false, schemaChanges: false } }; }
describe("validateQuickTaskContract", () => {
  it("accepts a safe quick contract", () => expect(validateQuickTaskContract(config, contract()).ok).toBe(true));
  it("rejects quick contracts that permit schema changes", () => { const value = contract(); value.constraints!.schemaChanges = true; expect(validateQuickTaskContract(config, value).issues).toContain("quick mode requires schemaChanges=false"); });
});
