import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadAgentTopologySource, resolveAgentTopology } from "../src/agents/config.js";
import { executionSelectionForAgent } from "../src/agents/routing.js";
import type { HarnessProjectConfig } from "../src/core/types.js";

const config: HarnessProjectConfig = {
  version: 1,
  project: { name: "layer-test" },
  agents: { configPath: ".harness/agents.source.jsonc", activeProfile: "balanced" }
};

async function fixture(source: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-agents-"));
  await fs.mkdir(path.join(root, ".harness"), { recursive: true });
  await fs.writeFile(path.join(root, ".harness", "agents.source.jsonc"), source);
  return root;
}

describe("agent topology", () => {
  it("loads the built-in default pack and its useful cross-project roles", async () => {
    const root = await fixture('{"version":1,"extends":["aeh:default"]}');
    const source = await loadAgentTopologySource(root, config);
    for (const name of ["lead", "operation-supervisor", "explorer", "librarian", "planner", "spec-manager", "implementer", "reviewer", "repairer"]) expect(source.agents[name]).toBeDefined();
    expect(source.agents["oracle"]).toBeUndefined();
    expect(source.agents["environment-manager"]).toBeUndefined();
  });

  it("supports partial override, addition and wildcard deletion in one project layer", async () => {
    const root = await fixture(`{
      "version": 1,
      "extends": ["aeh:default"],
      "agents": {
        "implementer": { "temperature": 0.05, "description": "Project implementation charter" },
        "domain-specialist": {
          "role": "Implementer",
          "domains": ["billing"],
          "execution": { "model": "@workhorse" },
          "permissions": { "read": "allow", "write": "allow", "shell": "allow" },
          "outputContract": "implementer"
        }
      },
      "routing": [
        { "id": "billing", "priority": 90, "when": { "intent": "implement", "domains": ["billing"] }, "select": { "role": "Implementer", "domains": ["billing"] } }
      ],
      "remove": { "agents": ["mobile-*"], "routing": [] }
    }`);
    const source = await loadAgentTopologySource(root, config);
    expect(source.agents["implementer"].role).toBe("Implementer");
    expect(source.agents["implementer"].execution.model).toBe("@workhorse");
    expect(source.agents["implementer"].temperature).toBe(0.05);
    expect(source.agents["implementer"].description).toBe("Project implementation charter");
    expect(source.agents["domain-specialist"].domains).toEqual(["billing"]);
    expect(source.routing?.find((rule) => rule.id === "billing")?.select).toEqual({ role: "Implementer", domains: ["billing"] });
  });

  it("keeps role selectors independent of runtime participant identities", async () => {
    const root = await fixture('{"version":1,"extends":["aeh:default"]}');
    const source = await loadAgentTopologySource(root, config);
    const generic = source.routing?.find((rule) => rule.id === "default-implementation");
    expect(generic?.review).toEqual([{ role: "Reviewer", domains: ["*"] }]);
  });

  it("rejects superseded lowercase roles and concrete routing fields instead of translating them", async () => {
    const roleRoot = await fixture('{"version":1,"extends":["aeh:default"],"agents":{"stale":{"role":"implementer","execution":{"model":"@workhorse"}}}}');
    await expect(loadAgentTopologySource(roleRoot, config)).rejects.toThrow();
    const routeRoot = await fixture('{"version":1,"extends":["aeh:default"],"routing":[{"id":"stale","when":{"intent":"implement"},"use":"implementer"}]}');
    await expect(loadAgentTopologySource(routeRoot, config)).rejects.toThrow();
  });

  it("makes inherited agent charters available to runtime execution selections", async () => {
    const root = await fixture('{"version":1,"extends":["aeh:default"]}');
    const topology = resolveAgentTopology(await loadAgentTopologySource(root, config), "balanced");
    const selection = executionSelectionForAgent(topology, "reviewer");
    expect(selection.modelAlias).toBe("workhorse");
    expect(selection.description).toContain("scope");
    const lead = executionSelectionForAgent(topology, "lead");
    expect(lead.contextRequirements).toEqual(expect.objectContaining({ repositoryMap: "FORBIDDEN", semanticRetrieval: "FORBIDDEN", rawRetrieval: "FORBIDDEN" }));
    expect(lead.runtimeCapabilities.mcp).toBe(true);
  });

  it("gives OpenCode DeepSeek V4 Flash the max thinking variant and durable CHANGE contracts in the orchestration preset", async () => {
    const root = await fixture('{"version":1,"extends":["aeh:orchestration"]}');
    const topology = resolveAgentTopology(await loadAgentTopologySource(root, config), "balanced");
    const selection = executionSelectionForAgent(topology, "reviewer");
    expect(selection.runtimeAdapter).toBe("opencode");
    expect(selection.modelAlias).toBe("workhorse");
    expect(selection.modelName).toBe("MiMo-V2.6-Flash");
    expect(selection.variant).toBe("max");
    expect(selection.runtimeCapabilities.variantSelection).toBe(true);
    expect(executionSelectionForAgent(topology, "explorer").outputContract).toBe("explorer");
    expect(executionSelectionForAgent(topology, "librarian").outputContract).toBe("knowledge-pack");
    expect(executionSelectionForAgent(topology, "spec-manager").outputContract).toBe("spec-authoring");
  });
});
