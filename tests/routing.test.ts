import { describe, expect, it } from "vitest";
import { resolveAgentTopology } from "../src/agents/config.js";
import { resolveRoute, selectExecutionForTask } from "../src/agents/routing.js";
import type { AgentTopologySource } from "../src/agents/types.js";

const source: AgentTopologySource = { version: 1, runtimes: { opencode: { adapter: "opencode", paseoProvider: "opencode", capabilities: { nativeAgent: true } } }, models: { workhorse: { runtime: "opencode", provider: "x", model: "fast" } }, agents: { generic: { role: "Implementer", execution: { model: "@workhorse" } }, backend: { role: "Implementer", domains: ["backend"], execution: { model: "@workhorse", nativeAgent: "backend" } }, review: { role: "Reviewer", execution: { model: "@workhorse" } } }, routing: [{ id: "generic", priority: 0, when: { intent: "implement" }, select: { role: "Implementer" } }, { id: "backend", priority: 10, when: { intent: "implement", domains: ["backend"] }, select: { role: "Implementer", domains: ["backend"] }, review: [{ role: "Reviewer" }] }] };

describe("routing", () => {
  it("selects the highest priority matching domain route", () => { const topology = resolveAgentTopology(source); const route = resolveRoute(topology, { intent: "implement", domains: ["backend"] }); expect(route.implementation).toMatchObject({ role: "Implementer", domains: ["backend"] }); expect(route.review).toEqual([{ role: "Reviewer" }]); });
  it("produces runtime/model/native-agent execution selection", () => { const topology = resolveAgentTopology(source); const { selection } = selectExecutionForTask(topology, { version: 1, task: { id: "T", title: "x" }, routing: { domains: ["backend"] } }); expect(selection.modelId).toBe("x/fast"); expect(selection.paseoProvider).toBe("opencode"); expect(selection.nativeAgent).toBe("backend"); });
  it("preserves the canonical route and assurance on the executable selection", () => {
    const topology = resolveAgentTopology(source);
    const { route } = selectExecutionForTask(topology, { version: 1, task: { id: "T-CRITICAL", title: "x" }, routing: { domains: ["backend"], route: "DELEGATED", assurance: "CRITICAL" }, verification: { commands: [] } });
    expect(route).toMatchObject({ implementationRoute: "DELEGATED", assurance: "CRITICAL", reviewers: ["review"] });
  });
  it("fails closed for an unsubstantiated critical assurance contract", () => {
    const topology = resolveAgentTopology(source);
    expect(() => selectExecutionForTask(topology, { version: 1, task: { id: "T-CRITICAL", title: "x" }, routing: { route: "DIRECT", assurance: "CRITICAL" } })).toThrow("CRITICAL_ASSURANCE_GATE_REJECTED");
    expect(() => selectExecutionForTask(topology, { version: 1, task: { id: "T-NONE", title: "x" }, routing: { route: "NO_AGENT", assurance: "CRITICAL" } })).toThrow("NO_AGENT_ROUTE");
  });
});
