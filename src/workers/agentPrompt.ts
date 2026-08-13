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
  materializeManagedPaseoAgent
} from "../paseo/runtime.js";
import { PaseoSdkUnavailableError } from "../paseo/sdk.js";
import { allowedSandboxEnvironment, hardenedPodmanArgs, sandboxImage } from "../security/sandbox.js";
import { runProcess } from "../utils/process.js";
import {
  activateStructuredResultTurnForAgent,
  reconcileStructuredResult,
  type AcceptedStructuredResult
} from "./resultGateway.js";
import { compileAgentPromptPolicy } from "./promptPolicy.js";

export interface AgentPromptOptions {
  outputContract?: string;
  resumeSessionId?: string;
  phase?: string;
  operationKind?: string;
  parentAgentId?: string;
  supervisorAgent?: boolean;
}

export interface CapturedContractValidation {
  ok: boolean;
  failure?: string;
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
  const effectivePrompt = await buildEffectivePrompt(root, config, contract, selection, prompt, options);
  if (options.resumeSessionId && !options.supervisorAgent) {
    await markOperationSessionRunning(root, options.resumeSessionId).catch(() => undefined);
  }
  if (options.outputContract && options.resumeSessionId && transport !== "paseo") {
    await activateStructuredResultTurnForAgent(root, options.resumeSessionId, options.phase).catch(() => undefined);
  }
  let result: WorkerSession;
  if (transport === "paseo") result = await executeViaPaseo(root, config, contract, selection, effectivePrompt, options);
  else if (transport === "direct") result = await executeDirect(root, config, selection, effectivePrompt, options);
  else if (transport === "podman") result = await executePodman(root, config, contract, selection, effectivePrompt, options);
  else throw new Error(`Unsupported agent prompt transport: ${transport}`);
  return finalizeOperationSession(root, contract, selection, result, options);
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
  const spec = await compilePaseoAgentLaunchSpec(root, config, contract, {
    selection,
    phase: options.phase ?? "queued",
    kind: options.operationKind,
    parentAgentId: options.parentAgentId,
    supervisorAgent: options.supervisorAgent
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
  const timeout = config.orchestration?.worker?.timeoutSeconds ?? 1800;
  const schema = options.outputContract ? outputJsonSchema(options.outputContract) : undefined;
  const continued = await continueManagedPaseoAgent(root, materialized.id, effectivePrompt, timeout, undefined, schema);
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
  const finalized = await finalizeOperationSession(root, contract, selection, result, options);

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
  return finalizeOperationSession(root, contract, selection, repairedResult, repairOptions);
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
  options: AgentPromptOptions
): Promise<WorkerSession> {
  const spec = await compilePaseoAgentLaunchSpec(root, config, contract, {
    selection,
    phase: options.phase ?? "work",
    kind: options.operationKind,
    parentAgentId: options.parentAgentId,
    supervisorAgent: options.supervisorAgent
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
    workspaceId: spec.workspaceId,
    parentAgentId: spec.parentAgentId,
    prompt,
    outputSchema: schema,
    labels: spec.labels,
    timeoutSeconds: spec.timeoutSeconds
  });
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
    const projection = compileOpenCodeRuntimeProjection(selection, config);
    const args = ["opencode", "run", "--auto", "--format", "json", "--model", selection.modelId];
    if (options.resumeSessionId) args.push("--session", options.resumeSessionId);
    if (selection.variant) args.push("--variant", selection.variant);
    args.push("--agent", projection.binding.agentId, ...selection.args, prompt);
    const result = await runProcess(args.map(quote).join(" "), { cwd: root, timeoutMs: (config.orchestration?.worker?.timeoutSeconds ?? 1800) * 1000, env: { ...projection.env, ...executionEnv } });
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
    args.push(...selection.args, prompt);
    const result = await runProcess(args.map(quote).join(" "), { cwd: root, timeoutMs: (config.orchestration?.worker?.timeoutSeconds ?? 1800) * 1000, env: executionEnv });
    let stdout = result.stdout;
    if (outputFile) { try { stdout = await fs.readFile(outputFile, "utf8"); } catch { /* event stream fallback */ } }
    const id = options.resumeSessionId ?? extractSessionId(result.stdout);
    return session(selection, result.exitCode, stdout, [result.stderr, outputFile ? `CODEX_EVENT_STREAM:\n${result.stdout}` : ""].filter(Boolean).join("\n"), { id, ...directMetadata(options, startedAt) });
  } finally {
    if (temp) await fs.rm(temp, { recursive: true, force: true });
  }
}

async function executePodman(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  selection: AgentExecutionSelection,
  prompt: string,
  options: AgentPromptOptions
): Promise<WorkerSession> {
  if (selection.runtimeAdapter !== "opencode") throw new Error(`Podman prompt execution currently supports OpenCode; selected ${selection.runtimeAdapter}.`);
  if (options.resumeSessionId) throw new Error("Ephemeral hardened Podman sessions cannot resume a host agent session without an explicit persisted session volume.");
  const startedAt = new Date().toISOString();
  const writable = selection.permissions.write === "allow";
  const args: string[] = ["podman", "run", ...hardenedPodmanArgs(config, selection, writable)];
  args.push("-v", `${root}:/workspace:${writable ? "rw" : "ro"}`);
  if (writable) for (const relative of sealedArtifacts(config, contract)) args.push("-v", `${path.resolve(root, relative)}:/workspace/${relative}:ro`);
  const projection = compileOpenCodeRuntimeProjection(selection, config);
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

async function buildEffectivePrompt(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  selection: AgentExecutionSelection,
  prompt: string,
  options: AgentPromptOptions
): Promise<string> {
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
  return withAgentCharter(
    selection,
    prompt,
    frozenSkills,
    [managedBoundedAgentPromptContext(identity), hierarchy].filter(Boolean).join("\n"),
    policy.outputContractContext
  );
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

async function finalizeOperationSession(
  root: string,
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
    const resolution = await reconcileStructuredResult(root, {
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
    if (resolution.accepted) {
      accepted = resolution.accepted;
      result = { ...observed, stdout: JSON.stringify(resolution.accepted.payload) };
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
