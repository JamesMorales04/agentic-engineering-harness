import {
  compileOpenCodeRuntimeProjection,
  type OpenCodeAgentBindingSource
} from "../agents/permissions.js";
import type { AgentExecutionSelection } from "../agents/types.js";
import type { HarnessProjectConfig, TaskContract } from "../core/types.js";
import { deliveryWorkspaceId } from "../delivery/handoff.js";
import { buildManagedAgentEnvironment } from "../operations/executionContext.js";
import { activeOperationSupervisor, currentOperationContext, loadOperation } from "../operations/state.js";
import type { PaseoSdkMcpStdioServer, PaseoSdkToolPolicy } from "./sdk.js";

export interface PaseoLaunchSpecOptions {
  selection?: AgentExecutionSelection;
  logicalAgent?: string;
  provider?: string;
  model?: string;
  titlePrefix?: string;
  phase?: string;
  kind?: string;
  parentAgentId?: string;
  supervisorAgent?: boolean;
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
  parentAgentId?: string;
  supervisorGeneration?: number;
  labels: Record<string, string>;
  timeoutSeconds: number;
  operationId: string;
  operationKind: string;
  phase: string;
  mcpServers?: Record<string, PaseoSdkMcpStdioServer>;
  toolPolicy?: PaseoSdkToolPolicy;
}

export async function compilePaseoAgentLaunchSpec(root: string, config: HarnessProjectConfig, contract: TaskContract, options: PaseoLaunchSpecOptions = {}): Promise<PaseoAgentLaunchSpec> {
  const selection = options.selection;
  const worker = config.orchestration?.worker;
  const logicalAgent = options.logicalAgent ?? selection?.logicalAgent ?? "worker";
  const provider = options.provider ?? selection?.paseoProvider ?? worker?.provider ?? "opencode";
  const model = options.model ?? (selection ? selection.runtimeAdapter === "codex" ? selection.modelName : selection.modelId : worker?.model);
  const operation = currentOperationContext();
  const operationId = operation.id ?? contract.task.id;
  const operationKind = operation.kind ?? options.kind ?? inferOperationKind(contract);
  const phase = options.phase ?? inferAgentPhase(selection, logicalAgent);
  const deliveryId = await deliveryWorkspaceId(root, config, contract.task.id);
  const workspaceId = deliveryId ?? operation.workspaceId;
  const title = `${options.titlePrefix ?? worker?.titlePrefix ?? "aeh"}-${contract.task.id}-${logicalAgent}`;
  const controlRoot = process.env.AEH_CONTROL_ROOT?.trim() || root;
  const durable = operation.id ? await loadOperation(controlRoot, operation.id).catch(() => undefined) : undefined;
  const activeSupervisor = durable ? activeOperationSupervisor(durable) : undefined;
  const supervisorAgent = options.supervisorAgent === true || logicalAgent === "operation-supervisor";
  const parentAgentId = options.parentAgentId ?? (supervisorAgent ? durable?.lead?.agentId : activeSupervisor?.agentId);
  const supervisorGeneration = supervisorAgent ? undefined : activeSupervisor?.generation;

  const openCode = selection?.runtimeAdapter === "opencode" && provider === "opencode" ? compileOpenCodeRuntimeProjection(selection, config) : undefined;
  const explicitOpenCodeMode = openCode && !openCode.binding.managed ? openCode.binding.agentId : undefined;
  const executionEnv = buildManagedAgentEnvironment({ logicalAgent, role: selection?.role ?? "worker", operationId, operationKind, phase, interactiveLead: false, orchestrationAllowed: false });
  const mcpServers = contextMcpServers(root, config, selection, logicalAgent, operationId);
  const toolPolicy = mcpServers?.["aeh-context"] ? { preapproved: [{ kind: "mcp" as const, server: "aeh-context", tool: "aeh_context_retrieve" }] } : undefined;
  if (parentAgentId) executionEnv.AEH_PARENT_AGENT_ID = parentAgentId;
  if (supervisorGeneration !== undefined) executionEnv.AEH_SUPERVISOR_GENERATION = String(supervisorGeneration);
  if (supervisorAgent) executionEnv.AEH_OPERATION_SUPERVISOR = "1";
  executionEnv.AEH_CONTROL_ROOT = controlRoot;

  const labels: Record<string, string> = {
    "aeh.project": config.project.name,
    "aeh.kind": supervisorAgent ? "supervisor" : "worker",
    "aeh.task": contract.task.id,
    "aeh.role": logicalAgent,
    "aeh.operation": operationId,
    "aeh.operation.kind": operationKind,
    "aeh.operation.phase": phase
  };
  if (selection?.profile) labels["aeh.profile"] = selection.profile;
  if (selection?.outputContract) labels["aeh.output.contract"] = selection.outputContract;
  if (parentAgentId) labels["aeh.parent-agent"] = parentAgentId;
  if (supervisorGeneration !== undefined) labels["aeh.supervisor.generation"] = String(supervisorGeneration);
  if (supervisorAgent) labels["aeh.supervisor"] = "true";
  if (openCode) {
    labels["aeh.native-agent"] = openCode.binding.agentId;
    labels["aeh.native-agent.source"] = openCode.binding.source;
  }
  if (workspaceId && workspaceId === operation.workspaceId && !deliveryId) labels["aeh.workspace.kind"] = "orchestration";
  if (workspaceId && deliveryId) labels["aeh.workspace.kind"] = "delivery";

  return {
    cwd: root,
    title,
    provider,
    model,
    modeId: explicitOpenCodeMode,
    modeSource: explicitOpenCodeMode ? openCode?.binding.source : undefined,
    thinkingOptionId: selection?.runtimeCapabilities?.variantSelection === false ? undefined : selection?.variant,
    env: { ...(openCode?.env ?? {}), ...executionEnv },
    nativeAgentId: openCode?.binding.agentId,
    workspaceId,
    parentAgentId,
    supervisorGeneration,
    labels,
    timeoutSeconds: worker?.timeoutSeconds ?? 1800,
    ...(mcpServers ? { mcpServers } : {}),
    ...(toolPolicy ? { toolPolicy } : {}),
    operationId,
    operationKind,
    phase
  };
}

