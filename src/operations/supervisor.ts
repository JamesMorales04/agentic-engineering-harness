import type { AgentExecutionSelection, ResolvedAgentTopology } from "../agents/types.js";
import { supervisorOutputSchema, type NormalizedFinding, type SupervisorOutput } from "../agents/outputContracts.js";
import { extractMarkedJson } from "../agents/structuredOutput.js";
import { executionSelectionForAgent } from "../agents/routing.js";
import type { HarnessProjectConfig, TaskContract, WorkerSession } from "../core/types.js";
import { statusLeadContext } from "../paseo/context.js";
import { archivePaseoSdkAgent } from "../paseo/sdk.js";
import { recordPaseoTrace } from "../paseo/trace.js";
import { dispatchMaterializedAgentPrompt, executeAgentPrompt, materializeAgentPrompt } from "../workers/agentPrompt.js";
import { hasTraceableAcceptance } from "../workers/promptPolicy.js";
import { persistOperationConsolidation, persistSupervisorCheckpoint } from "./artifacts.js";
import { supervisorEventSkills, type SupervisorSemanticEvent } from "./supervisorEventPolicy.js";
import { compactDeterministicEvidence, supervisorCheckpointProjection, supervisorConsolidationProjection, supervisorHandoffProjection, supervisorInitializationProjection } from "./supervisorPrompt.js";
import { activeOperationSupervisor, currentOperationContext, loadOperation, patchOperation, registerSupervisorGeneration, resolveOperationStateRoot, updateSupervisorGeneration, type OperationRecordV2 } from "./state.js";

export interface EnsureSupervisorOptions { required?: boolean; forceMaterialize?: boolean; }
export interface OperationSupervisorHandle { operationId: string; generation: number; agentId?: string; materialized: boolean; selection: AgentExecutionSelection; session?: WorkerSession; }
export interface SupervisorConsolidationInput { key: string; purpose: string; findings: NormalizedFinding[]; sourceArtifacts?: string[]; deterministicEvidence?: unknown; }
export interface SupervisorConsolidationResult { output: SupervisorOutput; artifact: string; session: WorkerSession; }
interface SupervisorContextPolicy { handoffThreshold: number; hardHandoffThreshold: number; }
interface SupervisionConfigExtension { operations?: { supervision?: { initializationTimeoutSeconds?: number; context?: { handoffThreshold?: number; hardHandoffThreshold?: number; }; }; }; }
const SUPERVISOR_INITIALIZATION_ATTEMPTS = 2;
const DEFAULT_SUPERVISOR_INITIALIZATION_TIMEOUT_SECONDS = 60;

export function operationSupervisorContextPolicy(config: HarnessProjectConfig): SupervisorContextPolicy {
  const configured = (config.orchestration as (HarnessProjectConfig["orchestration"] & SupervisionConfigExtension) | undefined)?.operations?.supervision?.context;
  const handoffThreshold = ratio(configured?.handoffThreshold, 0.75);
  return { handoffThreshold, hardHandoffThreshold: Math.max(handoffThreshold, ratio(configured?.hardHandoffThreshold, 0.85)) };
}
export function operationSupervisorInitializationTimeoutSeconds(config: HarnessProjectConfig): number {
  const value = (config.orchestration as (HarnessProjectConfig["orchestration"] & SupervisionConfigExtension) | undefined)?.operations?.supervision?.initializationTimeoutSeconds;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_SUPERVISOR_INITIALIZATION_TIMEOUT_SECONDS;
}
function supervisorInitializationConfig(config: HarnessProjectConfig): HarnessProjectConfig {
  if (!config.orchestration) return config;
  return { ...config, orchestration: { ...config.orchestration, worker: { ...config.orchestration.worker, timeoutSeconds: operationSupervisorInitializationTimeoutSeconds(config) } } };
}

