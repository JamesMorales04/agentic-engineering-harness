import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessProjectConfig, RunMetrics, TaskContract, ValidationReport, WorkerSession } from "./types.js";
import { validateSddChange } from "./sdd.js";
import { sealTask } from "./seal.js";
import { verifyTask } from "./verify.js";
import { createRepairPacket, writeRepairPacket } from "./repair.js";
import { createWorkerExecutor } from "../workers/factory.js";
import { snapshotGraph } from "../validators/graphify.js";
import { runProcess } from "../utils/process.js";
import { recordEvent } from "../telemetry/events.js";
import { extractUsageMetrics } from "../metrics/usage.js";
import { buildRunMetrics, countHumanInterventions } from "../metrics/runMetrics.js";

export interface TaskRunResult { taskId: string; status: "PASS" | "FAIL"; attempts: number; worker: WorkerSession; report: ValidationReport; metrics: RunMetrics; }

export async function runTask(root: string, config: HarnessProjectConfig, contract: TaskContract): Promise<TaskRunResult> {
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const trace = await validateSddChange(root, contract.task.id, config);
  if (!trace.ok) throw new Error(`SDD validation failed before delegation:\n${[...trace.missing, ...trace.issues].map((item) => `- ${item}`).join("\n")}`);
  await recordEvent(root, config, "harness.run.start", { taskId: contract.task.id });
  await sealTask(root, config, contract);
  await refreshGraphIfConfigured(root, config);
  const beforeSnapshot = await snapshotGraph(root, config, contract.task.id, "before");
  if (!beforeSnapshot && config.codeIntelligence?.required) throw new Error("Code intelligence is required but the Graphify before snapshot could not be created.");

  const executor = createWorkerExecutor(config);
  const health = await executor.doctor(root, config);
  if (!health.ok) throw new Error(`${executor.name} executor unavailable: ${health.message}`);
  let worker = await executor.start(root, config, contract);
  let attempts = 0;
  let report = await verifyAfterWorker(root, config, contract);
  const firstPassSuccess = report.status === "PASS";
  const maxRepairs = contract.repair?.maxAttempts ?? config.orchestration?.worker?.maxRepairAttempts ?? 2;

  while (report.status === "FAIL" && attempts < maxRepairs) {
    attempts += 1;
    const packet = createRepairPacket(report, attempts);
    if (!packet.failures.length) break;
    await writeRepairPacket(root, config, packet);
    await recordEvent(root, config, "harness.repair.start", { taskId: contract.task.id, attempt: attempts, failures: packet.failures.length });
    worker = await executor.repair(root, config, contract, worker, packet);
    report = await verifyAfterWorker(root, config, contract);
    await recordEvent(root, config, "harness.repair.finish", { taskId: contract.task.id, attempt: attempts, status: report.status });
  }

  worker.metrics = extractUsageMetrics(`${worker.stdout}\n${worker.stderr}`);
  const metrics = buildRunMetrics({
    firstPassSuccess,
    repairCount: attempts,
    humanInterventions: await countHumanInterventions(root, config, contract.task.id, startedAt),
    durationMs: Date.now() - startedMs,
    usage: worker.metrics
  });
  const result: TaskRunResult = { taskId: contract.task.id, status: report.status, attempts, worker, report, metrics };
  const runsDir = path.resolve(root, config.sdd?.runsDir ?? ".harness/runs");
  await fs.mkdir(runsDir, { recursive: true });
  await fs.writeFile(path.join(runsDir, `${contract.task.id}.json`), `${JSON.stringify(result, null, 2)}\n`);
  await recordEvent(root, config, "harness.run.finish", { taskId: contract.task.id, status: result.status, attempts, durationMs: metrics.durationMs, totalTokens: metrics.usage.totalTokens ?? 0, costUsd: metrics.usage.costUsd ?? 0 });
  return result;
}

async function verifyAfterWorker(root: string, config: HarnessProjectConfig, contract: TaskContract): Promise<ValidationReport> {
  await refreshGraphIfConfigured(root, config);
  const afterSnapshot = await snapshotGraph(root, config, contract.task.id, "after");
  if (!afterSnapshot && config.codeIntelligence?.required) throw new Error("Code intelligence is required but the Graphify after snapshot could not be created.");
  return verifyTask(root, config, contract);
}

async function refreshGraphIfConfigured(root: string, config: HarnessProjectConfig): Promise<void> {
  const command = config.codeIntelligence?.refreshCommand;
  if (!command) return;
  const result = await runProcess(command, { cwd: root, timeoutMs: 300_000 });
  if (result.exitCode !== 0 && config.codeIntelligence?.required) throw new Error(`Code intelligence refresh failed: ${result.stderr || result.stdout}`);
}
