import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentExecutionSelection } from "../agents/types.js";
import { outputJsonSchema, validateAgentOutput } from "../agents/outputContracts.js";
import { compileOpenCodeRuntimeProjection } from "../agents/permissions.js";
import { extractMarkedJson, StructuredOutputError } from "../agents/structuredOutput.js";
import { loadFrozenSkillContext } from "../core/controlPlane.js";
import type { HarnessProjectConfig, TaskContract, WorkerSession } from "../core/types.js";
import {
  buildManagedAgentEnvironment,
  managedBoundedAgentPromptContext,
  type ManagedAgentExecutionIdentity
} from "../operations/executionContext.js";
import { persistOperationAgentArtifact } from "../operations/artifacts.js";
import {
  currentOperationContext,
  loadOperation,
  registerOperationAgent,
  updateOperationParticipant
} from "../operations/state.js";
import { compilePaseoAgentLaunchSpec } from "../paseo/launchSpec.js";
import {
  continueManagedPaseoAgent,
  launchManagedPaseoAgent,
  materializeManagedPaseoAgent,
  stopManagedPaseoAgent
} from "../paseo/runtime.js";
import { PaseoSdkUnavailableError } from "../paseo/sdk.js";
import { allowedSandboxEnvironment, hardenedPodmanArgs, sandboxImage } from "../security/sandbox.js";
import { runProcess } from "../utils/process.js";
import {
  activateStructuredResultTurnForAgent,
  acceptedStructuredResultForAgent,
  reconcileStructuredResult,
  type AcceptedStructuredResult
} from "./resultGateway.js";
import { compileAgentPromptPolicy } from "./promptPolicy.js";
import { prepareContext } from "../context/gateway.js";
import { semanticFirstInstruction } from "../context/repository/serena.js";
import { resolveContextTransportCapabilities, type EffectiveContextCapabilities } from "../context/transport.js";
import { sha256 } from "../context/provenance.js";
import { outputPolicyInstruction, resolveContextPolicy } from "../context/policy.js";
import { buildRepositoryContextMap } from "../context/repository/map.js";
import { createMemoryProvider } from "../providers/memory.js";
import type { ContextFragment } from "../context/types.js";
import { repositoryPath } from "../utils/repositoryPath.js";
import { runDirectWorkerProcess } from "./directProcess.js";
import { recordEvent } from "../telemetry/events.js";

export interface AgentPromptOptions {
  outputContract?: string;
  resumeSessionId?: string;
  phase?: string;
  operationKind?: string;
  parentAgentId?: string;
  supervisorAgent?: boolean;
  contextCapabilities?: EffectiveContextCapabilities;
}

export interface CapturedContractValidation {
  ok: boolean;
  failure?: string;
}

async function recordAgentLifecycle(
  root: string,
  config: HarnessProjectConfig,
  name: string,
  attributes: Record<string, unknown>
): Promise<void> {
  // Lifecycle evidence must never turn an otherwise valid agent result into a
  // runtime failure. The event itself is durable when telemetry is enabled.
  await recordEvent(root, config, `harness.agent.${name}`, attributes).catch(() => undefined);
}

export async function executeAgentPrompt(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  selection: AgentExecutionSelection,
  prompt: string,
  options: AgentPromptOptions = {}
): Promise<WorkerSession> {
  const transport = selection.transport === "inherit" ? (config.orchestration?.provider ?? "none") : selection.transport;
  const effectiveOptions = options.contextCapabilities
    ? options
    : { ...options, contextCapabilities: await resolveContextTransportCapabilities(root, config, selection, { mode: "live" }) };
  const effectivePrompt = await buildEffectivePrompt(root, config, contract, selection, prompt, effectiveOptions);
  if (effectiveOptions.resumeSessionId && !effectiveOptions.supervisorAgent) {
    await markOperationSessionRunning(root, effectiveOptions.resumeSessionId).catch(() => undefined);
  }
  if (effectiveOptions.outputContract && effectiveOptions.resumeSessionId && transport !== "paseo") {
    await activateStructuredResultTurnForAgent(root, effectiveOptions.resumeSessionId, effectiveOptions.phase);
  }
  let result: WorkerSession;
  if (transport === "paseo") result = await executeViaPaseo(root, config, contract, selection, effectivePrompt, effectiveOptions);
  else if (transport === "direct") result = await executeDirect(root, config, selection, effectivePrompt, effectiveOptions);
  else if (transport === "podman") result = await executePodman(root, config, contract, selection, effectivePrompt, effectiveOptions);
  else throw new Error(`Unsupported agent prompt transport: ${transport}`);
  return finalizeOperationSession(root, config, contract, selection, result, effectiveOptions);
}

