import fs from "node:fs/promises";
import path from "node:path";
import type { AgentExecutionSelection, ResolvedAgentTopology } from "../agents/types.js";
import { loadResolvedAgentTopology } from "../agents/config.js";
import { executionSelectionForAgent } from "../agents/routing.js";
import type { HarnessProjectConfig } from "../core/types.js";
import { setupToolchain } from "../toolchain/setup.js";
import { clearToolchainEnvCache, commandExists, runProcess, type ProcessResult } from "../utils/process.js";
import { buildPaseoBackgroundRunCommand, detectPaseoCapabilities, extractPaseoAgentId, isRecoverableDaemonStatus, type PaseoCapabilities } from "./capabilities.js";

export const PASEO_BOOTSTRAP_VERSION = 3;
export type PaseoSessionPolicy = "fresh-on-start" | "reuse-compatible" | "resume-explicit";

export interface PaseoStartOptions { autoSetup?: boolean; webUi?: boolean; forceNew?: boolean; resume?: boolean; leadAgent?: string; title?: string; aehCommand?: string; }
export interface PaseoLeadState { version: 1; bootstrapVersion: number; projectRoot: string; projectName: string; agentId: string; title: string; leadAgent: string; provider: string; model: string; createdAt: string; generation?: number; }
export interface PaseoStartResult { daemonStarted: boolean; session: "created" | "reused"; agentId: string; title: string; leadAgent: string; provider: string; model: string; stateFile: string; bootstrapFile: string; paseoVersion?: string; }
interface PaseoStartDeps { run: typeof runProcess; commandExists: typeof commandExists; setupToolchain: typeof setupToolchain; loadTopology: typeof loadResolvedAgentTopology; detectCapabilities: typeof detectPaseoCapabilities; }
const DEFAULT_DEPS: PaseoStartDeps = { run: runProcess, commandExists, setupToolchain, loadTopology: loadResolvedAgentTopology, detectCapabilities: detectPaseoCapabilities };
type InteractiveV6 = NonNullable<NonNullable<HarnessProjectConfig["orchestration"]>["interactive"]> & { sessionPolicy?: PaseoSessionPolicy; usePaseoTools?: boolean; context?: { pressureThreshold?: number; handoffThreshold?: number; hardHandoffThreshold?: number } };

export async function startPaseoHarness(root: string, config: HarnessProjectConfig, options: PaseoStartOptions = {}, deps: PaseoStartDeps = DEFAULT_DEPS): Promise<PaseoStartResult> {
  const projectRoot = path.resolve(root);
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
  const bootstrap = buildPaseoLeadBootstrap(config.project.name, projectRoot, aehCommand, settings?.usePaseoTools !== false);
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(bootstrapFile, `${bootstrap}\n`);

  const previous = await loadState(stateFile);
  if (!options.forceNew && reuseRequested && previous && compatibleState(previous, { projectRoot, leadName, provider, model, title })) {
    const probe = await deps.run(`paseo logs ${quote(previous.agentId)} --tail 1`, { cwd: projectRoot, timeoutMs: 30_000 });
    if (probe.exitCode === 0) return { daemonStarted, session: "reused", agentId: previous.agentId, title: previous.title, leadAgent: previous.leadAgent, provider: previous.provider, model: previous.model, stateFile, bootstrapFile, paseoVersion: capabilities.version };
  }

  const launchCommand = buildPaseoBackgroundRunCommand({ title, provider, model, prompt: bootstrap }, capabilities);
  const launch = await deps.run(launchCommand, { cwd: projectRoot, timeoutMs: 60_000 });
  if (launch.exitCode !== 0) throw new Error(`Failed to create AEH lead in Paseo${capabilities.version ? ` ${capabilities.version}` : ""}: ${diagnostic(launch)}`);
  const agentId = extractPaseoAgentId(launch.stdout);
  if (!agentId) throw new Error(`Paseo created no parseable agent id. Output: ${launch.stdout.trim() || "<empty>"}`);
  const wait = await deps.run(`paseo wait ${quote(agentId)} --timeout 300`, { cwd: projectRoot, timeoutMs: 330_000 });
  if (wait.exitCode !== 0) throw new Error(`AEH lead bootstrap did not complete successfully: ${diagnostic(wait)}`);

  const state: PaseoLeadState = { version: 1, bootstrapVersion: PASEO_BOOTSTRAP_VERSION, projectRoot, projectName: config.project.name, agentId, title, leadAgent: leadName, provider, model, createdAt: new Date().toISOString(), generation: (previous?.generation ?? 0) + 1 };
  await fs.writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  return { daemonStarted, session: "created", agentId, title, leadAgent: leadName, provider, model, stateFile, bootstrapFile, paseoVersion: capabilities.version };
}

