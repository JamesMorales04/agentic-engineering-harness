import { sha256Canonical } from "../core/digest.js";
import type { EconomicEnvelopeV1 } from "./executionLiveness.js";
import type { OperationRecordV2 } from "./state.js";
import { createTrustedOperationToolError } from "./toolDiagnostics.js";

export interface OperationEconomicUsageSnapshotV1 {
  version: 1;
  operationId: string;
  providerTurnsPerParticipant: Array<{ participantId: string; generation: string; observed: number }>;
  toolCalls: { observed: number | null; coverage: "COMPLETE" | "UNKNOWN" };
  tokens: { observed: number | null; coverage: "COMPLETE" | "PARTIAL" | "UNKNOWN" };
  costUsd: { observed: number | null; coverage: "COMPLETE" | "PARTIAL" | "UNKNOWN" };
  providerUsageEvidence: Array<{ participantId: string; generation: string | null; observationId: string }>;
  economicEvidenceDigest: string;
  digest: string;
}

/** Deterministic, provider-grounded cumulative usage snapshot for recovery lineage. */
export async function collectOperationEconomicUsageV1(root: string, operation: OperationRecordV2): Promise<OperationEconomicUsageSnapshotV1> {
  const { readOperationEfficiencyObservations, summarizeOperationEfficiencyV2 } = await import("../telemetry/efficiency.js");
  const observations = await readOperationEfficiencyObservations(root, operation.id);
  const summary = summarizeOperationEfficiencyV2(operation, observations, operation.finishedAt ?? operation.updatedAt);
  const providerUsageEvidence = observations.participants.map((item) => ({ participantId: item.participantId, generation: item.generation, observationId: item.observationId }))
    .sort((left, right) => left.participantId.localeCompare(right.participantId) || String(left.generation).localeCompare(String(right.generation)) || left.observationId.localeCompare(right.observationId));
  const participants = Object.values(operation.participants);
  const providerTurnsPerParticipant = participants.flatMap((participant) => participant.executionBinding && participant.executionLiveness
    ? [{ participantId: participant.id, generation: participant.executionBinding.participantGeneration, observed: participant.executionLiveness.providerTurns }]
    : []).sort((left, right) => left.participantId.localeCompare(right.participantId) || left.generation.localeCompare(right.generation));
  const toolCalls = participants.length === 0
    ? { observed: 0, coverage: "COMPLETE" as const }
    : { observed: summary.budgets.toolCalls.observed, coverage: summary.budgets.toolCalls.observed === null ? "UNKNOWN" as const : "COMPLETE" as const };
  const tokens = { observed: summary.budgets.tokenUsage.observed, coverage: summary.budgets.tokenUsage.coverage };
  const costUsd = { observed: summary.budgets.cost.observedUsd, coverage: summary.budgets.cost.coverage };
  const body = {
    version: 1 as const,
    operationId: operation.id,
    providerTurnsPerParticipant,
    toolCalls,
    tokens,
    costUsd,
    providerUsageEvidence,
    economicEvidenceDigest: sha256Canonical({ providerTurnsPerParticipant, toolCalls, tokens, costUsd, providerUsageEvidence })
  };
  return { ...body, digest: sha256Canonical(body) };
}

/** Shrink inherited operation-wide ceilings by already observed parent usage. */
export function remainingEconomicEnvelopeForRecoveryV1(envelope: EconomicEnvelopeV1, usage: OperationEconomicUsageSnapshotV1): EconomicEnvelopeV1 {
  const remaining = { ...envelope };
  if (envelope.hardToolCalls !== undefined) {
    if (usage.toolCalls.coverage !== "COMPLETE" || usage.toolCalls.observed === null) throw createTrustedOperationToolError("OPERATION_RECOVERY_OWNER_BOUNDARY_REQUIRED", "Parent tool-call usage is incomplete under a configured Owner hard ceiling.", undefined, usage.operationId);
    const value = envelope.hardToolCalls - usage.toolCalls.observed;
    if (value <= 0) throw createTrustedOperationToolError("OPERATION_RECOVERY_OWNER_BOUNDARY_REQUIRED", "No Owner-authorized hard tool-call budget remains after the failed parent.", undefined, usage.operationId);
    remaining.hardToolCalls = value;
  }
  if (envelope.hardTotalTokens !== undefined) {
    if (usage.tokens.coverage !== "COMPLETE" || usage.tokens.observed === null) throw createTrustedOperationToolError("OPERATION_RECOVERY_OWNER_BOUNDARY_REQUIRED", "Parent provider token usage is incomplete under a configured Owner hard ceiling.", undefined, usage.operationId);
    const value = envelope.hardTotalTokens - usage.tokens.observed;
    if (value <= 0) throw createTrustedOperationToolError("OPERATION_RECOVERY_OWNER_BOUNDARY_REQUIRED", "No Owner-authorized hard token budget remains after the failed parent.", undefined, usage.operationId);
    remaining.hardTotalTokens = value;
  }
  if (envelope.hardCostUsd !== undefined) {
    if (usage.costUsd.coverage !== "COMPLETE" || usage.costUsd.observed === null) throw createTrustedOperationToolError("OPERATION_RECOVERY_OWNER_BOUNDARY_REQUIRED", "Parent provider cost usage is incomplete under a configured Owner hard ceiling.", undefined, usage.operationId);
    const value = envelope.hardCostUsd - usage.costUsd.observed;
    if (value <= 0) throw createTrustedOperationToolError("OPERATION_RECOVERY_OWNER_BOUNDARY_REQUIRED", "No Owner-authorized hard USD budget remains after the failed parent.", undefined, usage.operationId);
    remaining.hardCostUsd = value;
  }
  return remaining;
}
