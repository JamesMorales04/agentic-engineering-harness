import type { ActionReconciliationResultV1 } from "./actionReconciliation.js";
import { type ActionIntentV1, type ActionReceiptV1, type ToolActionRequestV1 } from "./toolActionGate.js";
/**
 * Deterministic orchestration of one gated side effect:
 * ActionRequest -> authority -> ToolActionGate -> durable ActionIntent ->
 * side effect -> durable ActionReceipt, with explicit reconciliation when a
 * prior intent has no receipt. The executor must not mutate external state
 * itself; it is invoked only after the intent is durable.
 *
 * An exception from `execute` is an uncertain effect: the side effect may
 * already have happened. The durable intent is then reconciled against
 * observable state through the caller-supplied reconciliation
 * callback, and `execute` is never invoked again for that intent. Only an
 * observed SUCCEEDED or FAILED outcome is persisted as a reconciled receipt;
 * UNKNOWN, HUMAN_REQUIRED, or a failing reconciliation leaves the intent
 * unresolved for a later retry to reconcile.
 */
export type GatedActionStatusV1 = "EXECUTED" | "ALREADY_COMPLETED" | "RECONCILED" | "RECONCILIATION_REQUIRED" | "HUMAN_REQUIRED";
export interface GatedActionResultV1 {
    status: GatedActionStatusV1;
    intent: ActionIntentV1;
    receipt?: ActionReceiptV1;
    reconciliation?: ActionReconciliationResultV1;
    detail: string;
}
export declare function executeGatedAction(input: {
    root: string;
    request: ToolActionRequestV1;
    execute: (intent: ActionIntentV1) => Promise<{
        outcome: "SUCCEEDED" | "FAILED";
        evidence: unknown;
    }>;
    reconcile: (intent: ActionIntentV1) => Promise<ActionReconciliationResultV1>;
    now?: Date;
}): Promise<GatedActionResultV1>;
