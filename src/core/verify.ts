import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessProjectConfig, TaskContract, ValidationCheck, ValidationReport } from "./types.js";
import { getChangedFiles, getDiffStats } from "./git.js";
import { validateDiffScope } from "../validators/diffScope.js";
import { validateDiffBudget } from "../validators/constraints.js";
import { runValidationCommand } from "../validators/commands.js";
import { recordEvent } from "../telemetry/events.js";
import { runOpaPolicies } from "../validators/opa.js";
import { verifyTaskSeal } from "./seal.js";
import { runConfiguredValidators } from "../validators/registry.js";
import { collectPolicyEvidence } from "../validators/evidence.js";

export async function verifyTask(root: string, config: HarnessProjectConfig, contract: TaskContract): Promise<ValidationReport> {
  const startedAt = new Date().toISOString(); const baseRef = contract.git?.baseRef ?? config.validation?.baseRef ?? "HEAD";
  await recordEvent(root, config, "harness.verify.start", { taskId: contract.task.id, baseRef });
  const changedFiles = await getChangedFiles(root, baseRef); const stats = await getDiffStats(root, baseRef); const checks: ValidationCheck[] = [];
  checks.push(await verifyTaskSeal(root, contract, config.validation?.requireSeal ?? true));
  const scopeChecks = validateDiffScope(changedFiles, contract, config.validation?.frozenPaths ?? []); checks.push(...scopeChecks); checks.push(...validateDiffBudget(contract, stats));
  const frozenChanged = (scopeChecks.find((c) => c.id === "diff.frozen-paths")?.details?.frozenChanged ?? []) as string[];
  const evidence = collectPolicyEvidence(changedFiles);
  checks.push(await runOpaPolicies(root, config, contract, changedFiles, frozenChanged, evidence));
  const commands = [...(config.validation?.commands ?? []), ...(contract.verification?.commands ?? [])]; for (const command of commands) checks.push(await runValidationCommand(root, command));
  checks.push(...await runConfiguredValidators(root, config, contract, baseRef, changedFiles));
  const status = checks.some((check) => check.status === "FAIL") ? "FAIL" : "PASS";
  const report: ValidationReport = { version: 1, taskId: contract.task.id, status, startedAt, finishedAt: new Date().toISOString(), checks, changedFiles, metadata: { project: config.project.name, baseRef } };
  const reportsDir = config.sdd?.reportsDir ?? ".harness/reports"; const output = path.join(root, reportsDir, `${contract.task.id}.json`); await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  await recordEvent(root, config, "harness.verify.finish", { taskId: contract.task.id, status, checks: checks.length }); return report;
}
