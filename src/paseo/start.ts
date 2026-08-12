import fs from "node:fs/promises";
import path from "node:path";
import type { AgentExecutionSelection, ResolvedAgentTopology } from "../agents/types.js";
import { loadResolvedAgentTopology } from "../agents/config.js";
import { executionSelectionForAgent } from "../agents/routing.js";
import type { HarnessProjectConfig } from "../core/types.js";
import { setupToolchain } from "../toolchain/setup.js";
import { clearToolchainEnvCache, commandExists, runProcess, type ProcessResult } from "../utils/process.js";

export const PASEO_BOOTSTRAP_VERSION = 2;

export interface PaseoStartOptions { autoSetup?: boolean; webUi?: boolean; forceNew?: boolean; leadAgent?: string; title?: string; aehCommand?: string; }
export interface PaseoLeadState { version: 1; bootstrapVersion: number; projectRoot: string; projectName: string; agentId: string; title: string; leadAgent: string; provider: string; model: string; createdAt: string; }
export interface PaseoStartResult { daemonStarted: boolean; session: "created" | "reused"; agentId: string; title: string; leadAgent: string; provider: string; model: string; stateFile: string; bootstrapFile: string; }
interface PaseoStartDeps { run: typeof runProcess; commandExists: typeof commandExists; setupToolchain: typeof setupToolchain; loadTopology: typeof loadResolvedAgentTopology; }
const DEFAULT_DEPS: PaseoStartDeps = { run: runProcess, commandExists, setupToolchain, loadTopology: loadResolvedAgentTopology };

export async function startPaseoHarness(root: string, config: HarnessProjectConfig, options: PaseoStartOptions = {}, deps: PaseoStartDeps = DEFAULT_DEPS): Promise<PaseoStartResult> {
  const projectRoot = path.resolve(root);
  const settings = config.orchestration?.interactive;
  const autoSetup = options.autoSetup ?? settings?.autoSetup ?? true;
  const webUi = options.webUi ?? settings?.webUi ?? true;
  const forceNew = options.forceNew ?? false;
  const reuseSession = settings?.reuseSession ?? true;
  const stateDir = path.resolve(projectRoot, settings?.stateDir ?? ".harness/paseo");
  const stateFile = path.join(stateDir, "lead-session.json");
  const bootstrapFile = path.join(stateDir, "lead-bootstrap.md");

  const topology = await deps.loadTopology(projectRoot, config, config.agents?.activeProfile);
  const leadName = resolveLeadAgent(topology, options.leadAgent ?? settings?.leadAgent);
  const selection = executionSelectionForAgent(topology, leadName);
  const runtimeCommand = runtimeExecutable(topology, leadName);

  const missingBefore = await missingCommands(projectRoot, ["paseo", runtimeCommand], deps);
  if (missingBefore.length && autoSetup) { await deps.setupToolchain(projectRoot, config, { skipProjectDependencies: true }); clearToolchainEnvCache(); }
  const missingAfter = await missingCommands(projectRoot, ["paseo", runtimeCommand], deps);
  if (missingAfter.length) throw new Error(`aeh start cannot launch Paseo because these managed commands are unavailable: ${missingAfter.join(", ")}. Run aeh setup or provide the required host prerequisite/credential.`);

  let daemonStarted = false;
  const daemonStatus = await deps.run("paseo daemon status --json", { cwd: projectRoot, timeoutMs: 30_000 });
  if (daemonStatus.exitCode !== 0) {
    const startCommand = webUi ? "paseo daemon start --web-ui" : "paseo daemon start";
    const daemonStart = await deps.run(startCommand, { cwd: projectRoot, timeoutMs: 60_000 });
    if (daemonStart.exitCode !== 0) throw new Error(`Failed to start Paseo daemon: ${diagnostic(daemonStart)}`);
    daemonStarted = true;
    const verify = await deps.run("paseo daemon status --json", { cwd: projectRoot, timeoutMs: 30_000 });
    if (verify.exitCode !== 0) throw new Error(`Paseo daemon did not become ready after startup: ${diagnostic(verify)}`);
  }

  const provider = selection.paseoProvider;
  const model = paseoModel(selection);
  const title = options.title ?? settings?.title ?? `AEH Lead · ${config.project.name}`;
  const aehCommand = options.aehCommand ?? "aeh";
  const bootstrap = buildPaseoLeadBootstrap(config.project.name, projectRoot, aehCommand);
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(bootstrapFile, `${bootstrap}\n`);

  if (!forceNew && reuseSession) {
    const existing = await loadState(stateFile);
    if (existing && compatibleState(existing, { projectRoot, leadName, provider, model, title })) {
      const probe = await deps.run(`paseo logs ${quote(existing.agentId)} --tail 1`, { cwd: projectRoot, timeoutMs: 30_000 });
      if (probe.exitCode === 0) return { daemonStarted, session: "reused", agentId: existing.agentId, title: existing.title, leadAgent: existing.leadAgent, provider: existing.provider, model: existing.model, stateFile, bootstrapFile };
    }
  }

  const launch = await deps.run(["paseo run --background --quiet", `--title ${quote(title)}`, `--provider ${quote(provider)}`, `--model ${quote(model)}`, quote(bootstrap)].join(" "), { cwd: projectRoot, timeoutMs: 60_000 });
  if (launch.exitCode !== 0) throw new Error(`Failed to create persistent AEH lead in Paseo: ${diagnostic(launch)}`);
  const agentId = extractAgentId(launch.stdout);
  if (!agentId) throw new Error(`Paseo created no parseable agent id. Output: ${launch.stdout.trim() || "<empty>"}`);
  const wait = await deps.run(`paseo wait ${quote(agentId)} --timeout 300`, { cwd: projectRoot, timeoutMs: 330_000 });
  if (wait.exitCode !== 0) throw new Error(`AEH lead bootstrap did not complete successfully: ${diagnostic(wait)}`);

  const state: PaseoLeadState = { version: 1, bootstrapVersion: PASEO_BOOTSTRAP_VERSION, projectRoot, projectName: config.project.name, agentId, title, leadAgent: leadName, provider, model, createdAt: new Date().toISOString() };
  await fs.writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  return { daemonStarted, session: "created", agentId, title, leadAgent: leadName, provider, model, stateFile, bootstrapFile };
}

