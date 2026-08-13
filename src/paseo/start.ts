import fs from "node:fs/promises";
import path from "node:path";
import type { AgentExecutionSelection, ResolvedAgentTopology } from "../agents/types.js";
import { loadResolvedAgentTopology } from "../agents/config.js";
import { executionSelectionForAgent } from "../agents/routing.js";
import { reconcileHarnessAssets } from "../core/assets.js";
import type { HarnessProjectConfig } from "../core/types.js";
import { buildManagedAgentEnvironment } from "../operations/executionContext.js";
import { rebindActiveOperationsToLead } from "../operations/leadBinding.js";
import { setupToolchain } from "../toolchain/setup.js";
import { clearToolchainEnvCache, commandExists, runProcess, type ProcessResult } from "../utils/process.js";
import { VERSION } from "../version.js";
import { detectPaseoDaemonCapabilities, isRecoverableDaemonStatus } from "./capabilities.js";
import { launchManagedPaseoAgent, probeManagedPaseoAgent } from "./runtime.js";
import type { PaseoSdkAgentOptions } from "./sdk.js";

export const PASEO_BOOTSTRAP_VERSION = 11;
export type PaseoSessionPolicy = "fresh-on-start" | "reuse-compatible" | "resume-explicit";

export interface PaseoStartOptions {
  autoSetup?: boolean;
  webUi?: boolean;
  forceNew?: boolean;
  resume?: boolean;
  leadAgent?: string;
  title?: string;
  aehCommand?: string;
  handoffPath?: string;
}
export interface PaseoLeadState {
  version: 2;
  bootstrapVersion: number;
  aehVersion: string;
  aehCommand: string;
  projectRoot: string;
  projectName: string;
  agentId: string;
  title: string;
  leadAgent: string;
  provider: string;
  model: string;
  createdAt: string;
  generation?: number;
  handoffPath?: string;
}
export interface PaseoStartResult {
  daemonStarted: boolean;
  session: "created" | "reused";
  agentId: string;
  title: string;
  leadAgent: string;
  provider: string;
  model: string;
  aehVersion: string;
  aehCommand: string;
  stateFile: string;
  bootstrapFile: string;
  paseoVersion?: string;
  transport?: "sdk" | "cli";
}
interface PaseoStartDeps {
  run: typeof runProcess;
  commandExists: typeof commandExists;
  setupToolchain: typeof setupToolchain;
  loadTopology: typeof loadResolvedAgentTopology;
  detectCapabilities: typeof detectPaseoDaemonCapabilities;
  launchAgent: typeof launchManagedPaseoAgent;
  probeAgent: typeof probeManagedPaseoAgent;
  reconcileAssets?: typeof reconcileHarnessAssets;
}
const DEFAULT_DEPS: PaseoStartDeps = {
  run: runProcess,
  commandExists,
  setupToolchain,
  loadTopology: loadResolvedAgentTopology,
  detectCapabilities: detectPaseoDaemonCapabilities,
  launchAgent: launchManagedPaseoAgent,
  probeAgent: probeManagedPaseoAgent,
  reconcileAssets: reconcileHarnessAssets
};
type InteractiveV10 = NonNullable<NonNullable<HarnessProjectConfig["orchestration"]>["interactive"]>;

