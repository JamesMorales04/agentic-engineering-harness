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

const VERSION = "0.5.1";
const args = process.argv.slice(2);
if (args.length === 1 && ["--version", "-V"].includes(args[0])) { console.log(VERSION); process.exit(0); }

if (args[0] === "start") { await runStart(args.slice(1)); process.exit(process.exitCode ?? 0); }
if (args[0] === "setup") { await runSetup(args.slice(1)); process.exit(process.exitCode ?? 0); }
if (args[0] === "toolchain") { await runToolchain(args.slice(1)); process.exit(process.exitCode ?? 0); }
if (args[0] === "init" && args.includes("--setup")) { await runInitSetup(args.slice(1)); process.exit(process.exitCode ?? 0); }
if (args[0] === "worker") { await runWorker(args.slice(1)); process.exit(process.exitCode ?? 0); }
if (args[0] === "policy" && args[1] === "sync") { await runPolicySync(args.slice(2)); process.exit(process.exitCode ?? 0); }
if (args[0] === "mcp" && args[1] === "benchmark") { await runMcpBenchmark(args.slice(2)); process.exit(process.exitCode ?? 0); }
if (args[0] === "eval" && ["repeat", "dashboard"].includes(args[1] ?? "")) { await runStatisticalEval(args.slice(1)); process.exit(process.exitCode ?? 0); }

await import("./cli.js");

async function runStart(argv: string[]): Promise<void> {
  const parsed = parseGeneric(argv, new Set(["lead", "title"]), new Set(["new", "no-web-ui", "no-setup"]));
  if (parsed.positional.length > 1) throw new Error(`aeh start accepts at most one project directory, received: ${parsed.positional.join(", ")}`);
  const root = path.resolve(parsed.positional[0] ?? ".");
  const config = await loadProjectConfig(root);
  const entry = path.resolve(process.argv[1]);
  const aehCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(entry)}`;
  const result = await startPaseoHarness(root, config, {
    autoSetup: parsed.flag("no-setup") ? false : undefined,
    webUi: parsed.flag("no-web-ui") ? false : undefined,
    forceNew: parsed.flag("new"),
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
  console.log(`agentId=${result.agentId}`);
  console.log(`title=${result.title}`);
  console.log(`Open Paseo and continue in '${result.title}'. Repository-changing prompts in that conversation now route through the Harness automatically.`);
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

function parse(argv: string[]): { directory: string; flag(name: string): boolean; value(name: string): string | undefined } { const parsed = parseGeneric(argv, new Set(["profile"]), new Set(["dry-run", "update-lock", "skip-project-deps", "prefer-containers"])); if (parsed.positional.length > 1) throw new Error(`Expected at most one project directory, received: ${parsed.positional.join(", ")}`); return { directory: parsed.positional[0] ?? ".", flag: parsed.flag, value: parsed.value }; }
function parseGeneric(argv: string[], valueFlags: Set<string>, booleanFlags: Set<string>): { positional: string[]; flag(name: string): boolean; value(name: string): string | undefined; values(name: string): string[] } {
  const flags = new Map<string, Array<string | true>>(); const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) { const token = argv[i]; if (!token.startsWith("--")) { positional.push(token); continue; } const name = token.slice(2); if (valueFlags.has(name)) { const next = argv[++i]; if (!next || next.startsWith("--")) throw new Error(`--${name} requires a value.`); const list = flags.get(name) ?? []; list.push(next); flags.set(name, list); continue; } if (!booleanFlags.has(name)) throw new Error(`Unknown option --${name}.`); const list = flags.get(name) ?? []; list.push(true); flags.set(name, list); }
  return { positional, flag: (name) => flags.get(name)?.includes(true) ?? false, value: (name) => { const found = flags.get(name)?.find((item): item is string => typeof item === "string"); return found; }, values: (name) => (flags.get(name) ?? []).filter((item): item is string => typeof item === "string") };
}