export async function materializeAgentPrompt(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  selection: AgentExecutionSelection,
  options: AgentPromptOptions = {}
): Promise<WorkerSession | undefined> {
  const transport = selection.transport === "inherit" ? (config.orchestration?.provider ?? "none") : selection.transport;
  if (transport !== "paseo" || options.resumeSessionId) return undefined;
  const contextCapabilities = options.contextCapabilities ?? await resolveContextTransportCapabilities(root, config, selection, { mode: "live" });
  const spec = await compilePaseoAgentLaunchSpec(root, config, contract, {
    selection,
    phase: options.phase ?? "queued",
    kind: options.operationKind,
    parentAgentId: options.parentAgentId,
    supervisorAgent: options.supervisorAgent,
    contextCapabilities
  });
  const startedAt = new Date().toISOString();
  const schema = options.outputContract ? outputJsonSchema(options.outputContract) : undefined;
  try {
    const materialized = await materializeManagedPaseoAgent(root, {
      cwd: spec.cwd,
      title: spec.title,
      provider: spec.provider,
      model: spec.model,
      modeId: spec.modeId,
      modeSource: spec.modeSource,
      thinkingOptionId: spec.thinkingOptionId,
      env: spec.env,
      mcpServers: spec.mcpServers,
      toolPolicy: spec.toolPolicy,
      workspaceId: spec.workspaceId,
      parentAgentId: spec.parentAgentId,
      outputSchema: schema,
      labels: spec.labels,
      waitForFinish: false,
      timeoutSeconds: spec.timeoutSeconds
    });
    const result = session(selection, materialized.exitCode, materialized.stdout, materialized.stderr, {
      id: materialized.id,
      nativeAgent: spec.nativeAgentId ?? selection.nativeAgent,
      transport: `paseo-${materialized.transport}`,
      workspaceId: materialized.workspaceId ?? spec.workspaceId,
      title: spec.title,
      operationId: spec.operationId,
      operationKind: spec.operationKind,
      operationRevision: Number.isInteger(Number(spec.labels["aeh.operation.revision"])) ? Number(spec.labels["aeh.operation.revision"]) : undefined,
      supervisorGeneration: spec.supervisorGeneration,
      phase: spec.phase,
      status: materialized.status ?? "idle",
      startedAt
    });
    if (result.id && !options.supervisorAgent) {
      await updateOperationParticipant(root, spec.operationId, result.id, {
        logicalAgent: selection.logicalAgent,
        role: selection.role,
        stage: spec.phase,
        phase: spec.phase,
        parentSupervisorGeneration: spec.supervisorGeneration,
        parentAgentId: spec.parentAgentId,
        workspaceId: result.workspaceId,
        transport: result.transport,
        status: "IDLE"
      }).catch(() => undefined);
      await recordAgentLifecycle(root, config, "participant.created", {
        operationId: spec.operationId,
        participantId: result.id,
        logicalAgent: selection.logicalAgent,
        role: selection.role,
        phase: spec.phase,
        attempt: 1,
        revision: 1,
        status: "IDLE"
      });
      await recordAgentLifecycle(root, config, "session.created", {
        operationId: spec.operationId,
        participantId: result.id,
        logicalAgent: selection.logicalAgent,
        transport: result.transport,
        workspaceId: result.workspaceId,
        status: result.status
      });
    }
    return result;
  } catch (error) {
    if (error instanceof PaseoSdkUnavailableError || (error instanceof Error && error.name === "PaseoSdkUnavailableError")) return undefined;
    throw error;
  }
}

export async function dispatchMaterializedAgentPrompt(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  selection: AgentExecutionSelection,
  materialized: WorkerSession | undefined,
  prompt: string,
  options: AgentPromptOptions = {}
): Promise<WorkerSession> {
  if (!materialized?.id) return executeAgentPrompt(root, config, contract, selection, prompt, options);
  const effectivePrompt = await buildEffectivePrompt(root, config, contract, selection, prompt, options);
  if (!options.supervisorAgent) await markOperationSessionRunning(root, materialized.id).catch(() => undefined);
  await recordAgentLifecycle(root, config, "participant.started", {
    operationId: materialized.operationId ?? currentOperationContext().id ?? contract.task.id,
    participantId: materialized.id,
    logicalAgent: selection.logicalAgent,
    role: selection.role,
    phase: options.phase ?? materialized.phase,
    attempt: 1,
    revision: 1,
    status: "RUNNING"
  });
  await recordAgentLifecycle(root, config, "model.requested", {
    operationId: materialized.operationId ?? currentOperationContext().id ?? contract.task.id,
    participantId: materialized.id,
    logicalAgent: selection.logicalAgent,
    transport: materialized.transport,
    phase: options.phase ?? materialized.phase
  });
  const timeout = config.orchestration?.worker?.timeoutSeconds ?? 1800;
  const schema = options.outputContract ? outputJsonSchema(options.outputContract) : undefined;
  const continued = schema
    ? await continueWithDurableResultReconciliation(root, config, materialized, selection, effectivePrompt, timeout, schema, options)
    : await continueManagedPaseoAgent(root, materialized.id, effectivePrompt, timeout, undefined, schema);
  const result: WorkerSession = {
    ...materialized,
    exitCode: continued.exitCode,
    stdout: continued.stdout || materialized.stdout,
    stderr: [materialized.stderr, continued.stderr].filter(Boolean).join("\n"),
    transport: `paseo-${continued.transport}`,
    workspaceId: continued.workspaceId ?? materialized.workspaceId,
    status: continued.status,
    phase: options.phase ?? materialized.phase,
    finishedAt: new Date().toISOString()
  };
  await recordAgentLifecycle(root, config, "runtime.terminal.observed", {
    operationId: result.operationId ?? currentOperationContext().id ?? contract.task.id,
    participantId: materialized.id,
    logicalAgent: selection.logicalAgent,
    transport: result.transport,
    status: result.status,
    exitCode: result.exitCode,
    stdoutBytes: Buffer.byteLength(result.stdout),
    stderrBytes: Buffer.byteLength(result.stderr)
  });
  await recordAgentLifecycle(root, config, "model.output.received", {
    operationId: result.operationId ?? currentOperationContext().id ?? contract.task.id,
    participantId: materialized.id,
    logicalAgent: selection.logicalAgent,
    outputBytes: Buffer.byteLength(result.stdout),
    outputPresent: Boolean(result.stdout.trim())
  });
  const finalized = await finalizeOperationSession(root, config, contract, selection, result, options);

  if (!options.outputContract || finalized.exitCode !== 0) return finalized;
  const delivery = validateCapturedAgentContract(options.outputContract, finalized.stdout, finalized.stderr);
  if (delivery.ok) return finalized;

  const repairPhase = `${options.phase ?? materialized.phase ?? "work"}-contract-repair`;
  const repairOptions: AgentPromptOptions = { ...options, phase: repairPhase };
  const repairPrompt = await buildEffectivePrompt(
    root,
    config,
    contract,
    selection,
    serializationRepairPrompt(options.outputContract, delivery.failure),
    repairOptions
  );
  if (!options.supervisorAgent) await markOperationSessionRunning(root, materialized.id).catch(() => undefined);
  const repaired = await continueManagedPaseoAgent(
    root,
    materialized.id,
    repairPrompt,
    timeout,
    undefined,
    undefined
  );
  const repairedResult: WorkerSession = {
    ...materialized,
    exitCode: repaired.exitCode,
    stdout: repaired.stdout,
    stderr: repaired.stderr,
    transport: `paseo-${repaired.transport}`,
    workspaceId: repaired.workspaceId ?? materialized.workspaceId,
    status: repaired.status,
    phase: repairPhase,
    finishedAt: new Date().toISOString()
  };
  return finalizeOperationSession(root, config, contract, selection, repairedResult, repairOptions);
}

