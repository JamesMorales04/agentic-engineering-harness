import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { minimatch } from "minimatch";
import type { AgentExecutionSelection, ResolvedAgentTopology } from "./types.js";
import { executionSelectionForAgent } from "./routing.js";
import { planParallelism, type ParallelismPlan } from "./parallelism.js";
import { plannerOutputSchema, type DelegationTask, type PlannerOutput } from "./outputContracts.js";
import { extractMarkedJson } from "./structuredOutput.js";
import { validateExecutionCapabilities } from "./permissions.js";
import type { ControlPlaneSnapshot } from "../core/controlPlane.js";
import { materializeControlPlaneSnapshot } from "../core/controlPlane.js";
import type { HarnessProjectConfig, TaskContract, ValidationReport, WorkerSession } from "../core/types.js";
import { executeAgentPrompt } from "../workers/agentPrompt.js";
import { runProcess } from "../utils/process.js";
import { recordEvent } from "../telemetry/events.js";

export interface DelegationExecutionResult {
  task: DelegationTask;
  session: WorkerSession;
  changedFiles: string[];
  patch: string;
  status: "PASS" | "FAIL";
  message?: string;
}

export interface WaveExecutionSummary {
  wave: number;
  taskIds: string[];
  status: "PASS" | "FAIL";
  results: DelegationExecutionResult[];
  barrier?: ValidationReport;
}

export interface PlannerWaveResult {
  used: boolean;
  plan?: PlannerOutput;
  schedule?: ParallelismPlan;
  waves: WaveExecutionSummary[];
  sessions: WorkerSession[];
  aggregateSession?: WorkerSession;
  report?: ValidationReport;
}