function contextMcpServers(root: string, config: HarnessProjectConfig, selection: AgentExecutionSelection | undefined, logicalAgent: string, operationId: string): Record<string, PaseoSdkMcpStdioServer> | undefined {
  if (!config.context || logicalAgent === "operation-supervisor" || selection?.role === "orchestrator") return undefined;
  const servers: Record<string, PaseoSdkMcpStdioServer> = {};
  const entry = process.env.AEH_ENTRY_FILE?.trim() || process.argv[1];
  if (entry) servers["aeh-context"] = { type: "stdio", command: process.execPath, args: [entry, "context", "mcp"], env: { AEH_CONTEXT_ROOT: root, AEH_CONTEXT_OPERATION_ID: operationId, AEH_LOGICAL_AGENT: logicalAgent }, alwaysLoad: true };
  if (config.context.semanticRetrieval?.provider !== "none") servers.serena = { type: "stdio", command: "serena", args: ["start-mcp-server", "--context", "ide-assistant", "--project", root], alwaysLoad: true };
  if (config.context.compression?.provider !== "none") servers.headroom = { type: "stdio", command: config.context.compression?.command ?? "headroom", args: ["mcp", "serve"], alwaysLoad: false };
  return Object.keys(servers).length ? servers : undefined;
}

export function inferAgentPhase(selection: AgentExecutionSelection | undefined, logicalAgent: string): string {
  const role = selection?.role?.toLowerCase() ?? "";
  const name = logicalAgent.toLowerCase();
  if (name.includes("operation-supervisor")) return "supervision";
  if (role === "planner" || name.includes("planner")) return "planning";
  if (role === "reviewer" || name.includes("reviewer")) return "review";
  if (role === "escalation" || name.includes("oracle")) return "diagnosis";
  if (name.includes("spec-manager")) return "spec-authoring";
  if (name.includes("environment-manager")) return "environment-recovery";
  if (role === "implementer" || name.includes("implementer") || name.includes("worker")) return "implementation";
  return "work";
}
function inferOperationKind(contract: TaskContract): string {
  const intent = contract.routing?.intent?.trim();
  if (intent === "audit") return "audit";
  if (intent) return intent;
  return contract.mode === "quick" ? "quick" : "run";
}
