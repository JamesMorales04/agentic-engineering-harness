#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Command } from "commander";
import { initializeProject } from "./core/init.js";
import { loadProjectConfig, loadTaskContract } from "./core/config.js";
import { runDoctor } from "./core/doctor.js";
import { verifyTask } from "./core/verify.js";
import { createSddChange, formatTraceabilityMatrix, validateSddChange } from "./core/sdd.js";
import { createQuickContract, validateQuickTaskContract } from "./core/quick.js";
import { formatTriageDecision, triageChange, type TriageFlag } from "./core/triage.js";
import { GraphifyCodeIntelligenceProvider } from "./providers/graphify.js";
import { sealTask } from "./core/seal.js";
import { runTask, type TaskRunResult } from "./core/run.js";
import { snapshotGraph } from "./validators/graphify.js";
import { runProcess } from "./utils/process.js";
import { compareEvalCase, runEvalCase } from "./evals/runner.js";
import { recordEvent } from "./telemetry/events.js";
import { runMemoryBenchmark } from "./memory/benchmark.js";
import { generateProvenance } from "./provenance/generate.js";
import { compileAgentTopology } from "./agents/compiler.js";
import { auditAgentTopology } from "./agents/audit.js";
import { loadAgentTopologySource, loadResolvedAgentTopology } from "./agents/config.js";
import { resolveRoute } from "./agents/routing.js";
import { validateAgentOutput, plannerOutputSchema } from "./agents/outputContracts.js";
import { planParallelism } from "./agents/parallelism.js";
import { dedupeFindings, extractFindings } from "./agents/findings.js";
import { handoffTask } from "./delivery/handoff.js";
import { inspectGithubIssue, prepareGithubIssueTask } from "./issues/intake.js";

const program = new Command();
program.name("engineering-harness").description("Deterministic control layer for spec-driven, issue-driven and bounded quick multi-agent software engineering").version("0.5.0");

program.command("init").argument("[directory]", "Project directory", ".").action(async (directory: string) => {
  const root = path.resolve(directory); const created = await initializeProject(root); const config = await loadProjectConfig(root);
  if (config.agents) { const compiled = await compileAgentTopology(root, config); if (!compiled.ok) throw new Error(compiled.issues.join("; ")); }
  console.log(created.length ? `Created: ${created.join(", ")}` : "Harness already initialized.");
});
program.command("doctor").argument("[directory]", "Project directory", ".").action(async (directory: string) => {
  const root = path.resolve(directory); const config = await loadProjectConfig(root); const results = await runDoctor(root, config); let failed = false;
  for (const result of results) { const marker = result.ok ? "✓" : result.required ? "✗" : "!"; console.log(`${marker} ${result.component}: ${result.message}`); if (!result.ok && result.required) failed = true; }
  if (failed) process.exitCode = 1;
});

program.command("triage").description("Deterministically classify a bounded engineering request as QUICK or SPEC").argument("<request>").option("--file <files...>").option("--domain <domains...>").option("--risk <risk>", "low, medium or high", "low").option("--flag <flags...>").argument("[directory]", "Project directory", ".").action(async (request: string, directory: string, options: { file?: string[]; domain?: string[]; risk?: "low" | "medium" | "high"; flag?: TriageFlag[] }) => {
  const root = path.resolve(directory); const config = await loadProjectConfig(root); const decision = triageChange(config, { request, files: options.file, domains: options.domain, risk: options.risk, flags: options.flag });
  console.log(formatTriageDecision(decision)); console.log(JSON.stringify(decision, null, 2)); if (decision.mode === "spec") process.exitCode = 2;
});

const quick = program.command("quick").description("Create and validate bounded QuickContracts without SDD artifacts");
quick.command("new").argument("<taskId>").requiredOption("--title <title>").requiredOption("--request <request>").requiredOption("--scope <paths...>").requiredOption("--acceptance <items...>").option("--domain <domains...>").option("--risk <risk>", "low, medium or high", "low").option("--flag <flags...>").option("--profile <profile>").argument("[directory]", "Project directory", ".").action(async (taskId: string, directory: string, options: { title: string; request: string; scope: string[]; acceptance: string[]; domain?: string[]; risk?: "low" | "medium" | "high"; flag?: TriageFlag[]; profile?: string }) => {
  const root = path.resolve(directory); const config = await loadProjectConfig(root); const result = await createQuickContract(root, config, taskId, { title: options.title, request: options.request, scope: options.scope, acceptance: options.acceptance, domains: options.domain, risk: options.risk, flags: options.flag, profile: options.profile });
  console.log(`Created QuickContract: ${path.relative(root, result.file)}`);
});
quick.command("validate").argument("<taskId>").argument("[directory]", "Project directory", ".").action(async (taskId: string, directory: string) => {
  const root = path.resolve(directory); const config = await loadProjectConfig(root); const contract = await loadTaskContract(root, taskId, config); const result = validateQuickTaskContract(config, contract);
  if (result.ok) console.log(`✓ ${taskId} QuickContract is safe to execute.`); else { result.issues.forEach((issue) => console.error(`✗ ${issue}`)); process.exitCode = 1; }
});

