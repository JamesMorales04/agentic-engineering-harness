import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
  bindOperationParticipantExecution,
  recordParticipantReceipt,
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
import { runExecutable } from "../utils/process.js";
import {
  activateStructuredResultTurnForAgent,
  acceptedStructuredResultForAgent,
  createStructuredResultProvenance,
  provisionStructuredResultChannel,
  bindStructuredResultChannel,
  finalizeStructuredResultChannelForAgent,
  resultSinkMcpServerDefinition,
  reconcileStructuredResult,
  structuredResultProvenanceForAgent,
  type AcceptedStructuredResult,
  type StructuredResultProvenanceV1
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
import { createDirectWorkerHome, removeDirectWorkerHome, type DirectWorkerHome, buildDirectWorkerEnvironment } from "./directProcess.js";
import { prepareCodexThread, prepareOpenCodeSession } from "./runtimeSessions.js";
import { recordEvent } from "../telemetry/events.js";
import { assertExecutionAuthority, prepareExecutionAuthority, type ExecutionAuthorityV1 } from "../security/executionLease.js";
import { sha256Canonical } from "../core/digest.js";
import { createPromptManifest } from "../context/runtimeV2.js";
import { assertExecutionBindingV2, assertExecutionBlueprintV2, assertResolvedOperationPolicyV1, assertRoleInvocationPolicyV1, assertSkillManifestV1, compileExecutionBinding, compileResolvedOperationPolicy, compileRoleInvocationPolicy, compileSkillManifest, createExecutionBlueprintV2, type ExecutionBindingV2, type ExecutionBlueprintV2, type ResolvedOperationPolicyV1, type RoleInvocationPolicyV1, type SkillManifestV1 } from "../architecture/executionIdentity.js";
import { configuredExternalEffects, requiredHumanActionAuthorizations } from "../security/actionPolicy.js";
import { compileExecutionCatalog } from "../architecture/executionCatalog.js";
import { defaultSkillSeed, roleProfile } from "../participants/index.js";
import { createWorkGraph, type WorkGraphV1 } from "../architecture/workGraph.js";
import { candidateRevisionsEqual } from "../operations/v2Contracts.js";
import { issueContextRefAuthorization, recordContextContinuation, validateCurrentContextAuthorization } from "../context/authorizationV2.js";
import { bindPaseoSession, loadPaseoSessionBinding, paseoSessionBindingMatches, resolveReusablePaseoSession, rotatePaseoSessionBinding, type PaseoSessionBindingIdentityV1 } from "../paseo/sessionBinding.js";

export interface AgentPromptOptions {
  outputContract?: string;
  resumeSessionId?: string;
  /** Actual runtime session observed or reserved before dispatching this turn. */
  executionSessionId?: string;
  /** Shared isolated home that owns a prepared direct-runtime session. */
  directWorkerHome?: DirectWorkerHome;
  /** Idle Paseo provider session materialized before its first semantic turn. */
  materializedPaseoSession?: WorkerSession;
  phase?: string;
  operationKind?: string;
  parentAgentId?: string;
  supervisorAgent?: boolean;
  contextCapabilities?: EffectiveContextCapabilities;
  participantId?: string;
  capabilityAuthority?: ExecutionAuthorityV1;
  requireExecutionAuthority?: boolean;
  executionBlueprintDigest?: string;
  resolvedOperationPolicyDigest?: string;
  executionBinding?: ExecutionBindingV2;
  executionBlueprint?: ExecutionBlueprintV2;
  roleInvocationPolicy?: RoleInvocationPolicyV1;
  skillManifest?: SkillManifestV1;
  contextManifest?: Readonly<Record<string, unknown>>;
  contextManifestDigest?: string;
  promptManifestDigest?: string;
  preparedPrompt?: string;
  structuredResultProvenance?: StructuredResultProvenanceV1;
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
  if (options.requireExecutionAuthority && options.capabilityAuthority) assertExecutionAuthority(options.capabilityAuthority);
  if (options.skillManifest) assertSkillManifestV1(options.skillManifest);
  const authority = options.capabilityAuthority ?? await prepareExecutionAuthority(root, selection, { participantId: options.participantId, phase: options.phase, required: options.requireExecutionAuthority });
  if (options.skillManifest?.entries.some((entry) => entry.kind === "ephemeral")) {
    if (!authority) throw new Error("SKILL_MANIFEST_AUTHORITY_REQUIRED: accepted ephemeral procedure content requires controller-issued participant authority.");
    assertExecutionAuthority(authority);
    if (authority.participantId !== options.skillManifest.scope.participantId) throw new Error("SKILL_MANIFEST_ASSIGNMENT_MISMATCH: accepted procedure content is available only to its assigned authorized participant.");
  }
  const authorityOptions = authority ? { ...options, participantId: authority.participantId, capabilityAuthority: authority } : options;
  const effectiveOptions = authorityOptions.contextCapabilities
    ? authorityOptions
    : { ...authorityOptions, contextCapabilities: await resolveContextTransportCapabilities(root, config, selection, { mode: "live" }) };
  const projected = effectiveOptions.preparedPrompt
    ? verifyPreparedPrompt(effectiveOptions.preparedPrompt, effectiveOptions, selection)
    : await buildEffectivePromptIdentity(root, config, contract, selection, prompt, effectiveOptions);
  const identityOptions = { ...effectiveOptions, preparedPrompt: projected.prompt, contextManifest: projected.contextManifest, contextManifestDigest: projected.contextManifestDigest, promptManifestDigest: projected.promptManifestDigest };
  let directWorkerHome: DirectWorkerHome | undefined = identityOptions.directWorkerHome;
  let materializedPaseoSession = identityOptions.materializedPaseoSession;
  let resultProvenance: StructuredResultProvenanceV1 | undefined;
  try {
    if (authority || identityOptions.outputContract) {
      const compiledIdentity = await prepareAgentExecutionIdentity(root, config, contract, selection, projected.prompt, identityOptions);
      identityOptions.capabilityAuthority = compiledIdentity.authority;
      identityOptions.participantId = compiledIdentity.authority.participantId;
      identityOptions.executionBlueprint = compiledIdentity.executionBlueprint;
      identityOptions.executionBlueprintDigest = compiledIdentity.executionBlueprint.digest;
      identityOptions.roleInvocationPolicy = compiledIdentity.roleInvocationPolicy;
      identityOptions.skillManifest = compiledIdentity.skillManifest;
      if (transport === "paseo" && identityOptions.executionBinding && !identityOptions.resumeSessionId && !materializedPaseoSession) throw new Error("PASEO_EXECUTION_SESSION_PREPARATION_REQUIRED: a fresh binding-bearing Paseo turn must provide its already materialized provider session.");
      if (transport === "paseo" && !identityOptions.resumeSessionId && !materializedPaseoSession) {
        materializedPaseoSession = await materializeAgentPrompt(root, config, contract, selection, identityOptions);
        if (!materializedPaseoSession?.id) throw new Error("PASEO_EXECUTION_SESSION_PREPARATION_REQUIRED: an identity-bound launch requires the actual idle Paseo agent id before binding or prompt dispatch.");
        identityOptions.materializedPaseoSession = materializedPaseoSession;
      }
      const sessionId = identityOptions.resumeSessionId ?? materializedPaseoSession?.id ?? identityOptions.executionBinding?.runtime.sessionId ?? identityOptions.executionSessionId ?? await prepareRuntimeSession(root, config, selection, identityOptions, authority, transport, (home) => { directWorkerHome = home; });
      identityOptions.executionSessionId = sessionId;
      if (directWorkerHome) identityOptions.directWorkerHome = directWorkerHome;
      await resolveExecutionBinding(root, config, contract, selection, identityOptions, authority, sessionId);
    }
    if (identityOptions.executionBinding && (transport === "direct" || transport === "podman") && !directWorkerHome) {
      throw new Error("EXECUTION_BINDING_RUNTIME_SESSION_UNAVAILABLE: direct runtime binding requires the isolated home containing the exact prepared session.");
    }
    resultProvenance = identityOptions.outputContract
      ? await resolveStructuredResultProvenance(root, config, contract, selection, identityOptions, authority)
      : undefined;
  } catch (error) {
    if (materializedPaseoSession?.id) await Promise.resolve(stopManagedPaseoAgent(root, materializedPaseoSession.id)).catch(() => undefined);
    await removeDirectWorkerHome(directWorkerHome);
    throw error;
  }
  const resultOptions = resultProvenance ? { ...identityOptions, structuredResultProvenance: resultProvenance } : identityOptions;
  const effectivePrompt = projected.prompt;
  if (resultOptions.resumeSessionId && !resultOptions.supervisorAgent) {
    await markOperationSessionRunning(root, resultOptions.resumeSessionId).catch(() => undefined);
  }
  if (resultOptions.outputContract && resultOptions.resumeSessionId && transport !== "paseo") {
    await activateStructuredResultTurnForAgent(root, resultOptions.resumeSessionId, resultOptions.phase);
  }
  try {
    let result: WorkerSession;
    if (transport === "paseo") result = await executeViaPaseo(root, config, contract, selection, effectivePrompt, resultOptions);
    else if (transport === "direct") result = await executeDirect(root, config, selection, effectivePrompt, resultOptions);
    else if (transport === "podman") result = await executePodman(root, config, contract, selection, effectivePrompt, resultOptions);
    else throw new Error(`Unsupported agent prompt transport: ${transport}`);
    if (resultOptions.executionBinding && result.id !== resultOptions.executionBinding.runtime.sessionId) throw new Error("EXECUTION_BINDING_RUNTIME_SESSION_MISMATCH: runtime returned a missing or different durable session id than the frozen ExecutionBinding.");
    return await finalizeOperationSession(root, config, contract, selection, { ...result, participantId: authority?.participantId, capabilityLeases: authority?.leases, executionBinding: resultOptions.executionBinding }, resultOptions);
  } finally {
    await removeDirectWorkerHome(directWorkerHome);
  }
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
  const authority = options.capabilityAuthority ?? await prepareExecutionAuthority(root, selection, { participantId: options.participantId, phase: options.phase ?? "queued" });
  let effectiveOptions = authority ? { ...options, participantId: authority.participantId, capabilityAuthority: authority } : options;
  const contextCapabilities = effectiveOptions.contextCapabilities ?? await resolveContextTransportCapabilities(root, config, selection, { mode: "live" });
  const spec = await compilePaseoAgentLaunchSpec(root, config, contract, {
    selection,
    phase: effectiveOptions.phase ?? "queued",
    kind: effectiveOptions.operationKind,
    parentAgentId: effectiveOptions.parentAgentId,
    supervisorAgent: effectiveOptions.supervisorAgent,
    contextCapabilities,
    participantId: authority?.participantId,
    candidateDigest: authority?.candidateDigest,
    capabilityLeases: authority?.leases,
    executionBlueprintDigest: effectiveOptions.executionBlueprint?.digest ?? effectiveOptions.executionBlueprintDigest,
    roleInvocationPolicyDigest: effectiveOptions.roleInvocationPolicy?.digest,
    skillManifestDigest: effectiveOptions.skillManifest?.digest,
    contextManifestDigest: effectiveOptions.contextManifestDigest,
    promptManifestDigest: effectiveOptions.promptManifestDigest
  });
  const startedAt = new Date().toISOString();
  let structuredResultChannelId: string | undefined;
  try {
    const structuredContract = effectiveOptions.outputContract ?? selection.outputContract;
    if (structuredContract) {
      const stateRoot = currentOperationContext().controlRoot ?? root;
      const operation = await loadOperation(stateRoot, spec.operationId);
      const pending = await provisionStructuredResultChannel(stateRoot, {
        operationId: spec.operationId,
        logicalAgent: selection.logicalAgent,
        role: selection.role,
        taskId: contract.task.id,
        operationRevision: operation.revision,
        supervisorGeneration: spec.supervisorGeneration,
        contract: structuredContract
      });
      if (pending.provenance.status !== "UNSUPPORTED" || pending.agentId || pending.activeTurn) throw new Error("AEH_RESULT_CHANNEL_STATE: fresh Paseo materialization requires an inert pending result channel.");
      structuredResultChannelId = pending.channelId;
      spec.labels["aeh.canonical.role"] = selection.role;
      spec.labels["aeh.output.contract"] = structuredContract;
      spec.labels["aeh.result.channel"] = pending.channelId;
      spec.labels["aeh.execution.binding.phase"] = "PENDING_SESSION";
      spec.mcpServers = {
        ...(spec.mcpServers ?? {}),
        "aeh-result": resultSinkMcpServerDefinition(stateRoot, spec.operationId, pending.channelId)
      };
      spec.toolPolicy = {
        preapproved: [
          ...(spec.toolPolicy?.preapproved ?? []).filter((item) => !(item.kind === "mcp" && item.server === "aeh-result" && item.tool === "aeh_submit_result")),
          { kind: "mcp", server: "aeh-result", tool: "aeh_submit_result" }
        ]
      };
    }
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
      outputSchema: undefined,
      labels: spec.labels,
      waitForFinish: false,
      timeoutSeconds: spec.timeoutSeconds
    });
    if (structuredResultChannelId && materialized.id) {
      await bindStructuredResultChannel(currentOperationContext().controlRoot ?? root, spec.operationId, structuredResultChannelId, materialized.id);
    }
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
      startedAt,
      participantId: authority?.participantId,
      capabilityLeases: authority?.leases,
      structuredResultChannelId
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

export async function prepareAgentExecutionBinding(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  selection: AgentExecutionSelection,
  prompt: string,
  options: AgentPromptOptions
): Promise<{ binding: ExecutionBindingV2; authority: ExecutionAuthorityV1; prompt: string; contextManifest: Readonly<Record<string, unknown>>; executionBlueprint: ExecutionBlueprintV2; roleInvocationPolicy: RoleInvocationPolicyV1; skillManifest: SkillManifestV1 }> {
  const identity = await prepareAgentExecutionIdentity(root, config, contract, selection, prompt, options);
  const boundOptions: AgentPromptOptions = { ...options, capabilityAuthority: identity.authority, participantId: identity.authority.participantId, preparedPrompt: identity.prompt, contextManifest: identity.contextManifest, contextManifestDigest: identity.contextManifestDigest, promptManifestDigest: identity.promptManifestDigest, executionBlueprint: identity.executionBlueprint, executionBlueprintDigest: identity.executionBlueprint.digest, roleInvocationPolicy: identity.roleInvocationPolicy, skillManifest: identity.skillManifest };
  const sessionId = boundOptions.executionSessionId ?? (boundOptions.resumeSessionId ? boundOptions.resumeSessionId : undefined);
  if (!sessionId) throw new Error("EXECUTION_BINDING_SESSION_REQUIRED: binding preparation requires an actual runtime session supplied by the selected adapter.");
  const binding = await resolveExecutionBinding(root, config, contract, selection, boundOptions, identity.authority, sessionId);
  return { binding, authority: identity.authority, prompt: identity.prompt, contextManifest: identity.contextManifest, executionBlueprint: identity.executionBlueprint, roleInvocationPolicy: identity.roleInvocationPolicy, skillManifest: identity.skillManifest };
}

export interface PreparedAgentExecutionIdentity {
  authority: ExecutionAuthorityV1;
  prompt: string;
  contextManifest: Readonly<Record<string, unknown>>;
  contextManifestDigest: string;
  promptManifestDigest: string;
  executionBlueprint: ExecutionBlueprintV2;
  roleInvocationPolicy: RoleInvocationPolicyV1;
  skillManifest: SkillManifestV1;
}

/** Compile all controller-owned identity needed for a remote worker before it acquires its actual runtime session. */
export async function prepareAgentExecutionIdentity(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  selection: AgentExecutionSelection,
  prompt: string,
  options: AgentPromptOptions
): Promise<PreparedAgentExecutionIdentity> {
  const authority = options.capabilityAuthority ?? await prepareExecutionAuthority(root, selection, { participantId: options.participantId, phase: options.phase, required: true });
  if (!authority) throw new Error("V2_AUTHORITY_REQUIRED: execution identity compilation requires controller-issued capability authority evidence.");
  const contextCapabilities = options.contextCapabilities ?? await resolveContextTransportCapabilities(root, config, selection, { mode: "live" });
  const projected = options.preparedPrompt
    ? verifyPreparedPrompt(options.preparedPrompt, options, selection)
    : await buildEffectivePromptIdentity(root, config, contract, selection, prompt, { ...options, capabilityAuthority: authority, participantId: authority.participantId, contextCapabilities });
  const identityOptions: AgentPromptOptions = { ...options, capabilityAuthority: authority, participantId: authority.participantId, preparedPrompt: projected.prompt, contextCapabilities, contextManifest: projected.contextManifest, contextManifestDigest: projected.contextManifestDigest, promptManifestDigest: projected.promptManifestDigest };
  const operation = await loadOperation(currentOperationContext().controlRoot ?? root, authority.operationId);
  const candidate = authority.candidateRevision ?? operation.candidateRevision;
  const epoch = authority.controllerEpoch;
  if (!candidate || epoch === undefined) throw new Error("EXECUTION_BINDING_REQUIRED: current candidate and controller epoch are required to compile remote execution identity.");
  const compiled = await compileParticipantInvocationIdentity(root, config, contract, selection, identityOptions, operation, candidate, authority.participantId, epoch);
  await bindResolvedPolicyIfAbsent(currentOperationContext().controlRoot ?? root, authority.operationId, compiled.policy);
  return { authority, prompt: projected.prompt, contextManifest: projected.contextManifest, contextManifestDigest: projected.contextManifestDigest, promptManifestDigest: projected.promptManifestDigest, executionBlueprint: compiled.blueprint, roleInvocationPolicy: compiled.rolePolicy, skillManifest: compiled.skillManifest };
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
  const authority = options.capabilityAuthority ?? await prepareExecutionAuthority(root, selection, { participantId: options.participantId ?? materialized.id, phase: options.phase ?? materialized.phase });
  let effectiveOptions = authority ? { ...options, participantId: authority.participantId, capabilityAuthority: authority } : options;
  if (effectiveOptions.outputContract) {
    const provenance = await structuredResultProvenanceForAgent(root, materialized.id);
    if (!provenance) throw new Error("AEH_RESULT_PROVENANCE_UNSUPPORTED: materialized participant has no frozen result provenance.");
    if (provenance.status === "BOUND") {
      const operationContext = currentOperationContext();
      const operation = operationContext.id ? await loadOperation(operationContext.controlRoot ?? root, operationContext.id) : undefined;
      assertResultProvenanceMatchesExecution(provenance, operation, contract, selection, effectiveOptions);
      effectiveOptions = { ...effectiveOptions, structuredResultProvenance: provenance };
    } else if (provenance.status !== "UNSUPPORTED" || !materialized.structuredResultChannelId) {
      throw new Error("AEH_RESULT_PROVENANCE_UNSUPPORTED: materialized structured-result participant does not have an inert pending channel.");
    }
  }
  const projected = effectiveOptions.preparedPrompt
    ? verifyPreparedPrompt(effectiveOptions.preparedPrompt, effectiveOptions, selection)
    : await buildEffectivePromptIdentity(root, config, contract, selection, prompt, effectiveOptions);
  effectiveOptions = { ...effectiveOptions, contextManifest: projected.contextManifest, contextManifestDigest: projected.contextManifestDigest, promptManifestDigest: projected.promptManifestDigest };
  effectiveOptions.executionSessionId = materialized.id;
  effectiveOptions.resumeSessionId = materialized.id;
  if (authority || effectiveOptions.outputContract) await resolveExecutionBinding(root, config, contract, selection, effectiveOptions, authority, materialized.id);
  if (effectiveOptions.outputContract) {
    const provenance = await resolveStructuredResultProvenance(root, config, contract, selection, effectiveOptions, authority);
    effectiveOptions = { ...effectiveOptions, structuredResultProvenance: provenance };
  }
  const effectivePrompt = projected.prompt;
  if (!effectiveOptions.supervisorAgent) await markOperationSessionRunning(root, materialized.id).catch(() => undefined);
  await recordAgentLifecycle(root, config, "participant.started", {
    operationId: materialized.operationId ?? currentOperationContext().id ?? contract.task.id,
    participantId: materialized.id,
    logicalAgent: selection.logicalAgent,
    role: selection.role,
    phase: effectiveOptions.phase ?? materialized.phase,
    attempt: 1,
    revision: 1,
    status: "RUNNING"
  });
  await recordAgentLifecycle(root, config, "model.requested", {
    operationId: materialized.operationId ?? currentOperationContext().id ?? contract.task.id,
    participantId: materialized.id,
    logicalAgent: selection.logicalAgent,
    transport: materialized.transport,
    phase: effectiveOptions.phase ?? materialized.phase
  });
  const timeout = config.orchestration?.worker?.timeoutSeconds ?? 1800;
  const schema = effectiveOptions.outputContract ? outputJsonSchema(effectiveOptions.outputContract) : undefined;
  const executionLabels = boundPaseoExecutionLabels(effectiveOptions, selection.role, materialized.structuredResultChannelId);
  const continued = schema
    ? await continueWithDurableResultReconciliation(root, config, materialized, selection, effectivePrompt, timeout, schema, effectiveOptions, executionLabels)
    : await continueManagedPaseoAgent(root, materialized.id, effectivePrompt, timeout, undefined, schema, executionLabels);
  const result: WorkerSession = {
    ...materialized,
    exitCode: continued.exitCode,
    stdout: continued.stdout || materialized.stdout,
    stderr: [materialized.stderr, continued.stderr].filter(Boolean).join("\n"),
    transport: `paseo-${continued.transport}`,
    workspaceId: continued.workspaceId ?? materialized.workspaceId,
    status: continued.status,
    phase: effectiveOptions.phase ?? materialized.phase,
    participantId: authority?.participantId ?? materialized.participantId,
    capabilityLeases: authority?.leases ?? materialized.capabilityLeases,
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
  const finalized = await finalizeOperationSession(root, config, contract, selection, result, effectiveOptions);

  if (!effectiveOptions.outputContract || finalized.exitCode !== 0) return finalized;
  const delivery = validateCapturedAgentContract(effectiveOptions.outputContract, finalized.stdout, finalized.stderr);
  if (delivery.ok) return finalized;

  const repairPhase = `${effectiveOptions.phase ?? materialized.phase ?? "work"}-contract-repair`;
  const repairOptions: AgentPromptOptions = { ...effectiveOptions, phase: repairPhase };
  const repairPrompt = await buildEffectivePrompt(
    root,
    config,
    contract,
    selection,
    serializationRepairPrompt(effectiveOptions.outputContract, delivery.failure),
    repairOptions
  );
  if (!effectiveOptions.supervisorAgent) await markOperationSessionRunning(root, materialized.id).catch(() => undefined);
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
    contextCapabilities: options.contextCapabilities,
    participantId: options.participantId,
    candidateDigest: options.capabilityAuthority?.candidateDigest,
    capabilityLeases: options.capabilityAuthority?.leases,
    executionBinding: options.executionBinding
  });
  attachStructuredResultProvenance(spec.labels, options.structuredResultProvenance, selection.role);
  const startedAt = new Date().toISOString();
  const schema = options.outputContract ? outputJsonSchema(options.outputContract) : undefined;
  if (options.resumeSessionId) {
    const continued = await continueManagedPaseoAgent(root, options.resumeSessionId, prompt, spec.timeoutSeconds, undefined, schema, spec.labels);
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
      finishedAt: new Date().toISOString(),
      participantId: options.participantId,
      capabilityLeases: options.capabilityAuthority?.leases
    });
  }
  if (options.materializedPaseoSession) {
    const materialized = options.materializedPaseoSession;
    if (!materialized.id || materialized.id !== options.executionBinding?.runtime.sessionId) throw new Error("EXECUTION_BINDING_RUNTIME_SESSION_MISMATCH: materialized Paseo session does not match the frozen binding before first-turn dispatch.");
    const timeout = spec.timeoutSeconds;
    const continued = await continueManagedPaseoAgent(root, materialized.id, prompt, timeout, undefined, schema, spec.labels);
    if (continued.id && continued.id !== materialized.id) throw new Error("EXECUTION_BINDING_RUNTIME_SESSION_MISMATCH: Paseo continuation returned a different provider agent id than the materialized session.");
    if (!options.supervisorAgent) await markOperationSessionRunning(root, materialized.id).catch(() => undefined);
    return {
      ...materialized,
      exitCode: continued.exitCode,
      stdout: continued.stdout || materialized.stdout,
      stderr: [materialized.stderr, continued.stderr].filter(Boolean).join("\n"),
      transport: `paseo-${continued.transport}`,
      workspaceId: continued.workspaceId ?? materialized.workspaceId,
      status: continued.status,
      startedAt,
      finishedAt: new Date().toISOString()
    };
  }
  if (options.executionBinding) throw new Error("PASEO_EXECUTION_SESSION_PREPARATION_REQUIRED: a fresh binding-bearing Paseo launch must continue an already materialized actual session.");
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
    operationRevision: Number.isInteger(Number(spec.labels["aeh.operation.revision"])) ? Number(spec.labels["aeh.operation.revision"]) : undefined,
    supervisorGeneration: spec.supervisorGeneration,
    phase: spec.phase,
    status: launched.status,
    startedAt,
    finishedAt: new Date().toISOString(),
    participantId: options.participantId,
    capabilityLeases: options.capabilityAuthority?.leases
  });
}

