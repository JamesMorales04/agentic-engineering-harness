/** A line range is inclusive and uses one-based source line numbers. */
export interface ContextLineRangeV1 {
    startLine: number;
    endLine: number;
}
export interface ContextSymbolRangeV1 {
    symbol: string;
    range: ContextLineRangeV1;
    /** The complete symbol path, when a parser can provide one. */
    symbolPath?: string[];
}
export type ContextShardLocatorV1 = {
    kind: "range";
    file: string;
    range: ContextLineRangeV1;
} | {
    kind: "symbol";
    file: string;
    symbol: string;
    range?: ContextLineRangeV1;
    symbolPath?: string[];
};
export interface ContextShardV1 {
    version: 1;
    shardId: string;
    file: string;
    content: string;
    /** Digest of the complete source, when the shard came from a larger source. */
    sourceDigest?: string;
    contentDigest: string;
    locator: ContextShardLocatorV1;
    symbols?: ContextSymbolRangeV1[];
}
export interface ContextPayloadV1 {
    content: string;
    digest: string;
    locator: ContextShardLocatorV1;
    range: ContextLineRangeV1;
    estimatedTokens: number;
}
/**
 * A ref is addressable before it is delivered.  In particular, `payload` is
 * absent for a JIT ref; knowing that a shard may be retrieved is not the same
 * thing as putting its contents in a prompt.
 */
