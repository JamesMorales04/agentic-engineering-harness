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
    for (const name of ["implementation-worker", "backend-implementer", "frontend-implementer", "data-implementer", "test-implementer", "security-reviewer", "requirements-reviewer", "integration-validator", "oracle", "designer", "github-manager"]) expect(source.agents[name]).toBeDefined();
    expect(source.agents["openspec-manager"]).toBeUndefined();
    expect(source.agents["github-manager"].mcps).toEqual(["github"]);
    expect(source.agents["designer"].mcps).toEqual(["playwright", "context7"]);
  });

  it("supports partial override, addition and wildcard deletion in one project layer", async () => {
    const root = await fixture(`{
      "version": 1,
      "extends": ["aeh:default"],
      "agents": {
        "backend-implementer": { "temperature": 0.05, "description": "Project backend charter" },
        "domain-specialist": {
          "role": "implementer",
          "domains": ["billing"],
          "execution": { "model": "@workhorse" },
          "permissions": { "read": "allow", "write": "allow", "shell": "allow" },
          "outputContract": "implementer"
        }
      },
      "routing": [
        { "id": "billing", "priority": 90, "when": { "intent": "implement", "domains": ["billing"] }, "use": "domain-specialist" }
      ],
      "remove": { "agents": ["mobile-*"], "routing": [] }
    }`);
    const source = await loadAgentTopologySource(root, config);
    expect(source.agents["backend-implementer"].role).toBe("implementer");
    expect(source.agents["backend-implementer"].execution.model).toBe("@workhorse");
    expect(source.agents["backend-implementer"].temperature).toBe(0.05);
    expect(source.agents["backend-implementer"].description).toBe("Project backend charter");
    expect(source.agents["domain-specialist"].domains).toEqual(["billing"]);
    expect(source.agents["mobile-implementer"]).toBeUndefined();
    expect(source.agents["mobile-reviewer"]).toBeUndefined();
    expect(source.routing?.find((rule) => rule.id === "mobile")).toBeUndefined();
    expect(source.routing?.find((rule) => rule.id === "billing")?.use).toBe("domain-specialist");
  });

  it("cascades deleted reviewer references without damaging the remaining default route", async () => {
    const root = await fixture('{"version":1,"extends":["aeh:default"],"remove":{"agents":["requirements-reviewer"]}}');
    const source = await loadAgentTopologySource(root, config);
    const generic = source.routing?.find((rule) => rule.id === "default-implementation");
    expect(generic?.reviewers).toContain("code-quality-reviewer");
    expect(generic?.reviewers).not.toContain("requirements-reviewer");
    expect(source.agents["requirements-reviewer"]).toBeUndefined();
  });

  it("makes inherited agent charters available to runtime execution selections", async () => {
    const root = await fixture('{"version":1,"extends":["aeh:default"]}');
    const topology = resolveAgentTopology(await loadAgentTopologySource(root, config), "balanced");
    const selection = executionSelectionForAgent(topology, "security-reviewer");
    expect(selection.modelAlias).toBe("brain");
    expect(selection.description).toContain("trust boundaries");
  });

  it("gives OpenCode DeepSeek V4 Flash the max thinking variant in the orchestration preset", async () => {
    const root = await fixture('{"version":1,"extends":["aeh:orchestration"]}');
    const topology = resolveAgentTopology(await loadAgentTopologySource(root, config), "balanced");
    const selection = executionSelectionForAgent(topology, "code-quality-reviewer");
    expect(selection.runtimeAdapter).toBe("opencode");
    expect(selection.modelAlias).toBe("workhorse");
    expect(selection.modelName).toBe("deepseek-v4-flash");
    expect(selection.variant).toBe("max");
    expect(selection.runtimeCapabilities.variantSelection).toBe(true);
  });
});
