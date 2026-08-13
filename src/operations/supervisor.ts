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
import { executeAgentPrompt, materializeAgentPrompt } from "../workers/agentPrompt.js";
import { persistOperationConsolidation, persistSupervisorCheckpoint } from "./artifacts.js";
import {
  activeOperationSupervisor,
  currentOperationContext,
  loadOperation,
  patchOperation,
  registerSupervisorGeneration,
  resolveOperationStateRoot,
  updateSupervisorGeneration,
  type OperationRecordV2
} from "./state.js";

export interface EnsureSupervisorOptions {
  required?: boolean;
  forceMaterialize?: boolean;
}

export interface OperationSupervisorHandle {
  operationId: string;
  generation: number;
  agentId?: string;
  materialized: boolean;
  selection: AgentExecutionSelection;
  session?: WorkerSession;
}

export interface SupervisorConsolidationInput {
  key: string;
  purpose: string;
  findings: NormalizedFinding[];
  sourceArtifacts?: string[];
  deterministicEvidence?: unknown;
}

export interface SupervisorConsolidationResult {
  output: SupervisorOutput;
  artifact: string;
  session: WorkerSession;
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
    if (required) {
      throw new Error(
        "AEH_OPERATION_SUPERVISOR_REQUIRED: topology has no enabled operation-supervisor agent."
      );
    }
    return undefined;
  }
  const selection = executionSelectionForAgent(topology, "operation-supervisor");
  const active = activeOperationSupervisor(operation);
  if (active?.agentId) {
    return {
      operationId,
      generation: active.generation,
      agentId: active.agentId,
      materialized: true,
      selection
    };
  }

  const session = await materializeAgentPrompt(root, config, contract, selection, {
    outputContract: "supervisor",
    phase: "supervision",
    operationKind: operation.kind,
    parentAgentId: operation.lead?.agentId,
    supervisorAgent: true
  });
  operation = await registerSupervisorGeneration(stateRoot, operationId, {
    agentId: session?.id,
    materialized: Boolean(session?.id)
  });
  const generation = operation.supervision.activeGeneration!;
  return {
    operationId,
    generation,
    agentId: session?.id,
    materialized: Boolean(session?.id),
    selection,
    session
  };
}

export async function consolidateWithOperationSupervisor(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  topology: ResolvedAgentTopology,
  input: SupervisorConsolidationInput
): Promise<SupervisorConsolidationResult> {
  const stateRoot = resolveOperationStateRoot(root);
  const supervisor = await ensureOperationSupervisor(root, config, contract, topology, {
    required: true,
    forceMaterialize: true
  });
  if (!supervisor?.agentId) {
    throw new Error(
      "AEH_OPERATION_SUPERVISOR_UNAVAILABLE: semantic consolidation requires a materialized supervisor session."
    );
  }
  const rawIds = [...new Set(input.findings.map((finding) => finding.id))].sort();
  const prompt = [
    `Consolidate ${input.purpose} for operation ${supervisor.operationId}.`,
    "You are the semantic operation supervisor, not the deterministic lifecycle authority.",
    "Every raw finding below must be accounted for in sourceFindingIds at set level. You may merge semantic duplicates, but never invent source evidence or silently drop a source finding.",
    "Do not change deterministic validation outcomes. Surface conflicts and missing evidence explicitly.",
    `Source artifacts: ${JSON.stringify(input.sourceArtifacts ?? [])}`,
    `Deterministic evidence: ${JSON.stringify(input.deterministicEvidence ?? null)}`,
    `Raw findings: ${JSON.stringify(input.findings)}`,
    "Return the supervisor output contract."
  ].join("\n\n");
  const operation = await loadOperation(stateRoot, supervisor.operationId);
  const session = await executeAgentPrompt(
    root,
    config,
    contract,
    supervisor.selection,
    prompt,
    {
      outputContract: "supervisor",
      resumeSessionId: supervisor.agentId,
      phase: "consolidating",
      operationKind: operation.kind,
      supervisorAgent: true
    }
  );
  if (session.exitCode !== 0) {
    throw new Error(
      `AEH_OPERATION_SUPERVISOR_FAILED: supervisor exited with ${session.exitCode}: ${session.stderr || session.stdout}`
    );
  }
  let output: SupervisorOutput;
  try {
    output = supervisorOutputSchema.parse(extractMarkedJson(session.stdout, session.stderr));
  } catch (error) {
    throw new Error(`AEH_OPERATION_SUPERVISOR_CONTRACT: ${String(error)}`);
  }
  const sourceIds = [...new Set(output.sourceFindingIds)].sort();
  if (sourceIds.length !== rawIds.length || sourceIds.some((id, index) => id !== rawIds[index])) {
    throw new Error(
      `AEH_OPERATION_SUPERVISOR_PROVENANCE: consolidation did not account for the exact raw finding set. expected=${rawIds.join(",")} received=${sourceIds.join(",")}`
    );
  }
  const artifact = await persistOperationConsolidation(stateRoot, supervisor.operationId, input.key, {
    generation: supervisor.generation,
    sourceArtifacts: input.sourceArtifacts ?? [],
    rawFindingIds: rawIds,
    output
  });
  const current = await loadOperation(stateRoot, supervisor.operationId);
  await patchOperation(stateRoot, supervisor.operationId, {
    supervision: {
      ...current.supervision,
      latestConsolidationRevision: current.revision + 1,
      latestConsolidationArtifact: artifact
    }
  });
  return { output, artifact, session };
}