export async function resumeAgentPrompt(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  selection: AgentExecutionSelection,
  previous: WorkerSession,
  prompt: string,
  options: Omit<AgentPromptOptions, "resumeSessionId"> = {}
): Promise<WorkerSession> {
  if (!previous.id) return executeAgentPrompt(root, config, contract, selection, prompt, options);
  return executeAgentPrompt(root, config, contract, selection, prompt, { ...options, resumeSessionId: previous.id });
}

export function validateCapturedAgentContract(
  contractName: string,
  stdout: string,
  stderr = ""
): CapturedContractValidation {
  try {
    const parsed = extractMarkedJson(stdout, stderr);
    const validation = validateAgentOutput(contractName, parsed);
    return validation.ok
      ? { ok: true }
      : { ok: false, failure: `SCHEMA_VALIDATION_FAILED: ${validation.issues.join("; ")}` };
  } catch (error) {
    if (error instanceof StructuredOutputError) {
      return { ok: false, failure: `${error.reason}: ${error.message}` };
    }
    return { ok: false, failure: `OUTPUT_CONTRACT_UNKNOWN: ${String(error)}` };
  }
}

function serializationRepairPrompt(contractName: string, failure?: string): string {
  return [
    `Your previous task is complete. Only repair delivery for the '${contractName}' output contract.`,
    "Do not inspect files, run tools, repeat the task, add new findings, or change conclusions.",
    `The prior delivery failed structured serialization: ${failure ?? "unknown contract failure"}.`,
    "Serialize only the result already present in this session into the requested contract.",
    "If aeh_submit_result is available, submit the contract object through that tool; a successful durable submission is authoritative and no marker is required.",
    "Only if the result tool is unavailable, return exactly one plain-text marker line and nothing else:",
    "AEH_RESULT_JSON=<valid compact JSON>",
    "For the marker fallback use ordinary ASCII JSON double quotes (U+0022); do not use Markdown fences or typographic quotes."
  ].join("\n");
}

async function executeViaPaseo(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  selection: AgentExecutionSelection,
  prompt: string,
  options: AgentPromptOptions = {}
): Promise<WorkerSession> {
  const spec = await compilePaseoAgentLaunchSpec(root, config, contract, {
    selection,
    phase: options.phase ?? "work",
    kind: options.operationKind,
    parentAgentId: options.parentAgentId,
    supervisorAgent: options.supervisorAgent,
    contextCapabilities: options.contextCapabilities
  });
  const startedAt = new Date().toISOString();
  const schema = options.outputContract ? outputJsonSchema(options.outputContract) : undefined;
  if (options.resumeSessionId) {
    const continued = await continueManagedPaseoAgent(root, options.resumeSessionId, prompt, spec.timeoutSeconds, undefined, schema);
    return session(selection, continued.exitCode, continued.stdout, continued.stderr, {
      id: options.resumeSessionId,
      nativeAgent: spec.nativeAgentId ?? selection.nativeAgent,
      transport: `paseo-${continued.transport}`,
      workspaceId: continued.workspaceId ?? spec.workspaceId,
      title: spec.title,
      operationId: spec.operationId,
      operationKind: spec.operationKind,
      operationRevision: Number.isInteger(Number(spec.labels["aeh.operation.revision"])) ? Number(spec.labels["aeh.operation.revision"]) : undefined,
      supervisorGeneration: spec.supervisorGeneration,
      phase: spec.phase,
      status: continued.status,
      startedAt,
      finishedAt: new Date().toISOString()
    });
  }
  const launched = await launchManagedPaseoAgent(root, {
    cwd: spec.cwd,
    title: spec.title,
    provider: spec.provider,
    model: spec.model,
    modeId: spec.modeId,
    modeSource: spec.modeSource,
    thinkingOptionId: spec.thinkingOptionId,
    env: spec.env,
    mcpServers: spec.mcpServers,
    toolPolicy: spec.toolPolicy,
    workspaceId: spec.workspaceId,
    parentAgentId: spec.parentAgentId,
    prompt,
    outputSchema: schema,
    labels: spec.labels,
    timeoutSeconds: spec.timeoutSeconds
  });
  if (launched.id && !options.supervisorAgent) await markOperationSessionRunning(root, launched.id).catch(() => undefined);
  return session(selection, launched.exitCode, launched.stdout, launched.stderr, {
    id: launched.id,
    nativeAgent: spec.nativeAgentId ?? selection.nativeAgent,
    transport: `paseo-${launched.transport}`,
    workspaceId: launched.workspaceId ?? spec.workspaceId,
    title: spec.title,
    operationId: spec.operationId,
    operationKind: spec.operationKind,
    phase: spec.phase,
    status: launched.status,
    startedAt,
    finishedAt: new Date().toISOString()
  });
}