export async function executePlannerWaves(input: {
  root: string;
  stateRoot: string;
  config: HarnessProjectConfig;
  contract: TaskContract;
  topology: ResolvedAgentTopology;
  implementationSelection: AgentExecutionSelection;
  controller?: ControlPlaneSnapshot;
  revalidate: () => Promise<ValidationReport>;
}): Promise<PlannerWaveResult> {
  const planning = input.config.workflow?.planning;
  if (planning?.enabled === false || input.contract.mode === "quick") return { used: false, waves: [], sessions: [] };
  const planner = findPlanner(input.topology, planning?.plannerAgent);
  if (!planner) return { used: false, waves: [], sessions: [] };

  const plannerSelection = executionSelectionForAgent(input.topology, planner);
  const plannerSession = await executeAgentPrompt(input.root, input.config, input.contract, plannerSelection, buildPlannerPrompt(input.contract));
  const sessions: WorkerSession[] = [plannerSession];
  if (plannerSession.exitCode !== 0) return { used: true, waves: [], sessions, aggregateSession: aggregate(sessions, 1, "Planner runtime failed.") };

  let plan: PlannerOutput;
  try { plan = plannerOutputSchema.parse(extractMarkedJson(plannerSession.stdout, plannerSession.stderr)); }
  catch (error) { return { used: true, waves: [], sessions, aggregateSession: aggregate(sessions, 1, `Invalid planner output: ${String(error)}`) }; }
  const planIssues = validatePlan(input.contract, input.topology, plan);
  if (planIssues.length) return { used: true, plan, waves: [], sessions, aggregateSession: aggregate(sessions, 1, `Planner contract rejected: ${planIssues.join("; ")}`) };
  if (!plan.tasks.length) return { used: false, plan, waves: [], sessions };

  const schedule = await planParallelism(input.root, input.config, input.contract.task.id, plan.tasks);
  await recordEvent(input.stateRoot, input.config, "harness.plan.ready", { taskId: input.contract.task.id, tasks: plan.tasks.length, waves: schedule.waves.length, conflicts: schedule.conflicts.length, graphUsed: schedule.graphUsed });

  const acceptedPatches: string[] = [];
  const waveSummaries: WaveExecutionSummary[] = [];
  let finalReport: ValidationReport | undefined;
  for (let index = 0; index < schedule.waves.length; index += 1) {
    const ids = schedule.waves[index];
    const tasks = ids.map((id) => plan.tasks.find((task) => task.id === id)!).filter(Boolean);
    const results = await mapLimit(tasks, planning?.maxWaveConcurrency ?? tasks.length, (task) => executeDelegation({ ...input, task, priorPatches: acceptedPatches }));
    sessions.push(...results.map((result) => result.session));
    if (results.some((result) => result.status === "FAIL")) {
      const summary: WaveExecutionSummary = { wave: index + 1, taskIds: ids, status: "FAIL", results };
      waveSummaries.push(summary);
      await recordEvent(input.stateRoot, input.config, "harness.wave.finish", { taskId: input.contract.task.id, wave: index + 1, status: "FAIL", tasks: ids });
      return { used: true, plan, schedule, waves: waveSummaries, sessions, aggregateSession: aggregate(sessions, 1, `Wave ${index + 1} failed.`) };
    }

    for (const result of results) {
      if (!result.patch.trim()) continue;
      const check = await runProcess("git apply --check --binary -", { cwd: input.root, timeoutMs: 60_000, stdin: result.patch });
      if (check.exitCode !== 0) {
        result.status = "FAIL"; result.message = `Patch integration check failed: ${check.stderr || check.stdout}`;
        const summary: WaveExecutionSummary = { wave: index + 1, taskIds: ids, status: "FAIL", results };
        waveSummaries.push(summary);
        return { used: true, plan, schedule, waves: waveSummaries, sessions, aggregateSession: aggregate(sessions, 1, result.message) };
      }
    }
    for (const result of results) {
      if (!result.patch.trim()) continue;
      const apply = await runProcess("git apply --binary -", { cwd: input.root, timeoutMs: 60_000, stdin: result.patch });
      if (apply.exitCode !== 0) throw new Error(`Previously checked wave patch failed to apply: ${apply.stderr || apply.stdout}`);
      acceptedPatches.push(result.patch);
    }

    finalReport = planning?.barrierValidation === false ? undefined : await input.revalidate();
    const status = finalReport?.status === "FAIL" ? "FAIL" : "PASS";
    const summary: WaveExecutionSummary = { wave: index + 1, taskIds: ids, status, results, barrier: finalReport };
    waveSummaries.push(summary);
    await recordEvent(input.stateRoot, input.config, "harness.wave.finish", { taskId: input.contract.task.id, wave: index + 1, status, tasks: ids, checks: finalReport?.checks.length });
    if (status === "FAIL") return { used: true, plan, schedule, waves: waveSummaries, sessions, aggregateSession: aggregate(sessions, 1, `Wave ${index + 1} deterministic barrier failed.`), report: finalReport };
  }

  finalReport ??= await input.revalidate();
  return { used: true, plan, schedule, waves: waveSummaries, sessions, aggregateSession: aggregate(sessions, finalReport.status === "PASS" ? 0 : 1, `Executed ${plan.tasks.length} task(s) across ${schedule.waves.length} wave(s).`), report: finalReport };
}

