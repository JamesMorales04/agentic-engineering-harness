#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { Command } from "commander";
import { initializeProject } from "./core/init.js";
import { loadProjectConfig, loadTaskContract } from "./core/config.js";
import { runDoctor } from "./core/doctor.js";
import { verifyTask } from "./core/verify.js";
import { createSddChange, validateSddChange } from "./core/sdd.js";
import { GraphifyCodeIntelligenceProvider } from "./providers/graphify.js";
import { sealTask } from "./core/seal.js";

const program = new Command();
program
  .name("engineering-harness")
  .description("Deterministic, spec-driven control layer for multi-agent software engineering")
  .version("0.1.0");

program.command("init")
  .argument("[directory]", "Project directory", ".")
  .description("Initialize harness files in a consumer repository")
  .action(async (directory: string) => {
    const root = path.resolve(directory);
    const created = await initializeProject(root);
    console.log(created.length ? `Created: ${created.join(", ")}` : "Harness already initialized.");
    console.log("Next: edit .harness/project.yaml, then run engineering-harness doctor");
  });

program.command("doctor")
  .argument("[directory]", "Project directory", ".")
  .description("Check required and optional engineering tools")
  .action(async (directory: string) => {
    const root = path.resolve(directory);
    const config = await loadProjectConfig(root);
    const results = await runDoctor(root, config);
    let failed = false;
    for (const result of results) {
      const marker = result.ok ? "✓" : result.required ? "✗" : "!";
      console.log(`${marker} ${result.component}: ${result.message}`);
      if (!result.ok && result.required) failed = true;
    }
    if (failed) process.exitCode = 1;
  });

const sdd = program.command("sdd").description("Spec-driven development workflow");
sdd.command("new")
  .argument("<taskId>")
  .requiredOption("--title <title>")
  .action(async (taskId: string, options: { title: string }) => {
    const dir = await createSddChange(process.cwd(), taskId, options.title);
    console.log(`Created SDD change at ${dir}`);
  });

sdd.command("validate")
  .argument("<taskId>")
  .action(async (taskId: string) => {
    const result = await validateSddChange(process.cwd(), taskId);
    if (result.ok) console.log(`✓ ${taskId} contains all required SDD artifacts.`);
    else {
      console.error(`✗ Missing/empty SDD artifacts: ${result.missing.join(", ")}`);
      process.exitCode = 1;
    }
  });

program.command("seal")
  .argument("<taskId>")
  .argument("[directory]", "Project directory", ".")
  .description("Freeze the TaskContract and referenced SDD artifacts using SHA-256")
  .action(async (taskId: string, directory: string) => {
    const root = path.resolve(directory);
    const config = await loadProjectConfig(root);
    const contract = await loadTaskContract(root, taskId, config);
    const output = await sealTask(root, config, contract);
    console.log(`Sealed ${taskId}: ${output}`);
  });

program.command("verify")
  .argument("<taskId>")
  .argument("[directory]", "Project directory", ".")
  .description("Run deterministic validation for a frozen TaskContract")
  .action(async (taskId: string, directory: string) => {
    const root = path.resolve(directory);
    const config = await loadProjectConfig(root);
    const contract = await loadTaskContract(root, taskId, config);
    const report = await verifyTask(root, config, contract);
    for (const check of report.checks) console.log(`${check.status.padEnd(4)} ${check.id}: ${check.message}`);
    console.log(`\n${report.status} — report written to ${(config.sdd?.reportsDir ?? ".harness/reports")}/${taskId}.json`);
    if (report.status === "FAIL") process.exitCode = 1;
  });

program.command("graph-update")
  .argument("[directory]", "Project directory", ".")
  .description("Update Graphify structural code graph when configured")
  .action(async (directory: string) => {
    const root = path.resolve(directory);
    const provider = new GraphifyCodeIntelligenceProvider();
    const health = await provider.doctor(root);
    if (!health.ok) {
      console.error(health.message);
      process.exitCode = 1;
      return;
    }
    await provider.update(root);
    console.log("Graphify graph updated.");
  });

await program.parseAsync(process.argv);
