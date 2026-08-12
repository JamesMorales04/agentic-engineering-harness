import fs from "node:fs/promises";
import path from "node:path";
import type { AgentExecutionSelection, ResolvedAgentTopology } from "../agents/types.js";
import { loadResolvedAgentTopology } from "../agents/config.js";
import { executionSelectionForAgent } from "../agents/routing.js";
import { reconcileHarnessAssets } from "../core/assets.js";
import type { HarnessProjectConfig } from "../core/types.js";
import { setupToolchain } from "../toolchain/setup.js";
import { clearToolchainEnvCache, commandExists, runProcess, type ProcessResult } from "../utils/process.js";
import { detectPaseoCapabilities, isRecoverableDaemonStatus } from "./capabilities.js";
import { launchManagedPaseoAgent, probeManagedPaseoAgent } from "./runtime.js";

export const PASEO_BOOTSTRAP_VERSION = 4;
export type PaseoSessionPolicy = "fresh-on-start" | "reuse-compatible" | "resume-explicit";

export interface PaseoStartOptions { autoSetup?: boolean; webUi?: boolean; forceNew?: boolean; resume?: boolean; leadAgent?: string; title?: string; aehCommand?: string; handoffPath?: string; }
export interface PaseoLeadState { version: 1; bootstrapVersion: number; projectRoot: string; projectName: string; agentId: string; title: string; leadAgent: string; provider: string; model: string; createdAt: string; generation?: number; handoffPath?: string; }
export interface PaseoStartResult { daemonStarted: boolean; session: "created" | "reused"; agentId: string; title: string; leadAgent: string; provider: string; model: string; stateFile: string; bootstrapFile: string; paseoVersion?: string; transport?: "sdk" | "cli"; }
interface PaseoStartDeps { run: typeof runProcess; commandExists: typeof commandExists; setupToolchain: typeof setupToolchain; loadTopology: typeof loadResolvedAgentTopology; detectCapabilities: typeof detectPaseoCapabilities; launchAgent: typeof launchManagedPaseoAgent; probeAgent: typeof probeManagedPaseoAgent; reconcileAssets?: typeof reconcileHarnessAssets; }
const DEFAULT_DEPS: PaseoStartDeps = { run: runProcess, commandExists, setupToolchain, loadTopology: loadResolvedAgentTopology, detectCapabilities: detectPaseoCapabilities, launchAgent: launchManagedPaseoAgent, probeAgent: probeManagedPaseoAgent, reconcileAssets: reconcileHarnessAssets };
type InteractiveV6 = NonNullable<NonNullable<HarnessProjectConfig["orchestration"]>["interactive"]>;

