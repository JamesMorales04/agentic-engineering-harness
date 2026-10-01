import { reconciliationReceiptOutcome } from "./actionReconciliation.js";
import { authorizeToolAction, loadActionIntent, recordReconciledToolActionReceipt, recordToolActionReceipt } from "./toolActionGate.js";
export async function executeGatedAction(input) {
    let authorization;
    try {
        authorization = await authorizeToolAction(input.request);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("TOOL_ACTION_RECONCILIATION_REQUIRED"))
            throw error;
        const intent = await loadActionIntent(input.root, input.request.operationId, input.request.actionKey);
        if (!intent)
            throw error;
        return reconcileUnresolvedIntent(input, intent, message);
    }
    if (authorization.decision === "ALREADY_COMPLETED") {
        return { status: "ALREADY_COMPLETED", intent: authorization.intent, receipt: authorization.receipt, detail: "The action already has a durable receipt for this exact request." };
    }
    let result;
    try {
        result = await input.execute(authorization.intent);
    }
    catch (error) {
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
async function reconcileUnresolvedIntent(input, intent, reason) {
    let reconciliation;
    try {
        reconciliation = await input.reconcile(intent);
    }
    catch (error) {
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
//# sourceMappingURL=gatedAction.js.map