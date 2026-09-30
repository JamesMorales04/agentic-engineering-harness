import type { ExecutionBlueprint } from "../architecture/participantPlan.js";
import { type CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { type CanonicalRole } from "../participants/index.js";
import { type ExecutionAuthorityV1 } from "./executionLease.js";
import { type ToolActionKindV1 } from "./actionKinds.js";
export { TOOL_ACTION_KINDS_V1 } from "./actionKinds.js";
export type { ToolActionKindV1 } from "./actionKinds.js";
export type ToolActionImpactV1 = "LOCAL_REPOSITORY_MUTATION" | "LOCAL_RESOURCE_CREATION" | "EXTERNAL_RECONCILABLE" | "EXTERNAL_NON_IDEMPOTENT" | "EXTERNAL_PUBLICATION";
export type ToolActionOutcomeV1 = "SUCCEEDED" | "FAILED" | "UNKNOWN";
export type ToolActionAuthorityEvidenceV1 = {
    kind: "execution-authority";
    authority: ExecutionAuthorityV1;
} | {
    kind: "execution-blueprint";
    blueprint: ExecutionBlueprint;
} | {
    kind: "controller-authority";
    operationId: string;
    controllerEpoch: number;
};
export interface ToolActionRequestV1 {
    root: string;
    operationId: string;
    participantId: string;
    /** Required for participant/blueprint authority; omitted for the deterministic controller actor. */
    role?: CanonicalRole;
    candidate: CandidateRevisionV1;
    actionKey: string;
    action: ToolActionKindV1;
    payload: unknown;
    authority: ToolActionAuthorityEvidenceV1;
    now?: Date;
}
/** Deterministic actor id of the fenced controller that owns an operation. */
export declare function controllerActorId(operationId: string): string;
export interface ActionIntentV1 {
    version: 2;
    intentId: string;
    actionKey: string;
    operationId: string;
    participantId: string;
    role?: CanonicalRole;
    candidate: CandidateRevisionV1;
    operationExecutionRevision: number;
    policyDigest: string;
    action: ToolActionKindV1;
    impact: ToolActionImpactV1;
    controllerEpoch: number;
    payloadDigest: string;
    authorityBindingDigest: string;
    requestDigest: string;
    createdAt: string;
}
export interface ActionReceiptV1 {
    version: 2;
    receiptId: string;
    intentId: string;
    operationId: string;
    participantId: string;
    candidateDigest: string;
    operationExecutionRevision: number;
    policyDigest: string;
    action: ToolActionKindV1;
    controllerEpoch: number;
    reconciledUnderEpoch?: number;
    outcome: ToolActionOutcomeV1;
    resultDigest: string;
    receiptDigest: string;
    recordedAt: string;
}
export type ToolActionGateResultV1 = {
    decision: "EXECUTE_ONCE";
    intent: ActionIntentV1;
} | {
    decision: "ALREADY_COMPLETED";
    intent: ActionIntentV1;
    receipt: ActionReceiptV1;
};
/** Stable deterministic classification; callers cannot downgrade an action's impact. */
export declare function classifyToolActionImpact(action: ToolActionKindV1): ToolActionImpactV1;
/**
 * Persist one stable intent before a side effect. Repeating the same request
 * returns its receipt or fails closed while the earlier attempt is unresolved.
 */
export declare function authorizeToolAction(request: ToolActionRequestV1): Promise<ToolActionGateResultV1>;
/** Load and validate one persisted ActionIntent without authorizing a new action. */
export declare function loadActionIntent(root: string, operationId: string, actionKey: string): Promise<ActionIntentV1 | undefined>;
/** Load and validate one persisted ActionReceipt without authorizing a new action. */
export declare function loadActionReceipt(root: string, operationId: string, actionKey: string): Promise<ActionReceiptV1 | undefined>;
/** List current operation intents that have no durable or reconciled receipt. */
export declare function listUnresolvedToolActionIntents(root: string, operationId: string): Promise<ActionIntentV1[]>;
/** Record the deterministic outcome after the caller has attempted the side effect. */
export declare function recordToolActionReceipt(root: string, intent: ActionIntentV1, outcome: ToolActionOutcomeV1, resultEvidence: unknown, now?: Date): Promise<ActionReceiptV1>;
/** Record observation-only reconciliation under a newly current controller epoch. */
export declare function recordReconciledToolActionReceipt(root: string, intent: ActionIntentV1, outcome: ToolActionOutcomeV1, resultEvidence: unknown, now?: Date): Promise<ActionReceiptV1>;