const issue = program.command("issue").description("Inspect, freeze and execute an existing GitHub issue through the Harness workflow");
issue.command("inspect").argument("<number>").argument("[directory]", "Project directory", ".").action(async (number: string, directory: string) => {
  const root = path.resolve(directory); const config = await loadProjectConfig(root); const inspected = await inspectGithubIssue(root, config, parseIssueNumber(number));
  console.log(`${inspected.preliminaryMode.toUpperCase()} — ${inspected.snapshot.repository}#${inspected.snapshot.number} ${inspected.snapshot.title}`);
  console.log(`contentSha256=${inspected.snapshot.contentSha256}`); console.log(`reasons=${inspected.reasons.join("; ")}`); console.log(JSON.stringify(inspected.evidence, null, 2));
});
issue.command("import").argument("<number>").option("--refresh").option("--force").option("--no-planner").argument("[directory]", "Project directory", ".").action(async (number: string, directory: string, options: { refresh?: boolean; force?: boolean; planner: boolean }) => {
  const root = path.resolve(directory); const config = await loadProjectConfig(root); const prepared = await prepareGithubIssueTask(root, config, parseIssueNumber(number), { refresh: options.refresh, force: options.force, usePlanner: options.planner });
  console.log(`Prepared ${prepared.taskId} from ${prepared.snapshot.repository}#${prepared.snapshot.number}: mode=${prepared.mode}, normalizedBy=${prepared.normalizedBy}, sha=${prepared.snapshot.contentSha256.slice(0, 12)}`);
  if (prepared.traceability) console.log(`\n${prepared.traceability}`);
});
issue.command("implement").argument("<number>").option("--profile <profile>").option("--refresh").option("--force").option("--no-planner").argument("[directory]", "Project directory", ".").action(async (number: string, directory: string, options: { profile?: string; refresh?: boolean; force?: boolean; planner: boolean }) => {
  const root = path.resolve(directory); const result = await executeIssueWorkflow(root, parseIssueNumber(number), options); printRunResult(result.result, result.contract.mode ?? "spec");
});

