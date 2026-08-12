import { describe, expect, it } from "vitest";
import { selectAuditReviewers } from "../src/audit/run.js";

function topology(names: string[]) {
  return {
    routing: [],
    agents: Object.fromEntries(names.map((name) => [name, { name, role: "reviewer", disabled: false }]))
  } as never;
}

describe("audit reviewer scheduling", () => {
  it("does not silently discard the fifth default reviewer for a low-risk repository audit", () => {
    const names = ["code-quality-reviewer", "architecture-reviewer", "security-reviewer", "test-quality-reviewer", "test-reviewer"];
    expect(selectAuditReviewers(topology(names), { request: "audit" })).toEqual(names);
  });

  it("preserves explicitly requested reviewers ahead of defaults", () => {
    const names = ["custom-reviewer", "code-quality-reviewer", "architecture-reviewer", "security-reviewer", "test-quality-reviewer", "test-reviewer"];
    const selected = selectAuditReviewers(topology(names), { request: "audit", reviewers: ["custom-reviewer"], risk: "medium" });
    expect(selected[0]).toBe("custom-reviewer");
    expect(selected).toHaveLength(6);
  });
});
