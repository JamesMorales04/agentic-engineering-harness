import { readManagedRuntimeSnapshot } from "../runtime/managed.js";
import { loadOperation, type OperationPauseDrainReceiptV1 } from "./state.js";

/**
 * Deterministic drain evidence for a controller-owned PAUSE. A writer is active
 * while a participant is RUNNING or a provider lease still reports ACTIVE or
 * UNCERTAIN; only observed quiescence produces an empty receipt.
 */
export async function computeOperationDrainReceipt(root: string, operationId: string): Promise<OperationPauseDrainReceiptV1> {
  const record = await loadOperation(root, operationId);
  const activeParticipantIds = Object.values(record.participants)
    .filter((participant) => participant.status === "RUNNING")
    .map((participant) => participant.id)
    .sort();
  const snapshot = await readManagedRuntimeSnapshot(root).catch(() => undefined);
  const activeProviderLeaseIds = (snapshot?.providerLeases ?? [])
    .filter((lease) => lease.lifecycle?.operationId === operationId
      && (lease.lifecycle.providerStatus === "ACTIVE" || lease.lifecycle.providerStatus === "UNCERTAIN"))
    .map((lease) => lease.leaseId)
    .sort();
  return { activeParticipantIds, activeProviderLeaseIds, observedAt: new Date().toISOString() };
}

/** Wait, bounded, for all active mutable writers to settle before PAUSED. */
export async function drainOperationWriters(
  root: string,
  operationId: string,
  options: { timeoutMs?: number; pollMs?: number } = {}
): Promise<OperationPauseDrainReceiptV1> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pollMs = options.pollMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const receipt = await computeOperationDrainReceipt(root, operationId);
    if (!receipt.activeParticipantIds.length && !receipt.activeProviderLeaseIds.length) return receipt;
    if (Date.now() >= deadline) return receipt;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export function drainReceiptIsQuiescent(receipt: OperationPauseDrainReceiptV1): boolean {
  return receipt.activeParticipantIds.length === 0 && receipt.activeProviderLeaseIds.length === 0;
}
