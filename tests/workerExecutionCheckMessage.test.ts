import { describe, expect, it } from "vitest";
import { workerExecutionCheckMessage } from "../src/core/run.js";
import type { WorkerSession } from "../src/core/types.js";

function session(overrides: Partial<WorkerSession>): WorkerSession {
  return {
    provider: "opencode",
    exitCode: 0,
    stdout: "",
    stderr: "",
    ...overrides
  };
}

describe("workerExecutionCheckMessage (deterministic aggregate attribution)", () => {
  it("reports a successful worker normally", () => {
    expect(workerExecutionCheckMessage(session({ exitCode: 0, logicalAgent: "implementer" }))).toBe(
      "Agent implementer completed successfully."
    );
  });

  it("reports a real worker runtime exit as an agent runtime exit", () => {
    const message = workerExecutionCheckMessage(session({ provider: "opencode", exitCode: 1, stderr: "boom" }));
    expect(message).toBe("Agent runtime exited with code 1.");
  });

  it("does not report a synthetic multi-worker aggregate barrier failure as an agent runtime exit", () => {
    const message = workerExecutionCheckMessage(
      session({ provider: "multi-worker", logicalAgent: "planner-waves", exitCode: 1, stdout: "Wave 1 deterministic barrier failed.", stderr: "" })
    );
    expect(message).not.toContain("Agent runtime exited");
    expect(message).toContain("Wave execution aggregate exited with code 1");
    expect(message).toContain("Wave 1 deterministic barrier failed.");
  });

  it("keeps the aggregate message bounded and total when stdout is empty", () => {
    const message = workerExecutionCheckMessage(session({ provider: "multi-worker", exitCode: 1, stdout: "", stderr: "" }));
    expect(message).toContain("Wave execution aggregate exited with code 1");
    expect(message.length).toBeLessThan(400);
  });
});
