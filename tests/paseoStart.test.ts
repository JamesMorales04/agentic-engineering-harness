import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedAgentTopology } from "../src/agents/types.js";
import type { HarnessProjectConfig } from "../src/core/types.js";
import { PASEO_BOOTSTRAP_VERSION, buildAehControlMcp, buildPaseoLeadBootstrap, parseCommandVector, resolveLeadAgent, startPaseoHarness } from "../src/paseo/start.js";
import { VERSION } from "../src/version.js";

const config = {
  version: 1,
  project: { name: "demo" },
  agents: { activeProfile: "balanced" },
  orchestration: { provider: "paseo", interactive: { autoSetup: true, webUi: true, leadAgent: "lead", sessionPolicy: "fresh-on-start", usePaseoTools: true, stateDir: ".harness/paseo", title: "AEH Lead" } }
} as unknown as HarnessProjectConfig;

function topology(): ResolvedAgentTopology {
  const model = { alias: "brain", id: "openai/gpt-test", runtime: "codex", provider: "openai", model: "gpt-test" };
  return { version: 1, profile: "balanced", skillRoots: [], runtimes: { codex: { adapter: "codex", paseoProvider: "codex", capabilities: { sessions: true } } }, models: { brain: model }, agents: { lead: { name: "lead", role: "orchestrator", domains: ["*"], description: "Own the engineering workflow.", execution: { model: "@brain" }, runtime: { name: "codex", adapter: "codex", paseoProvider: "codex", capabilities: { sessions: true } }, model, skills: ["engineering-workflow"], permissions: { read: "allow", write: "deny", delegate: "allow", review: "allow" } } }, routing: [], recovery: {}, councils: {} };
}
function processResult(exitCode: number, stdout = "", stderr = "") { return { exitCode, stdout, stderr, durationMs: 1 }; }
function capabilities() { return { version: "0.6.0", background: true, quiet: true, json: false, outputSchema: true, daemonJson: true, nativeToolsRecommended: true }; }
function managed(id: string) { return { id, exitCode: 0, stdout: "", stderr: "", status: "idle", transport: "sdk" as const }; }

