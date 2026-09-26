import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedAgentTopology } from "../src/agents/types.js";
import type { HarnessProjectConfig } from "../src/core/types.js";
import { loadOperationCompletionTarget, registerOperationCompletionTarget } from "../src/operations/completion.js";
import { loadOperationPortfolio, syncOperationPortfolio } from "../src/operations/portfolio.js";
import { currentControllerEpoch, loadOperation, type OperationRecordV2 } from "../src/operations/state.js";
import { PASEO_BOOTSTRAP_VERSION, buildAehControlMcp, buildPaseoLeadBootstrap, parseCommandVector, resolveLeadAgent, startPaseoHarness } from "../src/paseo/start.js";
import { createManagedRuntime, readManagedRuntimeSnapshot, RuntimeOwnershipError, runtimeProjectId, type RuntimeServiceV1 } from "../src/runtime/index.js";
import { VERSION } from "../src/version.js";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";

const config = {
  version: 1,
  project: { name: "demo" },
  agents: { activeProfile: "balanced" },
  orchestration: { provider: "paseo", interactive: { autoSetup: true, webUi: true, leadAgent: "lead", sessionPolicy: "fresh-on-start", usePaseoTools: true, stateDir: ".harness/paseo", title: "AEH Lead" } }
} as unknown as HarnessProjectConfig;

function topology(): ResolvedAgentTopology {
  const model = { alias: "brain", id: "openai/gpt-test", runtime: "codex", provider: "openai", model: "gpt-test" };
  return { version: 1, profile: "balanced", skillRoots: [], runtimes: { codex: { adapter: "codex", paseoProvider: "codex", capabilities: { sessions: true } } }, models: { brain: model }, agents: { lead: { name: "lead", role: "Lead/Director", domains: ["*"], description: "Own the engineering workflow.", execution: { model: "@brain" }, runtime: { name: "codex", adapter: "codex", paseoProvider: "codex", capabilities: { sessions: true } }, model, skills: ["engineering-workflow"], permissions: { read: "allow", write: "deny", delegate: "allow", review: "allow" } } }, routing: [], recovery: {}, councils: {} };
}
function processResult(exitCode: number, stdout = "", stderr = "") { return { exitCode, stdout, stderr, durationMs: 1 }; }
function healthyDaemonStatus() { return JSON.stringify({ localDaemon: "running", connectedDaemon: "not_probed" }); }
function capabilities() { return { version: "0.6.0", background: true, quiet: true, json: false, outputSchema: true, daemonJson: true, nativeToolsRecommended: true }; }
function managed(id: string) { return { id, exitCode: 0, stdout: "", stderr: "", status: "idle", transport: "sdk" as const }; }
const tempRoots: string[] = [];
const liveChildren: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(liveChildren.splice(0).map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
  }));
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
function runningOperation(root: string, id: string, leadAgentId: string): OperationRecordV2 {
  const now = new Date().toISOString();
  return {
    version: 2,
    id,
    kind: "audit",
    status: "RUNNING",
    phase: "reviewing",
    root,
    payload: { request: "review active operation" },
    revision: 4,
    createdAt: now,
    updatedAt: now,
    lastProgressAt: now,
    lead: { agentId: leadAgentId, source: "lead-start", generation: 1, boundAt: now, acknowledgedRevision: 3, acknowledgedAt: now },
    supervision: {
      required: true,
      materialized: true,
      activeGeneration: 1,
      generations: [{ generation: 1, agentId: "supervisor-old", status: "ACTIVE", createdAt: now, activatedAt: now }]
    },
    stages: {},
    participants: {},
    progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: 3, lastLeadWakeAt: now, lastLeadWakeReason: "operation-started", terminalDelivered: false, attempts: 0 }
  };
}
const CONTROLLER_ENV_KEYS = ["AEH_CONTROLLER_EPOCH", "AEH_CONTROLLER_TOKEN", "AEH_OPERATION_ID", "AEH_CONTROL_ROOT", "AEH_OPERATION_STATE_REDIRECT"] as const;
function snapshotEnv(keys: readonly string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}
function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
async function spawnLivePriorCaller(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  liveChildren.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
  if (!child.pid) throw new Error("Failed to spawn a live process for the prior Paseo service owner.");
  return child.pid;
}
interface SeededPaseoService {
  serviceId: string;
  transientOwner: string;
  record: RuntimeServiceV1;
}
async function seedPriorReadyPaseoService(root: string): Promise<SeededPaseoService> {
  const projectId = runtimeProjectId(root);
  const serviceId = `paseo:${projectId}`;
  const priorPid = await spawnLivePriorCaller();
  const seeder = await createManagedRuntime({ root, projectId, ownerId: `paseo-start:${priorPid}:${projectId}` });
  const record = await seeder.registerService({ serviceId, kind: "paseo", status: "READY", pid: priorPid, metadata: { aehVersion: VERSION } });
  return { serviceId, transientOwner: `paseo-start:${process.pid}:${projectId}`, record };
}
async function loadPaseoServiceRecord(root: string, serviceId: string): Promise<RuntimeServiceV1 | undefined> {
  const snapshot = await readManagedRuntimeSnapshot(root);
  return snapshot.services.find((service) => service.serviceId === serviceId);
}
function paseoStartDeps(run: (command: string) => Promise<ReturnType<typeof processResult>>) {
  return {
    run: run as never,
    commandExists: vi.fn(async () => true) as never,
    setupToolchain: vi.fn(async () => ({} as never)) as never,
    loadTopology: vi.fn(async () => topology()) as never,
    detectCapabilities: vi.fn(async () => capabilities()) as never,
    launchAgent: vi.fn(async () => managed("agent-1")) as never,
    probeAgent: vi.fn(async () => false) as never
  };
}