async function executeDirect(root: string, config: HarnessProjectConfig, selection: AgentExecutionSelection, prompt: string, options: AgentPromptOptions): Promise<WorkerSession> {
  const startedAt = new Date().toISOString();
  const executionEnv = boundedExecutionEnvironment(selection, options);
  if (selection.runtimeAdapter === "opencode") {
    const projection = compileOpenCodeRuntimeProjection(selection, config, options.contextCapabilities);
    const args = ["opencode", "run", "--auto", "--format", "json", "--model", selection.modelId];
    if (options.resumeSessionId) args.push("--session", options.resumeSessionId);
    if (selection.variant) args.push("--variant", selection.variant);
    args.push("--agent", projection.binding.agentId, ...selection.args, prompt);
    const result = await runDirectWorkerProcess("opencode", args.slice(1), config, { cwd: root, timeoutMs: (config.orchestration?.worker?.timeoutSeconds ?? 1800) * 1000, environment: { ...withDirectContextIdentity(projection.env, root, selection, options), ...executionEnv } });
    return session(selection, result.exitCode, result.stdout, result.stderr, { id: options.resumeSessionId ?? extractSessionId(result.stdout), nativeAgent: projection.binding.agentId, ...directMetadata(options, startedAt) });
  }
  if (selection.runtimeAdapter === "codex") return executeCodex(root, config, selection, prompt, options, startedAt, executionEnv);
  throw new Error(`No direct runtime adapter for ${selection.runtimeAdapter}`);
}

async function executeCodex(
  root: string,
  config: HarnessProjectConfig,
  selection: AgentExecutionSelection,
  prompt: string,
  options: AgentPromptOptions,
  startedAt: string,
  executionEnv: Record<string, string>
): Promise<WorkerSession> {
  const schema = options.outputContract ? outputJsonSchema(options.outputContract) : undefined;
  const temp = schema ? await fs.mkdtemp(path.join(os.tmpdir(), "aeh-codex-schema-")) : undefined;
  try {
    const schemaFile = temp ? path.join(temp, "schema.json") : undefined;
    const outputFile = temp ? path.join(temp, "output.json") : undefined;
    if (schemaFile) await fs.writeFile(schemaFile, `${JSON.stringify(schema, null, 2)}\n`);
    const args = options.resumeSessionId
      ? ["codex", "exec", "resume", options.resumeSessionId, "--json", "--model", selection.modelName]
      : ["codex", "exec", "--json", "--model", selection.modelName];
    if (schemaFile && outputFile) args.push("--output-schema", schemaFile, "-o", outputFile);
    args.push(...selection.args, ...codexPermissionArgs(selection), prompt);
    const result = await runDirectWorkerProcess(args[0]!, args.slice(1), config, { cwd: root, timeoutMs: (config.orchestration?.worker?.timeoutSeconds ?? 1800) * 1000, environment: executionEnv });
    let stdout = result.stdout;
    if (outputFile) { try { stdout = await fs.readFile(outputFile, "utf8"); } catch { /* event stream fallback */ } }
    const id = options.resumeSessionId ?? extractSessionId(result.stdout);
    return session(selection, result.exitCode, stdout, [result.stderr, outputFile ? `CODEX_EVENT_STREAM:\n${result.stdout}` : ""].filter(Boolean).join("\n"), { id, ...directMetadata(options, startedAt) });
  } finally {
    if (temp) await fs.rm(temp, { recursive: true, force: true });
  }
}

function codexPermissionArgs(selection: AgentExecutionSelection): string[] {
  const args: string[] = [];
  if (selection.permissions.write === "deny") args.push("--sandbox", "read-only");
  else if (selection.permissions.write === "allow") args.push("--sandbox", "workspace-write");
  if (selection.permissions.shell === "deny") args.push("--ask-for-approval", "never");
  if (selection.permissions.network === "deny") args.push("-c", "sandbox_workspace_write.network_access=false");
  return args;
}

