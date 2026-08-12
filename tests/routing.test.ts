import { describe, expect, it } from "vitest";
import { resolveAgentTopology } from "../src/agents/config.js";
import { resolveRoute, selectExecutionForTask } from "../src/agents/routing.js";
import type { AgentTopologySource } from "../src/agents/types.js";

const source: AgentTopologySource = { version: 1, runtimes: { opencode: { adapter: "opencode", paseoProvider: "opencode", capabilities: { nativeAgent: true } } }, models: { workhorse: { runtime: "opencode", provider: "x", model: "fast" } }, agents: { generic: { role: "implementer", execution: { model: "@workhorse" } }, backend: { role: "implementer", domains: ["backend"], execution: { model: "@workhorse", nativeAgent: "backend" } }, review: { role: "reviewer", execution: { model: "@workhorse" } } }, routing: [{ id: "generic", priority: 0, when: { intent: "implement" }, use: "generic" }, { id: "backend", priority: 10, when: { intent: "implement", domains: ["backend"] }, use: "backend", reviewers: ["review"] }] };

describe("routing", () => {
  it("selects the highest priority matching domain route", () => { const topology = resolveAgentTopology(source); const route = resolveRoute(topology, { intent: "implement", domains: ["backend"] }); expect(route.agent).toBe("backend"); expect(route.reviewers).toContain("review"); });
  it("produces runtime/model/native-agent execution selection", () => { const topology = resolveAgentTopology(source); const { selection } = selectExecutionForTask(topology, { version: 1, task: { id: "T", title: "x" }, routing: { domains: ["backend"] } }); expect(selection.modelId).toBe("x/fast"); expect(selection.paseoProvider).toBe("opencode"); expect(selection.nativeAgent).toBe("backend"); });
});