export async function maybeRotateOperationSupervisor(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  topology: ResolvedAgentTopology
): Promise<OperationSupervisorHandle | undefined> {
  const operationId = currentOperationContext().id;
  if (!operationId) return undefined;
  const stateRoot = resolveOperationStateRoot(root);
  const operation = await loadOperation(stateRoot, operationId);
  const active = activeOperationSupervisor(operation);
  if (!active?.agentId) {
    return ensureOperationSupervisor(root, config, contract, topology, {
      required: operation.supervision.required
    });
  }

  const context = await statusLeadContext(root, config, active.agentId);
  if (context.state !== "HANDOFF_REQUIRED" && context.state !== "HARD_HANDOFF") {
    if (context.usage.ratio !== undefined) {
      await updateSupervisorGeneration(stateRoot, operationId, active.generation, {
        contextRatio: context.usage.ratio,
        error: undefined
      });
    }
    return {
      operationId,
      generation: active.generation,
      agentId: active.agentId,
      materialized: true,
      selection: executionSelectionForAgent(topology, "operation-supervisor")
    };
  }

  const checkpointArtifact = await persistSupervisorCheckpoint(
    stateRoot,
    operationId,
    active.generation,
    buildSupervisorCheckpoint(operation, context.usage.ratio)
  );
  await updateSupervisorGeneration(stateRoot, operationId, active.generation, {
    status: "DRAINING",
    drainingAt: new Date().toISOString(),
    checkpointArtifact,
    contextRatio: context.usage.ratio,
    error: undefined
  });

  // Existing children intentionally remain attached to the draining generation.
  // The new active generation receives every new child and restores semantic
  // context from durable state/checkpoint rather than transcript replay.
  const selection = executionSelectionForAgent(topology, "operation-supervisor");
  const session = await materializeAgentPrompt(root, config, contract, selection, {
    outputContract: "supervisor",
    phase: "supervision",
    operationKind: operation.kind,
    parentAgentId: operation.lead?.agentId,
    supervisorAgent: true
  });
  const next = await registerSupervisorGeneration(stateRoot, operationId, {
    agentId: session?.id,
    materialized: Boolean(session?.id),
    checkpointArtifact
  });
  await recordPaseoTrace(stateRoot, "operation.supervisor.rotated", {
    operationId,
    fromGeneration: active.generation,
    fromAgentId: active.agentId,
    toGeneration: next.supervision.activeGeneration ?? 0,
    toAgentId: session?.id ?? "",
    contextRatio: context.usage.ratio ?? -1,
    checkpointArtifact
  });
  return {
    operationId,
    generation: next.supervision.activeGeneration!,
    agentId: session?.id,
    materialized: Boolean(session?.id),
    selection,
    session
  };
}

export async function settleDrainingSupervisorGenerations(
  root: string,
  operationId: string
): Promise<OperationRecordV2> {
  const stateRoot = resolveOperationStateRoot(root);
  let record = await loadOperation(stateRoot, operationId);
  for (const generation of record.supervision.generations.filter(
    (item) => item.status === "DRAINING"
  )) {
    const unsettled = Object.values(record.participants).some(
      (participant) =>
        participant.parentSupervisorGeneration === generation.generation &&
        !["COMPLETED", "FAILED", "CANCELLED"].includes(participant.status)
    );
    if (unsettled) continue;

    if (generation.agentId) {
      try {
        await archivePaseoSdkAgent(root, generation.agentId);
        await recordPaseoTrace(stateRoot, "operation.supervisor.archived", {
          operationId,
          generation: generation.generation,
          agentId: generation.agentId
        });
      } catch (error) {
        record = await updateSupervisorGeneration(stateRoot, operationId, generation.generation, {
          error: error instanceof Error ? error.message : String(error)
        });
        await recordPaseoTrace(stateRoot, "operation.supervisor.archive-failed", {
          operationId,
          generation: generation.generation,
          agentId: generation.agentId,
          error: error instanceof Error ? error.message : String(error)
        });
        continue;
      }
    }
    record = await updateSupervisorGeneration(stateRoot, operationId, generation.generation, {
      status: "ARCHIVED",
      archivedAt: new Date().toISOString(),
      error: undefined
    });
  }
  return record;
}

function buildSupervisorCheckpoint(
  operation: OperationRecordV2,
  contextRatio?: number
): Record<string, unknown> {
  return {
    operationId: operation.id,
    revision: operation.revision,
    phase: operation.phase,
    status: operation.status,
    contextRatio,
    intent: operation.intent,
    stages: operation.stages,
    progress: operation.progress,
    latestConsolidationArtifact: operation.supervision.latestConsolidationArtifact,
    unresolvedParticipants: Object.values(operation.participants)
      .filter(
        (participant) =>
          !["COMPLETED", "FAILED", "CANCELLED"].includes(participant.status)
      )
      .map((participant) => ({
        id: participant.id,
        logicalAgent: participant.logicalAgent,
        role: participant.role,
        stage: participant.stage,
        status: participant.status,
        resultArtifact: participant.resultArtifact
      })),
    instruction:
      "Resume semantic supervision from this durable checkpoint and OperationRecord. Do not request transcript replay from the draining supervisor."
  };
}
