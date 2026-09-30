import { type OperationPauseDrainReceiptV1 } from "./state.js";
/**
 * Deterministic drain evidence for a controller-owned PAUSE. A writer is active
 * while a participant is RUNNING or a provider lease still reports ACTIVE or
 * UNCERTAIN; only observed quiescence produces an empty receipt.
 */
export declare function computeOperationDrainReceipt(root: string, operationId: string): Promise<OperationPauseDrainReceiptV1>;
/** Wait, bounded, for all active mutable writers to settle before PAUSED. */
export declare function drainOperationWriters(root: string, operationId: string, options?: {
    timeoutMs?: number;
    pollMs?: number;
}): Promise<OperationPauseDrainReceiptV1>;
export declare function drainReceiptIsQuiescent(receipt: OperationPauseDrainReceiptV1): boolean;