export function buildPaseoLeadBootstrap(projectName: string, projectRoot: string, aehCommand: string): string {
  return `AEH persistent Paseo lead bootstrap v${PASEO_BOOTSTRAP_VERSION}.

You are the persistent top-level engineering lead for project ${JSON.stringify(projectName)} at ${JSON.stringify(projectRoot)}. This instruction governs every later user message in this Paseo conversation.

Before handling engineering work, read AGENTS.md and .harness/skills/engineering-workflow/SKILL.md when present. Every engineering operation must enter through the Agentic Engineering Harness, whether it is read-only or mutating. Only a purely informational question may bypass the Harness. The user must not have to mention AEH, AUDIT, QUICK, SPEC, SDD, TaskContract, validators, reviewers, Graphify, workers, or any Harness command.

Whenever the workflow skill says \`aeh\`, invoke the Harness through this command on this machine: \`${aehCommand}\`.

For every user request, first classify intent through the Harness:
- INFORMATIONAL: explanation or lookup only, with no engineering assessment and no repository mutation. Answer directly and do not mutate.
- AUDIT: review, validation, architecture/security/performance/quality assessment, bug discovery, coverage analysis, PR/code review or any other engineering analysis that is read-only. Run the AEH audit pipeline. Do not perform an ad-hoc review outside the Harness.
- CHANGE: any request to implement, fix, refactor, add, remove, update, configure or otherwise mutate repository state. Continue to deterministic QUICK/SPEC triage and the normal change lifecycle.

Required behavior:
1. inspect repository context and automatically build intent/triage evidence;
2. run \`aeh intent\` when the request is not trivially informational;
3. for AUDIT, run \`aeh audit\` so deterministic validators, failure classification, reviewer agents, finding normalization/deduplication and quality debt reporting execute under the frozen control plane;
4. for CHANGE, obey deterministic QUICK/SPEC triage without manual downgrade, materialize/validate the required contract, seal normative inputs, and invoke the Harness run;
5. never implement a CHANGE directly and never perform an engineering AUDIT as an ad-hoc direct review;
6. keep implementation/tool/review failures autonomous unless the Harness reaches a true human-on-exception state;
7. surface concise progress and final audit/acceptance/delivery state to the user.

If a later prompt asks to fix findings from an audit, reuse .harness/audits/latest.json and the referenced AuditReport as evidence for the new CHANGE request instead of rediscovering the same findings. Those findings are advisory input; deterministic change triage still decides QUICK versus SPEC. Security, architecture, schema, public API or cross-module findings must not be forced into QUICK.

Existing GitHub issue requests must use the issue-driven Harness path. If a QUICK request discovers architecture/security/schema/public-API/cross-module or otherwise unsafe scope, escalate it to SPEC rather than broadening QUICK.

You remain the parent Paseo session. Harness-spawned agents are workers/subagents, not replacements for this lead. Do not ask the user to choose the internal workflow.

Initialize this role now by reading the project entry instructions. Do not start an engineering operation until the user supplies one. When initialization is complete, respond with exactly: AEH READY`;
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
function extractAgentId(stdout: string): string | undefined { return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1); }
async function loadState(file: string): Promise<PaseoLeadState | undefined> { try { return JSON.parse(await fs.readFile(file, "utf8")) as PaseoLeadState; } catch { return undefined; } }
function compatibleState(state: PaseoLeadState, expected: { projectRoot: string; leadName: string; provider: string; model: string; title: string }): boolean { return state.version === 1 && state.bootstrapVersion === PASEO_BOOTSTRAP_VERSION && state.projectRoot === expected.projectRoot && state.leadAgent === expected.leadName && state.provider === expected.provider && state.model === expected.model && state.title === expected.title; }
function diagnostic(result: ProcessResult): string { return [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n") || `exit code ${result.exitCode}`; }
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