const agents = program.command("agents").description("Compile, inspect and validate the declarative agent topology");
agents.command("compile").option("--profile <profile>").argument("[directory]", "Project directory", ".").action(async (directory: string, options: { profile?: string }) => { const root = path.resolve(directory); const config = await loadProjectConfig(root); const result = await compileAgentTopology(root, config, options.profile); if (!result.ok) { result.issues.forEach((issue) => console.error(`✗ ${issue}`)); process.exitCode = 1; } else console.log(`Compiled agent topology: ${result.output}`); });
agents.command("check").option("--profile <profile>").argument("[directory]", "Project directory", ".").action(async (directory: string, options: { profile?: string }) => { const root = path.resolve(directory); const config = await loadProjectConfig(root); const checkGenerated = !options.profile || options.profile === config.agents?.activeProfile; const report = await auditAgentTopology(root, config, options.profile, { checkGenerated }); for (const check of report.checks) console.log(`${check.status.padEnd(4)} ${check.id}: ${check.message}`); if (!report.ok) process.exitCode = 1; });
agents.command("list").option("--profile <profile>").argument("[directory]", "Project directory", ".").action(async (directory: string, options: { profile?: string }) => { const root = path.resolve(directory); const config = await loadProjectConfig(root); const topology = await loadResolvedAgentTopology(root, config, options.profile); for (const agent of Object.values(topology.agents)) console.log(`${agent.name.padEnd(28)} role=${agent.role.padEnd(12)} runtime=${agent.runtime.name.padEnd(10)} model=@${agent.model.alias}(${agent.model.id}) native=${agent.execution.nativeAgent ?? "-"} transport=${agent.execution.transport ?? "inherit"}`); });
agents.command("profiles").argument("[directory]", "Project directory", ".").action(async (directory: string) => { const root = path.resolve(directory); const config = await loadProjectConfig(root); const source = await loadAgentTopologySource(root, config); for (const name of Object.keys(source.profiles ?? {})) console.log(`${name}${name === (config.agents?.activeProfile ?? source.activeProfile) ? " *" : ""}`); });
agents.command("show").argument("<name>").option("--profile <profile>").argument("[directory]", "Project directory", ".").action(async (name: string, directory: string, options: { profile?: string }) => { const root = path.resolve(directory); const config = await loadProjectConfig(root); const topology = await loadResolvedAgentTopology(root, config, options.profile); const agent = topology.agents[name]; if (!agent) throw new Error(`Unknown agent ${name}`); console.log(JSON.stringify(agent, null, 2)); });
agents.command("route").requiredOption("--intent <intent>").option("--domain <domains...>").option("--file <files...>").option("--risk <risk>").option("--profile <profile>").argument("[directory]", "Project directory", ".").action(async (directory: string, options: { intent: string; domain?: string[]; file?: string[]; risk?: "low" | "medium" | "high"; profile?: string }) => { const root = path.resolve(directory); const config = await loadProjectConfig(root); const topology = await loadResolvedAgentTopology(root, config, options.profile); console.log(JSON.stringify(resolveRoute(topology, { intent: options.intent, domains: options.domain, files: options.file, risk: options.risk }), null, 2)); });
agents.command("validate-output").argument("<agent>").requiredOption("--file <path>").option("--profile <profile>").argument("[directory]", "Project directory", ".").action(async (agentName: string, directory: string, options: { file: string; profile?: string }) => { const root = path.resolve(directory); const config = await loadProjectConfig(root); const topology = await loadResolvedAgentTopology(root, config, options.profile); const contract = topology.agents[agentName]?.outputContract; if (!contract) throw new Error(`Agent ${agentName} has no outputContract.`); const result = validateAgentOutput(contract, JSON.parse(await fs.readFile(path.resolve(root, options.file), "utf8"))); if (result.ok) console.log(`PASS ${agentName} output satisfies ${contract}.`); else { result.issues.forEach((issue) => console.error(`FAIL ${issue}`)); process.exitCode = 1; } });
agents.command("parallelism").argument("<taskId>").requiredOption("--plan <path>").argument("[directory]", "Project directory", ".").action(async (taskId: string, directory: string, options: { plan: string }) => { const root = path.resolve(directory); const config = await loadProjectConfig(root); const parsed = plannerOutputSchema.parse(JSON.parse(await fs.readFile(path.resolve(root, options.plan), "utf8"))); const result = await planParallelism(root, config, taskId, parsed.tasks); console.log(JSON.stringify(result, null, 2)); });
agents.command("dedupe-findings").requiredOption("--input <paths...>").option("--out <path>").argument("[directory]", "Project directory", ".").action(async (directory: string, options: { input: string[]; out?: string }) => { const root = path.resolve(directory); const findings = []; for (const file of options.input) findings.push(...extractFindings(JSON.parse(await fs.readFile(path.resolve(root, file), "utf8")))); const result = dedupeFindings(findings); const json = `${JSON.stringify(result, null, 2)}\n`; if (options.out) { await fs.mkdir(path.dirname(path.resolve(root, options.out)), { recursive: true }); await fs.writeFile(path.resolve(root, options.out), json); console.log(`Wrote ${options.out}`); } else process.stdout.write(json); });

const sdd = program.command("sdd").description("Spec-driven development workflow");
sdd.command("new").argument("<taskId>").requiredOption("--title <title>").argument("[directory]", "Project directory", ".").action(async (taskId: string, directory: string, options: { title: string }) => { const root = path.resolve(directory); const config = await loadProjectConfig(root); const dir = await createSddChange(root, taskId, options.title, config); console.log(`Created SDD change at ${dir}`); console.log(`Created TaskContract at ${config.sdd?.contractsDir ?? ".harness/contracts"}/${taskId}.yaml`); });
sdd.command("validate").argument("<taskId>").argument("[directory]", "Project directory", ".").action(async (taskId: string, directory: string) => { const root = path.resolve(directory); const config = await loadProjectConfig(root); const result = await validateSddChange(root, taskId, config); console.log(formatTraceabilityMatrix(result.requirements)); if (result.ok) console.log(`\n✓ ${taskId} SDD traceability is complete.`); else { for (const item of result.missing) console.error(`✗ missing: ${item}`); for (const issue of result.issues) console.error(`✗ ${issue}`); process.exitCode = 1; } });
sdd.command("handoff").description("Publish a validated/sealed task to the optional GitHub issue/branch and Paseo worktree delivery flow").argument("<taskId>").argument("[directory]", "Project directory", ".").action(async (taskId: string, directory: string) => { const root = path.resolve(directory); const config = await loadProjectConfig(root); const record = await handoffTask(root, config, taskId); console.log(JSON.stringify(record, null, 2)); });

