#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { initializeProject } from "./core/init.js";
import { loadProjectConfig } from "./core/config.js";
import { compileAgentTopology } from "./agents/compiler.js";
import { compileToolchain, setupToolchain } from "./toolchain/setup.js";
import { loadToolchainConfig } from "./toolchain/config.js";
import { resolveToolchain } from "./toolchain/resolve.js";
import { runDistributedWorkerLoop } from "./distributed/worker.js";
import { serveDistributedQueue } from "./distributed/queue.js";
import { resolveOrganizationPolicyBundles } from "./policy/bundles.js";
import { benchmarkMcpCatalog } from "./mcp/benchmark.js";
import { buildEvalDashboard, runRepeatedEval } from "./evals/statistics.js";
import { startPaseoHarness } from "./paseo/start.js";
import { runDeterministicPaseoTurn, startDeterministicPaseoHarness } from "./paseo/deterministicSession.js";
import { guardLeadContext } from "./paseo/context.js";
import { listManagedPaseoAgents } from "./paseo/runtime.js";
import { prepareOpenSpecChange, compileOpenSpecChange } from "./spec/openspec.js";
import { classifyEngineeringIntent, formatEngineeringIntent } from "./audit/intent.js";
import { runAudit } from "./audit/run.js";
import type { TaskRisk } from "./core/types.js";
import { VERSION } from "./version.js";
import { retrievePersistedContext } from "./context/retrieval/persisted.js";
import { serveContextRetrievalMcp } from "./context/retrieval/server.js";

const args = process.argv.slice(2);
if (args.length === 1 && ["--version", "-V"].includes(args[0])) { console.log(VERSION); process.exit(0); }

if (args[0] === "start") { await runStart(args.slice(1)); process.exit(process.exitCode ?? 0); }
if (args[0] === "paseo" && args[1] === "turn") { await runPaseoTurn(args.slice(2)); process.exit(process.exitCode ?? 0); }
if (args[0] === "context" && args[1] === "guard") { await runContextGuard(args.slice(2)); process.exit(process.exitCode ?? 0); }
if (args[0] === "context" && args[1] === "retrieve") { await runContextRetrieve(args.slice(2)); process.exit(process.exitCode ?? 0); }
if (args[0] === "context" && args[1] === "mcp") { await serveContextRetrievalMcp(); process.exit(process.exitCode ?? 0); }
if (args[0] === "paseo" && args[1] === "agents") { await runPaseoAgents(args.slice(2)); process.exit(process.exitCode ?? 0); }
if (args[0] === "spec" && ["prepare", "compile"].includes(args[1] ?? "")) { await runSpec(args.slice(1)); process.exit(process.exitCode ?? 0); }
if (args[0] === "intent") { await runIntent(args.slice(1)); process.exit(process.exitCode ?? 0); }
if (args[0] === "audit") { await runAuditCommand(args.slice(1)); process.exit(process.exitCode ?? 0); }
if (args[0] === "setup") { await runSetup(args.slice(1)); process.exit(process.exitCode ?? 0); }
if (args[0] === "toolchain") { await runToolchain(args.slice(1)); process.exit(process.exitCode ?? 0); }
if (args[0] === "init" && args.includes("--setup")) { await runInitSetup(args.slice(1)); process.exit(process.exitCode ?? 0); }
if (args[0] === "worker") { await runWorker(args.slice(1)); process.exit(process.exitCode ?? 0); }
if (args[0] === "policy" && args[1] === "sync") { await runPolicySync(args.slice(2)); process.exit(process.exitCode ?? 0); }
if (args[0] === "mcp" && args[1] === "benchmark") { await runMcpBenchmark(args.slice(2)); process.exit(process.exitCode ?? 0); }
if (args[0] === "eval" && ["repeat", "dashboard"].includes(args[1] ?? "")) { await runStatisticalEval(args.slice(1)); process.exit(process.exitCode ?? 0); }

await import("./cli.js");