async function executeDelegation(input: {
  root: string;
  stateRoot: string;
  config: HarnessProjectConfig;
  contract: TaskContract;
  topology: ResolvedAgentTopology;
  implementationSelection: AgentExecutionSelection;
  controller?: ControlPlaneSnapshot;
  task: DelegationTask;
  priorPatches: string[];
}): Promise<DelegationExecutionResult> {
  const selection = input.topology.agents[input.task.agent] ? executionSelectionForAgent(input.topology, input.task.agent) : input.implementationSelection;
  const transport = selection.transport === "inherit" ? (input.config.orchestration?.provider ?? "none") : selection.transport;
  const capabilityIssues = validateExecutionCapabilities(selection, transport);
  if (capabilityIssues.length) return failed(input.task, selection, `Agent ${selection.logicalAgent} cannot execute: ${capabilityIssues.join("; ")}`);

  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), `aeh-${safe(input.contract.task.id)}-${safe(input.task.id)}-`));
  const add = await runProcess(`git worktree add --detach ${quote(worktree)} HEAD`, { cwd: input.root, timeoutMs: 120_000 });
  if (add.exitCode !== 0) return failed(input.task, selection, `Unable to create task worktree: ${add.stderr || add.stdout}`);
  try {
    for (const patchText of input.priorPatches) {
      const applied = await runProcess("git apply --binary -", { cwd: worktree, timeoutMs: 60_000, stdin: patchText });
      if (applied.exitCode !== 0) return failed(input.task, selection, `Unable to materialize prior wave state: ${applied.stderr || applied.stdout}`);
    }
    await copyTaskContext(input.root, worktree, input.config, input.contract);
    if (input.controller) await materializeControlPlaneSnapshot(input.controller, worktree, input.config);
    await runProcess("git add -A && git -c user.name=aeh -c user.email=aeh@localhost commit --no-gpg-sign -m 'aeh wave baseline' --allow-empty", { cwd: worktree, timeoutMs: 60_000 });

    const session = await executeAgentPrompt(worktree, input.config, input.contract, selection, buildDelegationPrompt(input.contract, input.task));
    if (session.exitCode !== 0) return { task: input.task, session, changedFiles: [], patch: "", status: "FAIL", message: `Agent exited with ${session.exitCode}.` };
    const status = await runProcess("git status --porcelain", { cwd: worktree, timeoutMs: 30_000 });
    const untracked = status.stdout.split(/\r?\n/).filter((line) => line.startsWith("?? ")).map((line) => line.slice(3).trim()).filter(Boolean);
    if (untracked.length) await runProcess(`git add -N -- ${untracked.map(quote).join(" ")}`, { cwd: worktree, timeoutMs: 30_000 });
    const names = await runProcess("git diff --name-only HEAD", { cwd: worktree, timeoutMs: 30_000 });
    const changedFiles = names.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const violations = changedFiles.filter((file) => !matchesAny(file, input.task.scope));
    if (violations.length) return { task: input.task, session, changedFiles, patch: "", status: "FAIL", message: `Delegation escaped scope: ${violations.join(", ")}` };
    const diff = await runProcess("git diff --binary --no-ext-diff HEAD", { cwd: worktree, timeoutMs: 60_000 });
    if (diff.exitCode !== 0) return { task: input.task, session, changedFiles, patch: "", status: "FAIL", message: diff.stderr || "Unable to capture delegation patch." };
    return { task: input.task, session, changedFiles, patch: diff.stdout, status: "PASS" };
  } finally {
    await runProcess(`git worktree remove --force ${quote(worktree)}`, { cwd: input.root, timeoutMs: 120_000 });
    await fs.rm(worktree, { recursive: true, force: true }).catch(() => undefined);
  }
}

function validatePlan(contract: TaskContract, topology: ResolvedAgentTopology, plan: PlannerOutput): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  const requirements = new Set((contract.requirements ?? []).map((item) => item.id));
  for (const task of plan.tasks) {
    if (ids.has(task.id)) issues.push(`duplicate task id ${task.id}`); ids.add(task.id);
    if (!topology.agents[task.agent]) issues.push(`${task.id} references unknown agent ${task.agent}`);
    if (!task.scope.length) issues.push(`${task.id} has empty scope`);
    for (const scope of task.scope) if (!withinContractScope(scope, contract.scope?.allowed ?? ["**"])) issues.push(`${task.id} scope ${scope} is outside TaskContract scope`);
    for (const req of task.acceptance) if (requirements.size && !requirements.has(req)) issues.push(`${task.id} references unknown requirement ${req}`);
  }
  for (const task of plan.tasks) for (const dependency of task.dependencies) if (!ids.has(dependency)) issues.push(`${task.id} depends on unknown task ${dependency}`);
  return [...new Set(issues)];
}

function findPlanner(topology: ResolvedAgentTopology, configured?: string): string | undefined {
  if (configured && topology.agents[configured] && !topology.agents[configured].disabled) return configured;
  return Object.values(topology.agents).find((agent) => agent.role === "planner" && !agent.disabled)?.name;
}

