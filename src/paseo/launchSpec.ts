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
import { staticContextCapabilities, type EffectiveContextCapabilities } from "../context/transport.js";
import { managedSerenaPool } from "../runtime/serenaPool.js";
import { SERENA_VERSION } from "../context/repository/serena.js";
import { createHash } from "node:crypto";
import type { CapabilityLeaseV1 } from "../security/authorityV2.js";
import { assertExecutionBindingV2, type ExecutionBindingV2 } from "../architecture/executionIdentity.js";

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
  contextCapabilities?: EffectiveContextCapabilities;
  participantId?: string;
  candidateDigest?: string;
  capabilityLeases?: CapabilityLeaseV1[];
  executionBinding?: ExecutionBindingV2;
  executionBlueprintDigest?: string;
  roleInvocationPolicyDigest?: string;
  skillManifestDigest?: string;
  contextManifestDigest?: string;
  promptManifestDigest?: string;
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

  const contextCapabilities = options.contextCapabilities ?? (selection ? staticContextCapabilities(config, selection) : undefined);
  const openCode = selection?.runtimeAdapter === "opencode" && provider === "opencode" ? compileOpenCodeRuntimeProjection(selection, config, contextCapabilities) : undefined;
  const explicitOpenCodeMode = openCode && !openCode.binding.managed ? openCode.binding.agentId : undefined;
  const executionEnv = buildManagedAgentEnvironment({ logicalAgent, role: selection?.role ?? "worker", operationId, operationKind, phase, interactiveLead: false, orchestrationAllowed: false });
  const mcpServers = contextMcpServers(root, config, selection, logicalAgent, operationId, phase, contextCapabilities, options.participantId, controlRoot);
  const toolPolicy = mcpServers?.["aeh-context"] ? { preapproved: [{ kind: "mcp" as const, server: "aeh-context", tool: "aeh_context_retrieve" }] } : undefined;
  if (parentAgentId) executionEnv.AEH_PARENT_AGENT_ID = parentAgentId;
  if (supervisorGeneration !== undefined) executionEnv.AEH_SUPERVISOR_GENERATION = String(supervisorGeneration);
  if (supervisorAgent) executionEnv.AEH_OPERATION_SUPERVISOR = "1";
  if (options.participantId) executionEnv.AEH_PARTICIPANT_ID = options.participantId;
  const candidateDigest = options.candidateDigest ?? options.capabilityLeases?.[0]?.candidate.identityDigest;
  if (candidateDigest) executionEnv.AEH_CANDIDATE_DIGEST = candidateDigest;
  if (options.capabilityLeases?.length) executionEnv.AEH_CAPABILITY_LEASES = JSON.stringify(options.capabilityLeases);
  if (options.executionBinding) {
    assertExecutionBindingV2(options.executionBinding);
    if (options.executionBinding.operationId !== operationId || options.executionBinding.participantId !== options.participantId || options.executionBinding.candidateDigest !== candidateDigest || options.executionBinding.runtime.runtimeId !== selection?.runtimeName || options.executionBinding.runtime.modelId !== selection?.modelId) throw new Error("EXECUTION_BINDING_MISMATCH: Paseo launch spec does not match the frozen participant binding.");
    executionEnv.AEH_EXECUTION_BINDING = JSON.stringify(options.executionBinding);
    executionEnv.AEH_CONTEXT_MANIFEST_DIGEST = options.executionBinding.contextManifestDigest;
    executionEnv.AEH_PROMPT_MANIFEST_DIGEST = options.executionBinding.promptManifestDigest;
    executionEnv.AEH_SKILL_MANIFEST_DIGEST = options.executionBinding.skillManifestDigest;
  }
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
  if (durable) labels["aeh.operation.revision"] = String(durable.revision);
  if (parentAgentId) labels["aeh.parent-agent"] = parentAgentId;
  if (supervisorGeneration !== undefined) labels["aeh.supervisor.generation"] = String(supervisorGeneration);
  if (supervisorAgent) labels["aeh.supervisor"] = "true";
  if (options.participantId) labels["aeh.participant"] = options.participantId;
  if (candidateDigest) labels["aeh.candidate"] = candidateDigest;
  if (options.executionBlueprintDigest) labels["aeh.execution.blueprint.digest"] = options.executionBlueprintDigest;
  if (options.roleInvocationPolicyDigest) labels["aeh.role.invocation.policy.digest"] = options.roleInvocationPolicyDigest;
  if (options.skillManifestDigest) labels["aeh.skill.manifest.digest"] = options.skillManifestDigest;
  if (options.contextManifestDigest) labels["aeh.context.manifest.digest"] = options.contextManifestDigest;
  if (options.promptManifestDigest) labels["aeh.prompt.manifest.digest"] = options.promptManifestDigest;
  if (options.executionBinding) {
    labels["aeh.execution.binding"] = JSON.stringify(options.executionBinding);
    labels["aeh.execution.binding.digest"] = options.executionBinding.digest;
    labels["aeh.execution.binding.phase"] = "BOUND";
    labels["aeh.context.manifest.digest"] = options.executionBinding.contextManifestDigest;
    labels["aeh.prompt.manifest.digest"] = options.executionBinding.promptManifestDigest;
    labels["aeh.skill.manifest.digest"] = options.executionBinding.skillManifestDigest;
  }
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

