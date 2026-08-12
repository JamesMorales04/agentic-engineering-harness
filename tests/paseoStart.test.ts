import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedAgentTopology } from "../src/agents/types.js";
import type { HarnessProjectConfig } from "../src/core/types.js";
import { buildPaseoLeadBootstrap, resolveLeadAgent, startPaseoHarness } from "../src/paseo/start.js";

const config = {
  version: 1,
  project: { name: "demo" },
  agents: { activeProfile: "balanced" },
  orchestration: { provider: "paseo", interactive: { autoSetup: true, webUi: true, leadAgent: "lead", sessionPolicy: "fresh-on-start", stateDir: ".harness/paseo", title: "AEH Lead" } }
} as unknown as HarnessProjectConfig;

function topology(): ResolvedAgentTopology {
  const model = { alias: "brain", id: "openai/gpt-test", runtime: "codex", provider: "openai", model: "gpt-test" };
  return { version: 1, profile: "balanced", skillRoots: [], runtimes: { codex: { adapter: "codex", paseoProvider: "codex", capabilities: { sessions: true } } }, models: { brain: model }, agents: { lead: { name: "lead", role: "orchestrator", domains: ["*"], description: "Own the engineering workflow.", execution: { model: "@brain" }, runtime: { name: "codex", adapter: "codex", paseoProvider: "codex", capabilities: { sessions: true } }, model, skills: ["engineering-workflow"], permissions: { read: "allow", write: "deny", delegate: "allow", review: "allow" } } }, routing: [], recovery: {}, councils: {} };
}
function processResult(exitCode: number, stdout = "", stderr = "") { return { exitCode, stdout, stderr, durationMs: 1 }; }
function capabilities() { return { version: "0.6.0", background: true, quiet: true, json: false, outputSchema: true, daemonJson: true, nativeToolsRecommended: true }; }

