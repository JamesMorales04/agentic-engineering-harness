import { describe, expect, it } from "vitest";
import { promoteInteractiveOperation } from "../src/operations/interactive.js";

describe("managed-lead interactive operation promotion", () => {
  it("promotes synchronous audit to detached operation", () => {
    expect(promoteInteractiveOperation(
      ["audit", "review the repository", "--risk", "high"],
      { PASEO_AGENT_ID: "lead-1" }
    )).toEqual({
      kind: "audit",
      operationArgv: ["audit", "review the repository", "--risk", "high"]
    });
  });

  it("promotes a standard sealed run and preserves project/profile", () => {
    expect(promoteInteractiveOperation(
      ["run", "TASK-123", "/repo", "--profile", "quality"],
      { PASEO_AGENT_ID: "lead-1" }
    )).toEqual({
      kind: "run",
      operationArgv: ["run", "TASK-123", "/repo", "--profile", "quality"]
    });
  });

  it("leaves non-interactive compatibility commands untouched", () => {
    expect(promoteInteractiveOperation(["audit", "review"], {})).toBeUndefined();
    expect(promoteInteractiveOperation(["run", "TASK-1"], { PASEO_AGENT_ID: "lead", AEH_ALLOW_SYNC_INTERACTIVE: "1" })).toBeUndefined();
  });

  it("fails closed for synchronous issue/complex run shortcuts in a managed lead", () => {
    expect(() => promoteInteractiveOperation(
      ["run", "--issue", "26"],
      { PASEO_AGENT_ID: "lead-1" }
    )).toThrow("cannot execute synchronous 'aeh run' option --issue");
  });
});