function buildPlannerPrompt(contract: TaskContract): string {
  const requirements = (contract.requirements ?? []).map((item) => `- ${item.id}: ${item.description ?? ""}`).join("\n") || "- none";
  return `Create the implementation delegation plan for ${contract.task.id}: ${contract.task.title}.\nThe TaskContract and sealed sources are immutable. Produce the smallest dependency-aware tasks, assign each to a configured logical implementer, give concrete path scopes, and map every task to requirement IDs. Do not create product requirements.\nRequirements:\n${requirements}\nAllowed scope: ${(contract.scope?.allowed ?? ["**"]).join(", ")}\nReturn exactly one final line beginning AEH_RESULT_JSON= followed by JSON matching the planner output contract.`;
}

function buildDelegationPrompt(contract: TaskContract, task: DelegationTask): string {
  return `Implement only delegated task ${task.id} for parent ${contract.task.id}.\nSummary: ${task.summary}\nAllowed task scope: ${task.scope.join(", ")}\nDependencies already integrated: ${task.dependencies.join(", ") || "none"}\nAcceptance requirement IDs: ${task.acceptance.join(", ")}\nRisk: ${task.risk}.\nThe parent TaskContract, SDD and control-plane snapshot are frozen. Do not edit outside the delegated scope, do not commit, push, rebase or change requirements. Run focused tests when practical and leave the worktree with only the implementation diff.`;
}

async function copyTaskContext(root: string, target: string, config: HarnessProjectConfig, contract: TaskContract): Promise<void> {
  const relative = [
    `${config.sdd?.contractsDir ?? ".harness/contracts"}/${contract.task.id}.yaml`,
    `.harness/seals/${contract.task.id}.json`,
    ...Object.values(contract.source ?? {}).filter((value): value is string => Boolean(value)),
    contract.issue?.snapshotPath
  ].filter((value): value is string => Boolean(value));
  for (const item of [...new Set(relative)]) {
    const source = path.resolve(root, item); const destination = path.resolve(target, item);
    try { await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.copyFile(source, destination); } catch { /* validation will surface truly required missing context */ }
  }
}

function withinContractScope(candidate: string, allowed: string[]): boolean { return allowed.some((pattern) => pattern === "**" || minimatch(candidate, pattern, { dot: true }) || staticPrefix(candidate).startsWith(staticPrefix(pattern))); }
function matchesAny(file: string, patterns: string[]): boolean { return patterns.some((pattern) => minimatch(file, pattern, { dot: true }) || file.startsWith(staticPrefix(pattern))); }
function staticPrefix(pattern: string): string { return pattern.split(/[?*\[]/, 1)[0].replace(/\/+$/, ""); }
function failed(task: DelegationTask, selection: AgentExecutionSelection, message: string): DelegationExecutionResult { return { task, session: { provider: selection.runtimeAdapter, model: selection.modelName, logicalAgent: selection.logicalAgent, runtime: selection.runtimeName, profile: selection.profile, exitCode: 1, stdout: "", stderr: message }, changedFiles: [], patch: "", status: "FAIL", message }; }
function aggregate(sessions: WorkerSession[], exitCode: number, message: string): WorkerSession { return { provider: "multi-worker", logicalAgent: "planner-waves", exitCode, stdout: message, stderr: exitCode ? sessions.filter((session) => session.exitCode !== 0).map((session) => session.stderr).filter(Boolean).join("\n") : "" }; }
async function mapLimit<T, R>(values: T[], limit: number, fn: (value: T) => Promise<R>): Promise<R[]> { const result = new Array<R>(values.length); let cursor = 0; const workers = Array.from({ length: Math.max(1, Math.min(limit, values.length)) }, async () => { while (true) { const index = cursor++; if (index >= values.length) return; result[index] = await fn(values[index]); } }); await Promise.all(workers); return result; }
function safe(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, "-"); }
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