program.command("seal").argument("<taskId>").argument("[directory]", "Project directory", ".").action(async (taskId: string, directory: string) => { const root = path.resolve(directory); const config = await loadProjectConfig(root); const contract = await loadTaskContract(root, taskId, config); console.log(`Sealed ${taskId}: ${await sealTask(root, config, contract)}`); });
program.command("verify").argument("<taskId>").argument("[directory]", "Project directory", ".").action(async (taskId: string, directory: string) => { const root = path.resolve(directory); const config = await loadProjectConfig(root); const contract = await loadTaskContract(root, taskId, config); const report = await verifyTask(root, config, contract); printChecks(report.checks); console.log(`\n${report.status} — report written to ${(config.sdd?.reportsDir ?? ".harness/reports")}/${taskId}.json`); if (report.status === "FAIL") process.exitCode = 1; });
program.command("run").argument("[taskId]").option("--issue <number>", "Import and execute an existing GitHub issue").option("--profile <profile>").option("--refresh-issue").option("--force-issue-refresh").option("--no-planner").argument("[directory]", "Project directory", ".").description("Execute TaskContract/SDD or an existing GitHub issue through routing, deterministic validation and quality convergence").action(async (taskId: string | undefined, directory: string, options: { issue?: string; profile?: string; refreshIssue?: boolean; forceIssueRefresh?: boolean; planner: boolean }) => {
  const root = path.resolve(directory); const config = await loadProjectConfig(root);
  if (options.issue) { const executed = await executeIssueWorkflow(root, parseIssueNumber(options.issue), { profile: options.profile, refresh: options.refreshIssue, force: options.forceIssueRefresh, planner: options.planner }); printRunResult(executed.result, executed.contract.mode ?? "spec"); return; }
  if (!taskId) throw new Error("run requires <taskId> or --issue <number>.");
  const contract = await loadTaskContract(root, taskId, config); const result = await runTask(root, config, contract, { profile: options.profile }); printRunResult(result, contract.mode ?? "spec");
});
program.command("intervention").argument("<taskId>").requiredOption("--reason <reason>").argument("[directory]", "Project directory", ".").action(async (taskId: string, directory: string, options: { reason: string }) => { const root = path.resolve(directory); const config = await loadProjectConfig(root); await recordEvent(root, config, "harness.human.intervention", { taskId, reason: options.reason }); console.log(`Recorded human intervention for ${taskId}.`); });

