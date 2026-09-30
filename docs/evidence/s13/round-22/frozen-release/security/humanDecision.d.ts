import { type CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { type ToolActionKindV1 } from "./actionKinds.js";
export declare const humanDecisionKindValues: readonly ["APPROVE", "REJECT", "CHOOSE", "CANCEL", "RETRY", "ACKNOWLEDGE", "PAUSE", "RESUME"];
export type HumanDecisionKindV2 = (typeof humanDecisionKindValues)[number];
export type OperationControlCommandV1 = "CANCEL" | "RETRY" | "ACKNOWLEDGE" | "PAUSE" | "RESUME";
export type HumanDecisionPurposeV2 = {
    kind: "PRODUCT_CHOICE";
    requestId: string;
    choiceId: string;
} | {
    kind: "ACTION_AUTHORIZATION";
    action: ToolActionKindV1;
    effectDigest: string;
} | {
    kind: "OPERATION_CONTROL";
    command: OperationControlCommandV1;
};
export interface HumanDecisionV2 {
    version: 2;
    decisionId: string;
    operationId: string;
    candidate: CandidateRevisionV1;
    operationExecutionRevision: number;
    policyDigest: string;
    controllerEpoch: number;
    purpose: HumanDecisionPurposeV2;
    kind: HumanDecisionKindV2;
    actorId: string;
    reason: string;
    createdAt: string;
    expiresAt?: string;
}
export interface HumanDecisionInputV2 extends Omit<HumanDecisionV2, "version" | "decisionId" | "createdAt" | "expiresAt"> {
    createdAt?: string | Date;
    expiresAt?: string | Date;
}
export interface HumanDecisionBindingV2 {
    operationId: string;
    candidate: CandidateRevisionV1;
    operationExecutionRevision: number;
    policyDigest: string;
    controllerEpoch: number;
}
export interface DecisionEvidenceReferenceV1 {
    artifact: string;
    sha256: string;
    description: string;
}
export interface DecisionChoiceV1 {
    choiceId: string;
    label: string;
    description: string;
    consequences: string[];
}
export interface DecisionRequestV1 extends HumanDecisionBindingV2 {
    version: 1;
    requestId: string;
    issue: string;
    authoritativeEvidence: DecisionEvidenceReferenceV1[];
    whatTried: string[];
    whyUnresolvable: string;
    choices: DecisionChoiceV1[];
    workThatCanContinue: string[];
    resumeTarget: "SPEC_AUTHORING";
    createdAt: string;
    expiresAt: string;
}
export declare const continuationRevalidationValuesV1: readonly ["candidate-current", "operation-revision-current", "policy-current", "controller-epoch-current", "checkpoint-current"];
export type ContinuationRevalidationV1 = (typeof continuationRevalidationValuesV1)[number];
export interface ContinuationRecordV1 extends HumanDecisionBindingV2 {
    version: 1;
    continuationId: string;
    resumeTarget: "SPEC_AUTHORING";
    reason: "PRODUCT_CHOICE";
    requestId: string;
    checkpointArtifact: string;
    checkpointDigest: string;
    requiredRevalidation: ContinuationRevalidationV1[];
    state: "WAITING" | "CHOICE_CONSUMED" | "RESUMING";
    suspendedAt: string;
    updatedAt: string;
    selectedDecisionId?: string;
    selectedChoiceId?: string;
    selectedDecisionBinding?: HumanDecisionBindingV2;
    appliedRequirementDigest?: string;
}
export declare class HumanDecisionError extends Error {
    constructor(message: string);
}
export declare function assertDecisionRequestV1(value: unknown): DecisionRequestV1;
export declare function assertContinuationRecordV1(value: unknown): ContinuationRecordV1;
export declare function assertDecisionBindingMatchesRequest(request: DecisionRequestV1, binding: HumanDecisionBindingV2): void;
/**
 * Durable V2 HumanDecision storage. Each decision and its one-time consumption
 * receipt is created exclusively, so concurrent consumers cannot both use it.
 * A pre-V2 file at the configured path fails explicitly and requires migration.
 */
export declare class HumanDecisionLedgerV2 {
    private readonly directoryPath;
    constructor(directoryPath: string);
    record(input: HumanDecisionInputV2): Promise<HumanDecisionV2>;
    /** Reserve at most one paired product choice for a request and persist its HumanDecision. */
    recordProductChoice(input: HumanDecisionInputV2, requestId: string): Promise<HumanDecisionV2>;
    /** Load and repair a reserved request after a crash between reservation and ledger materialization. */
    productChoiceForRequest(requestIdInput: string, bindingInput: HumanDecisionBindingV2, allowedChoiceIds: readonly string[]): Promise<HumanDecisionV2 | undefined>;
    private create;
    private writeExclusive;
    list(): Promise<HumanDecisionV2[]>;
    active(bindingInput: HumanDecisionBindingV2, now?: Date): Promise<HumanDecisionV2[]>;
    find(decisionId: string): Promise<HumanDecisionV2 | undefined>;
    consumeExact(bindingInput: HumanDecisionBindingV2, purposeInput: HumanDecisionPurposeV2, decisionId: string, actorIdInput: string, now?: Date): Promise<HumanDecisionV2>;
    /** Recovery-only read: recognizes the same durable consumption after a crash, never grants a second consume. */
    consumedExact(bindingInput: HumanDecisionBindingV2, purposeInput: HumanDecisionPurposeV2, decisionId: string, actorIdInput: string): Promise<HumanDecisionV2 | undefined>;
    consume(bindingInput: HumanDecisionBindingV2, purposeInput: HumanDecisionPurposeV2, actorIdInput?: string, now?: Date): Promise<HumanDecisionV2>;
    private ensureDirectory;
    private decisionFile;
    private consumedFile;
    private isConsumed;
}
export declare function assertDecisionV2(value: unknown): HumanDecisionV2;