describe("Paseo Harness start", () => {
  it("creates idle SDK portfolio leads with project-locked operation tools and explicit runtime identity", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-paseo-start-"));
    const commands: string[] = [];
    let daemonReady = false; let launchCount = 0;
    const run = vi.fn(async (command: string) => {
      commands.push(command);
      if (command === "paseo daemon status --json") return daemonReady ? processResult(0, "{}") : processResult(1, "", "not running");
      if (command === "paseo daemon stop") return processResult(0, "stopped");
      if (command === "paseo daemon start --web-ui") { daemonReady = true; return processResult(0, "started"); }
      throw new Error(`unexpected command: ${command}`);
    });
    const launchAgent = vi.fn(async () => { launchCount += 1; return managed(`agent-${launchCount}`); });
    const probeAgent = vi.fn(async () => true);
    const deps = { run: run as never, commandExists: vi.fn(async () => true) as never, setupToolchain: vi.fn(async () => ({} as never)) as never, loadTopology: vi.fn(async () => topology()) as never, detectCapabilities: vi.fn(async () => capabilities()) as never, launchAgent: launchAgent as never, probeAgent: probeAgent as never };
    const aehCommand = '"/usr/bin/node" "/pkg/dist/main.js"';

    const first = await startPaseoHarness(root, config, { aehCommand }, deps);
    expect(first.session).toBe("created"); expect(first.agentId).toBe("agent-1"); expect(first.daemonStarted).toBe(true); expect(first.transport).toBe("sdk");
    const second = await startPaseoHarness(root, config, { aehCommand }, deps);
    expect(second.session).toBe("created"); expect(second.agentId).toBe("agent-2");
    const resumed = await startPaseoHarness(root, config, { resume: true, aehCommand }, deps);
    expect(resumed.session).toBe("reused"); expect(resumed.agentId).toBe("agent-2");
    expect(launchCount).toBe(2); expect(probeAgent).toHaveBeenCalledWith(root, "agent-2");

    const state = JSON.parse(await fs.readFile(path.join(root, ".harness/paseo/lead-session.json"), "utf8")) as { version: number; agentId: string; bootstrapVersion: number; aehVersion: string; aehCommand: string; generation: number };
    expect(state).toEqual(expect.objectContaining({ version: 2, agentId: "agent-2", bootstrapVersion: PASEO_BOOTSTRAP_VERSION, aehVersion: VERSION, aehCommand, generation: 2 }));
    const bootstrap = await fs.readFile(path.join(root, ".harness/paseo/lead-bootstrap.md"), "utf8");
    expect(bootstrap).toContain("thin portfolio orchestrator");
    expect(bootstrap).toContain("operation-supervisor");
    expect(bootstrap).toContain("OperationRecord");
    expect(bootstrap).toContain("aeh_operation_portfolio");
    expect(bootstrap).toContain("watchdog");
    expect(bootstrap).toContain("AUDIT, CHANGE and prepared RUN");
    expect(bootstrap).toContain(aehCommand);
    expect(bootstrap).toContain(`AEH runtime v${VERSION}`);
    expect(bootstrap).not.toContain("Delegation policy:");
    expect(bootstrap).not.toContain("AEH READY");
    expect(commands.some((command) => command.startsWith("paseo run"))).toBe(false);

    const launchOptions = launchAgent.mock.calls[0][1];
    expect(launchOptions).toEqual(expect.objectContaining({
      provider: "codex",
      model: "gpt-test",
      systemPrompt: expect.stringContaining("thin portfolio orchestrator"),
      labels: expect.objectContaining({ "aeh.kind": "lead", "aeh.role": "lead", "aeh.version": VERSION, "aeh.bootstrap": String(PASEO_BOOTSTRAP_VERSION) }),
      waitForFinish: false,
      mcpServers: {
        "aeh-control": { type: "stdio", command: "/usr/bin/node", args: ["/pkg/dist/main.js", "operation", "mcp"], env: { AEH_CONTROL_ROOT: root }, alwaysLoad: true }
      },
      toolPolicy: {
        preapproved: expect.arrayContaining([
          { kind: "mcp", server: "aeh-control", tool: "aeh_operation_start_audit" },
          { kind: "mcp", server: "aeh-control", tool: "aeh_operation_start_run" },
          { kind: "mcp", server: "aeh-control", tool: "aeh_operation_start_change" },
          { kind: "mcp", server: "aeh-control", tool: "aeh_operation_status" },
          { kind: "mcp", server: "aeh-control", tool: "aeh_operation_portfolio" },
          { kind: "mcp", server: "aeh-control", tool: "aeh_operation_cancel" },
          { kind: "mcp", server: "aeh-control", tool: "aeh_context_status" }
        ])
      }
    }));
    expect(launchOptions).not.toHaveProperty("prompt");
  });

  it("does not reuse a lead created by a different AEH invocation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-paseo-runtime-identity-"));
    let launchCount = 0;
    const launchAgent = vi.fn(async () => { launchCount += 1; return managed(`agent-${launchCount}`); });
    const deps = { run: vi.fn(async (command: string) => command === "paseo daemon status --json" ? processResult(0, "{}") : Promise.reject(new Error(command))) as never, commandExists: vi.fn(async () => true) as never, setupToolchain: vi.fn(async () => ({} as never)) as never, loadTopology: vi.fn(async () => topology()) as never, detectCapabilities: vi.fn(async () => capabilities()) as never, launchAgent: launchAgent as never, probeAgent: vi.fn(async () => true) as never };
    await startPaseoHarness(root, config, { aehCommand: '"/node" "/pkg-a/dist/main.js"' }, deps);
    const next = await startPaseoHarness(root, config, { resume: true, aehCommand: '"/node" "/pkg-b/dist/main.js"' }, deps);
    expect(next.session).toBe("created"); expect(next.agentId).toBe("agent-2"); expect(launchCount).toBe(2);
  });

  it("recovers a stale daemon before starting an SDK lead", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-paseo-stale-")); let calls = 0;
    const run = vi.fn(async (command: string) => {
      if (command === "paseo daemon status --json") { calls += 1; return calls === 1 ? processResult(1, "", "stale_pid/unreachable") : processResult(0, "{}"); }
      if (command === "paseo daemon stop") return processResult(0, "stopped");
      if (command === "paseo daemon start --web-ui") return processResult(0, "started");
      throw new Error(command);
    });
    const deps = { run: run as never, commandExists: vi.fn(async () => true) as never, setupToolchain: vi.fn(async () => ({} as never)) as never, loadTopology: vi.fn(async () => topology()) as never, detectCapabilities: vi.fn(async () => capabilities()) as never, launchAgent: vi.fn(async () => managed("agent-stale")) as never, probeAgent: vi.fn(async () => false) as never };
    const value = await startPaseoHarness(root, config, {}, deps);
    expect(value.daemonStarted).toBe(true); expect(run).toHaveBeenCalledWith("paseo daemon stop", expect.anything());
  });

  it("auto-runs toolchain setup when Paseo or the lead runtime is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-paseo-setup-")); let reconciled = false;
    const setup = vi.fn(async () => { reconciled = true; return {} as never; });
    const deps = { run: vi.fn(async (command: string) => { if (command === "paseo daemon status --json") return processResult(0, "{}"); throw new Error(`unexpected command: ${command}`); }) as never, commandExists: vi.fn(async () => reconciled) as never, setupToolchain: setup as never, loadTopology: vi.fn(async () => topology()) as never, detectCapabilities: vi.fn(async () => capabilities()) as never, launchAgent: vi.fn(async () => managed("agent-setup")) as never, probeAgent: vi.fn(async () => false) as never };
    const value = await startPaseoHarness(root, config, {}, deps);
    expect(value.session).toBe("created"); expect(setup).toHaveBeenCalledTimes(1); expect(setup).toHaveBeenCalledWith(root, config, { skipProjectDependencies: true });
  });

  it("builds a thin portfolio bootstrap that delegates operation-local work to supervisors", () => {
    const bootstrap = buildPaseoLeadBootstrap("pawra", "/repo/pawra", "npm-exec-aeh");
    expect(bootstrap).toContain("thin portfolio orchestrator");
    expect(bootstrap).toContain("multiple concurrent operations");
    expect(bootstrap).toContain("operation-supervisor");
    expect(bootstrap).toContain("OperationRecord");
    expect(bootstrap).toContain("aeh_operation_portfolio");
    expect(bootstrap).toContain("watchdog");
    expect(bootstrap).toContain("OpenSpec");
    expect(bootstrap).toContain("npm-exec-aeh");
    expect(bootstrap).toContain(`AEH runtime v${VERSION}`);
    expect(bootstrap).not.toContain("AEH READY");
  });

  it("does not inject operation MCP when Paseo tools are disabled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-paseo-no-tools-"));
    const disabled = { ...config, orchestration: { ...config.orchestration, interactive: { ...config.orchestration?.interactive, usePaseoTools: false } } } as HarnessProjectConfig;
    const launchAgent = vi.fn(async () => managed("agent-disabled"));
    const deps = { run: vi.fn(async (command: string) => command === "paseo daemon status --json" ? processResult(0, "{}") : Promise.reject(new Error(command))) as never, commandExists: vi.fn(async () => true) as never, setupToolchain: vi.fn(async () => ({} as never)) as never, loadTopology: vi.fn(async () => topology()) as never, detectCapabilities: vi.fn(async () => capabilities()) as never, launchAgent: launchAgent as never, probeAgent: vi.fn(async () => false) as never };
    await startPaseoHarness(root, disabled, { aehCommand: '"/usr/bin/node" "/pkg/dist/main.js"' }, deps);
    expect(launchAgent.mock.calls[0][1]).not.toHaveProperty("mcpServers");
    expect(launchAgent.mock.calls[0][1]).not.toHaveProperty("toolPolicy");
  });

  it("parses only safe command vectors for MCP injection", () => {
    expect(parseCommandVector('"/usr/bin/node" "/pkg/dist/main.js"')).toEqual(["/usr/bin/node", "/pkg/dist/main.js"]);
    expect(parseCommandVector("node /pkg/dist/main.js")).toEqual(["node", "/pkg/dist/main.js"]);
    expect(parseCommandVector("node /pkg/main.js; rm -rf / ")).toBeUndefined();
    expect(buildAehControlMcp("aeh", "/repo").mcpServers?.["aeh-control"]).toEqual({ type: "stdio", command: "aeh", args: ["operation", "mcp"], env: { AEH_CONTROL_ROOT: "/repo" }, alwaysLoad: true });
  });

  it("resolves lead explicitly, then falls back to an enabled orchestrator", () => {
    const value = topology(); expect(resolveLeadAgent(value, "lead")).toBe("lead");
    const alternate = { ...value, agents: { ...value.agents, lead: { ...value.agents.lead, disabled: true }, coordinator: { ...value.agents.lead, name: "coordinator", disabled: false } } };
    expect(resolveLeadAgent(alternate)).toBe("coordinator");
  });
});