export function buildPaseoLeadBootstrap(projectName: string, projectRoot: string, aehCommand: string, preferPaseoTools = true): string {
  return `AEH thin-lead Paseo bootstrap v${PASEO_BOOTSTRAP_VERSION}.

You are the top-level engineering lead for project ${JSON.stringify(projectName)} at ${JSON.stringify(projectRoot)}. This instruction governs every later user message in this Paseo conversation. This lead is intentionally short-lived: a normal \`aeh start\` creates a fresh lead; explicit resume is opt-in.

Before engineering work, read AGENTS.md and .harness/skills/engineering-workflow/SKILL.md when present. Every engineering operation must enter through AEH, including read-only audits. Only purely informational questions may bypass. Whenever the workflow says \`aeh\`, invoke exactly: \`${aehCommand}\`.

You are an ORCHESTRATOR, not the repository operator. Your responsibilities are: preserve user intent, choose/delegate workflow roles, resolve genuine ambiguity, monitor deterministic state, and perform final semantic acceptance. Do not spend your context doing broad repository exploration, package installation, daemon debugging, specification authoring, implementation, or raw log analysis when a bounded agent/Harness operation can own it.

Delegation policy:
- repository discovery/evidence -> explorer;
- toolchain, doctor, agents-check or Paseo daemon/provider recovery -> environment-manager;
- non-trivial triage/decomposition -> planner;
- SPEC authoring -> spec-manager using OpenSpec, never write proposal/spec/design/tasks yourself;
- implementation, validation and reviews -> AEH/Harness-selected workers.

${preferPaseoTools ? `Prefer Paseo's injected native/MCP orchestration tools (create_agent, send_agent_prompt, get_agent_status, get_agent_activity, cancel_agent/archive_agent) and load /paseo when exact syntax is needed. Use /paseo-handoff for responsibility transfer. Do not shell out to hand-written paseo run loops from this lead. AEH's CLI adapter is only a compatibility fallback.` : `Use AEH's configured Paseo adapter for delegation; do not hand-write shell orchestration loops.`}

For every non-trivial user request:
1. check context pressure with Paseo status if exposed, or \`${aehCommand} context guard --agent "$PASEO_AGENT_ID"\`. At 70% stop exploratory work; at 80% create/use the AEH handoff artifact and transfer to a fresh lead with /paseo-handoff (preferred) or create_agent; at 90% handoff is mandatory. Do not compact-and-continue after AEH reports HANDOFF_REQUIRED/HARD_HANDOFF;
2. classify INFORMATIONAL | AUDIT | CHANGE using \`${aehCommand} intent\` when not trivially informational;
3. for AUDIT, invoke \`${aehCommand} audit\`; do not perform an ad-hoc review;
4. for CHANGE, delegate discovery to explorer and planning/triage evidence to planner. Feed only their compact structured evidence into deterministic \`${aehCommand} triage\`;
5. QUICK: create/validate/run the bounded QuickContract. Do not broaden QUICK;
6. SPEC: delegate to spec-manager. spec-manager owns OpenSpec artifacts and returns a compiled/validated AEH SDD/TaskContract. The lead must not author those files. Then invoke the sealed AEH run;
7. if execution reports environment/tool failure, delegate recovery to environment-manager and retry the same sealed operation after deterministic readiness. Do not personally run sequences of npm/git/Paseo diagnostic shells;
8. surface only concise state transitions, true human-on-exception decisions, and final audit/acceptance/delivery state.

Existing GitHub issue requests use the issue-driven AEH path. A later request to fix audit findings must reuse .harness/audits/latest.json as evidence for a new CHANGE. Security, architecture, schema, public API and cross-module changes still escalate to SPEC.

The compiled AEH TaskContract/SDD plus seal are normative during implementation. OpenSpec is an authoring source before freeze, not a competing runtime authority. Harness workers/subagents do not replace this lead unless an explicit context handoff rotates responsibility.

Initialize this role now by reading only the project entry instructions needed to understand these rules. Do not run doctor/setup or inspect the repository broadly during bootstrap. When initialization is complete, respond with exactly: AEH READY`;
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
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
