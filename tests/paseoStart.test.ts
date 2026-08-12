import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedAgentTopology } from "../src/agents/types.js";
import type { HarnessProjectConfig } from "../src/core/types.js";
import { buildPaseoLeadBootstrap, resolveLeadAgent, startPaseoHarness } from "../src/paseo/start.js";

const config: HarnessProjectConfig = {
  version: 1,
  project: { name: "demo" },
  agents: { activeProfile: "balanced" },
  orchestration: { provider: "paseo", interactive: { autoSetup: true, webUi: true, leadAgent: "lead", reuseSession: true, stateDir: ".harness/paseo", title: "AEH Lead" } }
};

function topology(): ResolvedAgentTopology {
  const model = { alias: "brain", id: "openai/gpt-test", runtime: "codex", provider: "openai", model: "gpt-test" };
  return { version: 1, profile: "balanced", skillRoots: [], runtimes: { codex: { adapter: "codex", paseoProvider: "codex", capabilities: { sessions: true } } }, models: { brain: model }, agents: { lead: { name: "lead", role: "orchestrator", domains: ["*"], description: "Own the engineering workflow.", execution: { model: "@brain" }, runtime: { name: "codex", adapter: "codex", paseoProvider: "codex", capabilities: { sessions: true } }, model, skills: ["engineering-workflow"], permissions: { read: "allow", write: "deny", delegate: "allow", review: "allow" } } }, routing: [], recovery: {}, councils: {} };
}
function processResult(exitCode: number, stdout = "", stderr = "") { return { exitCode, stdout, stderr, durationMs: 1 }; }

describe("Paseo Harness start", () => {
  it("creates a bootstrapped persistent lead and reuses it on the next start", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-paseo-start-"));
    const commands: string[] = [];
    let daemonReady = false;
    const run = vi.fn(async (command: string) => {
      commands.push(command);
      if (command === "paseo daemon status --json") return daemonReady ? processResult(0, "{}") : processResult(1, "", "not running");
      if (command === "paseo daemon start --web-ui") { daemonReady = true; return processResult(0, "started"); }
      if (command.startsWith("paseo run --background --quiet")) return processResult(0, "agent-123\n");
      if (command === "paseo wait 'agent-123' --timeout 300") return processResult(0, "idle");
      if (command === "paseo logs 'agent-123' --tail 1") return processResult(0, "AEH READY");
      throw new Error(`unexpected command: ${command}`);
    });
    const setup = vi.fn(async () => ({} as never));
    const deps = { run: run as never, commandExists: vi.fn(async () => true) as never, setupToolchain: setup as never, loadTopology: vi.fn(async () => topology()) as never };

    const first = await startPaseoHarness(root, config, { aehCommand: "node /pkg/dist/entry.js" }, deps);
    expect(first.session).toBe("created");
    expect(first.daemonStarted).toBe(true);
    expect(first.agentId).toBe("agent-123");
    expect(setup).not.toHaveBeenCalled();
    expect(commands.some((command) => command.includes("--provider 'codex'") && command.includes("--model 'gpt-test'"))).toBe(true);

    const state = JSON.parse(await fs.readFile(path.join(root, ".harness/paseo/lead-session.json"), "utf8")) as { agentId: string; bootstrapVersion: number };
    expect(state.agentId).toBe("agent-123");
    expect(state.bootstrapVersion).toBe(2);
    const bootstrap = await fs.readFile(path.join(root, ".harness/paseo/lead-bootstrap.md"), "utf8");
    expect(bootstrap).toContain("INFORMATIONAL");
    expect(bootstrap).toContain("AUDIT");
    expect(bootstrap).toContain("CHANGE");
    expect(bootstrap).toContain("aeh audit");
    expect(bootstrap).toContain("node /pkg/dist/entry.js");

    const launchesBefore = commands.filter((command) => command.startsWith("paseo run --background")).length;
    const second = await startPaseoHarness(root, config, { aehCommand: "node /pkg/dist/entry.js" }, deps);
    expect(second.session).toBe("reused");
    expect(second.daemonStarted).toBe(false);
    expect(commands.filter((command) => command.startsWith("paseo run --background")).length).toBe(launchesBefore);
  });

  it("auto-runs toolchain setup when Paseo or the lead runtime is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-paseo-setup-"));
    let reconciled = false;
    const setup = vi.fn(async () => { reconciled = true; return {} as never; });
    const deps = { run: vi.fn(async (command: string) => { if (command === "paseo daemon status --json") return processResult(0, "{}"); if (command.startsWith("paseo run --background --quiet")) return processResult(0, "agent-setup\n"); if (command === "paseo wait 'agent-setup' --timeout 300") return processResult(0, "idle"); throw new Error(`unexpected command: ${command}`); }) as never, commandExists: vi.fn(async () => reconciled) as never, setupToolchain: setup as never, loadTopology: vi.fn(async () => topology()) as never };

    const result = await startPaseoHarness(root, config, { forceNew: true }, deps);
    expect(result.session).toBe("created");
    expect(setup).toHaveBeenCalledTimes(1);
    expect(setup).toHaveBeenCalledWith(root, config, { skipProjectDependencies: true });
  });

  it("builds a bootstrap that sends read-only engineering reviews through AUDIT", () => {
    const bootstrap = buildPaseoLeadBootstrap("pawra", "/repo/pawra", "npm exec -- aeh");
    expect(bootstrap).toContain("Every engineering operation must enter");
    expect(bootstrap).toContain("INFORMATIONAL");
    expect(bootstrap).toContain("AUDIT");
    expect(bootstrap).toContain("CHANGE");
    expect(bootstrap).toContain("review, validation");
    expect(bootstrap).toContain("aeh audit");
    expect(bootstrap).toContain("never perform an engineering AUDIT as an ad-hoc direct review");
    expect(bootstrap).toContain("npm exec -- aeh");
  });

  it("resolves lead explicitly, then falls back to an enabled orchestrator", () => {
    const value = topology();
    expect(resolveLeadAgent(value, "lead")).toBe("lead");
    const alternate = { ...value, agents: { ...value.agents, lead: { ...value.agents.lead, disabled: true }, coordinator: { ...value.agents.lead, name: "coordinator", disabled: false } } };
    expect(resolveLeadAgent(alternate)).toBe("coordinator");
  });
});
