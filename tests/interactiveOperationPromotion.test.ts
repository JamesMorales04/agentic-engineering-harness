import { describe, expect, it } from "vitest";
import { promoteInteractiveOperation } from "../src/operations/interactive.js";

const leadEnv = {
  PASEO_AGENT_ID: "lead-1",
  AEH_MANAGED_AGENT: "1",
  AEH_INTERACTIVE_LEAD: "1",
  AEH_ORCHESTRATION_ALLOWED: "1"
};

describe("managed-lead interactive operation promotion", () => {
  it("promotes synchronous audit to detached operation only for the explicit managed lead", () => {
    expect(promoteInteractiveOperation(
      ["audit", "review the repository", "--risk", "high"],
      leadEnv
    )).toEqual({
      kind: "audit",
      operationArgv: ["audit", "review the repository", "--risk", "high"]
    });
  });

  it("promotes a standard sealed run and preserves project/profile", () => {
    expect(promoteInteractiveOperation(
      ["run", "TASK-123", "/repo", "--profile", "quality"],
      leadEnv
    )).toEqual({
      kind: "run",
      operationArgv: ["run", "TASK-123", "/repo", "--profile", "quality"]
    });
  });

  it("does not treat an arbitrary Paseo reviewer as the interactive lead", () => {
    expect(promoteInteractiveOperation(
      ["audit", "review"],
      {
        PASEO_AGENT_ID: "reviewer-1",
        AEH_MANAGED_AGENT: "1",
        AEH_INTERACTIVE_LEAD: "0",
        AEH_ORCHESTRATION_ALLOWED: "0",
        AEH_LOGICAL_AGENT: "architecture-reviewer"
      }
    )).toBeUndefined();
    expect(promoteInteractiveOperation(
      ["audit", "review"],
      { PASEO_AGENT_ID: "legacy-session-without-aeh-lead-identity" }
    )).toBeUndefined();
  });

  it("keeps help/version invocations side-effect free even for a managed lead", () => {
    expect(promoteInteractiveOperation(["audit", "--help"], leadEnv)).toBeUndefined();
    expect(promoteInteractiveOperation(["run", "--help"], leadEnv)).toBeUndefined();
    expect(promoteInteractiveOperation(["audit", "-h"], leadEnv)).toBeUndefined();
  });

  it("leaves non-interactive compatibility commands untouched", () => {
    expect(promoteInteractiveOperation(["audit", "review"], {})).toBeUndefined();
    expect(promoteInteractiveOperation(
      ["run", "TASK-1"],
      { ...leadEnv, AEH_ALLOW_SYNC_INTERACTIVE: "1" }
    )).toBeUndefined();
  });

  it("fails closed for synchronous issue/complex run shortcuts in a managed lead", () => {
    expect(() => promoteInteractiveOperation(
      ["run", "--issue", "26"],
      leadEnv
    )).toThrow("cannot execute synchronous 'aeh run' option --issue");
  });
});