export interface ContextRefV1 {
    version: 1;
    refId: string;
    operationId: string;
    projectId: string;
    operationExecutionRevision: number;
    candidateRevision: number;
    candidateRevisionDigest: string;
    participantId: string;
    participantGeneration: string;
    executionBlueprintDigest: string;
    operationPolicyDigest: string;
    controllerEpoch: number;
    sessionId: string;
    shardId: string;
    fragmentId: string;
    artifactPath: string;
    sourceFile?: string;
    sourceDigest: string;
    contentDigest: string;
    locator: ContextShardLocatorV1;
    authorized: true;
    addressable: true;
    delivered: boolean;
    delivery: "addressable" | "delivered";
    authorizationGrantId: string;
    authorizationDigest: string;
    payload?: ContextPayloadV1;
}
export interface ContextRefAuthorizationV1 {
    version: 1;
    grantId: string;
    operationId: string;
    projectId: string;
    operationExecutionRevision: number;
    candidateRevision: number;
    candidateRevisionDigest: string;
    participantId: string;
    participantGeneration: string;
    executionBlueprintDigest: string;
    operationPolicyDigest: string;
    controllerEpoch: number;
    sessionId: string;
    retrievalBudget: ContextRetrievalBudgetV1;
    allowedRefs: ContextRefAuthorizationEntryV1[];
    issuedAt: string;
    expiresAt: string;
    grantDigest: string;
}
export interface ContextRetrievalBudgetV1 {
    maxRequestsPerTurn: number;
    maxTokensPerRequest: number;
    maxTotalTokensPerTurn: number;
}
export interface ContextRefAuthorizationEntryV1 {
    refId: string;
    fragmentId: string;
    shardId: string;
    artifactPath: string;
    sourceFile?: string;
    sourceDigest: string;
    contentDigest: string;
    locator: ContextShardLocatorV1;
    estimatedTokens: number;
}
/** Controller persistence pins the issued grant to the final S1 binding. */
export interface ContextRefAuthorizationReceiptV1 {
    version: 1;
    grant: ContextRefAuthorizationV1;
    executionBindingDigest: string;
    contextManifestDigest: string;
    promptManifestDigest: string;
    receiptDigest: string;
}
export interface ContextRefAuthorizationExpectationV1 {
    operationId: string;
    projectId: string;
    operationExecutionRevision: number;
    candidateRevision: number;
    candidateRevisionDigest: string;
    participantId: string;
    participantGeneration: string;
    executionBlueprintDigest: string;
    operationPolicyDigest: string;
    controllerEpoch: number;
    sessionId: string;
    executionBindingDigest: string;
    contextManifestDigest: string;
    promptManifestDigest: string;
}
export interface ContextSelectionV1 {
    shardId: string;
    file: string;
    locator: ContextShardLocatorV1;
    range: ContextLineRangeV1;
    content: string;
    digest: string;
    sourceDigest?: string;
    estimatedTokens: number;
}
export interface ContextRefInputV1 {
    refId: string;
    /** The controller's durable issue receipt must be validated against current identity. */
    authorizationReceipt: ContextRefAuthorizationReceiptV1;
    expected: ContextRefAuthorizationExpectationV1;
}
export interface ContextContinuationV1 {
    version: 1;
    continuationId: string;
    operationId: string;
    projectId: string;
    operationExecutionRevision: number;
    candidateRevision: number;
    candidateRevisionDigest: string;
    participantId: string;
    participantGeneration: string;
    executionBindingDigest: string;
    controllerEpoch: number;
    contextManifestDigest: string;
    promptManifestDigest: string;
    previousSessionId: string;
    nextSessionId: string;
    previousTurnId: string;
    nextTurnId?: string;
    sequence: number;
    contextRefIds: string[];
    retrievalReceiptIds: string[];
    bindingDigest: string;
}
export interface ContextContinuationInputV1 {
    continuationId?: string;
    operationId: string;
    projectId: string;
    operationExecutionRevision: number;
    candidateRevision: number;
    candidateRevisionDigest: string;
    participantId: string;
    participantGeneration: string;
    executionBindingDigest: string;
    controllerEpoch: number;
    contextManifestDigest: string;
    promptManifestDigest: string;
    previousSessionId: string;
    nextSessionId: string;
    previousTurnId: string;
    nextTurnId?: string;
    sequence: number;
    contextRefIds?: string[];
    retrievalReceiptIds?: string[];
}
export interface ExecutionBudgetV1 {
    version: 1;
    operationId: string;
    projectId?: string;
    candidateRevisionDigest?: string;
    maxTokens: number;
    consumedTokens: number;
    remainingTokens: number;
    sessionUsage: Record<string, number>;
}
export interface PromptManifestEntryV1 {
    id: string;
    content?: string;
    digest?: string;
    role?: string;
    source?: string;
}
export interface PromptManifestV1 {
    version: 1;
    staticPrefix: PromptManifestEntryV1[];
    dynamic: PromptManifestEntryV1[];
    staticDigest: string;
    dynamicDigest: string;
    /** Digest of the stable prompt prefix; independent of dynamic entries. */
    prefixDigest: string;
    digest: string;
}
export interface PromptManifestInputV1 {
    staticPrefix?: PromptManifestEntryV1[];
    staticEntries?: PromptManifestEntryV1[];
    dynamic?: PromptManifestEntryV1[];
    dynamicEntries?: PromptManifestEntryV1[];
}
export declare function stableJsonV1(value: unknown): string;
export declare function digestV1(value: unknown): string;
export declare function createContextShard(input: Omit<ContextShardV1, "version" | "contentDigest"> & {
    contentDigest?: string;
}): ContextShardV1;
export declare function digestText(value: string): string;
export declare function rangeShardLocator(file: string, range: ContextLineRangeV1): ContextShardLocatorV1;
export declare function symbolShardLocator(file: string, symbol: string, range?: ContextLineRangeV1, symbolPath?: string[]): ContextShardLocatorV1;
export declare function selectContextShard(shard: ContextShardV1, locator: ContextShardLocatorV1): ContextSelectionV1;
export declare const selectShardRange: typeof selectContextShard;
export declare function compileContextRefAuthorization(input: Omit<ContextRefAuthorizationV1, "version" | "grantDigest">): ContextRefAuthorizationV1;
export declare function compileContextRefAuthorizationReceipt(grant: ContextRefAuthorizationV1, binding: Pick<ContextRefAuthorizationExpectationV1, "executionBindingDigest" | "contextManifestDigest" | "promptManifestDigest">): ContextRefAuthorizationReceiptV1;
export declare function assertContextRefAuthorization(grant: ContextRefAuthorizationV1, expected: Omit<ContextRefAuthorizationExpectationV1, "executionBindingDigest" | "contextManifestDigest" | "promptManifestDigest">, now?: Date): void;
export declare function createContextRef(input: ContextRefInputV1): ContextRefV1;
export declare function deliverContextPayload(ref: ContextRefV1, shard: ContextShardV1, receipt: ContextRefAuthorizationReceiptV1, expected: ContextRefAuthorizationExpectationV1, now?: Date): ContextRefV1;
export declare function bindContinuation(input: ContextContinuationInputV1): ContextContinuationV1;
export interface ContinuationBindingExpectationV1 {
    operationId: string;
    projectId: string;
    operationExecutionRevision: number;
    candidateRevision: number;
    candidateRevisionDigest: string;
    participantId: string;
    participantGeneration: string;
    executionBindingDigest: string;
    controllerEpoch: number;
    contextManifestDigest: string;
    promptManifestDigest: string;
    previousSessionId: string;
    nextSessionId: string;
    previousTurnId: string;
    sequence: number;
    availableRefs?: readonly ContextRefV1[];
    availableReceiptIds?: readonly string[];
}
export declare function assertContinuationBinding(continuation: ContextContinuationV1, expected: ContinuationBindingExpectationV1): void;
export declare function isContinuationBindingValid(continuation: ContextContinuationV1, expected: ContinuationBindingExpectationV1): boolean;
export declare function createExecutionBudget(operationId: string, maxTokens: number, identity?: {
    projectId?: string;
    candidateRevisionDigest?: string;
}): ExecutionBudgetV1;
export declare function startBudgetSession(budget: ExecutionBudgetV1, sessionId: string): ExecutionBudgetV1;
export declare function consumeExecutionBudget(budget: ExecutionBudgetV1, sessionId: string, tokens: number): ExecutionBudgetV1;
export declare const recordExecutionUsage: typeof consumeExecutionBudget;
export declare function assertBudgetAvailable(budget: ExecutionBudgetV1, tokens: number): void;
export declare function stablePrefixDigest(prefix: PromptManifestV1 | readonly PromptManifestEntryV1[] | string): string;
export declare function computeStaticPromptDigest(entries: readonly PromptManifestEntryV1[]): string;
export declare function computeDynamicPromptDigest(entries: readonly PromptManifestEntryV1[]): string;
export declare function computePromptManifestDigest(manifest: Pick<PromptManifestV1, "staticDigest" | "dynamicDigest">): string;
export declare function createPromptManifest(input?: PromptManifestInputV1): PromptManifestV1;
export declare function verifyPromptManifestDigest(manifest: PromptManifestV1): boolean;
