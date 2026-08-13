import { describe, expect, it } from "vitest";
import {
  assertHarnessWorkflowEntryAllowed,
  buildManagedAgentEnvironment,
  isManagedBoundedAgent,
  isManagedInteractiveLead,
  managedBoundedAgentPromptContext
} from "../src/operations/executionContext.js";

const reviewerEnv = {
  PASEO_AGENT_ID: "reviewer-1",
  AEH_MANAGED_AGENT: "1",
  AEH_INTERACTIVE_LEAD: "0",
  AEH_ORCHESTRATION_ALLOWED: "0",
  AEH_LOGICAL_AGENT: "architecture-reviewer",
  AEH_AGENT_ROLE: "reviewer",
  AEH_PARENT_OPERATION_ID: "AUDIT-1"
};

describe("managed AEH agent execution identity", () => {
  it("builds explicit lead and bounded identities without relying on PASEO_AGENT_ID", () => {
    const lead = buildManagedAgentEnvironment({
      logicalAgent: "lead",
      role: "orchestrator",
      interactiveLead: true,
      orchestrationAllowed: true
    });
    expect(lead).toEqual(expect.objectContaining({
      AEH_MANAGED_AGENT: "1",
      AEH_LOGICAL_AGENT: "lead",
      AEH_AGENT_ROLE: "orchestrator",
      AEH_INTERACTIVE_LEAD: "1",
      AEH_ORCHESTRATION_ALLOWED: "1"
    }));
    expect(isManagedInteractiveLead(lead)).toBe(true);
    expect(isManagedBoundedAgent(lead)).toBe(false);

    const reviewer = buildManagedAgentEnvironment({
      logicalAgent: "architecture-reviewer",
      role: "reviewer",
      operationId: "AUDIT-1",
      operationKind: "audit",
      phase: "review"
    });
    expect(reviewer).toEqual(expect.objectContaining({
      AEH_INTERACTIVE_LEAD: "0",
      AEH_ORCHESTRATION_ALLOWED: "0",
      AEH_PARENT_OPERATION_ID: "AUDIT-1",
      AEH_PARENT_OPERATION_KIND: "audit",
      AEH_AGENT_PHASE: "review"
    }));
    expect(isManagedBoundedAgent(reviewer)).toBe(true);
  });

  it("denies nested Harness workflow entry from a bounded reviewer", () => {
    for (const argv of [
      ["audit", "review the repo"],
      ["run", "TASK-1"],
      ["start"],
      ["operation", "start", "audit"],
      ["operation", "execute", "AUDIT-1"],
      ["operation", "wait", "AUDIT-1"],
      ["operation", "cancel", "AUDIT-1"],
      ["quick", "create"],
      ["spec", "prepare", "TASK-1"]
    ]) {
      expect(() => assertHarnessWorkflowEntryAllowed(argv, reviewerEnv)).toThrow(
        "AEH_RECURSIVE_OPERATION_DENIED"
      );
    }
  });

  it("keeps metadata/help and read-only operation inspection available", () => {
    expect(() => assertHarnessWorkflowEntryAllowed(["audit", "--help"], reviewerEnv)).not.toThrow();
    expect(() => assertHarnessWorkflowEntryAllowed(["--version"], reviewerEnv)).not.toThrow();
    expect(() => assertHarnessWorkflowEntryAllowed(["operation", "status", "AUDIT-1"], reviewerEnv)).not.toThrow();
    expect(() => assertHarnessWorkflowEntryAllowed(["paseo", "agents", "--operation", "AUDIT-1"], reviewerEnv)).not.toThrow();
  });

  it("allows explicit controller-recovery override without granting it by default", () => {
    expect(() => assertHarnessWorkflowEntryAllowed(
      ["operation", "execute", "AUDIT-1"],
      { ...reviewerEnv, AEH_ALLOW_NESTED_OPERATION: "1" }
    )).not.toThrow();
  });

  it("renders the bounded prompt contract with parent-operation context", () => {
    const text = managedBoundedAgentPromptContext({
      logicalAgent: "architecture-reviewer",
      role: "reviewer",
      operationId: "AUDIT-1",
      operationKind: "audit",
      phase: "review"
    });
    expect(text).toContain("already entered AEH");
    expect(text).toContain("architecture-reviewer");
    expect(text).toContain("AUDIT-1");
    expect(text).toContain("Do not invoke or re-enter");
    expect(text).toContain("return the requested output contract");
  });
});