function withDirectContextIdentity(environment: Record<string, string>, root: string, selection: AgentExecutionSelection, options: AgentPromptOptions): Record<string, string> {
  const serialized = environment.OPENCODE_CONFIG_CONTENT;
  if (!serialized) return environment;
  try {
    const config = JSON.parse(serialized) as { mcp?: Record<string, { environment?: Record<string, string> }> };
    const context = config.mcp?.["aeh-context"];
    if (!context) return environment;
    context.environment = { ...(context.environment ?? {}), AEH_CONTEXT_ROOT: root, AEH_CONTEXT_OPERATION_ID: currentOperationContext().id ?? "", AEH_LOGICAL_AGENT: selection.logicalAgent, AEH_CONTEXT_PHASE: options.phase ?? "work" };
    return { ...environment, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
  } catch {
    return environment;
  }
}

async function executePodman(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  selection: AgentExecutionSelection,
  prompt: string,
  options: AgentPromptOptions = {}
): Promise<WorkerSession> {
  if (selection.runtimeAdapter !== "opencode") throw new Error(`Podman prompt execution currently supports OpenCode; selected ${selection.runtimeAdapter}.`);
  if (options.resumeSessionId) throw new Error("Ephemeral hardened Podman sessions cannot resume a host agent session without an explicit persisted session volume.");
  const startedAt = new Date().toISOString();
  const writable = selection.permissions.write === "allow";
  const args: string[] = ["podman", "run", ...hardenedPodmanArgs(config, selection, writable)];
  args.push("-v", `${root}:/workspace:${writable ? "rw" : "ro"}`);
  if (writable) for (const relative of sealedArtifacts(config, contract)) args.push("-v", `${repositoryPath(root, relative)}:/workspace/${relative}:ro`);
  const projection = compileOpenCodeRuntimeProjection(selection, config, options.contextCapabilities);
  args.push("-e", `OPENCODE_CONFIG_CONTENT=${projection.env.OPENCODE_CONFIG_CONTENT}`);
  for (const [name, value] of Object.entries(boundedExecutionEnvironment(selection, options))) args.push("-e", `${name}=${value}`);
  for (const [name, value] of Object.entries(allowedSandboxEnvironment(config))) args.push("-e", `${name}=${value}`);
  args.push(sandboxImage(config), "sh", "-lc");
  const runtimeArgs = ["opencode", "run", "--auto", "--format", "json", "--model", selection.modelId];
  if (selection.variant) runtimeArgs.push("--variant", selection.variant);
  runtimeArgs.push("--agent", projection.binding.agentId, ...selection.args, prompt);
  args.push(`cd /workspace && ${runtimeArgs.map(quote).join(" ")}`);
  const result = await runProcess(args.map(quote).join(" "), { cwd: root, timeoutMs: (config.orchestration?.worker?.timeoutSeconds ?? 1800) * 1000 });
  return session(selection, result.exitCode, result.stdout, result.stderr, { nativeAgent: projection.binding.agentId, ...directMetadata(options, startedAt, "podman") });
}

export async function buildAgentContextFragments(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  selection: AgentExecutionSelection,
  prompt: string,
  options: AgentPromptOptions = {}
): Promise<{ fragments: ContextFragment[]; capabilities: { authorizedRetrieval: boolean; semanticRetrieval: boolean } }> {
  const transport = selection.transport === "inherit" ? (config.orchestration?.provider ?? "none") : selection.transport;
  const operation = currentOperationContext();
  const operationKind = operation.kind ?? options.operationKind ?? contract.routing?.intent;
  const policy = compileAgentPromptPolicy(selection, contract, {
    outputContract: options.outputContract,
    phase: options.phase ?? "work",
    operationKind,
    transport
  });
  const frozenSkills = await loadFrozenSkillContext(root, config, contract.task.id, policy.skills);
  const identity: ManagedAgentExecutionIdentity = {
    logicalAgent: selection.logicalAgent,
    role: selection.role,
    operationId: operation.id ?? contract.task.id,
    operationKind,
    phase: options.phase ?? "work",
    interactiveLead: false,
    orchestrationAllowed: false
  };
  const hierarchy = [
    options.supervisorAgent ? "Operation Supervisor: semantic coordination only; deterministic controller authority remains authoritative." : undefined,
    options.parentAgentId ? `Paseo parent=${options.parentAgentId}; OperationRecord remains lifecycle authority.` : undefined
  ].filter(Boolean).join("\n");
  const contextOutputPolicy = config.context ? outputPolicyInstruction(resolveContextPolicy(config), selection.role) : undefined;
  const transportCapabilities = options.contextCapabilities ?? await resolveContextTransportCapabilities(root, config, selection, { mode: "live" });
  const semanticRetrieval = transportCapabilities.semanticRetrieval;
  const authorizedRetrieval = transportCapabilities.authorizedRetrieval;
  const fragments: ContextFragment[] = [];
  const add = (id: string, kind: ContextFragment["kind"], preservation: ContextFragment["preservation"], priority: number, content: string | undefined, metadata?: Record<string, unknown>): void => {
    if (content?.trim()) fragments.push({ id, kind, preservation, priority, content, metadata });
  };
  add("execution-envelope", "execution-envelope", "VERBATIM", 120, [managedBoundedAgentPromptContext(identity), hierarchy].filter(Boolean).join("\n"));
  add("agent-charter", "agent-charter", "VERBATIM", 115, selection.description);
  if (semanticRetrieval) add("semantic-retrieval-policy", "skill", "VERBATIM", 110, semanticFirstInstruction(), { provider: "serena" });
  for (const degradation of transportCapabilities.degradations) add("context-capability-degradation", "handoff", "VERBATIM", 109, `Context capability degradation (explicit, non-authoritative fallback): ${degradation}`, { authoritative: false, source: "context-capability-resolver" });
  add("frozen-skills", "skill", "VERBATIM", 108, frozenSkills);
  add("output-delivery-policy", "delivery", "VERBATIM", 105, [contextOutputPolicy, policy.outputContractContext].filter(Boolean).join("\n"));

  for (const artifact of await normativeArtifacts(root, config, contract)) {
    add(artifact.id, "normative", "VERBATIM", 125, artifact.content, { authoritative: true, artifact: artifact.path });
    const fragment = fragments.at(-1);
    if (fragment) fragment.source = { artifact: artifact.path, sha256: sha256(artifact.content) };
  }
  add("task-assignment", "instruction", "VERBATIM", 100, prompt);
  const operationRoot = process.env.AEH_CONTROL_ROOT?.trim() || root;
  const stateOperation = identity.operationId ? await loadOperation(operationRoot, identity.operationId).catch(() => undefined) : undefined;
  if (stateOperation) add("operation-state", "operation", "PROJECTABLE", 80, JSON.stringify(stateOperation), { authoritative: "deterministic-controller" });
  if (options.parentAgentId) add("structured-handoff-input", "handoff", "PROJECTABLE", 78, JSON.stringify({ parentAgentId: options.parentAgentId, operationId: identity.operationId, phase: identity.phase }), { authoritative: "operation-record" });
  const validationArtifact = await readOptionalText(root, path.posix.join(config.sdd?.reportsDir ?? ".harness/reports", `${contract.task.id}.json`));
  if (validationArtifact) add("validation-evidence", "validation", "COMPRESSIBLE", 75, validationArtifact, { artifact: path.posix.join(config.sdd?.reportsDir ?? ".harness/reports", `${contract.task.id}.json`) });
  const auditArtifact = await latestJsonArtifact(root, ".harness/audits");
  if (auditArtifact) add("audit-evidence", "audit", "PROJECTABLE", 72, auditArtifact.content, { artifact: auditArtifact.path });
  const hasGit = await fs.access(path.join(root, ".git")).then(() => true).catch(() => false);
  const diff = hasGit ? await runProcess("git diff --stat", { cwd: root, timeoutMs: 15_000 }).catch(() => undefined) : undefined;
  if (diff?.exitCode === 0 && diff.stdout.trim()) add("diff-projection", "diff", "PROJECTABLE", 70, diff.stdout.trim(), { authoritative: "current-git" });

  const contextPolicy = config.context ? resolveContextPolicy(config) : undefined;
  if (contextPolicy?.repositoryMap.enabled && transportCapabilities.repositoryMap) {
    const rendered = await buildRepositoryContextMap(root, config, { allowedPaths: contract.scope?.allowed, explicitPaths: contract.scope?.allowed, maxGraphHops: contextPolicy.repositoryMap.maxGraphHops });
    add("repository-map", "repository-map", "PROJECTABLE", 90, rendered.content, { provider: rendered.map.provider, selected: rendered.selected, omitted: rendered.omitted });
  }
  const memory = await createMemoryProvider(root, config).catch((error) => {
    if (config.memory?.required) throw error;
    return undefined;
  });
  if (memory) {
    const recalled = await memory.recall(config.project.name, prompt).catch((error) => {
      if (config.memory?.required) throw error;
      return [];
    });
    if (recalled.length) add("advisory-memory", "memory", "PROJECTABLE", 45, JSON.stringify({ advisory: true, records: recalled.slice(0, 8) }), { advisory: true, authoritative: false });
  }
  if (transportCapabilities.requirements.rawRetrieval !== "FORBIDDEN") {
    add("raw-evidence-references", "raw-evidence", "RETRIEVABLE", 35, JSON.stringify({ operationId: identity.operationId, note: "Raw evidence remains in durable AEH artifacts; retrieve only through transport-authorized fragment IDs." }));
  }
  return { fragments, capabilities: { authorizedRetrieval, semanticRetrieval } };
}

export async function buildEffectivePrompt(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  selection: AgentExecutionSelection,
  prompt: string,
  options: AgentPromptOptions = {}
): Promise<string> {
  const transport = selection.transport === "inherit" ? (config.orchestration?.provider ?? "none") : selection.transport;
  const preparedFragments = await buildAgentContextFragments(root, config, contract, selection, prompt, options);
  if (!config.context) return preparedFragments.fragments.map((fragment) => fragment.content).filter(Boolean).join("\n\n");
  const identity = currentOperationContext();
  const prepared = await prepareContext(root, config, {
    operationId: identity.id ?? contract.task.id,
    logicalAgent: selection.logicalAgent,
    role: selection.role ?? "worker",
    phase: options.phase ?? "work",
    fragments: preparedFragments.fragments,
    capabilities: preparedFragments.capabilities
  });
  return prepared.rendered;
}

async function normativeArtifacts(root: string, config: HarnessProjectConfig, contract: TaskContract): Promise<Array<{ id: string; path: string; content: string }>> {
  const candidates = [
    { id: "task-contract", path: path.posix.join(config.sdd?.contractsDir ?? ".harness/contracts", `${contract.task.id}.yaml`) },
    { id: "sealed-acceptance", path: path.posix.join(".harness/seals", `${contract.task.id}.json`) },
    ...Object.entries(contract.source ?? {}).map(([name, value]) => ({ id: `normative-${name}`, path: value }))
  ];
  const result: Array<{ id: string; path: string; content: string }> = [];
  for (const candidate of candidates) {
    if (!candidate.path || candidate.path.includes("..") || path.isAbsolute(candidate.path)) continue;
    try { result.push({ ...candidate, path: candidate.path.replaceAll(path.sep, "/"), content: await fs.readFile(path.resolve(root, candidate.path), "utf8") }); } catch { /* optional source artifacts */ }
  }
  return result;
}

async function readOptionalText(root: string, relative: string): Promise<string | undefined> {
  try { return await fs.readFile(path.resolve(root, relative), "utf8"); } catch { return undefined; }
}

async function latestJsonArtifact(root: string, relativeDirectory: string): Promise<{ path: string; content: string } | undefined> {
  const directory = path.resolve(root, relativeDirectory);
  try {
    const names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json")).sort();
    const name = names.at(-1); if (!name) return undefined;
    return { path: path.posix.join(relativeDirectory, name), content: await fs.readFile(path.join(directory, name), "utf8") };
  } catch { return undefined; }
}

function boundedExecutionEnvironment(selection: AgentExecutionSelection, options: AgentPromptOptions): Record<string, string> {
  const operation = currentOperationContext();
  const env = buildManagedAgentEnvironment({ logicalAgent: selection.logicalAgent, role: selection.role, operationId: operation.id, operationKind: operation.kind ?? options.operationKind, phase: options.phase ?? "work", interactiveLead: false, orchestrationAllowed: false });
  if (options.parentAgentId) env.AEH_PARENT_AGENT_ID = options.parentAgentId;
  if (options.supervisorAgent) env.AEH_OPERATION_SUPERVISOR = "1";
  return env;
}

function directMetadata(options: AgentPromptOptions, startedAt: string, transport = "direct"): Partial<WorkerSession> {
  const operation = currentOperationContext();
  return { transport, operationId: operation.id, operationKind: operation.kind ?? options.operationKind, phase: options.phase ?? "work", status: "finished", startedAt, finishedAt: new Date().toISOString() };
}

async function markOperationSessionRunning(root: string, agentId: string): Promise<void> {
  const operationId = currentOperationContext().id;
  if (!operationId) return;
  await updateOperationParticipant(root, operationId, agentId, { status: "RUNNING" });
}

async function continueWithDurableResultReconciliation(
  root: string,
  config: HarnessProjectConfig,
  materialized: WorkerSession,
  selection: AgentExecutionSelection,
  prompt: string,
  timeoutSeconds: number,
  outputSchema: Record<string, unknown>,
  options: AgentPromptOptions
): Promise<Awaited<ReturnType<typeof continueManagedPaseoAgent>>> {
  const operationId = materialized.operationId ?? currentOperationContext().id;
  if (!operationId || !materialized.id || !options.outputContract) {
    return continueManagedPaseoAgent(root, materialized.id!, prompt, timeoutSeconds, undefined, outputSchema);
  }

  const normal = continueManagedPaseoAgent(root, materialized.id, prompt, timeoutSeconds, undefined, outputSchema);
  const reconciled = waitForAcceptedResult(root, materialized.id, {
    operationId,
    participantId: materialized.id,
    logicalAgent: selection.logicalAgent,
    role: selection.role,
    contract: options.outputContract,
    phase: options.phase ?? materialized.phase,
    operationRevision: materialized.operationRevision,
    supervisorGeneration: materialized.supervisorGeneration
  }, Math.max(1, timeoutSeconds) * 1000, async (accepted) => {
    await stopManagedPaseoAgent(root, materialized.id!).catch(() => undefined);
    await recordAgentLifecycle(root, config, "runtime.terminal.reconciled", {
      operationId,
      participantId: materialized.id,
      logicalAgent: selection.logicalAgent,
      artifact: accepted.artifact,
      turnId: accepted.turnId,
      channelId: accepted.channelId,
      source: accepted.source,
      reason: "durable-result-without-runtime-terminal-event"
    });
  });
  const winner = await Promise.race([normal, reconciled]);
  return winner ?? normal;
}

async function waitForAcceptedResult(
  root: string,
  agentId: string,
  expected: Parameters<typeof acceptedStructuredResultForAgent>[2],
  timeoutMs: number,
  onAccepted: (accepted: AcceptedStructuredResult) => Promise<void>
): Promise<Awaited<ReturnType<typeof continueManagedPaseoAgent>> | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const accepted = await acceptedStructuredResultForAgent(root, agentId, expected).catch(() => undefined);
    if (accepted) {
      await onAccepted(accepted);
      return {
        id: agentId,
        exitCode: 0,
        stdout: JSON.stringify(accepted.payload),
        stderr: "",
        status: "idle",
        transport: "sdk",
        observation: "sdk-run"
      };
    }
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function finalizeOperationSession(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  selection: AgentExecutionSelection,
  observed: WorkerSession,
  options: AgentPromptOptions
): Promise<WorkerSession> {
  const operationId = observed.operationId ?? currentOperationContext().id ?? contract.task.id;
  let result = observed;
  let accepted: AcceptedStructuredResult | undefined;
  let contractDelivery: CapturedContractValidation | undefined;

  if (options.outputContract && observed.exitCode === 0) {
    const durable = observed.id
      ? await acceptedStructuredResultForAgent(root, observed.id, {
        operationId,
        participantId: observed.id,
        logicalAgent: selection.logicalAgent,
        role: selection.role,
        contract: options.outputContract,
        phase: observed.phase ?? options.phase,
        operationRevision: Number.isInteger(observed.operationRevision) ? observed.operationRevision : undefined,
        supervisorGeneration: observed.supervisorGeneration
      }).catch(() => undefined)
      : undefined;
    const resolution = durable
      ? { ok: true as const, accepted: durable }
      : await reconcileStructuredResult(root, {
        operationId,
        agentId: observed.id,
        logicalAgent: selection.logicalAgent,
        role: selection.role,
        contract: options.outputContract,
        phase: observed.phase ?? options.phase,
        stdout: observed.stdout,
        stderr: observed.stderr
      });
    contractDelivery = resolution.ok
      ? { ok: true }
      : { ok: false, failure: resolution.failure ?? `invalid ${options.outputContract} output contract` };
    await recordAgentLifecycle(root, config, "output.parsed", {
      operationId,
      participantId: observed.id,
      logicalAgent: selection.logicalAgent,
      phase: observed.phase ?? options.phase,
      parsed: contractDelivery.ok,
      failure: contractDelivery.failure
    });
    if (resolution.accepted) {
      accepted = resolution.accepted;
      result = { ...observed, stdout: JSON.stringify(resolution.accepted.payload) };
      await recordAgentLifecycle(root, config, "result.persisted", {
        operationId,
        participantId: observed.id,
        logicalAgent: selection.logicalAgent,
        artifact: accepted.artifact,
        turnId: accepted.turnId,
        channelId: accepted.channelId,
        source: accepted.source
      });
      await recordAgentLifecycle(root, config, "result.acknowledged", {
        operationId,
        participantId: observed.id,
        logicalAgent: selection.logicalAgent,
        artifact: accepted.artifact,
        turnId: accepted.turnId,
        turnRevision: accepted.turnId
      });
    }
  }

  if (options.supervisorAgent) return result;
  const turnStamp = (observed.finishedAt ?? new Date().toISOString()).replace(/[^0-9A-Za-z]+/g, "-");
  const transcriptArtifact = await persistOperationAgentArtifact(root, operationId, `${selection.logicalAgent}-${observed.id ?? "no-session"}-${turnStamp}`, {
    logicalAgent: selection.logicalAgent,
    role: selection.role,
    phase: observed.phase ?? options.phase,
    outputContract: options.outputContract,
    contractDelivery,
    structuredResultArtifact: accepted?.artifact,
    session: observed
  }).catch(() => undefined);
  await recordAgentLifecycle(root, config, "artifact.persisted", {
    operationId,
    participantId: observed.id,
    logicalAgent: selection.logicalAgent,
    artifact: transcriptArtifact,
    structuredResultArtifact: accepted?.artifact
  });
  if (!observed.id) return result;
  let operation = await loadOperation(root, operationId).catch(() => undefined);
  if (operation && !operation.participants[observed.id]) {
    await registerOperationAgent(root, operationId, {
      id: observed.id,
      logicalAgent: selection.logicalAgent,
      role: selection.role,
      phase: observed.phase ?? options.phase,
      workspaceId: observed.workspaceId,
      transport: observed.transport?.includes("cli") ? "cli" : "sdk"
    }).catch(() => undefined);
    operation = await loadOperation(root, operationId).catch(() => undefined);
  }
  const contractFailure = contractDelivery && !contractDelivery.ok
    ? contractDelivery.failure ?? `invalid ${options.outputContract ?? "agent"} output contract`
    : undefined;
  const failed = observed.exitCode !== 0 || Boolean(contractFailure);
  await updateOperationParticipant(root, operationId, observed.id, {
    logicalAgent: selection.logicalAgent,
    role: selection.role,
    stage: observed.phase ?? options.phase,
    phase: observed.phase ?? options.phase,
    parentAgentId: options.parentAgentId ?? operation?.participants[observed.id]?.parentAgentId,
    parentSupervisorGeneration: operation?.participants[observed.id]?.parentSupervisorGeneration,
    workspaceId: observed.workspaceId,
    transport: observed.transport,
    status: failed ? "FAILED" : "COMPLETED",
    resultArtifact: accepted?.artifact ?? transcriptArtifact,
    error: failed ? ((contractFailure ?? observed.stderr) || `agent exited with ${observed.exitCode}`) : undefined
  }).catch(() => undefined);
  await recordAgentLifecycle(root, config, "participant.marked_terminal", {
    operationId,
    participantId: observed.id,
    logicalAgent: selection.logicalAgent,
    status: failed ? "FAILED" : "COMPLETED",
    artifact: accepted?.artifact ?? transcriptArtifact,
    contractValid: !contractFailure
  });
  const settled = await loadOperation(root, operationId).catch(() => undefined);
  await recordAgentLifecycle(root, config, "participant.settled", {
    operationId,
    participantId: observed.id,
    logicalAgent: selection.logicalAgent,
    participantStatus: settled?.participants[observed.id]?.status,
    operationStatus: settled?.status,
    operationRevision: settled?.revision
  });
  return result;
}

function session(selection: AgentExecutionSelection, exitCode: number, stdout: string, stderr: string, metadata: Partial<WorkerSession> = {}): WorkerSession {
  return { provider: selection.runtimeAdapter, model: selection.modelName, logicalAgent: selection.logicalAgent, nativeAgent: selection.nativeAgent, runtime: selection.runtimeName, profile: selection.profile, exitCode, stdout, stderr, ...metadata };
}

function withAgentCharter(
  selection: AgentExecutionSelection,
  prompt: string,
  frozenSkills?: string,
  executionContext?: string,
  outputContractContext?: string
): string {
  return [
    executionContext,
    frozenSkills ? `Frozen semantic skill context (authoritative for this run):\n${frozenSkills}` : undefined,
    selection.description ? `Agent charter for ${selection.logicalAgent}:\n${selection.description}` : undefined,
    outputContractContext,
    prompt
  ].filter(Boolean).join("\n\n");
}

function sealedArtifacts(config: HarnessProjectConfig, contract: TaskContract): string[] {
  const dir = config.sdd?.contractsDir ?? ".harness/contracts";
  return [...new Set([`${dir}/${contract.task.id}.yaml`, `.harness/seals/${contract.task.id}.json`, ...Object.values(contract.source ?? {}).filter((value): value is string => Boolean(value))])];
}

function extractSessionId(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    const found = findSessionId(value);
    if (found) return found;
  }
  return undefined;
}

function findSessionId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) { const found = findSessionId(item); if (found) return found; }
    return undefined;
  }
  const object = value as Record<string, unknown>;
  for (const key of ["thread_id", "session_id", "sessionID", "sessionId", "threadId"]) if (typeof object[key] === "string") return object[key] as string;
  const kind = String(object.type ?? object.event ?? "").toLowerCase();
  if ((kind.includes("thread") || kind.includes("session")) && typeof object.id === "string") return object.id;
  for (const child of Object.values(object)) { const found = findSessionId(child); if (found) return found; }
  return undefined;
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