export async function startPaseoHarness(
  root: string,
  config: HarnessProjectConfig,
  options: PaseoStartOptions = {},
  deps: PaseoStartDeps = DEFAULT_DEPS
): Promise<PaseoStartResult> {
  const projectRoot = path.resolve(root);
  await (deps.reconcileAssets ?? reconcileHarnessAssets)(projectRoot);
  const settings = config.orchestration?.interactive as InteractiveV10 | undefined;
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
  if (missingBefore.length && autoSetup) {
    await deps.setupToolchain(projectRoot, config, { skipProjectDependencies: true });
    clearToolchainEnvCache();
  }
  const missingAfter = await missingCommands(projectRoot, ["paseo", runtimeCommand], deps);
  if (missingAfter.length) {
    throw new Error(`aeh start cannot launch Paseo because these managed commands are unavailable: ${missingAfter.join(", ")}. Run aeh setup or provide the required host prerequisite/credential.`);
  }

  const capabilities = await deps.detectCapabilities(projectRoot, deps.run);
  let daemonStarted = false;
  const daemonStatusCommand = capabilities.daemonJson ? "paseo daemon status --json" : "paseo daemon status";
  let daemonStatus = await deps.run(daemonStatusCommand, { cwd: projectRoot, timeoutMs: 30_000 });
  if (daemonStatus.exitCode !== 0) {
    if (isRecoverableDaemonStatus(daemonStatus)) {
      await deps.run("paseo daemon stop", { cwd: projectRoot, timeoutMs: 30_000 }).catch(() => undefined);
    }
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
  const preferPaseoTools = settings?.usePaseoTools !== false;
  const bootstrap = buildPaseoLeadBootstrap(config.project.name, projectRoot, aehCommand, preferPaseoTools, options.handoffPath);
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(bootstrapFile, `${bootstrap}\n`);

  const previous = await loadState(stateFile);
  if (!options.forceNew && reuseRequested && !options.handoffPath && previous && compatibleState(previous, { projectRoot, leadName, provider, model, title, aehCommand })) {
    if (await deps.probeAgent(projectRoot, previous.agentId)) {
      await rebindActiveOperationsToLead(projectRoot, config, previous.agentId, "lead-resume");
      return {
        daemonStarted,
        session: "reused",
        agentId: previous.agentId,
        title: previous.title,
        leadAgent: previous.leadAgent,
        provider: previous.provider,
        model: previous.model,
        aehVersion: VERSION,
        aehCommand,
        stateFile,
        bootstrapFile,
        paseoVersion: capabilities.version
      };
    }
  }

  const generation = (previous?.generation ?? 0) + 1;
  const labels: Record<string, string> = {
    "aeh.project": config.project.name,
    "aeh.kind": "lead",
    "aeh.role": leadName,
    "aeh.generation": String(generation),
    "aeh.version": VERSION,
    "aeh.bootstrap": String(PASEO_BOOTSTRAP_VERSION)
  };
  if (options.handoffPath) labels["aeh.handoff"] = options.handoffPath;
  const operationControl = preferPaseoTools ? buildAehControlMcp(aehCommand, projectRoot) : {};
  const launch = await deps.launchAgent(projectRoot, {
    cwd: projectRoot,
    title,
    provider,
    model,
    systemPrompt: bootstrap,
    env: buildManagedAgentEnvironment({
      logicalAgent: leadName,
      role: selection.role ?? "orchestrator",
      interactiveLead: true,
      orchestrationAllowed: true
    }),
    labels,
    waitForFinish: false,
    timeoutSeconds: 300,
    ...operationControl
  });
  if (launch.exitCode !== 0 || !launch.id) {
    throw new Error(`Failed to create AEH lead in Paseo${capabilities.version ? ` ${capabilities.version}` : ""}: ${launch.stderr || launch.stdout || `exit code ${launch.exitCode}`}`);
  }
  const agentId = launch.id;
  const state: PaseoLeadState = {
    version: 2,
    bootstrapVersion: PASEO_BOOTSTRAP_VERSION,
    aehVersion: VERSION,
    aehCommand,
    projectRoot,
    projectName: config.project.name,
    agentId,
    title,
    leadAgent: leadName,
    provider,
    model,
    createdAt: new Date().toISOString(),
    generation,
    handoffPath: options.handoffPath
  };
  await fs.writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  await rebindActiveOperationsToLead(projectRoot, config, agentId, options.handoffPath ? "lead-handoff" : "lead-start");
  return {
    daemonStarted,
    session: "created",
    agentId,
    title,
    leadAgent: leadName,
    provider,
    model,
    aehVersion: VERSION,
    aehCommand,
    stateFile,
    bootstrapFile,
    paseoVersion: capabilities.version,
    transport: launch.transport
  };
}

export function buildAehControlMcp(aehCommand: string, projectRoot: string): Pick<PaseoSdkAgentOptions, "mcpServers" | "toolPolicy"> {
  const argv = parseCommandVector(aehCommand);
  if (!argv?.length) return {};
  const [command, ...baseArgs] = argv;
  const server = "aeh-control";
  const tools = [
    "aeh_operation_start_audit",
    "aeh_operation_start_run",
    "aeh_operation_start_change",
    "aeh_operation_digest",
    "aeh_operation_status",
    "aeh_operation_ack",
    "aeh_operation_portfolio",
    "aeh_operation_cancel",
    "aeh_context_status"
  ];
  return {
    mcpServers: {
      [server]: {
        type: "stdio",
        command,
        args: [...baseArgs, "operation", "mcp"],
        env: { AEH_CONTROL_ROOT: path.resolve(projectRoot) },
        alwaysLoad: true
      }
    },
    toolPolicy: { preapproved: tools.map((tool) => ({ kind: "mcp" as const, server, tool })) }
  };
}

export function parseCommandVector(value: string): string[] | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('"')) {
    const matches = trimmed.match(/"(?:\\.|[^"\\])*"/g);
    if (!matches?.length || matches.join(" ") !== trimmed) return undefined;
    try { return matches.map((item) => JSON.parse(item) as string).filter(Boolean); }
    catch { return undefined; }
  }
  if (!/^[A-Za-z0-9_./:@+-]+(?:\s+[A-Za-z0-9_./:@+-]+)*$/.test(trimmed)) return undefined;
  return trimmed.split(/\s+/);
}