export async function startPaseoHarness(root: string, config: HarnessProjectConfig, options: PaseoStartOptions = {}, deps: PaseoStartDeps = DEFAULT_DEPS): Promise<PaseoStartResult> {
  const projectRoot = path.resolve(root);
  await (deps.reconcileAssets ?? reconcileHarnessAssets)(projectRoot);
  const settings = config.orchestration?.interactive as InteractiveV6 | undefined;
  const autoSetup = options.autoSetup ?? settings?.autoSetup ?? true;
  const webUi = options.webUi ?? settings?.webUi ?? true;
  const stateDir = path.resolve(projectRoot, settings?.stateDir ?? ".harness/paseo");
  const stateFile = path.join(stateDir, "lead-session.json");
  const bootstrapFile = path.join(stateDir, "lead-bootstrap.md");
  const sessionPolicy = settings?.sessionPolicy ?? "fresh-on-start";
  const reuseRequested = options.resume === true || (sessionPolicy === "reuse-compatible" && options.forceNew !== true);

  const topology = await deps.loadTopology(projectRoot, config, config.agents?.activeProfile);
  const leadName = resolveLeadAgent(topology, options.leadAgent ?? settings?.leadAgent);
  const selection = executionSelectionForAgent(topology, leadName);
  const runtimeCommand = runtimeExecutable(topology, leadName);

  const missingBefore = await missingCommands(projectRoot, ["paseo", runtimeCommand], deps);
  if (missingBefore.length && autoSetup) { await deps.setupToolchain(projectRoot, config, { skipProjectDependencies: true }); clearToolchainEnvCache(); }
  const missingAfter = await missingCommands(projectRoot, ["paseo", runtimeCommand], deps);
  if (missingAfter.length) throw new Error(`aeh start cannot launch Paseo because these managed commands are unavailable: ${missingAfter.join(", ")}. Run aeh setup or provide the required host prerequisite/credential.`);

  const capabilities = await deps.detectCapabilities(projectRoot, deps.run);
  let daemonStarted = false;
  const daemonStatusCommand = capabilities.daemonJson ? "paseo daemon status --json" : "paseo daemon status";
  let daemonStatus = await deps.run(daemonStatusCommand, { cwd: projectRoot, timeoutMs: 30_000 });
  if (daemonStatus.exitCode !== 0) {
    if (isRecoverableDaemonStatus(daemonStatus)) await deps.run("paseo daemon stop", { cwd: projectRoot, timeoutMs: 30_000 }).catch(() => undefined);
    const startCommand = webUi ? "paseo daemon start --web-ui" : "paseo daemon start";
    const daemonStart = await deps.run(startCommand, { cwd: projectRoot, timeoutMs: 60_000 });
    if (daemonStart.exitCode !== 0) throw new Error(`Failed to start Paseo daemon: ${diagnostic(daemonStart)}`);
    daemonStarted = true;
    daemonStatus = await deps.run(daemonStatusCommand, { cwd: projectRoot, timeoutMs: 30_000 });
    if (daemonStatus.exitCode !== 0) throw new Error(`Paseo daemon did not become ready after startup: ${diagnostic(daemonStatus)}`);
  }

  const provider = selection.paseoProvider;
  const model = paseoModel(selection);
  const title = options.title ?? settings?.title ?? `AEH Lead · ${config.project.name}`;
  const aehCommand = options.aehCommand ?? "aeh";
  const bootstrap = buildPaseoLeadBootstrap(config.project.name, projectRoot, aehCommand, settings?.usePaseoTools !== false, options.handoffPath);
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(bootstrapFile, `${bootstrap}\n`);

  const previous = await loadState(stateFile);
  if (!options.forceNew && reuseRequested && !options.handoffPath && previous && compatibleState(previous, { projectRoot, leadName, provider, model, title })) {
    if (await deps.probeAgent(projectRoot, previous.agentId)) return { daemonStarted, session: "reused", agentId: previous.agentId, title: previous.title, leadAgent: previous.leadAgent, provider: previous.provider, model: previous.model, stateFile, bootstrapFile, paseoVersion: capabilities.version };
  }

  const generation = (previous?.generation ?? 0) + 1;
  const labels: Record<string, string> = {
    "aeh.project": config.project.name,
    "aeh.kind": "lead",
    "aeh.role": leadName,
    "aeh.generation": String(generation)
  };
  if (options.handoffPath) labels["aeh.handoff"] = options.handoffPath;
  const launch = await deps.launchAgent(projectRoot, {
    cwd: projectRoot,
    title,
    provider,
    model,
    systemPrompt: bootstrap,
    labels,
    waitForFinish: false,
    timeoutSeconds: 300
  });
  if (launch.exitCode !== 0 || !launch.id) throw new Error(`Failed to create AEH lead in Paseo${capabilities.version ? ` ${capabilities.version}` : ""}: ${launch.stderr || launch.stdout || `exit code ${launch.exitCode}`}`);
  const agentId = launch.id;

  const state: PaseoLeadState = { version: 1, bootstrapVersion: PASEO_BOOTSTRAP_VERSION, projectRoot, projectName: config.project.name, agentId, title, leadAgent: leadName, provider, model, createdAt: new Date().toISOString(), generation, handoffPath: options.handoffPath };
  await fs.writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  return { daemonStarted, session: "created", agentId, title, leadAgent: leadName, provider, model, stateFile, bootstrapFile, paseoVersion: capabilities.version, transport: launch.transport };
}