async function runStart(argv: string[]): Promise<void> {
  const parsed = parseGeneric(argv, new Set(["lead", "title"]), new Set(["new", "resume", "no-web-ui", "no-setup", "deterministic"]));
  if (parsed.positional.length > 1) throw new Error(`aeh start accepts at most one project directory, received: ${parsed.positional.join(", ")}`);
  if (parsed.flag("new") && parsed.flag("resume")) throw new Error("aeh start cannot combine --new and --resume.");
  const root = path.resolve(parsed.positional[0] ?? ".");
  const config = await loadProjectConfig(root);
  const entry = path.resolve(process.argv[1]);
  const aehCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(entry)}`;
  const start = parsed.flag("deterministic") || process.env.AEH_DETERMINISTIC_PASEO === "1" ? startDeterministicPaseoHarness : startPaseoHarness;
  const result = await start(root, config, {
    autoSetup: parsed.flag("no-setup") ? false : undefined,
    webUi: parsed.flag("no-web-ui") ? false : undefined,
    forceNew: parsed.flag("new"),
    resume: parsed.flag("resume"),
    leadAgent: parsed.value("lead"),
    title: parsed.value("title"),
    aehCommand
  });
  console.log(`AEH Paseo ready for ${config.project.name}.`);
  console.log(`daemon=${result.daemonStarted ? "started" : "reused"}`);
  console.log(`session=${result.session}`);
  console.log(`lead=${result.leadAgent}`);
  console.log(`provider=${result.provider}`);
  console.log(`model=${result.model}`);
  if (result.paseoVersion) console.log(`paseo=${result.paseoVersion}`);
  console.log(`agentId=${result.agentId}`);
  console.log(`title=${result.title}`);
  if (parsed.flag("deterministic") || process.env.AEH_DETERMINISTIC_PASEO === "1") console.log("sessionBoundary=deterministic-fake-paseo-sdk");
  console.log(`Open Paseo and continue in '${result.title}'. Engineering operations route through the Harness; normal aeh start creates a fresh lead, while --resume explicitly reuses a compatible one.`);
}

async function runPaseoTurn(argv: string[]): Promise<void> {
  const parsed = parseGeneric(argv, new Set(), new Set(["json"]));
  if (parsed.positional.length < 1 || parsed.positional.length > 2) throw new Error("aeh paseo turn accepts <simulated-user-prompt> and at most one project directory.");
  const result = await runDeterministicPaseoTurn(path.resolve(parsed.positional[1] ?? "."), await loadProjectConfig(path.resolve(parsed.positional[1] ?? ".")), parsed.positional[0]);
  if (parsed.flag("json")) console.log(JSON.stringify(result, null, 2));
  else console.log(result.human);
}

async function runContextGuard(argv: string[]): Promise<void> {
  const parsed = parseGeneric(argv, new Set(["agent", "brief"]), new Set());
  if (parsed.positional.length > 1) throw new Error("aeh context guard accepts at most one project directory.");
  const root = path.resolve(parsed.positional[0] ?? ".");
  const config = await loadProjectConfig(root);
  const agentId = parsed.value("agent") ?? process.env.PASEO_AGENT_ID;
  if (!agentId) throw new Error("aeh context guard requires --agent <id> or PASEO_AGENT_ID.");
  const result = await guardLeadContext(root, config, agentId, { brief: parsed.value("brief") });
  console.log(result.state);
  console.log(result.message);
  console.log(JSON.stringify(result, null, 2));
}

async function runContextRetrieve(argv: string[]): Promise<void> {
  const parsed = parseGeneric(argv, new Set(["fragment", "agent", "max-tokens"]), new Set());
  if (parsed.positional.length > 2) throw new Error("aeh context retrieve accepts <operationId> and at most one project directory.");
  const operationId = parsed.positional[0]; if (!operationId) throw new Error("aeh context retrieve requires <operationId>.");
  const root = path.resolve(parsed.positional[1] ?? "."); const fragmentId = parsed.value("fragment"); if (!fragmentId) throw new Error("aeh context retrieve requires --fragment <id>.");
  const logicalAgent = parsed.value("agent") ?? process.env.AEH_LOGICAL_AGENT; if (!logicalAgent) throw new Error("aeh context retrieve requires --agent <logical-agent> or AEH_LOGICAL_AGENT.");
  const maxTokens = parsed.value("max-tokens") ? Number(parsed.value("max-tokens")) : undefined; if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens <= 0)) throw new Error("--max-tokens must be a positive integer.");
  const config = await loadProjectConfig(root); console.log(JSON.stringify(await retrievePersistedContext(root, config, operationId, logicalAgent, { fragmentId, maxTokens }), null, 2));
}

async function runPaseoAgents(argv: string[]): Promise<void> {
  const parsed = parseGeneric(argv, new Set(["task", "role", "kind", "status"]), new Set(["json"]));
  if (parsed.positional.length > 1) throw new Error("aeh paseo agents accepts at most one project directory.");
  const root = path.resolve(parsed.positional[0] ?? ".");
  const config = await loadProjectConfig(root);
  const labels: Record<string, string> = { "aeh.project": config.project.name };
  if (parsed.value("task")) labels["aeh.task"] = parsed.value("task")!;
  if (parsed.value("role")) labels["aeh.role"] = parsed.value("role")!;
  if (parsed.value("kind")) labels["aeh.kind"] = parsed.value("kind")!;
  const requestedStatus = parsed.value("status");
  const agents = (await listManagedPaseoAgents(root, labels)).filter((agent) => !requestedStatus || agent.status === requestedStatus);
  const view = agents.map((agent) => ({ id: agent.id, status: agent.status ?? "unknown", title: agent.title, workspaceId: agent.workspaceId, role: agent.labels?.["aeh.role"], task: agent.labels?.["aeh.task"], kind: agent.labels?.["aeh.kind"], labels: agent.labels }));
  if (parsed.flag("json")) { console.log(JSON.stringify(view, null, 2)); return; }
  if (!view.length) { console.log("No matching active AEH Paseo agents."); return; }
  for (const agent of view) console.log(`${agent.status.padEnd(12)} role=${(agent.role ?? "-").padEnd(24)} task=${(agent.task ?? "-").padEnd(24)} kind=${(agent.kind ?? "-").padEnd(8)} id=${agent.id}${agent.title ? ` title=${agent.title}` : ""}`);
}

async function runSpec(argv: string[]): Promise<void> {
  const sub = argv[0];
  const parsed = parseGeneric(argv.slice(1), new Set(["title", "change"]), new Set());
  const taskId = parsed.positional[0];
  if (!taskId) throw new Error(`aeh spec ${sub} requires <taskId>.`);
  if (parsed.positional.length > 2) throw new Error(`aeh spec ${sub} accepts <taskId> and at most one project directory.`);
  const root = path.resolve(parsed.positional[1] ?? ".");
  const title = parsed.value("title");
  if (!title) throw new Error(`aeh spec ${sub} requires --title <title>.`);
  const config = await loadProjectConfig(root);
  if (sub === "prepare") {
    const result = await prepareOpenSpecChange(root, config, taskId, title);
    console.log(`OPENSPEC ${result.created ? "CREATED" : "READY"} ${result.changeName}`);
    console.log(`manager=${result.managerAgent}`);
    console.log(`schema=${result.schema}`);
    console.log(`directory=${path.relative(root, result.directory).replaceAll("\\", "/")}`);
    return;
  }
  if (sub === "compile") {
    const result = await compileOpenSpecChange(root, config, taskId, title, parsed.value("change"));
    console.log(`COMPILED ${result.changeName} -> ${taskId}`);
    console.log(`requirements=${result.requirements.join(",")}`);
    console.log(`sourceSha256=${result.sourceSha256}`);
    console.log(`contract=${path.relative(root, result.contractPath).replaceAll("\\", "/")}`);
    return;
  }
  throw new Error(`Unknown spec command '${sub}'. Use prepare or compile.`);
}

async function runIntent(argv: string[]): Promise<void> {
  const parsed = parseGeneric(argv, new Set(["file", "domain", "risk"]), new Set());
  const request = parsed.positional[0];
  if (!request) throw new Error("aeh intent requires a natural-language request.");
  if (parsed.positional.length > 2) throw new Error("aeh intent accepts <request> and at most one project directory.");
  const root = path.resolve(parsed.positional[1] ?? ".");
  const config = await loadProjectConfig(root);
  const decision = classifyEngineeringIntent(config, { request, files: parsed.values("file"), domains: parsed.values("domain"), risk: parseRisk(parsed.value("risk")) });
  console.log(formatEngineeringIntent(decision));
  console.log(JSON.stringify(decision, null, 2));
}

async function runAuditCommand(argv: string[]): Promise<void> {
  const parsed = parseGeneric(argv, new Set(["file", "domain", "risk", "reviewer"]), new Set());
  const request = parsed.positional[0];
  if (!request) throw new Error("aeh audit requires a natural-language audit request.");
  if (parsed.positional.length > 2) throw new Error("aeh audit accepts <request> and at most one project directory.");
  const root = path.resolve(parsed.positional[1] ?? ".");
  const config = await loadProjectConfig(root);
  const intent = classifyEngineeringIntent(config, { request, files: parsed.values("file"), domains: parsed.values("domain"), risk: parseRisk(parsed.value("risk")), explicitIntent: "audit" });
  if (intent.intent !== "audit") throw new Error(`Request did not resolve to AUDIT: ${formatEngineeringIntent(intent)}`);
  const report = await runAudit(root, config, { request, files: parsed.values("file"), domains: parsed.values("domain"), risk: parseRisk(parsed.value("risk")), reviewers: parsed.values("reviewer") });
  console.log(`AUDIT ${report.status} — ${report.auditId}`);
  console.log(`productionSafe=${report.productionSafe}`);
  console.log(`findings critical=${report.counts.critical} high=${report.counts.high} medium=${report.counts.medium} low=${report.counts.low} note=${report.counts.note}`);
  console.log(`debtScore=${report.debtScore}`);
  for (const check of report.validationChecks.filter((item) => item.status !== "PASS" && item.status !== "SKIP")) console.log(`validator ${check.status} ${check.id} class=${check.failureClass}: ${check.message}`);
  for (const finding of report.findings) console.log(`${finding.severity.toUpperCase()} ${finding.id} ${finding.location.file}: ${finding.evidence}`);
  console.log(`report=.harness/audits/${report.auditId}.json`);
}

async function runSetup(argv: string[]): Promise<void> {
  const parsed = parse(argv); const root = path.resolve(parsed.directory); const config = await loadProjectConfig(root);
  const result = await setupToolchain(root, config, { profile: parsed.value("profile"), dryRun: parsed.flag("dry-run"), updateLock: parsed.flag("update-lock"), skipProjectDependencies: parsed.flag("skip-project-deps"), preferContainers: parsed.flag("prefer-containers") });
  console.log(`${result.dryRun ? "DRY-RUN" : "READY"} toolchain profile=${result.profile}`); console.log(`miseConfig=${result.generatedConfig}`); console.log(`lock=${result.lockFile}`); console.log(`state=${result.stateFile}`); if (result.installed.length) console.log(`tools=${result.installed.join(", ")}`); if (result.containers.length) console.log(`containers=${result.containers.join(", ")}`); if (result.projectDependencyCommands.length) console.log(`projectDeps=${result.projectDependencyCommands.join(" && ")}`); if (result.systemMissing.length) { console.error(`missingSystem=${result.systemMissing.join(", ")}`); process.exitCode = 1; }
}
async function runToolchain(argv: string[]): Promise<void> { const sub = argv[0] ?? "show"; const parsed = parse(argv.slice(1)); const root = path.resolve(parsed.directory); const config = await loadProjectConfig(root); if (sub === "compile") { console.log(`Compiled toolchain: ${await compileToolchain(root, config, { profile: parsed.value("profile"), updateLock: parsed.flag("update-lock") })}`); return; } if (sub === "show") { const tc = await loadToolchainConfig(root, config); console.log(JSON.stringify(await resolveToolchain(root, config, tc, { profile: parsed.value("profile") }), null, 2)); return; } if (sub === "setup") { await runSetup(argv.slice(1)); return; } throw new Error(`Unknown toolchain command '${sub}'. Use compile, show or setup.`); }
async function runInitSetup(argv: string[]): Promise<void> { const without = argv.filter((value) => value !== "--setup"); const parsed = parse(without); const root = path.resolve(parsed.directory); const created = await initializeProject(root); const config = await loadProjectConfig(root); if (config.agents) { const compiled = await compileAgentTopology(root, config); if (!compiled.ok) throw new Error(compiled.issues.join("; ")); } await compileToolchain(root, config); const setup = await setupToolchain(root, config, { profile: parsed.value("profile"), preferContainers: parsed.flag("prefer-containers") }); console.log(created.length ? `Created: ${created.join(", ")}` : "Harness already initialized."); console.log(`Toolchain ready: profile=${setup.profile}`); }

async function runWorker(argv: string[]): Promise<void> {
  const sub = argv[0] ?? "run"; const parsed = parseGeneric(argv.slice(1), new Set(["worker-id", "port", "host"]), new Set(["once"])); const root = path.resolve(parsed.positional[0] ?? "."); const config = await loadProjectConfig(root);
  if (sub === "run") { await runDistributedWorkerLoop(root, config, { workerId: parsed.value("worker-id"), once: parsed.flag("once") }); return; }
  if (sub === "serve") { const port = Number(parsed.value("port") ?? "8787"); if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("--port must be a valid TCP port."); const localConfig = { ...config, distributed: { ...config.distributed, provider: "filesystem" as const } }; await serveDistributedQueue(root, localConfig, { port, host: parsed.value("host") }); console.log(`AEH distributed queue listening on ${parsed.value("host") ?? "127.0.0.1"}:${port}`); await new Promise<void>(() => undefined); return; }
  throw new Error(`Unknown worker command '${sub}'. Use run or serve.`);
}

async function runPolicySync(argv: string[]): Promise<void> { const parsed = parseGeneric(argv, new Set(), new Set()); const root = path.resolve(parsed.positional[0] ?? "."); const config = await loadProjectConfig(root); const resolution = await resolveOrganizationPolicyBundles(root, config); console.log(JSON.stringify(resolution, null, 2)); if (resolution.issues.length && config.organization?.policyBundles?.required) process.exitCode = 1; }
async function runMcpBenchmark(argv: string[]): Promise<void> { const parsed = parseGeneric(argv, new Set(["server"]), new Set()); const root = path.resolve(parsed.positional[0] ?? "."); const config = await loadProjectConfig(root); const servers = parsed.values("server"); console.log(JSON.stringify(await benchmarkMcpCatalog(root, config, servers.length ? servers : undefined), null, 2)); }
async function runStatisticalEval(argv: string[]): Promise<void> { const sub = argv[0]; const parsed = parseGeneric(argv.slice(1), new Set(["variant", "runs"]), new Set()); const caseId = parsed.positional[0]; if (!caseId) throw new Error(`aeh eval ${sub} requires <caseId>.`); const root = path.resolve(parsed.positional[1] ?? "."); const config = await loadProjectConfig(root); if (sub === "repeat") { const runs = parsed.value("runs") ? Number(parsed.value("runs")) : undefined; console.log(JSON.stringify(await runRepeatedEval(root, config, caseId, parsed.value("variant"), runs), null, 2)); return; } console.log(JSON.stringify(await buildEvalDashboard(root, config, caseId), null, 2)); }

function parseRisk(value?: string): TaskRisk { if (!value) return "low"; if (value === "low" || value === "medium" || value === "high") return value; throw new Error(`Invalid risk '${value}'. Use low, medium or high.`); }
function parse(argv: string[]): { directory: string; flag(name: string): boolean; value(name: string): string | undefined } { const parsed = parseGeneric(argv, new Set(["profile"]), new Set(["dry-run", "update-lock", "skip-project-deps", "prefer-containers"])); if (parsed.positional.length > 1) throw new Error(`Expected at most one project directory, received: ${parsed.positional.join(", ")}`); return { directory: parsed.positional[0] ?? ".", flag: parsed.flag, value: parsed.value }; }
function parseGeneric(argv: string[], valueFlags: Set<string>, booleanFlags: Set<string>): { positional: string[]; flag(name: string): boolean; value(name: string): string | undefined; values(name: string): string[] } {
  const flags = new Map<string, Array<string | true>>(); const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) { const token = argv[i]; if (!token.startsWith("--")) { positional.push(token); continue; } const name = token.slice(2); if (valueFlags.has(name)) { const next = argv[++i]; if (!next || next.startsWith("--")) throw new Error(`--${name} requires a value.`); const list = flags.get(name) ?? []; list.push(next); flags.set(name, list); continue; } if (!booleanFlags.has(name)) throw new Error(`Unknown option --${name}.`); const list = flags.get(name) ?? []; list.push(true); flags.set(name, list); }
  return { positional, flag: (name) => flags.get(name)?.includes(true) ?? false, value: (name) => { const found = flags.get(name)?.find((item): item is string => typeof item === "string"); return found; }, values: (name) => (flags.get(name) ?? []).filter((item): item is string => typeof item === "string") };
}