export function buildPaseoLeadBootstrap(
  projectName: string,
  projectRoot: string,
  aehCommand: string,
  preferPaseoTools = true,
  handoffPath?: string
): string {
  const handoff = handoffPath
    ? `\n\nThis lead was created by proactive context rotation. Read the deterministic handoff artifact ${JSON.stringify(handoffPath)} plus the active operation portfolio/compact digests before making a new engineering decision. Active operations are rebound to this lead generation automatically; do not ask the previous lead to replay child-agent transcripts.`
    : "";
  return `AEH thin-lead Paseo bootstrap v${PASEO_BOOTSTRAP_VERSION}; AEH runtime v${VERSION}.

You are the top-level engineering lead for project ${JSON.stringify(projectName)} at ${JSON.stringify(projectRoot)}. Your role is the user/portfolio plane, not the worker plane.${handoff}

This session carries explicit AEH lead identity (\`AEH_INTERACTIVE_LEAD=1\`). Paseo session identity alone does not grant orchestration authority. Harness-spawned operation supervisors/reviewers/workers/planners are already inside an AEH workflow and must not recursively invoke AEH entrypoints.

Your exact AEH runtime invocation is \`${aehCommand}\`. This invocation and runtime version are part of the durable lead identity. Do not replace it with another global, cached, npx or guessed AEH executable.

Before engineering work, read AGENTS.md and .harness/skills/engineering-workflow/SKILL.md when present. Those instructions plus resolved AEH topology are authoritative. Every engineering operation must enter through AEH; only purely informational questions may bypass.

Operate as a thin portfolio orchestrator with interrupt-driven semantics. You may own multiple concurrent operations; use \`aeh_operation_portfolio\` only for portfolio-level decisions, never as a healthy-progress poll. Manage user intent, priorities, cross-operation dependencies, true exception decisions and final user-facing semantic acceptance. Do not directly multiplex planner/worker/reviewer timelines. Each non-trivial operation has an operation-supervisor responsible for operation-local semantic coordination/consolidation, while deterministic controller + OperationRecord remain lifecycle/gate authority.

${preferPaseoTools ? `Use the injected aeh-control tools for detached AUDIT, CHANGE and prepared RUN operations. Start tools return a compact operation digest. Once an operation starts successfully, return idle: do not poll \`aeh_operation_status\`, \`aeh_operation_digest\`, child agents, or the portfolio merely to watch healthy progress. Healthy revisions are controller-owned and intentionally do not wake the lead.

Use \`aeh_operation_digest\` only when a user explicitly asks for current operation status or after a blocked/stalled/terminal continuation event. \`aeh_operation_status\` defaults to the same compact view; request \`detail=full\` only for exceptional diagnostics or at most once when a terminal result cannot be consumed from the digest/result artifact. Reading status never acknowledges a revision. \`aeh_operation_ack\` is the separate exact-revision acknowledgement primitive.

The detached liveness watchdog may inspect durable state every few seconds without LLM tokens. It wakes the operation-supervisor first for stalls and wakes this lead only for bounded unresolved stalls, blocked decisions, or terminal completion. Never manufacture periodic progress commentary. On a terminal continuation, consume the referenced durable result, complete the pending user request, then acknowledge exactly that revision with \`aeh_operation_ack\`. Never start a duplicate operation merely because a callback was lost.` : `Use AEH's configured Paseo adapter for delegation and lifecycle control.`}