export async function ensureOperationSupervisor(root: string, config: HarnessProjectConfig, contract: TaskContract, topology: ResolvedAgentTopology, options: EnsureSupervisorOptions = {}): Promise<OperationSupervisorHandle | undefined> {
  const operationId = currentOperationContext().id;
  if (!operationId) return undefined;
  const stateRoot = resolveOperationStateRoot(root);
  let operation = await loadOperation(stateRoot, operationId);
  const required = options.required ?? operation.supervision.required;
  if (!required && !options.forceMaterialize) return undefined;
  const configured = topology.agents["operation-supervisor"];
  if (!configured || configured.disabled) {
    if (required) throw new Error("AEH_OPERATION_SUPERVISOR_REQUIRED: topology has no enabled operation-supervisor agent.");
    return undefined;
  }
  const selection = executionSelectionForAgent(topology, "operation-supervisor");
  const active = activeOperationSupervisor(operation);
  if (active?.agentId) return { operationId, generation: active.generation, agentId: active.agentId, materialized: true, selection };

  let lastError: string | undefined;
  for (let attempt = 1; attempt <= SUPERVISOR_INITIALIZATION_ATTEMPTS; attempt += 1) {
    operation = await loadOperation(stateRoot, operationId);
    const initSelection = eventSelection(selection, contract, "initialize", operation.kind);
    const materialized = await materializeAgentPrompt(root, config, contract, initSelection, { phase: "supervision", operationKind: operation.kind, parentAgentId: operation.lead?.agentId, supervisorAgent: true });
    if (!materialized?.id) { lastError = "Paseo SDK did not materialize a persistent supervisor session"; break; }
    operation = await registerSupervisorGeneration(stateRoot, operationId, { agentId: materialized.id, materialized: true, status: "INITIALIZING", initializationAttempt: attempt });
    const generation = [...operation.supervision.generations].reverse().find((item) => item.agentId === materialized.id && item.status === "INITIALIZING")?.generation;
    if (!generation) throw new Error("AEH_OPERATION_SUPERVISOR_STATE: materialized supervisor generation was not durably registered as INITIALIZING.");
    await recordPaseoTrace(stateRoot, "operation.supervisor.materialized", { operationId, generation, agentId: materialized.id, revision: operation.revision, attempt, status: "INITIALIZING" });
    try {
      operation = await updateSupervisorGeneration(stateRoot, operationId, generation, { initializationDispatchedAt: new Date().toISOString(), error: undefined });
      const session = await dispatchMaterializedAgentPrompt(root, supervisorInitializationConfig(config), contract, initSelection, materialized, initializationPrompt(operation, generation), { phase: "supervision", operationKind: operation.kind, supervisorAgent: true });
      if (session.exitCode !== 0 || !session.id) throw new Error(session.stderr || session.stdout || `exit ${session.exitCode}`);
      const completedAt = new Date().toISOString();
      const activated = await updateSupervisorGeneration(stateRoot, operationId, generation, { status: "ACTIVE", activatedAt: completedAt, initializationCompletedAt: completedAt, initializationEvidence: session.transport?.includes("paseo") ? "paseo-sdk-turn-barrier" : "turn-barrier", error: undefined });
      if (activated.supervision.activeGeneration !== generation) throw new Error("AEH_OPERATION_SUPERVISOR_STATE: initialized supervisor did not become the active generation.");
      await recordPaseoTrace(stateRoot, "operation.supervisor.initialized", { operationId, generation, agentId: session.id, revision: activated.revision, attempt, timeoutSeconds: operationSupervisorInitializationTimeoutSeconds(config), evidence: "turn-barrier" });
      return { operationId, generation, agentId: session.id, materialized: true, selection, session };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await updateSupervisorGeneration(stateRoot, operationId, generation, { status: "FAILED", error: `initialization failed: ${lastError}` }).catch(() => undefined);
      await archivePaseoSdkAgent(root, materialized.id).catch(() => undefined);
      await recordPaseoTrace(stateRoot, "operation.supervisor.initialization-failed", { operationId, generation, agentId: materialized.id, attempt, error: lastError, timeoutSeconds: operationSupervisorInitializationTimeoutSeconds(config) }).catch(() => undefined);
    }
  }
  throw new Error(`AEH_OPERATION_SUPERVISOR_UNAVAILABLE: initialization failed after ${SUPERVISOR_INITIALIZATION_ATTEMPTS} bounded attempt(s): ${lastError ?? "unknown error"}`);
}

