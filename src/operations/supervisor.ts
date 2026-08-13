import type { AgentExecutionSelection, ResolvedAgentTopology } from "../agents/types.js";
import {
  supervisorOutputSchema,
  type NormalizedFinding,
  type SupervisorOutput
} from "../agents/outputContracts.js";
import { extractMarkedJson } from "../agents/structuredOutput.js";
import { executionSelectionForAgent } from "../agents/routing.js";
import type { HarnessProjectConfig, TaskContract, WorkerSession } from "../core/types.js";
import { statusLeadContext } from "../paseo/context.js";
import { archivePaseoSdkAgent } from "../paseo/sdk.js";
import { recordPaseoTrace } from "../paseo/trace.js";
import {
  dispatchMaterializedAgentPrompt,
  executeAgentPrompt,
  materializeAgentPrompt
} from "../workers/agentPrompt.js";
import { persistOperationConsolidation, persistSupervisorCheckpoint } from "./artifacts.js";
import {
  activeOperationSupervisor,
  currentOperationContext,
  initializingOperationSupervisor,
  loadOperation,
  patchOperation,
  registerSupervisorGeneration,
  resolveOperationStateRoot,
  updateSupervisorGeneration,
  type OperationRecordV2
} from "./state.js";

export interface EnsureSupervisorOptions { required?: boolean; forceMaterialize?: boolean; }
export interface OperationSupervisorHandle {
  operationId: string; generation: number; agentId?: string; materialized: boolean;
  selection: AgentExecutionSelection; session?: WorkerSession;
}
export interface SupervisorConsolidationInput {
  key: string; purpose: string; findings: NormalizedFinding[]; sourceArtifacts?: string[]; deterministicEvidence?: unknown;
}
export interface SupervisorConsolidationResult { output: SupervisorOutput; artifact: string; session: WorkerSession; }
interface SupervisorContextPolicy { handoffThreshold: number; hardHandoffThreshold: number; }
interface SupervisionConfigExtension { operations?: { supervision?: { initializationTimeoutSeconds?: number; context?: { handoffThreshold?: number; hardHandoffThreshold?: number; }; }; }; }

const SUPERVISOR_INITIALIZATION_ATTEMPTS = 2;
const DEFAULT_SUPERVISOR_INITIALIZATION_TIMEOUT_SECONDS = 60;

export function operationSupervisorContextPolicy(config: HarnessProjectConfig): SupervisorContextPolicy {
  const orchestration = config.orchestration as (HarnessProjectConfig["orchestration"] & SupervisionConfigExtension) | undefined;
  const configured = orchestration?.operations?.supervision?.context;
  const handoffThreshold = ratio(configured?.handoffThreshold, 0.75);
  const hardHandoffThreshold = Math.max(handoffThreshold, ratio(configured?.hardHandoffThreshold, 0.85));
  return { handoffThreshold, hardHandoffThreshold };
}

export function operationSupervisorInitializationTimeoutSeconds(config: HarnessProjectConfig): number {
  const orchestration = config.orchestration as (HarnessProjectConfig["orchestration"] & SupervisionConfigExtension) | undefined;
  const value = orchestration?.operations?.supervision?.initializationTimeoutSeconds;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_SUPERVISOR_INITIALIZATION_TIMEOUT_SECONDS;
}

function supervisorInitializationConfig(config: HarnessProjectConfig): HarnessProjectConfig {
  if (!config.orchestration) return config;
  return {
    ...config,
    orchestration: {
      ...config.orchestration,
      worker: {
        ...config.orchestration.worker,
        timeoutSeconds: operationSupervisorInitializationTimeoutSeconds(config)
      }
    }
  };
}

