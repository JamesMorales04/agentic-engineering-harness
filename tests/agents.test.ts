import { describe, expect, it } from "vitest";
import { parseJsonc } from "../src/agents/jsonc.js";
import { resolveAgentTopology } from "../src/agents/config.js";
import type { AgentTopologySource } from "../src/agents/types.js";

describe("agent topology", () => {
  it("parses JSONC comments and trailing commas", () => {
    expect(parseJsonc('{ // hi\n "a": 1, }')).toEqual({ a: 1 });
  });

  it("resolves model aliases, runtime and profile overrides", () => {
    const source: AgentTopologySource = {
      version: 1,
      activeProfile: "balanced",
      runtimes: { codex: { adapter: "codex" }, opencode: { adapter: "opencode", capabilities: { nativeAgent: true } } },
      models: { brain: { runtime: "codex", provider: "openai", model: "gpt-x", variant: "max" }, workhorse: { runtime: "opencode", provider: "local", model: "fast" } },
      agents: { lead: { role: "orchestrator", execution: { model: "@brain" } }, worker: { role: "implementer", execution: { model: "@workhorse", nativeAgent: "build" } } },
      profiles: { balanced: { agents: { worker: { temperature: 0.05 } } } }
    };
    const resolved = resolveAgentTopology(source);
    expect(resolved.agents.lead.model.id).toBe("openai/gpt-x");
    expect(resolved.agents.lead.execution.variant).toBe("max");
    expect(resolved.agents.worker.runtime.name).toBe("opencode");
    expect(resolved.agents.worker.execution.nativeAgent).toBe("build");
    expect(resolved.agents.worker.temperature).toBe(0.05);
  });
});