const evalCommand = program.command("eval").description("Run and compare frozen engineering evals");
evalCommand.command("run").argument("<caseId>").option("--variant <name>").argument("[directory]", "Project directory", ".").action(async (caseId: string, directory: string, options: { variant?: string }) => { const root = path.resolve(directory); const config = await loadProjectConfig(root); const result = await runEvalCase(root, config, caseId, options.variant); console.log(`${result.status} ${result.caseId}/${result.variant} score=${result.score} repairs=${result.metrics?.repairCount ?? "n/a"} costUsd=${result.metrics?.usage.costUsd ?? "n/a"}`); if (result.status === "FAIL") process.exitCode = 1; });
evalCommand.command("compare").argument("<caseId>").argument("[directory]", "Project directory", ".").action(async (caseId: string, directory: string) => { const root = path.resolve(directory); const config = await loadProjectConfig(root); const results = await compareEvalCase(root, config, caseId); if (!results.length) { console.log("No eval results found."); return; } for (const [index, result] of results.entries()) console.log(`${index + 1}. ${result.variant.padEnd(20)} score=${String(result.score).padEnd(8)} status=${result.status} repairs=${result.metrics?.repairCount ?? "n/a"} cost=${result.metrics?.usage.costUsd ?? "n/a"}`); });
program.command("memory-benchmark").argument("[directory]", "Project directory", ".").action(async (directory: string) => { const root = path.resolve(directory); const config = await loadProjectConfig(root); const report = await runMemoryBenchmark(root, config); for (const [index, provider] of report.providers.entries()) console.log(`${index + 1}. ${provider.provider.padEnd(18)} score=${String(provider.score).padEnd(8)} recall=${provider.averageRecall} contamination=${provider.averageContamination} latencyMs=${provider.averageLatencyMs}`); });
program.command("telemetry-test").argument("[directory]", "Project directory", ".").action(async (directory: string) => { const root = path.resolve(directory); const config = await loadProjectConfig(root); await recordEvent(root, config, "harness.telemetry.test", { project: config.project.name, ok: true }); console.log(`Telemetry test event recorded; exporter=${config.telemetry?.exporter ?? "none"}.`); });
const provenance = program.command("provenance").description("Generate SLSA/in-toto provenance and optional SBOM/signature");
provenance.command("generate").requiredOption("--artifact <path>").option("--task <id>").option("--no-sbom").option("--sign").argument("[directory]", "Project directory", ".").action(async (directory: string, options: { artifact: string; task?: string; sbom: boolean; sign?: boolean }) => { const root = path.resolve(directory); const config = await loadProjectConfig(root); const result = await generateProvenance(root, config, { artifact: options.artifact, taskId: options.task, sbom: options.sbom, sign: options.sign }); console.log(`statement=${result.statementFile}`); console.log(`predicate=${result.predicateFile}`); if (result.sbomFile) console.log(`sbom=${result.sbomFile}`); if (result.bundleFile) console.log(`sigstoreBundle=${result.bundleFile}`); });
program.command("graph-snapshot").argument("<taskId>").requiredOption("--phase <phase>").argument("[directory]", "Project directory", ".").action(async (taskId: string, directory: string, options: { phase: string }) => { if (options.phase !== "before" && options.phase !== "after") throw new Error("--phase must be before or after"); const root = path.resolve(directory); const config = await loadProjectConfig(root); const file = await snapshotGraph(root, config, taskId, options.phase); if (!file) { console.error("Graphify graph not found or unreadable."); process.exitCode = 1; } else console.log(`Graphify ${options.phase} snapshot: ${file}`); });
program.command("graph-update").argument("[directory]", "Project directory", ".").action(async (directory: string) => { const root = path.resolve(directory); const config = await loadProjectConfig(root); const refresh = config.codeIntelligence?.refreshCommand; if (refresh) { const result = await runProcess(refresh, { cwd: root, timeoutMs: 300_000 }); if (result.exitCode !== 0) { console.error(result.stderr || result.stdout || "Graphify refresh command failed."); process.exitCode = 1; return; } console.log("Configured Graphify refresh command completed."); return; } const health = await new GraphifyCodeIntelligenceProvider().doctor(root); console.log(health.message); if (!health.ok) process.exitCode = 1; });

async function executeIssueWorkflow(root: string, issueNumber: number, options: { profile?: string; refresh?: boolean; force?: boolean; planner?: boolean }): Promise<{ result: TaskRunResult; contract: Awaited<ReturnType<typeof loadTaskContract>> }> {
  const config = await loadProjectConfig(root);
  const prepared = await prepareGithubIssueTask(root, config, issueNumber, { refresh: options.refresh, force: options.force, usePlanner: options.planner !== false });
  if (config.workflow?.issueIntake?.autoHandoff !== false && (config.delivery?.github?.enabled || config.delivery?.paseo?.enabled)) await handoffTask(root, config, prepared.taskId);
  const contract = await loadTaskContract(root, prepared.taskId, config);
  const result = await runTask(root, config, contract, { profile: options.profile });
  return { result, contract };
}
function parseIssueNumber(value: string): number { const parsed = Number(value.replace(/^#/, "")); if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid GitHub issue number: ${value}`); return parsed; }
function printRunResult(result: TaskRunResult, mode: string): void { printChecks(result.report.checks); console.log(`\n${result.status} — mode=${mode}, agent=${result.routing?.agent ?? result.worker.provider}, runtime=${result.routing?.runtime ?? result.worker.provider}, model=${result.routing?.model ?? result.worker.model ?? "default"}, profile=${result.routing?.profile ?? "legacy"}, repairs=${result.metrics.repairCount}, review=${result.review?.status ?? "skipped"}, finalState=${result.review?.finalState ?? "n/a"}, qualityRounds=${result.review?.rounds ?? 0}, debtScore=${result.review?.debtScore ?? "n/a"}, convergence=${result.review?.convergence ?? "n/a"}, humanRequired=${result.review?.humanRequired ?? false}, firstPass=${result.metrics.firstPassSuccess}, tokens=${result.metrics.usage.totalTokens ?? "n/a"}, costUsd=${result.metrics.usage.costUsd ?? "n/a"}`); if (result.status === "FAIL") process.exitCode = 1; }
function printChecks(checks: Array<{ status: string; id: string; message: string }>): void { for (const check of checks) console.log(`${check.status.padEnd(4)} ${check.id}: ${check.message}`); }
await program.parseAsync(process.argv);
