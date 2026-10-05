import { describe, expect, it } from "vitest";
import {
  assertHarnessWorkflowEntryAllowed,
  buildManagedAgentEnvironment,
} from "../../src/operations/executionContext.js";
import { sanitizeFixtureChildEnvironment } from "./fixture/controlCenterJourney.js";

/**
 * RED: in-operation-like managed parent env must not leak into the disposable
 * browser fixture's `aeh init/start/operation start` children. The fixture
 * spawns real CLI entrypoints on a tmpdir root; with the managed envelope
 * retained the executionContext guard denies with AEH_RECURSIVE_OPERATION_DENIED.
 * The sanitized env must allow `init` while the raw bounded env still denies
 * (guard preservation for REAL nested operations).
 */
describe("browser fixture child environment isolates the managed envelope", () => {
  const boundedParent: NodeJS.ProcessEnv = {
    ...process.env,
    ...buildManagedAgentEnvironment({
      logicalAgent: "repairer",
      role: "repairer",
      operationId: "CHANGE-20261005T105024Z-be9f5ac1",
      operationKind: "change",
      phase: "repair",
    }),
    PASEO_AGENT_ID: "repairer-session",
    PASEO_PARENT_AGENT_ID: "lead-session",
    PASEO_SESSION_ID: "session-1",
  };

  it("denies raw bounded re-entry (guard control)", () => {
    expect(() =>
      assertHarnessWorkflowEntryAllowed(["init", "/tmp/aeh-s9-browser-xyz"], boundedParent),
    ).toThrow("AEH_RECURSIVE_OPERATION_DENIED");
    expect(() =>
      assertHarnessWorkflowEntryAllowed(
        ["operation", "start", "change", "req", "/tmp/x"],
        boundedParent,
      ),
    ).toThrow("AEH_RECURSIVE_OPERATION_DENIED");
  });

  it("strips the managed envelope so fixture `aeh init` is not denied", () => {
    const child = sanitizeFixtureChildEnvironment(boundedParent);
    expect(child.AEH_MANAGED_AGENT).toBeUndefined();
    expect(child.AEH_LOGICAL_AGENT).toBeUndefined();
    expect(child.AEH_AGENT_ROLE).toBeUndefined();
    expect(child.AEH_PARENT_OPERATION_ID).toBeUndefined();
    expect(child.AEH_PARENT_OPERATION_KIND).toBeUndefined();
    expect(child.AEH_AGENT_PHASE).toBeUndefined();
    expect(child.AEH_INTERACTIVE_LEAD).toBeUndefined();
    expect(child.AEH_ORCHESTRATION_ALLOWED).toBeUndefined();
    expect(child.AEH_ALLOW_NESTED_OPERATION).toBeUndefined();
    expect(child.PASEO_AGENT_ID).toBeUndefined();
    expect(child.PASEO_PARENT_AGENT_ID).toBeUndefined();
    expect(child.PASEO_SESSION_ID).toBeUndefined();
    expect(() =>
      assertHarnessWorkflowEntryAllowed(["init", "/tmp/aeh-s9-browser-xyz"], child),
    ).not.toThrow();
    expect(() =>
      assertHarnessWorkflowEntryAllowed(
        ["operation", "start", "change", "req", "/tmp/x"],
        child,
      ),
    ).not.toThrow();
  });
});
