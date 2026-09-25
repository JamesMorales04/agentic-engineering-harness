import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { loadProjectConfig, loadTaskContract } from "../core/config.js";
import type { TaskRunResult } from "../core/run.js";
import { createIntentDecision } from "../audit/intentDecision.js";
import { startDetachedOperation, waitForOperation } from "../operations/controller.js";
import type { OperationRecordV2, RunOperationPayload } from "../operations/state.js";
import { createSemanticAssessmentRuntimeV1 } from "../semantic/runtime.js";
import { prepareGithubIssueTask } from "./intake.js";

export interface IssueWorkflowOptions {
  profile?: string;
  refresh?: boolean;
  force?: boolean;
}

export interface IssueWorkflowDependencies {
  loadConfig?: typeof loadProjectConfig;
  createSemanticRuntime?: typeof createSemanticAssessmentRuntimeV1;
  prepareIssue?: typeof prepareGithubIssueTask;
  startOperation?: typeof startDetachedOperation;
  waitForOperation?: typeof waitForOperation;
  nodeExecutable?: string;
  entryFile?: string;
}

/**
 * Import an existing issue, then execute its sealed contract as a managed
 * controller run. Public delivery is owned by the accepted run finalizer;
 * this entrypoint never performs a pre-acceptance handoff.
 */
export async function executeIssueWorkflow(
  root: string,
  issueNumber: number,
  options: IssueWorkflowOptions = {},
  dependencies: IssueWorkflowDependencies = {}
): Promise<{ result: TaskRunResult; contract: Awaited<ReturnType<typeof loadTaskContract>> }> {
  const loadConfig = dependencies.loadConfig ?? loadProjectConfig;
  const createSemanticRuntime = dependencies.createSemanticRuntime ?? createSemanticAssessmentRuntimeV1;
  const prepareIssue = dependencies.prepareIssue ?? prepareGithubIssueTask;
  const startOperation = dependencies.startOperation ?? startDetachedOperation;
  const waitOperation = dependencies.waitForOperation ?? waitForOperation;
  const config = await loadConfig(root);
  const semanticRuntime = await createSemanticRuntime(root, config, { profile: options.profile });
  const prepared = await prepareIssue(root, config, issueNumber, {
    refresh: options.refresh,
    force: options.force,
    semanticRuntime
  });
  const contract = await loadTaskContract(root, prepared.taskId, config);
  const payload: RunOperationPayload = {
    taskId: prepared.taskId,
    profile: options.profile,
    intentDecision: createIntentDecision("run", `Execute GitHub issue #${issueNumber}`, "explicit-cli")
  };
  const operation = await startOperation(root, "run", payload, {
    nodeExecutable: dependencies.nodeExecutable ?? process.execPath,
    entryFile: path.resolve(dependencies.entryFile ?? process.argv[1] ?? "")
  });
  const finished = await waitOperation(root, operation.id);
  const runFile = path.resolve(root, config.sdd?.runsDir ?? ".harness/runs", `${prepared.taskId}.json`);
  try {
    return { result: JSON.parse(await fs.readFile(runFile, "utf8")) as TaskRunResult, contract };
  } catch (error) {
    const detail = finished.error ?? (error instanceof Error ? error.message : String(error));
    throw new Error(`Issue operation ${operation.id} finished without a task run result: ${detail}`);
  }
}