export async function consolidateWithOperationSupervisor(root: string, config: HarnessProjectConfig, contract: TaskContract, topology: ResolvedAgentTopology, input: SupervisorConsolidationInput): Promise<SupervisorConsolidationResult> {
  const stateRoot = resolveOperationStateRoot(root);
  const supervisor = await ensureOperationSupervisor(root, config, contract, topology, { required: true, forceMaterialize: true });
  if (!supervisor?.agentId) throw new Error("AEH_OPERATION_SUPERVISOR_UNAVAILABLE: semantic consolidation requires a materialized supervisor session.");
  const rawIds = [...new Set(input.findings.map((finding) => finding.id))].sort();
  const operation = await loadOperation(stateRoot, supervisor.operationId);
  const generation = activeOperationSupervisor(operation);
  const selection = eventSelection(supervisor.selection, contract, "consolidate", operation.kind);
  const session = await executeAgentPrompt(root, config, contract, selection, consolidationPrompt(operation, input, generation?.checkpointArtifact), { outputContract: "supervisor", resumeSessionId: supervisor.agentId, phase: "consolidating", operationKind: operation.kind, supervisorAgent: true });
  if (session.exitCode !== 0) throw new Error(`AEH_OPERATION_SUPERVISOR_FAILED: supervisor exited with ${session.exitCode}: ${session.stderr || session.stdout}`);
  let output: SupervisorOutput;
  try { output = supervisorOutputSchema.parse(extractMarkedJson(session.stdout, session.stderr)); } catch (error) { throw new Error(`AEH_OPERATION_SUPERVISOR_CONTRACT: ${String(error)}`); }
  const sourceIds = [...new Set(output.sourceFindingIds)].sort();
  if (sourceIds.length !== rawIds.length || sourceIds.some((id, index) => id !== rawIds[index])) throw new Error(`AEH_OPERATION_SUPERVISOR_PROVENANCE: consolidation did not account for the exact raw finding set. expected=${rawIds.join(",")} received=${sourceIds.join(",")}`);
  const artifact = await persistOperationConsolidation(stateRoot, supervisor.operationId, input.key, { generation: supervisor.generation, sourceArtifacts: input.sourceArtifacts ?? [], rawFindingIds: rawIds, output });
  const current = await loadOperation(stateRoot, supervisor.operationId);
  await patchOperation(stateRoot, supervisor.operationId, { supervision: { ...current.supervision, latestConsolidationRevision: current.revision + 1, latestConsolidationArtifact: artifact } });
  return { output, artifact, session };
}

