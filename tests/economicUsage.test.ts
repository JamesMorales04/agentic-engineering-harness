import { describe, expect, it } from "vitest";
import { remainingEconomicEnvelopeForRecoveryV1, type OperationEconomicUsageSnapshotV1 } from "../src/operations/economicUsage.js";
import type { EconomicEnvelopeV1 } from "../src/operations/executionLiveness.js";

function usage(input: Partial<OperationEconomicUsageSnapshotV1> = {}): OperationEconomicUsageSnapshotV1 {
  const body = {
    version: 1 as const,
    operationId: "CHANGE-PARENT",
    providerTurnsPerParticipant: [{ participantId: "implementer", generation: "g1", observed: 5 }],
    toolCalls: { observed: 12, coverage: "COMPLETE" as const },
    tokens: { observed: 40, coverage: "COMPLETE" as const },
    costUsd: { observed: 2.5, coverage: "COMPLETE" as const },
    providerUsageEvidence: [] as Array<{ participantId: string; generation: string | null; observationId: string }>,
    economicEvidenceDigest: "a".repeat(64),
    ...input
  };
  return { ...body, digest: "b".repeat(64) };
}

describe("failed-operation economic continuation envelope", () => {
  it("subtracts proven parent usage before issuing a linked child envelope", () => {
    const parent: EconomicEnvelopeV1 = {
      version: 1, initialProviderTurns: 8, supervisorProviderTurns: 12, hardProviderTurns: 16,
      maxLocalRetries: 1, maxParticipantRestarts: 2, softThreshold: 0.8,
      hardToolCalls: 50, hardTotalTokens: 100, hardCostUsd: 10
    };
    const remaining = remainingEconomicEnvelopeForRecoveryV1(parent, usage());
    expect(remaining).toMatchObject({ hardToolCalls: 38, hardTotalTokens: 60, hardCostUsd: 7.5, hardProviderTurns: 16 });
    const grandchild = remainingEconomicEnvelopeForRecoveryV1(remaining, usage({
      operationId: "CHANGE-CHILD",
      toolCalls: { observed: 10, coverage: "COMPLETE" },
      tokens: { observed: 20, coverage: "COMPLETE" },
      costUsd: { observed: 1, coverage: "COMPLETE" }
    }));
    expect(grandchild).toMatchObject({ hardToolCalls: 28, hardTotalTokens: 40, hardCostUsd: 6.5 });
  });

  it("fails closed when a configured parent ceiling has unknown usage or no remaining authority", () => {
    const parent: EconomicEnvelopeV1 = {
      version: 1, initialProviderTurns: 1, supervisorProviderTurns: 1, hardProviderTurns: 2,
      maxLocalRetries: 1, maxParticipantRestarts: 1, softThreshold: 0.8, hardTotalTokens: 100
    };
    expect(() => remainingEconomicEnvelopeForRecoveryV1(parent, usage({ tokens: { observed: null, coverage: "UNKNOWN" } })))
      .toThrow(/OPERATION_RECOVERY_OWNER_BOUNDARY_REQUIRED/);
    expect(() => remainingEconomicEnvelopeForRecoveryV1(parent, usage({ tokens: { observed: 100, coverage: "COMPLETE" } })))
      .toThrow(/OPERATION_RECOVERY_OWNER_BOUNDARY_REQUIRED/);
  });
});