export function buildPaseoLeadBootstrap(projectName: string, projectRoot: string, aehCommand: string, preferPaseoTools = true, handoffPath?: string): string {
  const handoff = handoffPath ? `\n\nThis lead was created by proactive context rotation. Before the next engineering action, read the deterministic handoff artifact ${JSON.stringify(handoffPath)} and the sealed/run/audit/delivery artifacts it references. Durable artifacts are authoritative; do not ask the previous lead to replay its conversation.` : "";
  return `AEH thin-lead Paseo bootstrap v${PASEO_BOOTSTRAP_VERSION}.

You are the top-level engineering lead for project ${JSON.stringify(projectName)} at ${JSON.stringify(projectRoot)}. A normal \`aeh start\` creates a fresh lead; explicit resume is opt-in.${handoff}

Before engineering work, read AGENTS.md and .harness/skills/engineering-workflow/SKILL.md when present. Those instructions plus the resolved AEH agent topology are authoritative for available roles, charters, permissions, routing and delegation. Do not maintain or invent a separate role map in conversational context.

Every engineering operation must enter through AEH, including read-only audits. Only purely informational questions may bypass. Whenever the workflow says \`aeh\`, invoke exactly: \`${aehCommand}\`.

Remain a thin ORCHESTRATOR: preserve user intent, make semantic/risk decisions, delegate bounded operations through the authoritative topology, monitor deterministic state and perform final semantic acceptance. Follow engineering-workflow end-to-end for intent classification, AUDIT, QUICK/SPEC triage, OpenSpec authoring, sealed execution, recovery, validation and delivery rather than reproducing those procedures here.

${preferPaseoTools ? `When running inside Paseo, use the paseo-orchestration skill and injected native/MCP tools for conversational delegation and /paseo-handoff for responsibility transfer. AEH's external controller may create independent top-level Paseo agents for Harness-owned work; AEH run/task labels, not Paseo parentage, define their workflow ownership.` : `Use AEH's configured Paseo adapter for delegation and lifecycle control.`}

Before non-trivial work, inspect context pressure through Paseo status when exposed or run \`${aehCommand} context guard --agent "$PASEO_AGENT_ID"\`. Honor HANDOFF_REQUIRED/HARD_HANDOFF and stop the old lead when a replacement is created.

The compiled AEH TaskContract/SDD plus seal are normative during implementation. OpenSpec is authoring provenance before freeze, not a competing runtime authority. Do not perform broad repository operations directly when a bounded Harness operation or configured agent owns them.

This bootstrap is session configuration, not a user task. Do not emit an initialization handshake or synthetic readiness message; remain idle until the user's first real request.`;
}

export function resolveLeadAgent(topology: ResolvedAgentTopology, configured?: string): string {
  if (configured) { const selected = topology.agents[configured]; if (!selected || selected.disabled) throw new Error(`Configured interactive lead agent '${configured}' is unavailable.`); return configured; }
  if (topology.agents.lead && !topology.agents.lead.disabled) return "lead";
  const orchestrator = Object.values(topology.agents).find((agent) => agent.role === "orchestrator" && !agent.disabled);
  if (!orchestrator) throw new Error("aeh start requires an enabled orchestrator/lead agent in the resolved topology.");
  return orchestrator.name;
}
function runtimeExecutable(topology: ResolvedAgentTopology, leadName: string): string { const runtime = topology.agents[leadName].runtime; return runtime.command?.trim().split(/\s+/, 1)[0] || runtime.adapter; }
async function missingCommands(root: string, commands: string[], deps: PaseoStartDeps): Promise<string[]> { const result: string[] = []; for (const command of [...new Set(commands.filter(Boolean))]) if (!(await deps.commandExists(command, root))) result.push(command); return result; }
function paseoModel(selection: AgentExecutionSelection): string { return selection.runtimeAdapter === "codex" ? selection.modelName : selection.modelId; }
async function loadState(file: string): Promise<PaseoLeadState | undefined> { try { return JSON.parse(await fs.readFile(file, "utf8")) as PaseoLeadState; } catch { return undefined; } }
function compatibleState(state: PaseoLeadState, expected: { projectRoot: string; leadName: string; provider: string; model: string; title: string }): boolean { return state.version === 1 && state.bootstrapVersion === PASEO_BOOTSTRAP_VERSION && state.projectRoot === expected.projectRoot && state.leadAgent === expected.leadName && state.provider === expected.provider && state.model === expected.model && state.title === expected.title; }
function diagnostic(result: ProcessResult): string { return [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n") || `exit code ${result.exitCode}`; }