export async function maybeRotateOperationSupervisor(root: string, config: HarnessProjectConfig, contract: TaskContract, topology: ResolvedAgentTopology): Promise<OperationSupervisorHandle | undefined> {
  const operationId = currentOperationContext().id;
  if (!operationId) return undefined;
  const stateRoot = resolveOperationStateRoot(root);
  const operation = await loadOperation(stateRoot, operationId);
  const active = activeOperationSupervisor(operation);
  if (!active?.agentId) return ensureOperationSupervisor(root, config, contract, topology, { required: operation.supervision.required });
  const context = await statusLeadContext(root, config, active.agentId);
  const policy = operationSupervisorContextPolicy(config);
  const usageRatio = context.usage.ratio;
  const rotate = usageRatio !== undefined ? usageRatio >= policy.handoffThreshold : context.state === "HANDOFF_REQUIRED" || context.state === "HARD_HANDOFF";
  if (!rotate) {
    if (usageRatio !== undefined) await updateSupervisorGeneration(stateRoot, operationId, active.generation, { contextRatio: usageRatio, error: undefined });
    return { operationId, generation: active.generation, agentId: active.agentId, materialized: true, selection: executionSelectionForAgent(topology, "operation-supervisor") };
  }
  const checkpointArtifact = await persistSupervisorCheckpoint(stateRoot, operationId, active.generation, buildSupervisorCheckpoint(operation, usageRatio));
  await updateSupervisorGeneration(stateRoot, operationId, active.generation, { status: "DRAINING", drainingAt: new Date().toISOString(), checkpointArtifact, contextRatio: usageRatio, error: undefined });
  const selection = executionSelectionForAgent(topology, "operation-supervisor");
  const handoffSelection = eventSelection(selection, contract, "handoff", operation.kind);
  const latest = await loadOperation(stateRoot, operationId);
  const materialized = await materializeAgentPrompt(root, config, contract, handoffSelection, { phase: "supervision", operationKind: operation.kind, parentAgentId: operation.lead?.agentId, supervisorAgent: true });
  if (!materialized?.id) {
    await updateSupervisorGeneration(stateRoot, operationId, active.generation, { status: "ACTIVE", drainingAt: undefined, error: "replacement materialization failed" });
    throw new Error("AEH_OPERATION_SUPERVISOR_ROTATION_FAILED: Paseo SDK did not materialize the replacement supervisor.");
  }
  const registered = await registerSupervisorGeneration(stateRoot, operationId, { agentId: materialized.id, materialized: true, checkpointArtifact, status: "INITIALIZING", initializationAttempt: 1 });
  const replacementGeneration = [...registered.supervision.generations].reverse().find((item) => item.agentId === materialized.id && item.status === "INITIALIZING")?.generation;
  if (!replacementGeneration) throw new Error("AEH_OPERATION_SUPERVISOR_ROTATION_FAILED: replacement generation was not durably registered as INITIALIZING.");
  await recordPaseoTrace(stateRoot, "operation.supervisor.materialized", { operationId, generation: replacementGeneration, agentId: materialized.id, revision: registered.revision, replacementFor: active.generation, status: "INITIALIZING" });
  try {
    await updateSupervisorGeneration(stateRoot, operationId, replacementGeneration, { initializationDispatchedAt: new Date().toISOString(), error: undefined });
    const session = await dispatchMaterializedAgentPrompt(root, supervisorInitializationConfig(config), contract, handoffSelection, materialized, handoffPrompt(latest, replacementGeneration, checkpointArtifact), { phase: "supervision", operationKind: operation.kind, supervisorAgent: true });
    if (session.exitCode !== 0 || !session.id) throw new Error(session.stderr || session.stdout || `exit ${session.exitCode}`);
    const completedAt = new Date().toISOString();
    const activated = await updateSupervisorGeneration(stateRoot, operationId, replacementGeneration, { status: "ACTIVE", activatedAt: completedAt, initializationCompletedAt: completedAt, initializationEvidence: "paseo-sdk-turn-barrier", error: undefined });
    if (activated.supervision.activeGeneration !== replacementGeneration) throw new Error("replacement supervisor did not become active after initialization");
    await recordPaseoTrace(stateRoot, "operation.supervisor.rotated", { operationId, fromGeneration: active.generation, fromAgentId: active.agentId, toGeneration: replacementGeneration, toAgentId: session.id, contextRatio: usageRatio ?? -1, handoffThreshold: policy.handoffThreshold, hardHandoffThreshold: policy.hardHandoffThreshold, checkpointArtifact });
    return { operationId, generation: replacementGeneration, agentId: session.id, materialized: true, selection, session };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateSupervisorGeneration(stateRoot, operationId, replacementGeneration, { status: "FAILED", error: `replacement initialization failed: ${message}` }).catch(() => undefined);
    await archivePaseoSdkAgent(root, materialized.id).catch(() => undefined);
    await updateSupervisorGeneration(stateRoot, operationId, active.generation, { status: "ACTIVE", drainingAt: undefined, error: `replacement initialization failed: ${message}` });
    throw new Error(`AEH_OPERATION_SUPERVISOR_ROTATION_FAILED: ${message}`);
  }
}