Before non-trivial work and at completed-turn boundaries, inspect context pressure with \`aeh_context_status\`. Honor HANDOFF_REQUIRED/HARD_HANDOFF and stop the old lead when replacement is created. Lead rotation automatically rebinds active OperationRecords and completion targets to the new lead generation; durable artifacts, not conversational replay, carry continuity.

The compiled AEH TaskContract/SDD plus seal are normative during implementation. OpenSpec is authoring provenance before freeze, not a competing runtime authority. This bootstrap is session configuration, not a user task. Do not emit an initialization handshake; remain idle until the user's first real request.`;
}

export function resolveLeadAgent(topology: ResolvedAgentTopology, configured?: string): string {
  if (configured) {
    const selected = topology.agents[configured];
    if (!selected || selected.disabled) throw new Error(`Configured interactive lead agent '${configured}' is unavailable.`);
    return configured;
  }
  if (topology.agents.lead && !topology.agents.lead.disabled) return "lead";
  const orchestrator = Object.values(topology.agents).find((agent) => agent.role === "orchestrator" && !agent.disabled);
  if (!orchestrator) throw new Error("aeh start requires an enabled orchestrator/lead agent in the resolved topology.");
  return orchestrator.name;
}

function runtimeExecutable(topology: ResolvedAgentTopology, leadName: string): string {
  const runtime = topology.agents[leadName].runtime;
  return runtime.command?.trim().split(/\s+/, 1)[0] || runtime.adapter;
}
async function missingCommands(root: string, commands: string[], deps: PaseoStartDeps): Promise<string[]> {
  const result: string[] = [];
  for (const command of [...new Set(commands.filter(Boolean))]) if (!(await deps.commandExists(command, root))) result.push(command);
  return result;
}
function paseoModel(selection: AgentExecutionSelection): string { return selection.runtimeAdapter === "codex" ? selection.modelName : selection.modelId; }
async function loadState(file: string): Promise<PaseoLeadState | undefined> { try { return JSON.parse(await fs.readFile(file, "utf8")) as PaseoLeadState; } catch { return undefined; } }
function compatibleState(state: PaseoLeadState, expected: { projectRoot: string; leadName: string; provider: string; model: string; title: string; aehCommand: string }): boolean {
  return state.version === 2 && state.bootstrapVersion === PASEO_BOOTSTRAP_VERSION && state.aehVersion === VERSION && state.aehCommand === expected.aehCommand && state.projectRoot === expected.projectRoot && state.leadAgent === expected.leadName && state.provider === expected.provider && state.model === expected.model && state.title === expected.title;
}
function diagnostic(result: ProcessResult): string { return [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n") || `exit code ${result.exitCode}`; }
