import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedAgentTopology } from "../src/agents/types.js";
import type { HarnessProjectConfig } from "../src/core/types.js";
import { startPaseoHarness } from "../src/paseo/start.js";

const config = {
  version: 1,
  project: { name: "demo" },
  agents: { activeProfile: "balanced" },
  orchestration: { provider: "paseo", interactive: { autoSetup: false, webUi: false, leadAgent: "lead", stateDir: ".harness/paseo" } }
} as unknown as HarnessProjectConfig;

function topology(): ResolvedAgentTopology {
  const model = { alias: "brain", id: "openai/gpt-test", runtime: "codex", provider: "openai", model: "gpt-test" };
  return { version: 1, profile: "balanced", skillRoots: [".harness/skills"], runtimes: { codex: { adapter: "codex", paseoProvider: "codex", command: "codex", capabilities: { sessions: true } } }, models: { brain: model }, agents: { lead: { name: "lead", role: "orchestrator", domains: ["*"], execution: { model: "@brain" }, runtime: { name: "codex", adapter: "codex", paseoProvider: "codex", command: "codex", capabilities: { sessions: true } }, model, skills: ["engineering-workflow"], permissions: { read: "allow", write: "deny", delegate: "allow" } } }, routing: [], recovery: {}, councils: {} };
}

describe("Paseo start managed assets", () => {
  it("reconciles .harness skills before loading the resolved topology", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-paseo-assets-"));
    const skill = path.join(root, ".harness/skills/engineering-workflow/SKILL.md");
    const reconcileAssets = vi.fn(async () => {
      await fs.mkdir(path.dirname(skill), { recursive: true });
      await fs.writeFile(skill, "managed workflow\n");
      return { manifestPath: ".harness/managed-assets.json", created: [".harness/skills/engineering-workflow/SKILL.md"], updated: [], preservedOverrides: [], unchanged: [] };
    });
    const loadTopology = vi.fn(async () => {
      expect(await fs.readFile(skill, "utf8")).toBe("managed workflow\n");
      return topology();
    });
    const run = vi.fn(async (command: string) => {
      if (command === "paseo daemon status --json") return { exitCode: 0, stdout: "{}", stderr: "", durationMs: 1 };
      throw new Error(`unexpected command: ${command}`);
    });
    const deps = {
      run: run as never,
      commandExists: vi.fn(async () => true) as never,
      setupToolchain: vi.fn(async () => ({} as never)) as never,
      loadTopology: loadTopology as never,
      detectCapabilities: vi.fn(async () => ({ version: "test", background: true, quiet: true, json: false, outputSchema: true, daemonJson: true, nativeToolsRecommended: true })) as never,
      launchAgent: vi.fn(async () => ({ id: "lead-1", exitCode: 0, stdout: "", stderr: "", status: "idle", transport: "sdk" as const })) as never,
      probeAgent: vi.fn(async () => false) as never,
      reconcileAssets: reconcileAssets as never
    };

    const result = await startPaseoHarness(root, config, {}, deps);
    expect(result.agentId).toBe("lead-1");
    expect(reconcileAssets).toHaveBeenCalledWith(root);
    expect(loadTopology).toHaveBeenCalledTimes(1);
  });
});
