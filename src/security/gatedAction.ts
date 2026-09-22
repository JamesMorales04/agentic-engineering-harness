import type { ActionReconciliationResultV1 } from "./actionReconciliation.js";
import { reconciliationReceiptOutcome } from "./actionReconciliation.js";
import { authorizeToolAction, loadActionIntent, recordToolActionReceipt, type ActionIntentV1, type ActionReceiptV1, type ToolActionRequestV1 } from "./toolActionGate.js";

/**
 * Deterministic orchestration of one gated side effect:
 * ActionRequest -> authority -> ToolActionGate -> durable ActionIntent ->
 * side effect -> durable ActionReceipt, with explicit reconciliation when a
 * prior intent has no receipt. The executor must not mutate external state
 * itself; it is invoked only after the intent is durable.
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
    const reconciliation = await input.reconcile(intent);
    const outcome = reconciliationReceiptOutcome(reconciliation);
    if (!outcome) {
      return {
        status: reconciliation.outcome === "HUMAN_REQUIRED" ? "HUMAN_REQUIRED" : "RECONCILIATION_REQUIRED",
        intent,
        reconciliation,
        detail: reconciliation.detail
      };
    }
    const receipt = await recordToolActionReceipt(input.root, intent, outcome, reconciliation.evidence, input.now);
    return { status: "RECONCILED", intent, receipt, reconciliation, detail: reconciliation.detail };
  }

  if (authorization.decision === "ALREADY_COMPLETED") {
    return { status: "ALREADY_COMPLETED", intent: authorization.intent, receipt: authorization.receipt, detail: "The action already has a durable receipt for this exact request." };
  }

  const result = await input.execute(authorization.intent);
  const receipt = await recordToolActionReceipt(input.root, authorization.intent, result.outcome, result.evidence, input.now);
  return { status: "EXECUTED", intent: authorization.intent, receipt, detail: result.outcome === "SUCCEEDED" ? "Side effect executed and receipt persisted." : "Side effect failed deterministically and the failure receipt was persisted." };
}
