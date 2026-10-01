import { runExecutable } from "../utils/process.js";
import type { ActionIntentV1, ToolActionKindV1 } from "./toolActionGate.js";
/**
 * Deterministic reconciliation of externally observable tool-action effects.
 *
 * Decision mechanism: DETERMINISTIC. This module only inspects local Git state
 * or a provider HTTP API and reports what it observed. It never guesses and it
 * never treats missing evidence as success:
 * - a conclusive external fact -> SUCCEEDED or FAILED;
 * - missing payload evidence, transport failures or ambiguous responses -> UNKNOWN;
 * - no deterministic identity or no confirmed inspection contract -> HUMAN_REQUIRED.
 *
 * The module is intentionally read-only: it never mutates repository state and
 * never calls `recordToolActionReceipt`. The caller decides whether a
 * reconciled outcome may be persisted as a terminal receipt by using
 * `reconciliationReceiptOutcome`.
 *
 * Gaps in required files change the fail-closed behavior of a gate. Per the
 * repository validation invariant, audit/gate outputs must remain
 * machine-readable and reproducible; every result therefore carries a typed
 * `evidence` object and its canonical `evidenceDigest`.
 */
export type ActionReconciliationOutcomeV1 = "SUCCEEDED" | "FAILED" | "UNKNOWN" | "HUMAN_REQUIRED";
export interface ActionReconciliationResultV1 {
    version: 1;
    intentId: string;
    action: ToolActionKindV1;
    outcome: ActionReconciliationOutcomeV1;
    detail: string;
    /** `sha256Canonical(evidence)`; always a 64-character lowercase hex digest. */
    evidenceDigest: string;
    evidence: Record<string, unknown>;
    reconciledAt: string;
}
export interface ActionReconciliationHttpInitV1 {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
}
export interface ActionReconciliationDependenciesV1 {
    runExecutable?: typeof runExecutable;
    fetchJson?: (url: string, init?: ActionReconciliationHttpInitV1) => Promise<{
        status: number;
        body: unknown;
    }>;
    /** Explicit GitHub token; when omitted the standard delivery token environment is consulted. */
    token?: string;
    now?: Date;
}
/**
 * Reconcile one tool action against observable state.
 *
 * `payload` is the action payload that the caller intends to verify; it is the
 * same value whose canonical digest the gate stored as `intent.payloadDigest`,
 * and it is a separate parameter because payloads are not embedded in the
 * persisted intent. Reconciliation validates only the fields it needs per
 * action; it never re-derives the intent identity from the payload.
 *
 * `root` is the repository root used for local Git observations
 * (`git rev-parse`, `git ls-remote`). Provider actions (`github.*` and
 * `paseo.workspace.create`) do not touch the local working tree. Paseo
 * workspace creation is controller-owned local execution infrastructure;
 * uncertainty remains HUMAN_REQUIRED unless provider identity can be proven.
 */
export declare function reconcileToolAction(root: string, intent: ActionIntentV1, payload: unknown, dependencies?: ActionReconciliationDependenciesV1): Promise<ActionReconciliationResultV1>;
/**
 * Map a reconciliation result to the status that may be persisted as a
 * terminal `ActionReceipt`. UNKNOWN and HUMAN_REQUIRED are deliberately not
 * persistable: an unresolved action must remain at the intent stage so a
 * later reconciliation can still change the conclusion.
 */
export declare function reconciliationReceiptOutcome(result: ActionReconciliationResultV1): "SUCCEEDED" | "FAILED" | "UNKNOWN" | undefined;
