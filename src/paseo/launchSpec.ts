import {
  compileOpenCodeRuntimeProjection,
  type OpenCodeAgentBindingSource
} from "../agents/permissions.js";
import type { AgentExecutionSelection } from "../agents/types.js";
import type { HarnessProjectConfig, TaskContract } from "../core/types.js";
import { deliveryWorkspaceId } from "../delivery/handoff.js";
import { buildManagedAgentEnvironment } from "../operations/executionContext.js";
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
  modeId?: string;
  modeSource?: OpenCodeAgentBindingSource;
  thinkingOptionId?: string;
  env?: Record<string, string>;
  nativeAgentId?: string;
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
  const provider =
    options.provider ?? selection?.paseoProvider ?? worker?.provider ?? "opencode";
  const model =
    options.model ??
    (selection
      ? selection.runtimeAdapter === "codex"
        ? selection.modelName
        : selection.modelId
      : worker?.model);
  const operation = currentOperationContext();
  const operationId = operation.id ?? contract.task.id;
  const operationKind = operation.kind ?? options.kind ?? inferOperationKind(contract);
  const phase = options.phase ?? inferAgentPhase(selection, logicalAgent);
  const deliveryId = await deliveryWorkspaceId(root, config, contract.task.id);
  const workspaceId = deliveryId ?? operation.workspaceId;
  const title = `${options.titlePrefix ?? worker?.titlePrefix ?? "aeh"}-${contract.task.id}-${logicalAgent}`;

  const openCode =
    selection?.runtimeAdapter === "opencode" && provider === "opencode"
      ? compileOpenCodeRuntimeProjection(selection, config)
      : undefined;
  const explicitOpenCodeMode =
    openCode && !openCode.binding.managed ? openCode.binding.agentId : undefined;
  const executionEnv = buildManagedAgentEnvironment({
    logicalAgent,
    role: selection?.role ?? "worker",
    operationId,
    operationKind,
    phase,
    interactiveLead: false,
    orchestrationAllowed: false
  });

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
  if (openCode) {
    labels["aeh.native-agent"] = openCode.binding.agentId;
    labels["aeh.native-agent.source"] = openCode.binding.source;
  }
  if (workspaceId && workspaceId === operation.workspaceId && !deliveryId) {
    labels["aeh.workspace.kind"] = "orchestration";
  }
  if (workspaceId && deliveryId) labels["aeh.workspace.kind"] = "delivery";

  return {
    cwd: root,
    title,
    provider,
    model,
    // Paseo validates an explicit mode against the provider catalog before it
    // launches the per-session OpenCode process. AEH-managed agents exist only
    // in OPENCODE_CONFIG_CONTENT for that process, so exposing their generated
    // id as modeId makes Paseo reject them before OpenCode can load the config.
    // Leave modeId unset for managed identities: Paseo then omits the OpenCode
    // prompt `agent` field and the injected default_agent selects the managed
    // primary deterministically inside the session.
    modeId: explicitOpenCodeMode,
    modeSource: explicitOpenCodeMode ? openCode?.binding.source : undefined,
    thinkingOptionId: openCode ? selection?.variant : undefined,
    env: {
      ...(openCode?.env ?? {}),
      ...executionEnv
    },
    nativeAgentId: openCode?.binding.agentId,
    workspaceId,
    labels,
    timeoutSeconds: worker?.timeoutSeconds ?? 1800,
    operationId,
    operationKind,
    phase
  };
}

export function inferAgentPhase(
  selection: AgentExecutionSelection | undefined,
  logicalAgent: string
): string {
  const role = selection?.role?.toLowerCase() ?? "";
  const name = logicalAgent.toLowerCase();
  if (role === "planner" || name.includes("planner")) return "planning";
  if (role === "reviewer" || name.includes("reviewer")) return "review";
  if (role === "escalation" || name.includes("oracle")) return "diagnosis";
  if (name.includes("spec-manager")) return "spec-authoring";
  if (name.includes("environment-manager")) return "environment-recovery";
  if (
    role === "implementer" ||
    name.includes("implementer") ||
    name.includes("worker")
  ) {
    return "implementation";
  }
  return "work";
}

function inferOperationKind(contract: TaskContract): string {
  const intent = contract.routing?.intent?.trim();
  if (intent === "audit") return "audit";
  if (intent) return intent;
  return contract.mode === "quick" ? "quick" : "run";
}