function contextMcpServers(root: string, config: HarnessProjectConfig, selection: AgentExecutionSelection | undefined, logicalAgent: string, operationId: string, phase: string, capabilities?: EffectiveContextCapabilities, participantId?: string, controlRoot = root): Record<string, PaseoSdkMcpStdioServer> | undefined {
  if (!config.context || !selection) return undefined;
  const servers: Record<string, PaseoSdkMcpStdioServer> = {};
  const entry = process.env.AEH_ENTRY_FILE?.trim() || process.argv[1];
  if (entry && capabilities?.mcpServers.context && participantId) servers["aeh-context"] = { type: "stdio", command: process.execPath, args: [entry, "context", "mcp"], env: { AEH_CONTEXT_ROOT: root, AEH_CONTEXT_CONTROL_ROOT: controlRoot, AEH_CONTEXT_OPERATION_ID: operationId, AEH_CONTEXT_PARTICIPANT_ID: participantId, AEH_LOGICAL_AGENT: logicalAgent, AEH_CONTEXT_PHASE: phase }, alwaysLoad: true };
  if (capabilities?.mcpServers.serena) {
    const canEdit = selection?.permissions.write === "allow" && (selection.role === "Implementer" || selection.role === "Repairer");
    const projectId = `project:${createHash("sha256").update(root).digest("hex").slice(0, 24)}`;
    const workspaceId = process.env.AEH_OPERATION_WORKSPACE_ID?.trim() || operationId;
    const session = managedSerenaPool.acquire({ projectId, canonicalRoot: root, workspaceId, serenaVersion: SERENA_VERSION, ownerId: `${operationId}:${logicalAgent}`, access: canEdit ? "write" : "read", editingEnabled: canEdit });
    const pooled = session.mcpServer;
    servers.serena = { type: "stdio", command: pooled.command?.[0] ?? process.execPath, args: pooled.command?.slice(1), env: pooled.environment, alwaysLoad: true, toolPolicy: session.editingEnabled ? { allow: ["*"], deny: [] } : { allow: session.allowedTools, deny: session.deniedTools } };
  }
  return Object.keys(servers).length ? servers : undefined;
}

export function inferAgentPhase(selection: AgentExecutionSelection | undefined, logicalAgent: string): string {
  const role = selection?.role ?? "";
  const name = logicalAgent.toLowerCase();
  if (role === "Operation Supervisor" || name.includes("operation-supervisor")) return "supervision";
  if (role === "Planner") return "planning";
  if (role === "Reviewer") return "review";
  if (role === "Repairer") return "diagnosis";
  if (role === "Spec Manager") return "spec-authoring";
  if (role === "Implementer") return "implementation";
  return "work";
}
function inferOperationKind(contract: TaskContract): string {
  const intent = contract.routing?.intent?.trim();
  if (intent === "audit") return "audit";
  if (intent) return intent;
  return contract.routing?.route === "DIRECT" ? "direct" : contract.routing?.route === "DELEGATED" ? "delegated" : contract.routing?.route === "FORMAL_SDD" ? "formal-sdd" : "run";
}