async function executeDirect(root: string, config: HarnessProjectConfig, selection: AgentExecutionSelection, prompt: string, options: AgentPromptOptions): Promise<WorkerSession> {
  const startedAt = new Date().toISOString();
  const executionEnv = boundedExecutionEnvironment(selection, options);
  if (selection.runtimeAdapter === "opencode") {
    const projection = compileOpenCodeRuntimeProjection(selection, config, options.contextCapabilities);
    const args = ["opencode", "run", "--auto", "--format", "json", "--model", selection.modelId];
    const sessionId = options.resumeSessionId ?? options.executionSessionId;
    if (sessionId) args.push("--session", sessionId);
    if (selection.variant) args.push("--variant", selection.variant);
    args.push("--agent", projection.binding.agentId, ...selection.args, prompt);
    const result = await runDirectWorkerProcess("opencode", args.slice(1), config, { cwd: root, timeoutMs: (config.orchestration?.worker?.timeoutSeconds ?? 1800) * 1000, environment: { ...withDirectContextIdentity(projection.env, root, selection, options), ...executionEnv }, homeDirectory: options.directWorkerHome?.directory });
    const observedSessionId = extractSessionId(result.stdout);
    if ((options.executionBinding || options.outputContract) && (!observedSessionId || observedSessionId !== sessionId)) throw new Error("EXECUTION_BINDING_RUNTIME_SESSION_MISMATCH: OpenCode result did not identify the exact durable session frozen in the binding.");
    return session(selection, result.exitCode, result.stdout, result.stderr, { id: observedSessionId ?? sessionId, nativeAgent: projection.binding.agentId, ...directMetadata(options, startedAt) });
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
    const sessionId = options.resumeSessionId ?? options.executionSessionId;
    const args = sessionId
      ? ["codex", "exec", "resume", sessionId, "--json", "--model", selection.modelName]
      : ["codex", "exec", "--json", "--model", selection.modelName];
    if (schemaFile && outputFile) args.push("--output-schema", schemaFile, "-o", outputFile);
    args.push(...selection.args, ...codexPermissionArgs(selection), prompt);
    const result = await runDirectWorkerProcess(args[0]!, args.slice(1), config, { cwd: root, timeoutMs: (config.orchestration?.worker?.timeoutSeconds ?? 1800) * 1000, environment: { ...executionEnv, ...(options.directWorkerHome ? { CODEX_HOME: options.directWorkerHome.directory } : {}) }, homeDirectory: options.directWorkerHome?.directory });
    let stdout = result.stdout;
    if (outputFile) { try { stdout = await fs.readFile(outputFile, "utf8"); } catch { /* event stream fallback */ } }
    const id = extractSessionId(result.stdout);
    if ((options.executionBinding || options.outputContract) && (!id || id !== sessionId)) throw new Error("EXECUTION_BINDING_RUNTIME_SESSION_MISMATCH: Codex result did not identify the exact durable thread frozen in the binding.");
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
    const participantId = options.capabilityAuthority?.participantId ?? options.executionBinding?.participantId;
    if (!participantId) {
      delete config.mcp?.["aeh-context"];
      return { ...environment, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
    }
    context.environment = {
      ...(context.environment ?? {}),
      AEH_CONTEXT_ROOT: root,
      AEH_CONTEXT_CONTROL_ROOT: currentOperationContext().controlRoot ?? process.env.AEH_CONTROL_ROOT ?? root,
      AEH_CONTEXT_OPERATION_ID: currentOperationContext().id ?? "",
      AEH_CONTEXT_PARTICIPANT_ID: participantId,
      AEH_CONTEXT_SESSION_ID: options.executionBinding?.runtime.sessionId ?? options.executionSessionId ?? options.resumeSessionId ?? "",
      AEH_LOGICAL_AGENT: selection.logicalAgent,
      AEH_CONTEXT_PHASE: options.phase ?? "work"
    };
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
  const sessionId = options.resumeSessionId ?? options.executionSessionId;
  if (!options.directWorkerHome) throw new Error("EXECUTION_BINDING_SESSION_REQUIRED: Podman execution requires the isolated home containing the prepared OpenCode session.");
  const args: string[] = ["podman", "run", ...hardenedPodmanArgs(config, selection, writable, { persistentIsolatedHome: true })];
  args.push("-v", `${options.directWorkerHome.directory}:/home/aeh:rw`, "-e", "HOME=/home/aeh", "-e", "XDG_CONFIG_HOME=/home/aeh/.config", "-e", "XDG_CACHE_HOME=/home/aeh/.cache");
  args.push("-v", `${root}:/workspace:${writable ? "rw" : "ro"}`);
  if (writable) for (const relative of sealedArtifacts(config, contract)) args.push("-v", `${repositoryPath(root, relative)}:/workspace/${relative}:ro`);
  const projection = compileOpenCodeRuntimeProjection(selection, config, options.contextCapabilities);
  args.push("-e", `OPENCODE_CONFIG_CONTENT=${projection.env.OPENCODE_CONFIG_CONTENT}`);
  for (const [name, value] of Object.entries(boundedExecutionEnvironment(selection, options))) args.push("-e", `${name}=${value}`);
  for (const [name, value] of Object.entries(allowedSandboxEnvironment(config))) args.push("-e", `${name}=${value}`);
  args.push(sandboxImage(config), "sh", "-lc");
  const runtimeArgs = ["opencode", "run", "--auto", "--format", "json", "--model", selection.modelId];
  if (sessionId) runtimeArgs.push("--session", sessionId);
  if (selection.variant) runtimeArgs.push("--variant", selection.variant);
  runtimeArgs.push("--agent", projection.binding.agentId, ...selection.args, prompt);
  args.push(`cd /workspace && ${runtimeArgs.map(quote).join(" ")}`);
  const result = await runExecutable(args[0]!, args.slice(1), { cwd: root, timeoutMs: (config.orchestration?.worker?.timeoutSeconds ?? 1800) * 1000 });
  const observedSessionId = extractSessionId(result.stdout);
  if ((options.executionBinding || options.outputContract) && (!observedSessionId || observedSessionId !== sessionId)) throw new Error("EXECUTION_BINDING_RUNTIME_SESSION_MISMATCH: Podman OpenCode result did not identify the exact durable provider session frozen in the binding.");
  return session(selection, result.exitCode, result.stdout, result.stderr, { id: observedSessionId ?? sessionId, nativeAgent: projection.binding.agentId, ...directMetadata(options, startedAt, "podman") });
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
  const authorizedRetrieval = transportCapabilities.authorizedRetrieval && Boolean(options.capabilityAuthority?.participantId ?? options.executionBinding?.participantId) && Boolean(options.capabilityAuthority?.leases.some((lease) => lease.capability === "read"));
  const fragments: ContextFragment[] = [];
  const add = (id: string, kind: ContextFragment["kind"], preservation: ContextFragment["preservation"], priority: number, content: string | undefined, metadata?: Record<string, unknown>): void => {
    if (content?.trim()) fragments.push({ id, kind, preservation, priority, content, metadata });
  };
  add("execution-envelope", "execution-envelope", "VERBATIM", 120, [managedBoundedAgentPromptContext(identity), hierarchy].filter(Boolean).join("\n"));
  add("agent-charter", "agent-charter", "VERBATIM", 115, selection.description);
  if (semanticRetrieval) add("semantic-retrieval-policy", "skill", "VERBATIM", 110, semanticFirstInstruction(), { provider: "serena" });
  for (const degradation of transportCapabilities.degradations) add("context-capability-degradation", "handoff", "VERBATIM", 109, `Context capability degradation (explicit, non-authoritative fallback): ${degradation}`, { authoritative: false, source: "context-capability-resolver" });
  add("frozen-skills", "skill", "VERBATIM", 108, frozenSkills);
  if (options.skillManifest?.entries.some((entry) => entry.kind === "ephemeral")) {
    const participantId = options.capabilityAuthority?.participantId ?? options.participantId;
    if (!participantId || options.skillManifest.scope.participantId !== participantId) throw new Error("SKILL_MANIFEST_ASSIGNMENT_MISMATCH: accepted procedure content is available only to its assigned authorized participant.");
  }
  if (options.skillManifest) {
    for (const entry of options.skillManifest.entries) {
      if (sha256Canonical(entry.procedure) !== entry.procedureDigest) throw new Error(`SKILL_MANIFEST_INVALID: procedure digest mismatch for '${entry.skillId}'.`);
    }
    const procedureText = options.skillManifest.entries.map((entry) => `Skill ${entry.skillId} (${entry.competency})\n${entry.procedure.join("\n")}`).join("\n\n");
    add("skill-manifest-procedures", "skill", "VERBATIM", 111, procedureText, {
      participantId: options.skillManifest.scope.participantId,
      skillManifestDigest: options.skillManifest.digest,
      skillIds: options.skillManifest.entries.map((entry) => entry.skillId),
      procedureDigests: options.skillManifest.entries.map((entry) => entry.procedureDigest)
    });
  }
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
  const diff = hasGit ? await runExecutable("git", ["diff", "--stat"], { cwd: root, timeoutMs: 15_000 }).catch(() => undefined) : undefined;
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
    add("raw-evidence-references", "raw-evidence", "RETRIEVABLE", 35, JSON.stringify({ operationId: identity.operationId, note: "Raw evidence remains in durable AEH artifacts; retrieve only through controller-authorized reference IDs." }));
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
  return (await buildEffectivePromptIdentity(root, config, contract, selection, prompt, options)).prompt;
}

export async function buildEffectivePromptIdentity(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  selection: AgentExecutionSelection,
  prompt: string,
  options: AgentPromptOptions = {}
): Promise<{ prompt: string; contextManifest: Readonly<Record<string, unknown>>; contextManifestDigest: string; promptManifestDigest: string }> {
  const preparedFragments = await buildAgentContextFragments(root, config, contract, selection, prompt, options);
  const identity = currentOperationContext();
  const operation = identity.id ? await loadOperation(identity.controlRoot ?? root, identity.id).catch(() => undefined) : undefined;
  const contextManifest: Record<string, unknown> = {
    version: 1,
    operationId: identity.id ?? contract.task.id,
    projectId: operation?.candidateRevision?.projectId ?? config.project.name,
    candidateDigest: operation?.candidateRevision?.identityDigest,
    participantId: options.capabilityAuthority?.participantId ?? options.participantId,
    retrievalBudget: resolveContextPolicy(config).retrieval,
    fragments: preparedFragments.fragments.map((fragment) => ({ id: fragment.id, kind: fragment.kind, preservation: fragment.preservation, contentDigest: sha256Canonical(fragment.content), source: fragment.source, metadata: fragment.metadata }))
  };
  let rendered: string;
  if (!config.context) rendered = preparedFragments.fragments.map((fragment) => fragment.content).filter(Boolean).join("\n\n");
  else {
    const prepared = await prepareContext(root, config, {
      operationId: identity.id ?? contract.task.id,
      logicalAgent: selection.logicalAgent,
      role: selection.role ?? "worker",
      phase: options.phase ?? "work",
      fragments: preparedFragments.fragments,
      capabilities: preparedFragments.capabilities
    });
    rendered = prepared.rendered;
    contextManifest.envelopeDigest = prepared.envelope.provenance.sha256;
    contextManifest.deliveredFragments = prepared.envelope.fragments.map((fragment) => ({ id: fragment.id, contentDigest: sha256Canonical(fragment.content), source: fragment.source }));
    contextManifest.addressableRefs = prepared.envelope.retrieval.allowedFragmentIds.map((refId) => {
      const fragment = prepared.envelope.fragments.find((candidate) => candidate.id === refId);
      if (!fragment?.source?.artifact || !fragment.source.sha256) throw new Error(`EXECUTION_BINDING_CONTEXT_MISMATCH: addressable ref '${refId}' lacks durable source provenance.`);
      return { refId, artifactPath: fragment.source.artifact, sourceDigest: fragment.source.sha256 };
    });
  }
  freezeIdentityObject(contextManifest);
  const contextManifestDigest = sha256Canonical(contextManifest);
  const promptManifest = createPromptManifest({ dynamic: [{ id: "actual-rendered-prompt", content: rendered, role: selection.role, source: "agent-prompt-projection" }] });
  return { prompt: rendered, contextManifest, contextManifestDigest, promptManifestDigest: promptManifest.digest };
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
  if (options.capabilityAuthority) {
    env.AEH_CAPABILITY_LEASES = JSON.stringify(options.capabilityAuthority.leases);
    env.AEH_PARTICIPANT_ID = options.capabilityAuthority.participantId;
    env.AEH_CANDIDATE_DIGEST = options.capabilityAuthority.candidateDigest;
  }
  if (options.executionBinding) {
    env.AEH_EXECUTION_BINDING = JSON.stringify(options.executionBinding);
    env.AEH_CONTEXT_MANIFEST_DIGEST = options.executionBinding.contextManifestDigest;
    env.AEH_PROMPT_MANIFEST_DIGEST = options.executionBinding.promptManifestDigest;
    env.AEH_SKILL_MANIFEST_DIGEST = options.executionBinding.skillManifestDigest;
  }
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
  options: AgentPromptOptions,
  executionIdentityLabels?: Record<string, string>
): Promise<Awaited<ReturnType<typeof continueManagedPaseoAgent>>> {
  const operationId = materialized.operationId ?? currentOperationContext().id;
  if (!operationId || !materialized.id || !options.outputContract) {
    return continueManagedPaseoAgent(root, materialized.id!, prompt, timeoutSeconds, undefined, outputSchema, executionIdentityLabels);
  }

  const normal = continueManagedPaseoAgent(root, materialized.id, prompt, timeoutSeconds, undefined, outputSchema, executionIdentityLabels);
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
    const provenance = options.structuredResultProvenance;
    const provenanceFailure = !provenance || provenance.status !== "BOUND"
      ? `AEH_RESULT_PROVENANCE_INCOMPLETE: output contract '${options.outputContract}' lacks complete immutable execution identity${provenance?.unsupported.length ? `: ${provenance.unsupported.join(", ")}` : "."}`
      : undefined;
    const durable = observed.id
      && !provenanceFailure
      ? await acceptedStructuredResultForAgent(root, observed.id, {
        operationId,
        participantId: observed.id,
        logicalAgent: selection.logicalAgent,
        role: selection.role,
        contract: options.outputContract,
        phase: observed.phase ?? options.phase,
        operationRevision: provenance?.operationRevision,
        supervisorGeneration: observed.supervisorGeneration,
        provenance: provenance ? { ...provenance } : undefined,
        requireBoundProvenance: true,
        verifyCurrentCandidate: true
      }).catch(() => undefined)
      : undefined;
    const resolution = provenanceFailure
      ? { ok: false as const, failure: provenanceFailure }
      : durable
      ? { ok: true as const, accepted: durable }
      : await reconcileStructuredResult(root, {
        operationId,
        agentId: observed.id,
        logicalAgent: selection.logicalAgent,
        role: selection.role,
        taskId: contract.task.id,
        contract: options.outputContract,
        phase: observed.phase ?? options.phase,
        provenance,
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
  const afterParticipant = await loadOperation(root, operationId).catch(() => undefined);
  const receiptArtifact = accepted?.artifact ?? transcriptArtifact;
  if (!failed && afterParticipant?.candidateRevision && receiptArtifact) {
    const artifactPath = path.resolve(root, receiptArtifact);
    const artifactContent = await fs.readFile(artifactPath).catch(() => undefined);
    if (artifactContent) {
      const artifactDigest = sha256(artifactContent);
      const outcome = "SUCCEEDED" as const;
      const observedAt = new Date().toISOString();
      await recordParticipantReceipt(root, operationId, {
        version: 1,
        receiptId: `receipt:${observed.id}:${observedAt}`,
        operationId,
        participantId: observed.id,
        sessionId: observed.id,
        attempt: 1,
        parentParticipantId: options.parentAgentId,
        supervisorGeneration: afterParticipant.participants[observed.id]?.parentSupervisorGeneration,
        role: selection.role,
        phase: observed.phase ?? options.phase,
        startedAt: observed.startedAt,
        finishedAt: observed.finishedAt ?? observedAt,
        outputContract: options.outputContract,
        outputDigest: sha256(observed.stdout),
        artifactRef: receiptArtifact,
        candidate: afterParticipant.candidateRevision,
        outcome,
        runtimeTerminal: { kind: "runtime-terminal", eventId: `runtime:${observed.id}:${observedAt}`, observedAt, terminal: true, status: outcome, exitCode: observed.exitCode },
        contract: { contractId: options.outputContract ?? `task:${contract.task.id}`, contractDigest: sha256(JSON.stringify({ task: contract.task, outputContract: options.outputContract ?? "worker-result" })), valid: true },
        artifact: { artifactId: receiptArtifact, artifactDigest, persisted: true, persistedAt: observedAt },
        provenance: { provenanceId: `provenance:${operationId}:${observed.id}:${observedAt}`, provenanceDigest: sha256(`${afterParticipant.candidateRevision.identityDigest}:${artifactDigest}:${observed.id}`), source: "aeh-worker-finalization", valid: true },
        settled: true,
        createdAt: observedAt
      });
    } else if (!failed) {
      throw new Error(`V2_RECEIPT_REJECTED: participant artifact '${receiptArtifact}' could not be read for terminal evidence.`);
    }
  } else if (!failed && afterParticipant?.candidateRevision) {
    throw new Error("V2_RECEIPT_REJECTED: successful participant completion has no persisted artifact.");
  }
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

/**
 * Reserve the provider's durable session before freezing ExecutionBinding.
 * OpenCode and Codex have idle-session APIs. Paseo uses the separate managed
 * idle-agent materialization path before binding and first-turn dispatch.
 * Podman prepares the same OpenCode home that is mounted into the hardened
 * execution container.
 */
export async function prepareRuntimeSession(
  root: string,
  config: HarnessProjectConfig,
  selection: AgentExecutionSelection,
  options: AgentPromptOptions,
  authority: ExecutionAuthorityV1 | undefined,
  transport: string,
  onHome?: (home: DirectWorkerHome) => void
): Promise<string> {
  if (options.resumeSessionId) return options.resumeSessionId;
  if (options.executionSessionId) return options.executionSessionId;
  if (transport === "paseo") throw new Error("PASEO_EXECUTION_SESSION_PREPARATION_REQUIRED: bind the actual id returned by idle Paseo materialization before the first prompt.");
  if (transport !== "direct" && transport !== "podman") throw new Error(`EXECUTION_BINDING_SESSION_UNSUPPORTED: transport '${transport}' has no approved pre-prompt session materialization boundary.`);
  if (transport === "podman" && selection.runtimeAdapter !== "opencode") throw new Error("EXECUTION_BINDING_SESSION_UNSUPPORTED: hardened Podman session preparation currently supports only OpenCode.");

  const home = await createDirectWorkerHome();
  onHome?.(home);
  try {
    const explicit = boundedExecutionEnvironment(selection, { ...options, capabilityAuthority: authority });
    let environment = buildDirectWorkerEnvironment(config, explicit, home.directory);
    if (selection.runtimeAdapter === "opencode") {
      const projection = compileOpenCodeRuntimeProjection(selection, config, options.contextCapabilities);
      environment = buildDirectWorkerEnvironment(config, { ...withDirectContextIdentity(projection.env, root, selection, options), ...explicit }, home.directory);
      return await prepareOpenCodeSession({ cwd: root, environment, home, timeoutMs: (config.orchestration?.worker?.timeoutSeconds ?? 1800) * 1000 });
    }
    if (selection.runtimeAdapter === "codex") {
      const sandbox = selection.permissions.write === "deny" ? "read-only" : selection.permissions.write === "allow" ? "workspace-write" : "danger-full-access";
      const approvalPolicy = selection.permissions.shell === "deny" ? "never" : "on-request";
      return await prepareCodexThread({ cwd: root, environment, home, timeoutMs: (config.orchestration?.worker?.timeoutSeconds ?? 1800) * 1000, model: selection.modelName, modelProvider: selection.modelProvider, sandbox, approvalPolicy });
    }
    throw new Error(`EXECUTION_BINDING_SESSION_UNSUPPORTED: direct runtime '${selection.runtimeAdapter}' has no approved idle-session API.`);
  } catch (error) {
    await removeDirectWorkerHome(home);
    throw error;
  }
}

async function resolveStructuredResultProvenance(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  selection: AgentExecutionSelection,
  options: AgentPromptOptions,
  authority?: ExecutionAuthorityV1
): Promise<StructuredResultProvenanceV1> {
  const context = currentOperationContext();
  const operationId = authority?.operationId ?? context.id;
  if (!operationId) throw new Error("AEH_RESULT_PROVENANCE_UNSUPPORTED: output-contract participants require a managed operation identity.");
  const stateRoot = context.controlRoot ?? root;
  const operation = await loadOperation(stateRoot, operationId);
  const candidate = authority?.candidateRevision ?? operation.candidateRevision;
  const previous = options.resumeSessionId ? await structuredResultProvenanceForAgent(stateRoot, options.resumeSessionId) : undefined;
  if (previous?.status === "BOUND") {
    assertResultProvenanceMatchesExecution(previous, operation, contract, selection, options);
    return previous;
  }
  if (previous && previous.status !== "UNSUPPORTED") throw new Error("AEH_RESULT_PROVENANCE_INCOMPLETE: only an inert pending Paseo channel can be finalized for a new binding.");
  const participantId = authority?.participantId ?? options.participantId;
  const binding = options.executionBinding;
  if (!candidate || !participantId || !binding) throw new Error("EXECUTION_BINDING_REQUIRED: structured output requires a complete versioned execution binding.");
  if (binding.operationId !== operation.id || binding.participantId !== participantId || binding.candidateDigest !== candidate.identityDigest || binding.controllerEpoch !== (authority?.controllerEpoch ?? operation.controller?.epoch) || binding.operationExecutionRevision !== operation.operationExecutionRevision) throw new Error("EXECUTION_BINDING_STALE: binding does not match current operation, candidate, revision, epoch, or participant.");
  const outputSchema = outputJsonSchema(options.outputContract!);
  if (!outputSchema) throw new Error(`OUTPUT_CONTRACT_UNKNOWN: ${options.outputContract}.`);
  const provenance = createStructuredResultProvenance({
    operationId,
    projectId: authority?.projectId ?? candidate.projectId ?? config.project?.name,
    operationRevision: operation.revision,
    operationExecutionRevision: binding.operationExecutionRevision,
    participantId,
    participantGeneration: binding.participantGeneration,
    logicalAgent: selection.logicalAgent,
    role: selection.role,
    taskId: contract.task.id,
    candidate,
    controllerEpoch: binding.controllerEpoch,
    runtime: { provider: binding.runtime.provider, model: binding.runtime.modelId, runtimeId: binding.runtime.runtimeId, sessionId: binding.runtime.sessionId },
    outputContract: options.outputContract!,
    outputSchemaDigest: sha256Canonical(outputSchema),
    executionBlueprintDigest: binding.executionBlueprintDigest,
    resolvedOperationPolicyDigest: binding.operationPolicyDigest,
    executionBinding: binding,
    skillManifestDigest: binding.skillManifestDigest,
    contextManifestDigest: binding.contextManifestDigest,
    promptManifestDigest: binding.promptManifestDigest,
    unsupported: []
  });
  if (selection.transport === "paseo" || config.orchestration?.provider === "paseo") {
    const sessionId = binding.runtime.sessionId;
    if (!sessionId) throw new Error("EXECUTION_BINDING_SESSION_REQUIRED: structured Paseo result channel requires the materialized provider agent id.");
    await finalizeStructuredResultChannelForAgent(stateRoot, sessionId, provenance);
  }
  return provenance;
}

async function resolveExecutionBinding(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  selection: AgentExecutionSelection,
  options: AgentPromptOptions,
  authority?: ExecutionAuthorityV1,
  actualSessionId?: string
): Promise<ExecutionBindingV2> {
  if (options.executionBinding) {
    const binding = options.executionBinding;
    assertExecutionBindingV2(binding);
    if (!options.executionBlueprint || !options.roleInvocationPolicy || !options.skillManifest) throw new Error("EXECUTION_BINDING_REQUIRED: propagated launch requires its complete blueprint, role policy, and skill manifest.");
    assertExecutionBlueprintV2(options.executionBlueprint);
    assertRoleInvocationPolicyV1(options.roleInvocationPolicy);
    assertSkillManifestV1(options.skillManifest);
    const blueprintParticipant = options.executionBlueprint.participants.find((participant) => participant.participantId === binding.participantId);
    if (!blueprintParticipant || blueprintParticipant.roleInvocationPolicy.digest !== options.roleInvocationPolicy.digest || options.skillManifest.scope.participantId !== binding.participantId || options.skillManifest.scope.operationId !== binding.operationId || options.skillManifest.scope.operationExecutionRevision !== binding.operationExecutionRevision || options.skillManifest.scope.candidateRevision !== binding.candidateRevision || options.skillManifest.scope.candidateDigest !== binding.candidateDigest || options.skillManifest.scope.controllerEpoch !== binding.controllerEpoch || sha256Canonical(options.skillManifest.scope.workUnitIds) !== sha256Canonical(options.roleInvocationPolicy.workUnitIds) || sha256Canonical(options.skillManifest.scope.competencies) !== sha256Canonical(options.roleInvocationPolicy.competencies) || blueprintParticipant.skillManifestDigest !== options.skillManifest.digest || binding.executionBlueprintDigest !== options.executionBlueprint.digest || binding.operationExecutionRevision !== options.executionBlueprint.operationExecutionRevision || binding.candidateRevision !== options.executionBlueprint.candidateRevision || binding.candidateDigest !== options.executionBlueprint.candidateDigest || binding.operationPolicyDigest !== options.executionBlueprint.resolvedOperationPolicy.digest || binding.roleInvocationPolicyDigest !== options.roleInvocationPolicy.digest || binding.skillManifestDigest !== options.skillManifest.digest || binding.outputContract !== options.roleInvocationPolicy.outputContract || binding.contextManifestDigest !== options.contextManifestDigest || binding.promptManifestDigest !== options.promptManifestDigest || binding.participantId !== (authority?.participantId ?? options.participantId) || binding.candidateDigest !== authority?.candidateDigest || binding.controllerEpoch !== authority?.controllerEpoch || binding.operationId !== authority?.operationId || binding.leaseIdentities.join("\0") !== (authority?.leases.map((lease) => lease.leaseId).sort() ?? []).join("\0")) throw new Error("EXECUTION_BINDING_MISMATCH: propagated binding does not match the approved remote launch and actual manifests.");
    if (binding.runtime.runtimeId !== selection.runtimeName || binding.runtime.modelId !== selection.modelId || binding.runtime.model !== selection.modelName || binding.runtime.provider !== (selection.modelProvider ?? selection.paseoProvider ?? selection.runtimeAdapter)) throw new Error("EXECUTION_BINDING_RUNTIME_MISMATCH: propagated binding does not match the approved runtime and model.");
    if (actualSessionId && binding.runtime.sessionId !== actualSessionId) throw new Error("EXECUTION_BINDING_RUNTIME_SESSION_MISMATCH: propagated binding session does not match the runtime session selected for this launch.");
    const current = currentOperationContext();
    if (current.id) {
      if (current.id !== binding.operationId) throw new Error("EXECUTION_BINDING_STALE: propagated binding belongs to a different managed operation.");
      const propagatedStateRoot = current.controlRoot ?? root;
      const durable = await loadOperation(propagatedStateRoot, current.id);
      const persisted = durable.participants[binding.participantId]?.executionBinding;
      if (!persisted || persisted.digest !== binding.digest || !durable.candidateRevision || durable.candidateRevision.identityDigest !== binding.candidateDigest || durable.operationExecutionRevision !== binding.operationExecutionRevision || durable.resolvedOperationPolicy?.digest !== binding.operationPolicyDigest || (durable.controller?.epoch ?? 0) !== binding.controllerEpoch) throw new Error("EXECUTION_BINDING_STALE: propagated binding is not the current durable participant execution identity.");
      if (isPaseoExecution(selection, config)) {
        await assertPaseoSessionBinding(propagatedStateRoot, durable, binding, true);
        if (Array.isArray(options.contextManifest?.addressableRefs) && options.contextManifest.addressableRefs.length) await validateCurrentContextAuthorization(propagatedStateRoot, current.id, binding.participantId, actualSessionId);
      }
    }
    return binding;
  }
  const context = currentOperationContext();
  const operationId = authority?.operationId ?? context.id;
  if (!operationId) throw new Error("EXECUTION_BINDING_REQUIRED: managed operation identity is required at launch.");
  const stateRoot = context.controlRoot ?? root;
  let operation = await loadOperation(stateRoot, operationId);
  const candidate = authority?.candidateRevision ?? operation.candidateRevision;
  const participantId = authority?.participantId ?? options.participantId;
  const controllerEpoch = authority?.controllerEpoch ?? operation.controller?.epoch;
  if (!candidate || !participantId || controllerEpoch === undefined || operation.operationExecutionRevision === undefined) throw new Error("EXECUTION_BINDING_REQUIRED: operation candidate, execution revision, controller epoch, and participant identity are required.");
  if (authority && (authority.operationId !== operation.id || !candidateRevisionsEqual(authority.candidateRevision, candidate))) throw new Error("EXECUTION_BINDING_STALE: execution authority does not match the current operation candidate.");
  if (!options.contextManifestDigest || !options.promptManifestDigest || !options.contextManifest || sha256Canonical(options.contextManifest) !== options.contextManifestDigest) throw new Error("EXECUTION_BINDING_CONTEXT_MISMATCH: actual ContextManifest content is missing or does not match its digest.");
  if (!options.preparedPrompt || createPromptManifest({ dynamic: [{ id: "actual-rendered-prompt", content: options.preparedPrompt, role: selection.role, source: "agent-prompt-projection" }] }).digest !== options.promptManifestDigest) throw new Error("EXECUTION_BINDING_PROMPT_MISMATCH: actual PromptManifest content is missing or does not match its digest.");
  if (!actualSessionId?.trim() || actualSessionId.startsWith("launch:")) throw new Error("EXECUTION_BINDING_SESSION_REQUIRED: only an actual or runtime-reserved durable session identity can be bound; synthetic launch identities are unsupported.");
  if (options.resumeSessionId) {
    const prior = await structuredResultProvenanceForAgent(stateRoot, options.resumeSessionId);
    if (prior?.status === "BOUND") {
      if (!prior.executionBinding) throw new Error("EXECUTION_BINDING_REQUIRED: resumed session has no full versioned binding.");
      if (prior.executionBinding.runtime.sessionId !== actualSessionId) throw new Error("EXECUTION_BINDING_RUNTIME_SESSION_MISMATCH: resumed result channel does not identify the actual runtime session being continued.");
      assertResultProvenanceMatchesExecution(prior, operation, contract, selection, options);
      options.executionBinding = prior.executionBinding;
      if (isPaseoExecution(selection, config)) await assertPaseoSessionBinding(stateRoot, operation, prior.executionBinding, true);
      if (Array.isArray(options.contextManifest?.addressableRefs) && options.contextManifest.addressableRefs.length) await validateCurrentContextAuthorization(stateRoot, operationId, participantId, actualSessionId);
      await recordContextContinuation(stateRoot, operationId, participantId, {
        operationId,
        projectId: identityProjectId(operation),
        operationExecutionRevision: prior.executionBinding.operationExecutionRevision,
        candidateRevision: prior.executionBinding.candidateRevision,
        candidateRevisionDigest: prior.executionBinding.candidateDigest,
        participantId,
        participantGeneration: prior.executionBinding.participantGeneration,
        executionBindingDigest: prior.executionBinding.digest,
        controllerEpoch: prior.executionBinding.controllerEpoch,
        contextManifestDigest: prior.executionBinding.contextManifestDigest,
        promptManifestDigest: prior.executionBinding.promptManifestDigest,
        previousSessionId: actualSessionId!
      });
      return prior.executionBinding;
    }
    if (prior && prior.status !== "UNSUPPORTED") throw new Error("EXECUTION_BINDING_REQUIRED: resumed structured-result channel has unsupported partial identity and cannot be rebound.");
  }
  const identity = await compileParticipantInvocationIdentity(root, config, contract, selection, options, operation, candidate, participantId, controllerEpoch);
  options.executionBlueprint = identity.blueprint;
  options.roleInvocationPolicy = identity.rolePolicy;
  options.skillManifest = identity.skillManifest;
  operation = await bindResolvedPolicyIfAbsent(stateRoot, operationId, identity.policy);
  if (options.executionBlueprintDigest && options.executionBlueprintDigest !== identity.blueprint.digest) throw new Error("EXECUTION_BLUEPRINT_MISMATCH: supplied digest does not match the frozen ExecutionBlueprint.");
  const participantGeneration = randomUUID();
  const binding = options.executionBinding ?? compileExecutionBinding({
    operationId,
    operationExecutionRevision: operation.operationExecutionRevision!,
    candidateRevision: candidate.revision,
    candidateDigest: candidate.identityDigest,
    controllerEpoch,
    executionBlueprintDigest: identity.blueprint.digest,
    operationPolicyDigest: identity.policy.digest,
    participantId,
    participantGeneration,
    roleInvocationPolicyDigest: identity.rolePolicy.digest,
    skillManifestDigest: identity.skillManifest.digest,
    runtime: {
      runtimeId: selection.runtimeName,
      provider: selection.modelProvider ?? selection.paseoProvider ?? selection.runtimeAdapter,
      modelId: selection.modelId,
      model: selection.modelName,
      sessionId: actualSessionId
    },
    contextManifestDigest: options.contextManifestDigest,
    promptManifestDigest: options.promptManifestDigest,
    outputContract: options.outputContract ?? identity.rolePolicy.outputContract,
    leaseIdentities: authority?.leases.map((lease) => lease.leaseId) ?? []
  });
  assertExecutionBindingV2(binding);
  if (binding.contextManifestDigest !== options.contextManifestDigest || binding.promptManifestDigest !== options.promptManifestDigest || binding.operationExecutionRevision !== operation.operationExecutionRevision || binding.candidateDigest !== candidate.identityDigest || binding.controllerEpoch !== controllerEpoch || binding.operationId !== operationId || binding.participantId !== participantId) throw new Error("EXECUTION_BINDING_MISMATCH: supplied binding does not match the actual launch identity.");
  operation = await bindOperationParticipantExecution(stateRoot, operationId, { participantId, logicalAgent: selection.logicalAgent, role: selection.role, binding });
  if (isPaseoExecution(selection, config)) await assertPaseoSessionBinding(stateRoot, operation, binding, false);
  if (Array.isArray(options.contextManifest?.addressableRefs) && options.contextManifest.addressableRefs.length) {
    if (!authority) throw new Error("CONTEXT_RUNTIME_V2_AUTHORITY_REJECTED: a controller-issued read lease is required to authorize addressable context refs.");
    const contextAuthorization = await issueContextRefAuthorization(root, stateRoot, operationId, participantId, { logicalAgent: selection.logicalAgent, phase: options.phase ?? "work", retrievalBudget: resolveContextPolicy(config).retrieval, capabilityAuthority: authority, contextManifest: options.contextManifest! });
    if (!contextAuthorization) throw new Error("CONTEXT_RUNTIME_V2_ISSUE_REJECTED: the launch manifest advertises addressable refs but the controller did not persist an authorization receipt.");
  }
  options.executionBinding = binding;
  options.executionBlueprintDigest = binding.executionBlueprintDigest;
  options.resolvedOperationPolicyDigest = binding.operationPolicyDigest;
  return binding;
}

function isPaseoExecution(selection: AgentExecutionSelection, config: HarnessProjectConfig): boolean {
  return selection.transport === "paseo" || (selection.transport === "inherit" && config.orchestration?.provider === "paseo");
}

function identityProjectId(operation: Awaited<ReturnType<typeof loadOperation>>): string {
  if (operation.version !== 2 || !operation.resolvedOperationPolicy?.projectId) throw new Error("EXECUTION_BINDING_REQUIRED: frozen operation policy project identity is unavailable.");
  return operation.resolvedOperationPolicy.projectId;
}

async function assertPaseoSessionBinding(stateRoot: string, operation: Awaited<ReturnType<typeof loadOperation>>, binding: ExecutionBindingV2, reuseRequired: boolean): Promise<void> {
  if (operation.version !== 2 || !operation.resolvedOperationPolicy) throw new Error("PASEO_SESSION_BINDING_INVALID: current frozen operation policy is required.");
  const identity: PaseoSessionBindingIdentityV1 = {
    projectId: operation.resolvedOperationPolicy.projectId,
    operationId: binding.operationId,
    operationExecutionRevision: binding.operationExecutionRevision,
    participantId: binding.participantId,
    participantGeneration: binding.participantGeneration,
    candidateRevision: binding.candidateRevision,
    candidateDigest: binding.candidateDigest,
    executionBlueprintDigest: binding.executionBlueprintDigest,
    operationPolicyDigest: binding.operationPolicyDigest,
    contextManifestDigest: binding.contextManifestDigest,
    promptManifestDigest: binding.promptManifestDigest,
    controllerEpoch: binding.controllerEpoch
  };
  const actualAgentId = binding.runtime.sessionId;
  const current = await loadPaseoSessionBinding(stateRoot, binding.operationId, binding.participantId);
  if (reuseRequired) {
    const reusable = resolveReusablePaseoSession(current, identity);
    if (!reusable || reusable.paseoAgentId !== actualAgentId) throw new Error("PASEO_SESSION_BINDING_STALE: requested session does not match the complete current canonical binding.");
    return;
  }
  if (!current) {
    await bindPaseoSession(stateRoot, { ...identity, paseoAgentId: actualAgentId });
    return;
  }
  if (paseoSessionBindingMatches(current, identity) && current.paseoAgentId === actualAgentId && current.status === "ACTIVE") return;
  if (current.paseoAgentId === actualAgentId) throw new Error("PASEO_SESSION_BINDING_STALE: an existing live Paseo session cannot be relabeled after identity drift; materialize a new session.");
  await rotatePaseoSessionBinding(stateRoot, { ...identity, paseoAgentId: actualAgentId });
}

function verifyPreparedPrompt(prompt: string, options: AgentPromptOptions, selection: AgentExecutionSelection): { prompt: string; contextManifest: Readonly<Record<string, unknown>>; contextManifestDigest: string; promptManifestDigest: string } {
  if (!options.contextManifestDigest || !options.promptManifestDigest) throw new Error("EXECUTION_BINDING_REQUIRED: prepared prompt requires actual context and prompt manifest digests.");
  if (!options.contextManifest || sha256Canonical(options.contextManifest) !== options.contextManifestDigest) throw new Error("EXECUTION_BINDING_CONTEXT_MISMATCH: prepared ContextManifest bytes do not match the claimed digest.");
  const manifest = createPromptManifest({ dynamic: [{ id: "actual-rendered-prompt", content: prompt, role: selection.role, source: "agent-prompt-projection" }] });
  if (manifest.digest !== options.promptManifestDigest) throw new Error("EXECUTION_BINDING_PROMPT_MISMATCH: propagated PromptManifest digest does not match the exact prompt bytes.");
  if (options.skillManifest?.entries.some((entry) => entry.kind === "ephemeral" && entry.procedure.some((step) => !prompt.includes(step)))) throw new Error("SKILL_MANIFEST_PROJECTION_MISMATCH: accepted ephemeral procedure was not projected verbatim into the assigned participant prompt.");
  return { prompt, contextManifest: options.contextManifest, contextManifestDigest: options.contextManifestDigest, promptManifestDigest: options.promptManifestDigest };
}

function freezeIdentityObject<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) freezeIdentityObject(nested);
  }
  return value;
}

async function bindResolvedPolicyIfAbsent(root: string, operationId: string, policy: ResolvedOperationPolicyV1): Promise<Awaited<ReturnType<typeof loadOperation>>> {
  const current = await loadOperation(root, operationId);
  if (current.resolvedOperationPolicy?.digest === policy.digest) return current;
  if (current.resolvedOperationPolicy) throw new Error("EXECUTION_POLICY_RECOMPILE_REQUIRED: operation has a different frozen ResolvedOperationPolicy.");
  const { bindResolvedOperationPolicy } = await import("../operations/state.js");
  return bindResolvedOperationPolicy(root, operationId, policy);
}

async function compileParticipantInvocationIdentity(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  selection: AgentExecutionSelection,
  options: AgentPromptOptions,
  operation: Awaited<ReturnType<typeof loadOperation>>,
  candidate: NonNullable<Awaited<ReturnType<typeof loadOperation>>["candidateRevision"]>,
  participantId: string,
  controllerEpoch: number
): Promise<{ policy: ResolvedOperationPolicyV1; blueprint: ExecutionBlueprintV2; rolePolicy: RoleInvocationPolicyV1; skillManifest: SkillManifestV1 }> {
  if (selection.role === "Semantic Assessor") throw new Error("SEMANTIC_ASSESSOR_NOT_PARTICIPANT: bounded semantic assessments execute through the controller-side Paseo gateway and do not receive WorkGraph Participant identity.");
  if (options.executionBlueprint) {
    assertExecutionBlueprintV2(options.executionBlueprint);
    const policy = operation.resolvedOperationPolicy ?? options.executionBlueprint.resolvedOperationPolicy;
    assertResolvedOperationPolicyV1(policy);
    const participant = options.executionBlueprint.participants.find((item) => item.participantId === participantId);
    const rolePolicy = options.roleInvocationPolicy ?? participant?.roleInvocationPolicy;
    const skillManifest = options.skillManifest;
    if (!policy || !rolePolicy || !skillManifest) throw new Error("EXECUTION_BINDING_REQUIRED: frozen blueprint, role policy, and exact SkillManifest are required.");
    assertRoleInvocationPolicyV1(rolePolicy);
    assertSkillManifestV1(skillManifest);
    if (participantId !== rolePolicy.participantId || skillManifest.scope.participantId !== participantId || skillManifest.scope.operationId !== operation.id || skillManifest.scope.operationExecutionRevision !== operation.operationExecutionRevision || skillManifest.scope.candidateRevision !== candidate.revision || skillManifest.scope.candidateDigest !== candidate.identityDigest || skillManifest.scope.controllerEpoch !== controllerEpoch || sha256Canonical(skillManifest.scope.workUnitIds) !== sha256Canonical(rolePolicy.workUnitIds) || sha256Canonical(skillManifest.scope.competencies) !== sha256Canonical(rolePolicy.competencies) || participant?.roleInvocationPolicy.digest !== rolePolicy.digest || policy.digest !== options.executionBlueprint.resolvedOperationPolicy.digest || (operation.resolvedOperationPolicy && policy.digest !== operation.resolvedOperationPolicy.digest) || participant?.skillManifestDigest !== skillManifest.digest) throw new Error("EXECUTION_BINDING_INVALID: supplied participant artifacts do not match the frozen blueprint and durable operation policy.");
    if (options.outputContract && options.outputContract !== rolePolicy.outputContract) throw new Error("ROLE_INVOCATION_POLICY_VIOLATION: requested output contract exceeds or differs from the frozen role policy.");
    return { policy, blueprint: options.executionBlueprint, rolePolicy, skillManifest };
  }
  if (!Number.isSafeInteger(operation.operationExecutionRevision) || operation.operationExecutionRevision! < 1) throw new Error("UNSUPPORTED_OPERATION_EXECUTION_REVISION: migrate this operation record before structured-result launch.");
  const route = contract.routing?.route;
  const assurance = contract.routing?.assurance;
  if (!route || !assurance) throw new Error("EXECUTION_POLICY_INPUT_MISSING: TaskContract must carry deterministic route and minimum assurance before launch.");
  const scope = contract.scope?.allowed;
  if (!scope?.length) throw new Error("ROLE_INVOCATION_POLICY_INVALID: TaskContract must declare bounded scope before structured-result launch.");
  const profile = roleProfile(selection.role);
  const seed = defaultSkillSeed().skills;
  const selectedSkillIds = [...new Set([...profile.defaultSkills, ...selection.skills])];
  const selectedSkills = selectedSkillIds.map((id) => seed.find((skill) => skill.id === id));
  if (selectedSkills.some((skill) => !skill)) throw new Error(`SKILL_MANIFEST_INVALID: selected skill lacks procedure content: ${selectedSkillIds.filter((id) => !seed.some((skill) => skill.id === id)).join(", ")}.`);
  const invocationWorkUnitIds = [`invocation:${participantId}`];
  const invocationCompetencies = [...new Set([...(selection.specializations ?? []), ...(options.skillManifest?.entries.filter((entry) => entry.kind === "ephemeral").map((entry) => entry.competency) ?? [])])].sort();
  const skillManifest = options.skillManifest ?? compileSkillManifest({ scope: { operationId: operation.id, operationExecutionRevision: operation.operationExecutionRevision!, candidateRevision: candidate.revision, candidateDigest: candidate.identityDigest, controllerEpoch, participantId, workUnitIds: invocationWorkUnitIds, competencies: invocationCompetencies }, skills: selectedSkills.filter((skill): skill is NonNullable<typeof skill> => Boolean(skill)).map((skill) => ({ id: skill.id, kind: skill.kind, competencies: skill.competencies, proceduralSteps: skill.proceduralSteps })) });
  if (skillManifest.scope.participantId !== participantId || skillManifest.scope.operationId !== operation.id || skillManifest.scope.operationExecutionRevision !== operation.operationExecutionRevision || skillManifest.scope.candidateRevision !== candidate.revision || skillManifest.scope.candidateDigest !== candidate.identityDigest || skillManifest.scope.controllerEpoch !== controllerEpoch || sha256Canonical(skillManifest.scope.workUnitIds) !== sha256Canonical(invocationWorkUnitIds) || sha256Canonical(skillManifest.scope.competencies) !== sha256Canonical(invocationCompetencies)) throw new Error("SKILL_MANIFEST_ASSIGNMENT_MISMATCH: SkillManifest belongs to another operation, candidate, epoch, participant, work unit, or competency scope.");
  const allowedExternalEffects = configuredExternalEffects(config, operation.kind);
  const humanDecisionRequirements = requiredHumanActionAuthorizations(allowedExternalEffects);
  const deliveryPolicy = { githubEnabled: config.delivery?.github?.enabled === true, paseoEnabled: config.delivery?.paseo?.enabled === true, allowedExternalEffects };
  const policy = operation.resolvedOperationPolicy ?? compileResolvedOperationPolicy({
    projectId: candidate.projectId ?? config.project.name,
    operationId: operation.id,
    operationExecutionRevision: operation.operationExecutionRevision!,
    candidateRevision: candidate.revision,
    candidateDigest: candidate.identityDigest,
    controllerEpoch,
    intent: operation.intent?.request ?? contract.routing?.intent ?? contract.task.title,
    route,
    minimumAssurance: assurance,
    policyVersions: { resolvedOperationPolicy: "1", roleInvocationPolicy: "1", executionBlueprint: "2", executionBinding: "2", skillManifest: "1" },
    policyDigests: {
      validation: sha256Canonical(contract.verification ?? {}),
      delivery: sha256Canonical({ ...deliveryPolicy, humanDecisionRequirements }),
      knowledge: sha256Canonical(skillManifest.entries.map((entry) => ({ sourcePackDigest: entry.sourcePackDigest, trustDecisionDigest: entry.trustDecisionDigest }))),
      context: sha256Canonical(config.context ?? null)
    },
    validationPolicy: contract.verification ?? {},
    reviewPolicy: {
      minimumAssurance: assurance,
      independentReviewRequired: assurance === "ELEVATED" || assurance === "CRITICAL",
      leadAcceptance: config.workflow?.reviews?.leadAcceptance !== false,
      leadAcceptanceDirect: config.workflow?.reviews?.leadAcceptanceDirect === true
    },
    deliveryPolicy,
    knowledgePolicy: { skillManifestDigest: skillManifest.digest },
    contextPolicy: config.context ?? { mode: "disabled" },
    allowedExternalEffects,
    humanDecisionRequirements
  });
  assertResolvedOperationPolicyV1(policy);
  if (policy.version !== 1 || policy.operationId !== operation.id || policy.projectId !== (candidate.projectId ?? config.project.name) || policy.operationExecutionRevision !== operation.operationExecutionRevision || policy.candidateRevision !== candidate.revision || policy.candidateDigest !== candidate.identityDigest || policy.controllerEpoch !== controllerEpoch || policy.route !== route || policy.minimumAssurance !== assurance) throw new Error("EXECUTION_POLICY_STALE: durable ResolvedOperationPolicy does not match the current execution inputs.");
  const rolePolicy = options.roleInvocationPolicy ?? compileRoleInvocationPolicy({
    operationId: operation.id,
    operationPolicyDigest: policy.digest,
    participantId,
    role: selection.role,
    workUnitIds: [`invocation:${participantId}`],
    scope,
    competencies: invocationCompetencies,
    toolPack: profile.toolPack,
    resourceClaims: [],
    outputContract: options.outputContract ?? profile.outputContract,
    constraints: { maxCapabilities: [...profile.maxCapabilities].sort(), readOnly: selection.role === "Reviewer" }
  });
  assertRoleInvocationPolicyV1(rolePolicy);
  assertSkillManifestV1(skillManifest);
  if (options.outputContract && options.outputContract !== rolePolicy.outputContract) throw new Error("ROLE_INVOCATION_POLICY_VIOLATION: requested output contract exceeds or differs from the frozen role policy.");
  const graph = createWorkGraph({
    taskId: contract.task.id,
    objective: contract.task.title,
    route,
    assurance,
    requirementRefs: (contract.requirements ?? []).map((item) => item.id),
    acceptanceRefs: [],
    units: [{ version: 1, id: `invocation:${participantId}`, objective: contract.task.title, scope: [...scope], dependencies: [], requirementRefs: (contract.requirements ?? []).map((item) => item.id), acceptanceRefs: [], competencies: invocationCompetencies, riskTags: [], changeKinds: ["source"], risk: "low", status: "PENDING", resourceClaims: [] }]
  });
  const catalog = compileExecutionCatalog({
    runtimes: { [selection.runtimeName]: { adapter: selection.runtimeAdapter, paseoProvider: selection.paseoProvider, capabilities: selection.runtimeCapabilities } },
    models: { [selection.modelAlias]: { alias: selection.modelAlias, id: selection.modelId, runtime: selection.runtimeName, provider: selection.modelProvider, model: selection.modelName, variant: selection.variant } },
    roleBindings: { [selection.role]: { runtimeId: selection.runtimeName, modelAlias: selection.modelAlias, transport: selection.transport, profile: selection.profile, variant: selection.variant, nativeAgent: selection.nativeAgent, outputContract: options.outputContract ?? profile.outputContract, temperature: selection.temperature, args: selection.args } }
  });
  const validationResolution = { version: 1 as const, requirements: [], actions: [], blocked: [], digest: sha256Canonical({ version: 1, requirements: [], actions: [], blocked: [] }) };
  const assignment = { participantId, role: selection.role, specialization: selection.specializations?.[0] ?? selection.role, competencies: invocationCompetencies, skills: [...selection.skills], toolPack: profile.toolPack, budget: { maxTokens: 1, reservedTokens: 0, maxConcurrent: 1 }, workUnitIds: invocationWorkUnitIds, skillManifest, roleInvocationPolicy: rolePolicy };
  const planBody = { version: 1 as const, taskId: contract.task.id, route, assurance, assignments: [assignment], reviewDimensions: [], knowledgeRefs: skillManifest.entries.flatMap((entry) => entry.sourcePackDigest ? [entry.sourcePackDigest] : []), executionCatalogDigest: catalog.digest };
  const participantPlan = { ...planBody, compilerDigest: sha256Canonical(planBody) };
  const blueprint = createExecutionBlueprintV2({ projectId: policy.projectId, operationId: operation.id, operationExecutionRevision: policy.operationExecutionRevision, candidateRevision: candidate.revision, candidateDigest: candidate.identityDigest, controllerEpoch, resolvedOperationPolicy: policy, workGraph: graph, participantPlan, executionCatalog: catalog, participants: [{ participantId, role: selection.role, specialization: assignment.specialization, roleInvocationPolicy: rolePolicy, toolPack: rolePolicy.toolPack, resourceClaims: rolePolicy.resourceClaims, validationResolution, outputContract: rolePolicy.outputContract, skillManifestDigest: skillManifest.digest }], validationResolution });
  return { policy, blueprint, rolePolicy, skillManifest };
}

function assertResultProvenanceMatchesExecution(
  provenance: StructuredResultProvenanceV1,
  operation: Awaited<ReturnType<typeof loadOperation>> | undefined,
  contract: TaskContract,
  selection: AgentExecutionSelection,
  options: AgentPromptOptions
): void {
  if (!operation || provenance.operationId !== operation.id || provenance.logicalAgent !== selection.logicalAgent || provenance.role !== selection.role || provenance.taskId !== contract.task.id || provenance.outputContract !== options.outputContract) {
    throw new Error("AEH_RESULT_PROVENANCE: materialized result channel does not match this operation, participant, task, role, or output contract.");
  }
  if (!operation.candidateRevision || !provenance.candidate || operation.candidateRevision.identityDigest !== provenance.candidate.identityDigest) {
    throw new Error("AEH_RESULT_STALE_CANDIDATE: materialized result channel is bound to a prior or missing candidate.");
  }
  const executionBinding = provenance.participantId ? operation.participants[provenance.participantId]?.executionBinding : undefined;
  if (!executionBinding || executionBinding.participantGeneration !== provenance.participantGeneration || executionBinding.operationExecutionRevision !== provenance.operationExecutionRevision || executionBinding.candidateDigest !== provenance.candidate.identityDigest || executionBinding.controllerEpoch !== provenance.controllerEpoch || executionBinding.executionBlueprintDigest !== provenance.executionBlueprintDigest || executionBinding.operationPolicyDigest !== provenance.resolvedOperationPolicyDigest || executionBinding.digest !== provenance.executionBinding?.digest) {
    throw new Error("AEH_RESULT_STALE_EXECUTION: result channel belongs to an older participant generation, operation revision, or ExecutionBlueprint.");
  }
  if (options.contextManifestDigest && provenance.contextManifestDigest !== options.contextManifestDigest) throw new Error("EXECUTION_BINDING_STALE: ContextManifest changed after session materialization.");
  if (options.promptManifestDigest && provenance.promptManifestDigest !== options.promptManifestDigest) throw new Error("EXECUTION_BINDING_STALE: PromptManifest changed after session materialization.");
  if (options.participantId && provenance.participantId !== options.participantId) throw new Error("AEH_RESULT_PROVENANCE: result channel belongs to a different participant identity.");
  if (options.capabilityAuthority && (options.capabilityAuthority.candidateDigest !== provenance.candidate.identityDigest || options.capabilityAuthority.controllerEpoch !== provenance.controllerEpoch)) {
    throw new Error("AEH_RESULT_PROVENANCE: result channel does not match the current execution authority.");
  }
  if (options.executionBlueprintDigest && provenance.executionBlueprintDigest !== options.executionBlueprintDigest) throw new Error("AEH_RESULT_PROVENANCE: result channel belongs to a different execution blueprint.");
  if (options.resolvedOperationPolicyDigest && provenance.resolvedOperationPolicyDigest !== options.resolvedOperationPolicyDigest) throw new Error("AEH_RESULT_PROVENANCE: result channel belongs to a different operation policy.");
}

function attachStructuredResultProvenance(labels: Record<string, string>, provenance: StructuredResultProvenanceV1 | undefined, role: string): void {
  if (!provenance) return;
  labels["aeh.canonical.role"] = role;
  labels["aeh.execution.binding.phase"] = "BOUND";
  labels["aeh.result.provenance"] = JSON.stringify(provenance);
  if (provenance.executionBinding) labels["aeh.execution.binding"] = JSON.stringify(provenance.executionBinding);
  if (provenance.contextManifestDigest) labels["aeh.context.manifest.digest"] = provenance.contextManifestDigest;
  if (provenance.promptManifestDigest) labels["aeh.prompt.manifest.digest"] = provenance.promptManifestDigest;
  if (provenance.skillManifestDigest) labels["aeh.skill.manifest.digest"] = provenance.skillManifestDigest;
}

function boundPaseoExecutionLabels(options: AgentPromptOptions, role: string, channelId?: string): Record<string, string> | undefined {
  const binding = options.executionBinding;
  if (!binding) return undefined;
  const labels: Record<string, string> = {
    "aeh.canonical.role": role,
    "aeh.execution.binding": JSON.stringify(binding),
    "aeh.execution.binding.digest": binding.digest,
    "aeh.execution.binding.phase": "BOUND",
    "aeh.execution.blueprint.digest": binding.executionBlueprintDigest,
    "aeh.role.invocation.policy.digest": binding.roleInvocationPolicyDigest,
    "aeh.skill.manifest.digest": binding.skillManifestDigest,
    "aeh.context.manifest.digest": binding.contextManifestDigest,
    "aeh.prompt.manifest.digest": binding.promptManifestDigest
  };
  if (channelId) labels["aeh.result.channel"] = channelId;
  if (options.structuredResultProvenance) labels["aeh.result.provenance"] = JSON.stringify(options.structuredResultProvenance);
  return labels;
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
