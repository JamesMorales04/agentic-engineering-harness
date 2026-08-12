import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessProjectConfig, TaskContract, ValidationReport, WorkerSession } from "./types.js";
import { validateSddChange } from "./sdd.js";
import { sealTask } from "./seal.js";
import { verifyTask } from "./verify.js";
import { createWorkerExecutor } from "../workers/factory.js";
import { snapshotGraph } from "../validators/graphify.js";
import { runProcess } from "../utils/process.js";
import { recordEvent } from "../telemetry/events.js";

export interface TaskRunResult { taskId: string; status: "PASS" | "FAIL"; attempts: number; worker: WorkerSession; report: ValidationReport; }

export async function runTask(root: string, config: HarnessProjectConfig, contract: TaskContract): Promise<TaskRunResult> {
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
  const worker = await executor.start(root, config, contract);
  await refreshGraphIfConfigured(root, config);
  const afterSnapshot = await snapshotGraph(root, config, contract.task.id, "after");
  if (!afterSnapshot && config.codeIntelligence?.required) throw new Error("Code intelligence is required but the Graphify after snapshot could not be created.");
  const report = await verifyTask(root, config, contract);
  const result: TaskRunResult = { taskId: contract.task.id, status: report.status, attempts: 0, worker, report };
  const runsDir = path.resolve(root, config.sdd?.runsDir ?? ".harness/runs");
  await fs.mkdir(runsDir, { recursive: true });
  await fs.writeFile(path.join(runsDir, `${contract.task.id}.json`), `${JSON.stringify(result, null, 2)}\n`);
  await recordEvent(root, config, "harness.run.finish", { taskId: contract.task.id, status: result.status, attempts: 0 });
  return result;
}

async function refreshGraphIfConfigured(root: string, config: HarnessProjectConfig): Promise<void> {
  const command = config.codeIntelligence?.refreshCommand;
  if (!command) return;
  const result = await runProcess(command, { cwd: root, timeoutMs: 300_000 });
  if (result.exitCode !== 0 && config.codeIntelligence?.required) throw new Error(`Code intelligence refresh failed: ${result.stderr || result.stdout}`);
}
