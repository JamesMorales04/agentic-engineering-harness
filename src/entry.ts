#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { initializeProject } from "./core/init.js";
import { loadProjectConfig } from "./core/config.js";
import { compileAgentTopology } from "./agents/compiler.js";
import { compileToolchain, setupToolchain } from "./toolchain/setup.js";
import { loadToolchainConfig } from "./toolchain/config.js";
import { resolveToolchain } from "./toolchain/resolve.js";

const args = process.argv.slice(2);
if (args.length === 1 && ["--version", "-V"].includes(args[0])) { console.log("0.4.16"); process.exit(0); }

if (args[0] === "setup") { await runSetup(args.slice(1)); process.exit(process.exitCode ?? 0); }
if (args[0] === "toolchain") { await runToolchain(args.slice(1)); process.exit(process.exitCode ?? 0); }
if (args[0] === "init" && args.includes("--setup")) { await runInitSetup(args.slice(1)); process.exit(process.exitCode ?? 0); }

await import("./cli.js");

async function runSetup(argv: string[]): Promise<void> {
  const parsed = parse(argv); const root = path.resolve(parsed.directory); const config = await loadProjectConfig(root);
  const result = await setupToolchain(root, config, { profile: parsed.value("profile"), dryRun: parsed.flag("dry-run"), updateLock: parsed.flag("update-lock"), skipProjectDependencies: parsed.flag("skip-project-deps"), preferContainers: parsed.flag("prefer-containers") });
  console.log(`${result.dryRun ? "DRY-RUN" : "READY"} toolchain profile=${result.profile}`);
  console.log(`miseConfig=${result.generatedConfig}`); console.log(`lock=${result.lockFile}`); console.log(`state=${result.stateFile}`);
  if (result.installed.length) console.log(`tools=${result.installed.join(", ")}`);
  if (result.containers.length) console.log(`containers=${result.containers.join(", ")}`);
  if (result.projectDependencyCommands.length) console.log(`projectDeps=${result.projectDependencyCommands.join(" && ")}`);
  if (result.systemMissing.length) { console.error(`missingSystem=${result.systemMissing.join(", ")}`); process.exitCode = 1; }
}

async function runToolchain(argv: string[]): Promise<void> {
  const sub = argv[0] ?? "show"; const parsed = parse(argv.slice(1)); const root = path.resolve(parsed.directory); const config = await loadProjectConfig(root);
  if (sub === "compile") { console.log(`Compiled toolchain: ${await compileToolchain(root, config, { profile: parsed.value("profile"), updateLock: parsed.flag("update-lock") })}`); return; }
  if (sub === "show") { const tc = await loadToolchainConfig(root, config); console.log(JSON.stringify(await resolveToolchain(root, config, tc, { profile: parsed.value("profile") }), null, 2)); return; }
  if (sub === "setup") { await runSetup(argv.slice(1)); return; }
  throw new Error(`Unknown toolchain command '${sub}'. Use compile, show or setup.`);
}

async function runInitSetup(argv: string[]): Promise<void> {
  const without = argv.filter((value) => value !== "--setup"); const parsed = parse(without); const root = path.resolve(parsed.directory); const created = await initializeProject(root); const config = await loadProjectConfig(root);
  if (config.agents) { const compiled = await compileAgentTopology(root, config); if (!compiled.ok) throw new Error(compiled.issues.join("; ")); }
  await compileToolchain(root, config);
  const setup = await setupToolchain(root, config, { profile: parsed.value("profile"), preferContainers: parsed.flag("prefer-containers") });
  console.log(created.length ? `Created: ${created.join(", ")}` : "Harness already initialized.");
  console.log(`Toolchain ready: profile=${setup.profile}`);
}

function parse(argv: string[]): { directory: string; flag(name: string): boolean; value(name: string): string | undefined } {
  const flags = new Map<string, string | true>(); let directory = ".";
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value.startsWith("--")) { const name = value.slice(2); const next = argv[i + 1]; if (next && !next.startsWith("--")) { flags.set(name, next); i++; } else flags.set(name, true); }
    else directory = value;
  }
  return { directory, flag: (name) => flags.get(name) === true, value: (name) => typeof flags.get(name) === "string" ? flags.get(name) as string : undefined };
}