export async function ensureOperationSupervisor(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  topology: ResolvedAgentTopology,
  options: EnsureSupervisorOptions = {}
): Promise<OperationSupervisorHandle | undefined> {
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
    const materialized = await materializeAgentPrompt(root, config, contract, selection, {
      phase: "supervision",
      operationKind: operation.kind,
      parentAgentId: operation.lead?.agentId,
      supervisorAgent: true
    });
    if (!materialized?.id) {
      lastError = "Paseo SDK did not materialize a persistent supervisor session";
      break;
    }

    operation = await registerSupervisorGeneration(stateRoot, operationId, {
      agentId: materialized.id,
      materialized: true,
      status: "INITIALIZING",
      initializationAttempt: attempt
    });
    const generation = [...operation.supervision.generations].reverse().find((item) => item.agentId === materialized.id && item.status === "INITIALIZING")?.generation;
    if (!generation) throw new Error("AEH_OPERATION_SUPERVISOR_STATE: materialized supervisor generation was not durably registered as INITIALIZING.");
    await recordPaseoTrace(stateRoot, "operation.supervisor.materialized", {
      operationId, generation, agentId: materialized.id, revision: operation.revision, attempt, status: "INITIALIZING"
    });

    try {
      operation = await updateSupervisorGeneration(stateRoot, operationId, generation, {
        initializationDispatchedAt: new Date().toISOString(),
        error: undefined
      });
      const session = await dispatchMaterializedAgentPrompt(
        root,
        supervisorInitializationConfig(config),
        contract,
        selection,
        materialized,
        supervisorInitializationPrompt(operation),
        {
          phase: "supervision",
          operationKind: operation.kind,
          parentAgentId: operation.lead?.agentId,
          supervisorAgent: true
        }
      );
      if (session.exitCode !== 0 || !session.id) throw new Error(session.stderr || session.stdout || `exit ${session.exitCode}`);
      const completedAt = new Date().toISOString();
      const activated = await updateSupervisorGeneration(stateRoot, operationId, generation, {
        status: "ACTIVE",
        activatedAt: completedAt,
        initializationCompletedAt: completedAt,
        initializationEvidence: session.transport?.includes("paseo") ? "paseo-sdk-turn-barrier" : "turn-barrier",
        error: undefined
      });
      if (activated.supervision.activeGeneration !== generation) throw new Error("AEH_OPERATION_SUPERVISOR_STATE: initialized supervisor did not become the active generation.");
      await recordPaseoTrace(stateRoot, "operation.supervisor.initialized", {
        operationId, generation, agentId: session.id, revision: activated.revision, attempt,
        timeoutSeconds: operationSupervisorInitializationTimeoutSeconds(config),
        evidence: "turn-barrier"
      });
      return { operationId, generation, agentId: session.id, materialized: true, selection, session };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await updateSupervisorGeneration(stateRoot, operationId, generation, {
        status: "FAILED",
        error: `initialization failed: ${lastError}`
      }).catch(() => undefined);
      await archivePaseoSdkAgent(root, materialized.id).catch(() => undefined);
      await recordPaseoTrace(stateRoot, "operation.supervisor.initialization-failed", {
        operationId, generation, agentId: materialized.id, attempt, error: lastError,
        timeoutSeconds: operationSupervisorInitializationTimeoutSeconds(config)
      }).catch(() => undefined);
    }
  }

  throw new Error(`AEH_OPERATION_SUPERVISOR_UNAVAILABLE: initialization failed after ${SUPERVISOR_INITIALIZATION_ATTEMPTS} bounded attempt(s): ${lastError ?? "unknown error"}`);
}

