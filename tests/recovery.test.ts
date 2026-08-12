import { describe, expect, it } from "vitest";
import { classifyFailure, resolveRecoveryStep } from "../src/agents/recovery.js";
import { resolveAgentTopology } from "../src/agents/config.js";
import type { AgentTopologySource } from "../src/agents/types.js";

describe("recovery", () => {
  it("classifies deterministic validator failures", () => { expect(classifyFailure({ report: { version: 1, taskId: "T", status: "FAIL", startedAt: "", finishedAt: "", changedFiles: [], metadata: { project: "p", baseRef: "main" }, checks: [{ id: "test", category: "test", status: "FAIL", message: "failed" }] } })).toBe("VALIDATION_FAILURE"); });
  it("uses versioned recovery policy by attempt", () => { const source: AgentTopologySource = { version: 1, runtimes: { x: { adapter: "x" } }, models: { m: { runtime: "x", model: "m" } }, agents: { worker: { role: "implementer", execution: { model: "@m" } } }, recovery: { VALIDATION_FAILURE: [{ action: "same-agent" }, { action: "lead" }] } }; const topology = resolveAgentTopology(source); expect(resolveRecoveryStep(topology, "VALIDATION_FAILURE", 1).action).toBe("same-agent"); expect(resolveRecoveryStep(topology, "VALIDATION_FAILURE", 2).action).toBe("lead"); });
});