describe("Paseo Harness start", () => {
  it("creates idle SDK portfolio leads with project-locked operation tools and explicit runtime identity", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-paseo-start-"));
    const commands: string[] = [];
    let daemonReady = false; let launchCount = 0;
    const run = vi.fn(async (command: string) => {
      commands.push(command);
      if (command === "paseo daemon status --json") return daemonReady ? processResult(0, healthyDaemonStatus()) : processResult(1, "", "not running");
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
      labels: expect.objectContaining({ "aeh.kind": "lead", "aeh.role": "lead", "aeh.provider": "codex", "aeh.workspace.id": root, "aeh.version": VERSION, "aeh.bootstrap": String(PASEO_BOOTSTRAP_VERSION) }),
      waitForFinish: false,
      mcpServers: {
        "aeh-control": { type: "stdio", command: "/usr/bin/node", args: ["/pkg/dist/main.js", "operation", "mcp"], env: { AEH_CONTROL_ROOT: root }, alwaysLoad: true }
      },
      toolPolicy: {
        preapproved: expect.arrayContaining([
          { kind: "mcp", server: "aeh-control", tool: "aeh_informational_context" },
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
    const deps = { run: vi.fn(async (command: string) => command === "paseo daemon status --json" ? processResult(0, healthyDaemonStatus()) : Promise.reject(new Error(command))) as never, commandExists: vi.fn(async () => true) as never, setupToolchain: vi.fn(async () => ({} as never)) as never, loadTopology: vi.fn(async () => topology()) as never, detectCapabilities: vi.fn(async () => capabilities()) as never, launchAgent: launchAgent as never, probeAgent: vi.fn(async () => true) as never };
    await startPaseoHarness(root, config, { aehCommand: '"/node" "/pkg-a/dist/main.js"' }, deps);
    const next = await startPaseoHarness(root, config, { resume: true, aehCommand: '"/node" "/pkg-b/dist/main.js"' }, deps);
    expect(next.session).toBe("created"); expect(next.agentId).toBe("agent-2"); expect(launchCount).toBe(2);
  });

  it("recovers a stale daemon before starting an SDK lead", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-paseo-stale-")); let calls = 0;
    const run = vi.fn(async (command: string) => {
      if (command === "paseo daemon status --json") { calls += 1; return calls === 1 ? processResult(1, "", "stale_pid/unreachable") : processResult(0, healthyDaemonStatus()); }
      if (command === "paseo daemon stop") return processResult(0, "stopped");
      if (command === "paseo daemon start --web-ui") return processResult(0, "started");
      throw new Error(command);
    });
    const deps = { run: run as never, commandExists: vi.fn(async () => true) as never, setupToolchain: vi.fn(async () => ({} as never)) as never, loadTopology: vi.fn(async () => topology()) as never, detectCapabilities: vi.fn(async () => capabilities()) as never, launchAgent: vi.fn(async () => managed("agent-stale")) as never, probeAgent: vi.fn(async () => false) as never };
    const value = await startPaseoHarness(root, config, {}, deps);
    expect(value.daemonStarted).toBe(true); expect(run).toHaveBeenCalledWith("paseo daemon stop", expect.anything());
  });

  it("starts a daemon when Paseo returns a successful JSON status that says stopped", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-paseo-stopped-daemon-")); let calls = 0;
    const run = vi.fn(async (command: string) => {
      if (command === "paseo daemon status --json") {
        calls += 1;
        return calls === 1
          ? processResult(0, JSON.stringify({ localDaemon: "stopped", connectedDaemon: "not_probed" }))
          : processResult(0, JSON.stringify({ localDaemon: "running", connectedDaemon: "not_probed" }));
      }
      if (command === "paseo daemon stop") return processResult(0, "stopped");
      if (command === "paseo daemon start --web-ui") return processResult(0, "started");
      throw new Error(command);
    });
    const deps = { run: run as never, commandExists: vi.fn(async () => true) as never, setupToolchain: vi.fn(async () => ({} as never)) as never, loadTopology: vi.fn(async () => topology()) as never, detectCapabilities: vi.fn(async () => capabilities()) as never, launchAgent: vi.fn(async () => managed("agent-running")) as never, probeAgent: vi.fn(async () => false) as never };
    const value = await startPaseoHarness(root, config, {}, deps);
    expect(value.daemonStarted).toBe(true);
    expect(run).toHaveBeenCalledWith("paseo daemon start --web-ui", expect.anything());
  });

  it("auto-runs toolchain setup when Paseo or the lead runtime is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-paseo-setup-")); let reconciled = false;
    const setup = vi.fn(async () => { reconciled = true; return {} as never; });
    const deps = { run: vi.fn(async (command: string) => { if (command === "paseo daemon status --json") return processResult(0, healthyDaemonStatus()); throw new Error(`unexpected command: ${command}`); }) as never, commandExists: vi.fn(async () => reconciled) as never, setupToolchain: setup as never, loadTopology: vi.fn(async () => topology()) as never, detectCapabilities: vi.fn(async () => capabilities()) as never, launchAgent: vi.fn(async () => managed("agent-setup")) as never, probeAgent: vi.fn(async () => false) as never };
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
    const deps = { run: vi.fn(async (command: string) => command === "paseo daemon status --json" ? processResult(0, healthyDaemonStatus()) : Promise.reject(new Error(command))) as never, commandExists: vi.fn(async () => true) as never, setupToolchain: vi.fn(async () => ({} as never)) as never, loadTopology: vi.fn(async () => topology()) as never, detectCapabilities: vi.fn(async () => capabilities()) as never, launchAgent: launchAgent as never, probeAgent: vi.fn(async () => false) as never };
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

  it("resolves lead explicitly, then falls back to an enabled Lead/Director", () => {
    const value = topology(); expect(resolveLeadAgent(value, "lead")).toBe("lead");
    const alternate = { ...value, agents: { ...value.agents, lead: { ...value.agents.lead, disabled: true }, director: { ...value.agents.lead, name: "director", disabled: false } } };
    expect(resolveLeadAgent(alternate)).toBe("director");
  });

  it("leaves an active durable operation, its Lead binding, completion target and portfolio unchanged on public resume", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-paseo-resume-rebind-"));
    tempRoots.push(root);
    let launchCount = 0;
    const launchAgent = vi.fn(async () => { launchCount += 1; return managed(`agent-${launchCount}`); });
    const deps = { run: vi.fn(async (command: string) => command === "paseo daemon status --json" ? processResult(0, healthyDaemonStatus()) : Promise.reject(new Error(command))) as never, commandExists: vi.fn(async () => true) as never, setupToolchain: vi.fn(async () => ({} as never)) as never, loadTopology: vi.fn(async () => topology()) as never, detectCapabilities: vi.fn(async () => capabilities()) as never, launchAgent: launchAgent as never, probeAgent: vi.fn(async () => true) as never };
    const env = snapshotEnv(CONTROLLER_ENV_KEYS);
    try {
      const created = await startPaseoHarness(root, config, {}, deps);
      expect(created.session).toBe("created");
      expect(created.agentId).toBe("agent-1");

      const operationId = "AUDIT-R13-REBIND";
      await saveOwnedOperation(root, runningOperation(root, operationId, "lead-old"));
      await registerOperationCompletionTarget(root, operationId, "lead-old", "lead-start");
      const before = await loadOperation(root, operationId);
      await syncOperationPortfolio(root, config.project.name, before);
      const portfolioBefore = await loadOperationPortfolio(root, config.project.name);
      const completionBefore = await loadOperationCompletionTarget(root, operationId);

      delete process.env.AEH_CONTROLLER_EPOCH;
      delete process.env.AEH_CONTROLLER_TOKEN;
      const resumed = await startPaseoHarness(root, config, { resume: true }, deps);
      expect(resumed.session).toBe("reused");
      expect(resumed.agentId).toBe("agent-1");
      expect(launchCount).toBe(1);

      const after = await loadOperation(root, operationId);
      expect(currentControllerEpoch(after)).toBe(currentControllerEpoch(before));
      expect(after.controller).toEqual(before.controller);
      expect(after.lead).toEqual(before.lead);
      expect(after.revision).toBe(before.revision);
      expect(after.status).toBe(before.status);
      expect(await loadOperationCompletionTarget(root, operationId)).toEqual(completionBefore);
      expect(await loadOperationPortfolio(root, config.project.name)).toEqual(portfolioBefore);
    } finally {
      restoreEnv(env);
    }
  });

  it("observes current Paseo daemon status before reusing or preserving the persistent service record", async () => {
    const aehCommand = '"/usr/bin/node" "/pkg/dist/main.js"';

    const healthyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-paseo-daemon-healthy-"));
    tempRoots.push(healthyRoot);
    const healthyPrior = await seedPriorReadyPaseoService(healthyRoot);
    const healthyRun = vi.fn(async (command: string) => {
      if (command === "paseo daemon status --json") return processResult(0, JSON.stringify({ localDaemon: "running", connectedDaemon: "connected" }));
      throw new Error(`unexpected command: ${command}`);
    });

    const started = await startPaseoHarness(healthyRoot, config, { resume: true, aehCommand }, paseoStartDeps(healthyRun) as never);
    expect(started.agentId).toBe("agent-1");

    const reused = await loadPaseoServiceRecord(healthyRoot, healthyPrior.serviceId);
    expect(reused).toBeDefined();
    expect(reused?.kind).toBe("paseo");
    expect(reused?.status).toBe("READY");
    expect(reused?.canonicalRoot).toBe(path.resolve(healthyRoot));
    expect(reused?.ownerId).not.toBe(healthyPrior.transientOwner);
    expect(reused?.ownerId).not.toContain(`:${process.pid}:`);
    expect(reused?.pid).not.toBe(process.pid);

    const unresolvedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-paseo-daemon-unresolved-"));
    tempRoots.push(unresolvedRoot);
    const unresolvedPrior = await seedPriorReadyPaseoService(unresolvedRoot);
    const unresolvedRun = vi.fn(async (command: string) => {
      if (command === "paseo daemon status --json") return processResult(0, "");
      throw new Error(`unexpected command: ${command}`);
    });

    const outcome = await startPaseoHarness(unresolvedRoot, config, { resume: true, aehCommand }, paseoStartDeps(unresolvedRun) as never).then(() => undefined, (error: unknown) => error);
    expect(unresolvedRun).toHaveBeenCalledWith("paseo daemon status --json", expect.anything());
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toBeInstanceOf(RuntimeOwnershipError);

    const preserved = await loadPaseoServiceRecord(unresolvedRoot, unresolvedPrior.serviceId);
    expect(preserved).toEqual(unresolvedPrior.record);
    const snapshot = await readManagedRuntimeSnapshot(unresolvedRoot);
    expect(snapshot.services.filter((service) => service.ownerId === unresolvedPrior.transientOwner)).toEqual([]);
  });
});
