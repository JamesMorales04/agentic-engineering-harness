import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { loadAgentTopologySource, resolveAgentTopology } from "../src/agents/config.js";
import { executionSelectionForAgent } from "../src/agents/routing.js";

const config = { version: 1, project: { name: "routing-test" }, agents: { configPath: ".harness/agents.source.jsonc", activeProfile: "balanced" } } as never;

it("resolves balanced orchestration reviewers to the intended models", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-routing-"));
  await fs.mkdir(path.join(root, ".harness"), { recursive: true });
  await fs.writeFile(path.join(root, ".harness", "agents.source.jsonc"), '{"version":1,"extends":["aeh:orchestration"]}');
  const topology = resolveAgentTopology(await loadAgentTopologySource(root, config), "balanced");
  for (const name of ["code-quality-reviewer", "security-reviewer", "requirements-reviewer"]) {
    const selection = executionSelectionForAgent(topology, name);
    expect([selection.runtimeAdapter, selection.modelName, selection.variant]).toEqual(["opencode", "deepseek-v4-flash", "max"]);
  }
  const architecture = executionSelectionForAgent(topology, "architecture-reviewer");
  expect([architecture.runtimeAdapter, architecture.modelName, architecture.variant]).toEqual(["opencode", "deepseek-v4-flash", "max"]);
});