describe("Paseo Harness start", () => {
  it("creates a fresh lead on every normal start and reuses only with explicit resume", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-paseo-start-"));
    const commands: string[] = [];
    let daemonReady = false; let launchCount = 0;
    const run = vi.fn(async (command: string) => {
      commands.push(command);
      if (command === "paseo daemon status --json") return daemonReady ? processResult(0, "{}") : processResult(1, "", "not running");
      if (command === "paseo daemon stop") return processResult(0, "stopped");
      if (command === "paseo daemon start --web-ui") { daemonReady = true; return processResult(0, "started"); }
      if (command.startsWith("paseo run --background")) { launchCount += 1; return processResult(0, `agent-${launchCount}\n`); }
      if (/^paseo wait 'agent-\d+' --timeout 300$/.test(command)) return processResult(0, "idle");
      if (/^paseo logs 'agent-\d+' --tail 1$/.test(command)) return processResult(0, "AEH READY");
      throw new Error(`unexpected command: ${command}`);
    });
    const setup = vi.fn(async () => ({} as never));
    const deps = { run: run as never, commandExists: vi.fn(async () => true) as never, setupToolchain: setup as never, loadTopology: vi.fn(async () => topology()) as never, detectCapabilities: vi.fn(async () => capabilities()) as never };

    const first = await startPaseoHarness(root, config, { aehCommand: "node /pkg/dist/entry.js" }, deps);
    expect(first.session).toBe("created"); expect(first.agentId).toBe("agent-1"); expect(first.daemonStarted).toBe(true);
    const second = await startPaseoHarness(root, config, { aehCommand: "node /pkg/dist/entry.js" }, deps);
    expect(second.session).toBe("created"); expect(second.agentId).toBe("agent-2");
    const resumed = await startPaseoHarness(root, config, { resume: true, aehCommand: "node /pkg/dist/entry.js" }, deps);
    expect(resumed.session).toBe("reused"); expect(resumed.agentId).toBe("agent-2");
    expect(launchCount).toBe(2);

    const state = JSON.parse(await fs.readFile(path.join(root, ".harness/paseo/lead-session.json"), "utf8")) as { agentId: string; bootstrapVersion: number; generation: number };
    expect(state.agentId).toBe("agent-2"); expect(state.bootstrapVersion).toBe(3); expect(state.generation).toBe(2);
    const bootstrap = await fs.readFile(path.join(root, ".harness/paseo/lead-bootstrap.md"), "utf8");
    expect(bootstrap).toContain("ORCHESTRATOR");
    expect(bootstrap).toContain("environment-manager");
    expect(bootstrap).toContain("spec-manager");
    expect(bootstrap).toContain("OpenSpec");
    expect(bootstrap).toContain("/paseo-handoff");
    expect(bootstrap).toContain("80%");
    expect(bootstrap).toContain("node /pkg/dist/entry.js");
    expect(commands.some((command) => command.includes("--provider 'codex'") && command.includes("--model 'gpt-test'"))).toBe(true);
  });

  it("recovers a stale daemon before starting it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-paseo-stale-")); let calls = 0;
    const run = vi.fn(async (command: string) => {
      if (command === "paseo daemon status --json") { calls += 1; return calls === 1 ? processResult(1, "", "stale_pid/unreachable") : processResult(0, "{}"); }
      if (command === "paseo daemon stop") return processResult(0, "stopped");
      if (command === "paseo daemon start --web-ui") return processResult(0, "started");
      if (command.startsWith("paseo run --background")) return processResult(0, "agent-stale\n");
      if (command === "paseo wait 'agent-stale' --timeout 300") return processResult(0, "idle");
      throw new Error(command);
    });
    const deps = { run: run as never, commandExists: vi.fn(async () => true) as never, setupToolchain: vi.fn(async () => ({} as never)) as never, loadTopology: vi.fn(async () => topology()) as never, detectCapabilities: vi.fn(async () => capabilities()) as never };
    const value = await startPaseoHarness(root, config, {}, deps);
    expect(value.daemonStarted).toBe(true);
    expect(run).toHaveBeenCalledWith("paseo daemon stop", expect.anything());
  });

  it("auto-runs toolchain setup when Paseo or the lead runtime is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-paseo-setup-")); let reconciled = false;
    const setup = vi.fn(async () => { reconciled = true; return {} as never; });
    const deps = { run: vi.fn(async (command: string) => { if (command === "paseo daemon status --json") return processResult(0, "{}"); if (command.startsWith("paseo run --background")) return processResult(0, "agent-setup\n"); if (command === "paseo wait 'agent-setup' --timeout 300") return processResult(0, "idle"); throw new Error(`unexpected command: ${command}`); }) as never, commandExists: vi.fn(async () => reconciled) as never, setupToolchain: setup as never, loadTopology: vi.fn(async () => topology()) as never, detectCapabilities: vi.fn(async () => capabilities()) as never };
    const value = await startPaseoHarness(root, config, {}, deps);
    expect(value.session).toBe("created"); expect(setup).toHaveBeenCalledTimes(1); expect(setup).toHaveBeenCalledWith(root, config, { skipProjectDependencies: true });
  });

  it("builds a bootstrap that routes operations through delegated roles and proactive handoff", () => {
    const bootstrap = buildPaseoLeadBootstrap("pawra", "/repo/pawra", "npm exec -- aeh");
    expect(bootstrap).toContain("ORCHESTRATOR");
    expect(bootstrap).toContain("explorer");
    expect(bootstrap).toContain("environment-manager");
    expect(bootstrap).toContain("spec-manager");
    expect(bootstrap).toContain("create_agent");
    expect(bootstrap).toContain("/paseo-handoff");
    expect(bootstrap).toContain("OpenSpec");
    expect(bootstrap).toContain("80%");
    expect(bootstrap).toContain("npm exec -- aeh");
  });

  it("resolves lead explicitly, then falls back to an enabled orchestrator", () => {
    const value = topology(); expect(resolveLeadAgent(value, "lead")).toBe("lead");
    const alternate = { ...value, agents: { ...value.agents, lead: { ...value.agents.lead, disabled: true }, coordinator: { ...value.agents.lead, name: "coordinator", disabled: false } } };
    expect(resolveLeadAgent(alternate)).toBe("coordinator");
  });
});