export async function settleDrainingSupervisorGenerations(root: string, operationId: string): Promise<OperationRecordV2> {
  const stateRoot = resolveOperationStateRoot(root);
  let record = await loadOperation(stateRoot, operationId);
  for (const generation of record.supervision.generations.filter((item) => item.status === "DRAINING")) {
    const unsettled = Object.values(record.participants).some((participant) => participant.parentSupervisorGeneration === generation.generation && !["COMPLETED", "FAILED", "CANCELLED"].includes(participant.status));
    if (unsettled) continue;
    if (generation.agentId) {
      try { await archivePaseoSdkAgent(root, generation.agentId); await recordPaseoTrace(stateRoot, "operation.supervisor.archived", { operationId, generation: generation.generation, agentId: generation.agentId }); }
      catch (error) { record = await updateSupervisorGeneration(stateRoot, operationId, generation.generation, { error: error instanceof Error ? error.message : String(error) }); await recordPaseoTrace(stateRoot, "operation.supervisor.archive-failed", { operationId, generation: generation.generation, agentId: generation.agentId, error: error instanceof Error ? error.message : String(error) }); continue; }
    }
    record = await updateSupervisorGeneration(stateRoot, operationId, generation.generation, { status: "ARCHIVED", archivedAt: new Date().toISOString(), error: undefined });
  }
  return record;
}

function initializationPrompt(operation: OperationRecordV2, generation: number): string {
  return ["[AEH_SUPERVISOR_INITIALIZE]", `State: ${JSON.stringify(supervisorInitializationProjection(operation, generation))}`, "No semantic work is requested on this turn. This is only the bounded session-readiness turn barrier.", "Acknowledge initialization compactly and become idle."].join("\n\n");
}
function handoffPrompt(operation: OperationRecordV2, generation: number, checkpointArtifact: string): string {
  return ["[AEH_SUPERVISOR_HANDOFF]", `State: ${JSON.stringify(supervisorHandoffProjection(operation, generation, checkpointArtifact))}`, "Use the durable checkpoint plus OperationRecord as continuity authority instead of transcript replay.", "Acknowledge the handoff compactly and become idle."].join("\n\n");
}
function consolidationPrompt(operation: OperationRecordV2, input: SupervisorConsolidationInput, checkpointArtifact?: string): string {
  return ["[AEH_SUPERVISOR_CONSOLIDATE]", `Purpose: ${input.purpose}`, `State: ${JSON.stringify(supervisorConsolidationProjection(operation))}`, checkpointArtifact ? `Continuity checkpoint: ${checkpointArtifact}` : undefined, `Source artifacts: ${JSON.stringify(input.sourceArtifacts ?? [])}`, `Deterministic evidence digest: ${JSON.stringify(compactDeterministicEvidence(input.deterministicEvidence ?? null))}`, `Raw findings: ${JSON.stringify(input.findings)}`, "Consolidate using the frozen semantic protocol. Preserve the exact source finding set, surface conflicts and missing evidence, and preserve deterministic validation outcomes.", operation.kind === "audit" ? "Include a compact prioritized roadmap derived only from the consolidated findings." : undefined].filter(Boolean).join("\n\n");
}
function eventSelection(selection: AgentExecutionSelection, contract: TaskContract, event: SupervisorSemanticEvent, operationKind?: string): AgentExecutionSelection {
  return { ...selection, skills: supervisorEventSkills(event, operationKind, hasTraceableAcceptance(contract)) };
}
function buildSupervisorCheckpoint(operation: OperationRecordV2, contextRatio?: number): Record<string, unknown> {
  return { ...supervisorCheckpointProjection(operation, contextRatio), instruction: "Resume semantic supervision from this durable checkpoint and OperationRecord without transcript replay." };
}
function ratio(value: number | undefined, fallback: number): number { return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback; }
