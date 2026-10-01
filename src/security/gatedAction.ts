import type { ActionReconciliationResultV1 } from "./actionReconciliation.js";
import { reconciliationReceiptOutcome } from "./actionReconciliation.js";
import { authorizeToolAction, loadActionIntent, recordReconciledToolActionReceipt, recordToolActionReceipt, type ActionIntentV1, type ActionReceiptV1, type ToolActionRequestV1 } from "./toolActionGate.js";

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

export async function executeGatedAction(input: {
  root: string;
  request: ToolActionRequestV1;
  execute: (intent: ActionIntentV1) => Promise<{ outcome: "SUCCEEDED" | "FAILED"; evidence: unknown }>;
  reconcile: (intent: ActionIntentV1) => Promise<ActionReconciliationResultV1>;
  now?: Date;
}): Promise<GatedActionResultV1> {
  let authorization;
  try {
    authorization = await authorizeToolAction(input.request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("TOOL_ACTION_RECONCILIATION_REQUIRED")) throw error;
    const intent = await loadActionIntent(input.root, input.request.operationId, input.request.actionKey);
    if (!intent) throw error;
    return reconcileUnresolvedIntent(input, intent, message);
  }

  if (authorization.decision === "ALREADY_COMPLETED") {
    return { status: "ALREADY_COMPLETED", intent: authorization.intent, receipt: authorization.receipt, detail: "The action already has a durable receipt for this exact request." };
  }

  let result: { outcome: "SUCCEEDED" | "FAILED"; evidence: unknown };
  try {
    result = await input.execute(authorization.intent);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reconcileUnresolvedIntent(input, authorization.intent, `the executor threw before the effect was confirmed (${message})`);
  }
  const receipt = await recordToolActionReceipt(input.root, authorization.intent, result.outcome, result.evidence, input.now);
  return { status: "EXECUTED", intent: authorization.intent, receipt, detail: result.outcome === "SUCCEEDED" ? "Side effect executed and receipt persisted." : "Side effect failed deterministically and the failure receipt was persisted." };
}

/**
 * Observation-only resolution of an intent whose effect is uncertain.
 *
 * Decision mechanism: DETERMINISTIC. This function never performs the effect.
 * It invokes the reconciliation port exactly once, persists a reconciled
 * receipt only for an observed SUCCEEDED/FAILED outcome, and leaves the intent
 * unresolved for a later observation on UNKNOWN, HUMAN_REQUIRED or a
 * reconciliation error.
 */
async function reconcileUnresolvedIntent(input: {
  root: string;
  reconcile: (intent: ActionIntentV1) => Promise<ActionReconciliationResultV1>;
  now?: Date;
},
  intent: ActionIntentV1,
  reason: string
): Promise<GatedActionResultV1> {
  let reconciliation: ActionReconciliationResultV1;
  try {
    reconciliation = await input.reconcile(intent);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "RECONCILIATION_REQUIRED", intent, detail: `${reason}; reconciliation could not observe state (${message}), so the intent remains unresolved.` };
  }
  const outcome = reconciliationReceiptOutcome(reconciliation);
  if (!outcome) {
    return {
      status: reconciliation.outcome === "HUMAN_REQUIRED" ? "HUMAN_REQUIRED" : "RECONCILIATION_REQUIRED",
      intent,
      reconciliation,
      detail: reconciliation.detail
    };
  }
  const receipt = await recordReconciledToolActionReceipt(input.root, intent, outcome, reconciliation.evidence, input.now);
  return { status: "RECONCILED", intent, receipt, reconciliation, detail: reconciliation.detail };
}
