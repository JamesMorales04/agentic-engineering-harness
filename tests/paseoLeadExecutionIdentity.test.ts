import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedAgentTopology } from "../src/agents/types.js";
import type { HarnessProjectConfig } from "../src/core/types.js";
import { startPaseoHarness } from "../src/paseo/start.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function topology(): ResolvedAgentTopology {
  const model = {
    alias: "brain",
    id: "openai/gpt-test",
    runtime: "codex",
    provider: "openai",
    model: "gpt-test"
  };
  return {
    version: 1,
    profile: "balanced",
    skillRoots: [],
    runtimes: {
      codex: {
        adapter: "codex",
        paseoProvider: "codex",
        capabilities: { sessions: true }
      }
    },
    models: { brain: model },
    agents: {
      lead: {
        name: "lead",
        role: "orchestrator",
        domains: ["*"],
        description: "Own the engineering workflow.",
        execution: { model: "@brain" },
        runtime: {
          name: "codex",
          adapter: "codex",
          paseoProvider: "codex",
          capabilities: { sessions: true }
        },
        model,
        skills: [],
        permissions: { read: "allow", write: "deny", delegate: "allow" }
      }
    },
    routing: [],
    recovery: {},
    councils: {}
  } as ResolvedAgentTopology;
}

describe("managed Paseo lead execution identity", () => {
  it("marks the user-facing lead explicitly instead of inferring authority from PASEO_AGENT_ID", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-lead-identity-"));
    roots.push(root);
    const config = {
      version: 1,
      project: { name: "demo" },
      agents: { activeProfile: "balanced" },
      orchestration: {
        provider: "paseo",
        interactive: {
          autoSetup: true,
          webUi: true,
          leadAgent: "lead",
          usePaseoTools: true,
          stateDir: ".harness/paseo"
        }
      }
    } as unknown as HarnessProjectConfig;
    const launchAgent = vi.fn(async () => ({
      id: "lead-1",
      exitCode: 0,
      stdout: "",
      stderr: "",
      status: "idle",
      transport: "sdk" as const
    }));
    const deps = {
      run: vi.fn(async (command: string) => {
        if (command === "paseo daemon status --json") {
          return { exitCode: 0, stdout: "{}", stderr: "", durationMs: 1 };
        }
        throw new Error(`unexpected command: ${command}`);
      }) as never,
      commandExists: vi.fn(async () => true) as never,
      setupToolchain: vi.fn(async () => ({} as never)) as never,
      loadTopology: vi.fn(async () => topology()) as never,
      detectCapabilities: vi.fn(async () => ({
        version: "0.3.1",
        background: true,
        quiet: true,
        json: false,
        outputSchema: true,
        daemonJson: true,
        nativeToolsRecommended: true
      })) as never,
      launchAgent: launchAgent as never,
      probeAgent: vi.fn(async () => false) as never
    };

    await startPaseoHarness(root, config, { aehCommand: "aeh" }, deps);

    expect(launchAgent).toHaveBeenCalledWith(
      root,
      expect.objectContaining({
        env: {
          AEH_MANAGED_AGENT: "1",
          AEH_LOGICAL_AGENT: "lead",
          AEH_AGENT_ROLE: "orchestrator",
          AEH_INTERACTIVE_LEAD: "1",
          AEH_ORCHESTRATION_ALLOWED: "1"
        },
        waitForFinish: false
      })
    );
    expect(String(launchAgent.mock.calls[0][1].systemPrompt)).toContain("Paseo session identity alone does not grant orchestration authority");
  });
});