export async function consolidateWithOperationSupervisor(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  topology: ResolvedAgentTopology,
  input: SupervisorConsolidationInput
): Promise<SupervisorConsolidationResult> {
  const stateRoot = resolveOperationStateRoot(root);
  const supervisor = await ensureOperationSupervisor(root, config, contract, topology, { required: true, forceMaterialize: true });
  if (!supervisor?.agentId) throw new Error("AEH_OPERATION_SUPERVISOR_UNAVAILABLE: semantic consolidation requires a materialized supervisor session.");
  const rawIds = [...new Set(input.findings.map((finding) => finding.id))].sort();
  const operation = await loadOperation(stateRoot, supervisor.operationId);
  const generation = activeOperationSupervisor(operation);
  const prompt = [
    `Consolidate ${input.purpose} for operation ${supervisor.operationId}.`,
    "You are the semantic operation supervisor, not the deterministic lifecycle authority.",
    `Durable operation state: ${JSON.stringify(supervisorDurableSnapshot(operation))}`,
    `Generation checkpoint artifact: ${generation?.checkpointArtifact ?? "none"}. When present, use it plus OperationRecord as continuity authority instead of transcript replay.`,
    "Every raw finding below must be accounted for in sourceFindingIds at set level. You may merge semantic duplicates, but never invent source evidence or silently drop a source finding.",
    "Do not change deterministic validation outcomes. Surface conflicts and missing evidence explicitly.",
    `Source artifacts: ${JSON.stringify(input.sourceArtifacts ?? [])}`,
    `Deterministic evidence: ${JSON.stringify(input.deterministicEvidence ?? null)}`,
    `Raw findings: ${JSON.stringify(input.findings)}`,
    "Return the supervisor output contract."
  ].join("\n\n");
  const session = await executeAgentPrompt(root, config, contract, supervisor.selection, prompt, {
    outputContract: "supervisor", resumeSessionId: supervisor.agentId, phase: "consolidating", operationKind: operation.kind, supervisorAgent: true
  });
  if (session.exitCode !== 0) throw new Error(`AEH_OPERATION_SUPERVISOR_FAILED: supervisor exited with ${session.exitCode}: ${session.stderr || session.stdout}`);
  let output: SupervisorOutput;
  try { output = supervisorOutputSchema.parse(extractMarkedJson(session.stdout, session.stderr)); }
  catch (error) { throw new Error(`AEH_OPERATION_SUPERVISOR_CONTRACT: ${String(error)}`); }
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
  const latest = await loadOperation(stateRoot, operationId);
  const materialized = await materializeAgentPrompt(root, config, contract, selection, { phase: "supervision", operationKind: operation.kind, parentAgentId: operation.lead?.agentId, supervisorAgent: true });
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
    const session = await dispatchMaterializedAgentPrompt(root, supervisorInitializationConfig(config), contract, selection, materialized, supervisorInitializationPrompt(latest, checkpointArtifact), { phase: "supervision", operationKind: operation.kind, parentAgentId: operation.lead?.agentId, supervisorAgent: true });
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

function supervisorInitializationPrompt(operation: OperationRecordV2, checkpointArtifact?: string): string {
  return [
    "Initialize this AEH Operation Supervisor generation from durable state.",
    `OperationRecord snapshot: ${JSON.stringify(supervisorDurableSnapshot(operation))}`,
    `Continuity checkpoint: ${checkpointArtifact ?? "none"}`,
    "Own operation-local semantic coordination and consolidation only. The deterministic controller/OperationRecord owns lifecycle, participant completion, validation, rollback, gates and terminal status.",
    "Child notifications are wake signals; reason from OperationRecord/artifacts rather than treating notification text as authoritative.",
    "Do not start another AEH operation or contact the user directly. True product/external decisions belong to the bound lead.",
    "This is an internal initialization turn. Acknowledge compactly and become idle; do not create children yet."
  ].join("\n\n");
}

function supervisorDurableSnapshot(operation: OperationRecordV2): Record<string, unknown> {
  return {
    operationId: operation.id, kind: operation.kind, revision: operation.revision, phase: operation.phase, status: operation.status,
    intent: operation.intent,
    lead: operation.lead ? { generation: operation.lead.generation, acknowledgedRevision: operation.lead.acknowledgedRevision } : undefined,
    stages: operation.stages, progress: operation.progress,
    latestConsolidationArtifact: operation.supervision.latestConsolidationArtifact,
    activeSupervisorGeneration: operation.supervision.activeGeneration,
    initializingSupervisorGeneration: initializingOperationSupervisor(operation)?.generation,
    unresolvedParticipants: Object.values(operation.participants)
      .filter((participant) => !["COMPLETED", "FAILED", "CANCELLED"].includes(participant.status))
      .map((participant) => ({ id: participant.id, logicalAgent: participant.logicalAgent, role: participant.role, stage: participant.stage, status: participant.status, parentSupervisorGeneration: participant.parentSupervisorGeneration, resultArtifact: participant.resultArtifact }))
  };
}
function buildSupervisorCheckpoint(operation: OperationRecordV2, contextRatio?: number): Record<string, unknown> { return { ...supervisorDurableSnapshot(operation), contextRatio, instruction: "Resume semantic supervision from this durable checkpoint and OperationRecord. Do not request transcript replay from the draining supervisor." }; }
function ratio(value: number | undefined, fallback: number): number { return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback; }
