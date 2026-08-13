import { describe, expect, it } from "vitest";
import { classifyAuditFailure, selectAuditReviewers } from "../src/audit/run.js";
import { compileAuditReviewerPrompt } from "../src/audit/reviewerPrompt.js";

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

describe("audit reviewer prompt compiler", () => {
  it("compacts a large failed test run", () => {
    const stdout = `${Array.from({ length: 275 }, (_, index) => `pass-${index}`).join("\n")}\nTest Files  1 failed | 86 passed (87)\nTests  2 failed | 275 passed (277)\nenvironment 23ms`;
    const stderr = "FAIL tests/example.test.ts > reports a mismatch\nAssertionError: expected alpha but received beta\nExpected: alpha\nReceived: beta";
    const prompt = compileAuditReviewerPrompt({ reviewer: "architecture-reviewer", input: { request: "Review the engineering flow.", domains: ["architecture"], risk: "medium" }, dirtyPaths: ["package.json"], checks: [{ id: "command.check", category: "command", status: "FAIL", message: "check failed", failureClass: "ASSERTION_FAILURE", details: { command: "npm run check", exitCode: 1, stdout, stderr } }] });
    expect(prompt.length).toBeLessThan(5_000);
    expect(prompt).not.toContain("pass-274");
    expect(prompt).not.toContain("AEH_RESULT_JSON=");
    expect(prompt).toContain('"testsFailed": 2');
    expect(prompt).toContain("reports a mismatch");
  });

  it("classifies assertions before incidental environment timing text", () => {
    expect(classifyAuditFailure({ id: "command.check", category: "command", status: "FAIL", message: "check failed", details: { stdout: "environment 23ms", stderr: "AssertionError: expected alpha but received beta" } })).toBe("ASSERTION_FAILURE");
  });
});
