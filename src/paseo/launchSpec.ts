import process from "node:process";
import type { AgentExecutionSelection } from "../agents/types.js";
import type { HarnessProjectConfig, TaskContract } from "../core/types.js";
import { deliveryWorkspaceId } from "../delivery/handoff.js";
import { currentOperationContext } from "../operations/state.js";

export interface PaseoLaunchSpecOptions {
  selection?: AgentExecutionSelection;
  logicalAgent?: string;
  provider?: string;
  model?: string;
  titlePrefix?: string;
  phase?: string;
  kind?: string;
}

export interface PaseoAgentLaunchSpec {
  cwd: string;
  title: string;
  provider: string;
  model?: string;
  workspaceId?: string;
  labels: Record<string, string>;
  timeoutSeconds: number;
  operationId: string;
  operationKind: string;
  phase: string;
}

export async function compilePaseoAgentLaunchSpec(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  options: PaseoLaunchSpecOptions = {}
): Promise<PaseoAgentLaunchSpec> {
  const selection = options.selection;
  const worker = config.orchestration?.worker;
  const logicalAgent = options.logicalAgent ?? selection?.logicalAgent ?? "worker";
  const provider = options.provider ?? selection?.paseoProvider ?? worker?.provider ?? "opencode";
  const model = options.model ?? (selection ? (selection.runtimeAdapter === "codex" ? selection.modelName : selection.modelId) : worker?.model);
  const operation = currentOperationContext();
  const operationId = operation.id ?? contract.task.id;
  const operationKind = operation.kind ?? options.kind ?? inferOperationKind(contract);
  const phase = options.phase ?? "work";
  const deliveryId = await deliveryWorkspaceId(root, config, contract.task.id);
  const workspaceId = deliveryId ?? operation.workspaceId;
  const title = `${options.titlePrefix ?? worker?.titlePrefix ?? "aeh"}-${contract.task.id}-${logicalAgent}`;
  const labels: Record<string, string> = {
    "aeh.project": config.project.name,
    "aeh.kind": "worker",
    "aeh.task": contract.task.id,
    "aeh.role": logicalAgent,
    "aeh.operation": operationId,
    "aeh.operation.kind": operationKind,
    "aeh.operation.phase": phase
  };
  if (selection?.profile) labels["aeh.profile"] = selection.profile;
  if (workspaceId && workspaceId === operation.workspaceId && !deliveryId) labels["aeh.workspace.kind"] = "orchestration";
  if (workspaceId && deliveryId) labels["aeh.workspace.kind"] = "delivery";

  return {
    cwd: root,
    title,
    provider,
    model,
    workspaceId,
    labels,
    timeoutSeconds: worker?.timeoutSeconds ?? 1800,
    operationId,
    operationKind,
    phase
  };
}

function inferOperationKind(contract: TaskContract): string {
  const intent = contract.routing?.intent?.trim();
  if (intent === "audit") return "audit";
  if (intent) return intent;
  return contract.mode === "quick" ? "quick" : "run";
}
