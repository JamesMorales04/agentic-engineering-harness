import { resolveAttemptChainSupersedeV1, resolveCandidateLineageReceiptV1, type CandidateRevisionV1 } from "./v2Contracts.js";
import type { OperationParticipantStatus, OperationRecordV2 } from "./state.js";

export type ObjectiveParticipantAccountingEntryV1 = {
  id: string;
  required: boolean;
  status: OperationParticipantStatus;
  /** In-chain retry identity whose lineage-proven COMPLETED receipt supersedes this attempt (AEH-V2-0133). Present only on superseded attempts. */
  supersededBy?: string;
};

/**
 * Objective-completion participant accounting. Controller-issued participant identities
 * (`participant:<digest>`) are resumable launch identities whose live status is deliberately not
 * flipped by `recordParticipantReceipt` (AEH-V2-0089), so their bounded-work completion is proven
 * by the same durable settled receipt the successful-terminal gate consumes. A receipt that binds
 * the candidate the work observed is accepted directly, or through the deterministic assembly
 * receipt chain that proves its bounded work produced the current candidate (AEH-V2-0106).
 * A participant with no current or lineage-proven receipt keeps its live status and fails closed.
 *
 * Attempt-chain resolution (AEH-V2-0133, DETERMINISTIC): a FAILED attempt identity with no receipt
 * of its own is superseded — reported COMPLETED with `supersededBy` naming the retry identity —
 * when a descendant identity in the same retry chain carries a lineage-proven COMPLETED receipt.
 * The chain tip (no descendant) and identities outside every chain keep their live FAILED status.
 *
 * This derivation is the single deterministic source for both objective completion (producer) and
 * the successful-terminal snapshot check (verifier); a completion snapshot that disagrees with it
 * is stale and rejected.
 */
export function objectiveParticipantAccountingV1(operation: OperationRecordV2, candidate: CandidateRevisionV1): ObjectiveParticipantAccountingEntryV1[] {
  const receipts = Object.values(operation.participantReceipts ?? {});
  const assemblies = Object.values(operation.candidateAssemblyReceipts ?? {});
  return Object.values(operation.participants).map((participant) => {
    const live = participant.status;
    // A settled receipt for current or lineage-proven bounded work is the authoritative completion
    // evidence even when the resumable launch identity carries a transient live FAILED state from an
    // earlier attempt; the receipt is only accepted when the deterministic lineage resolver proves
    // it (AEH-V2-0124). No receipt falls back to the live status and fails closed.
    const receipt = receipts.find((entry) => (entry.participantId === participant.id || entry.sessionId === participant.id)
      && entry.settled === true && entry.candidate !== undefined
      && resolveCandidateLineageReceiptV1({ receipt: entry, current: candidate, assemblies }) !== undefined);
    if (receipt) return { id: participant.id, required: true, status: receipt.outcome === "SUCCEEDED" ? "COMPLETED" : receipt.outcome === "FAILED" ? "FAILED" : "CANCELLED" };
    // A superseded FAILED attempt never blocks the chain: only the latest identity in its retry
    // chain may fail the objective. Unknown or forged identities (no chain edge, no proven retry
    // receipt) fall through to the live status and stay failed.
    if (live === "FAILED") {
      const supersede = resolveAttemptChainSupersedeV1({
        participantId: participant.id,
        participants: operation.participants,
        receipts,
        current: candidate,
        assemblies
      });
      if (supersede) return { id: participant.id, required: true, status: "COMPLETED", supersededBy: supersede.supersededBy };
    }
    return { id: participant.id, required: true, status: live };
  });
}
