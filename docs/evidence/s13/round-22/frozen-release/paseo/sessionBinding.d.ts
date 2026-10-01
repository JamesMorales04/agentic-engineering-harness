export type PaseoSessionBindingStatusV1 = "ACTIVE" | "ARCHIVED" | "LOST";
/**
 * Complete deterministic identity for one Paseo session bound to one operation
 * participant at one execution revision.
 *
 * Every field is required and compared exactly: operation execution revision,
 * project, participant and participant generation, candidate revision and
 * digest, frozen ExecutionBlueprint, frozen resolved operation policy,
 * ContextManifest, PromptManifest, and controller epoch. There are no optional
 * or wildcard expectations: a missing or different value is never reusable.
 * The identity is derived only from frozen execution evidence, never from
 * display titles, agent names, mtimes, or session ordering.
 */
export interface PaseoSessionBindingIdentityV1 {
    projectId: string;
    operationId: string;
    operationExecutionRevision: number;
    participantId: string;
    participantGeneration: string;
    candidateRevision: number;
    candidateDigest: string;
    executionBlueprintDigest: string;
    operationPolicyDigest: string;
    contextManifestDigest: string;
    promptManifestDigest: string;
    controllerEpoch: number;
}
/**
 * Durable binding record for one Paseo session. `paseoAgentId` is the actual
 * Paseo agent/session id returned by launch and is required record integrity
 * evidence; `sessionGeneration`, `status`, and timestamps describe the record
 * lifecycle. The record is immutable identity evidence and grants no tools,
 * authority, mutation, or capabilities. Reuse decisions are made only by
 * `resolveReusablePaseoSession`.
 */
export interface PaseoSessionBindingV1 extends PaseoSessionBindingIdentityV1 {
    version: 1;
    bindingId: string;
    paseoAgentId: string;
    sessionGeneration: number;
    status: PaseoSessionBindingStatusV1;
    createdAt: string;
    updatedAt: string;
    bindingDigest: string;
}
export interface PaseoSessionBindingInputV1 extends PaseoSessionBindingIdentityV1 {
    paseoAgentId: string;
    status?: PaseoSessionBindingStatusV1;
    now?: Date;
}
/** Create the first durable binding for a participant session. Repeating the
 * same complete identity with the same actual Paseo agent is idempotent; any
 * identity change fails closed as stale, and a different actual agent fails
 * closed as a conflict. Callers rebind an existing participant only through
 * `rotatePaseoSessionBinding`. */
export declare function bindPaseoSession(root: string, input: PaseoSessionBindingInputV1): Promise<PaseoSessionBindingV1>;
/** Explicit rebind path: always writes a new binding with the next session
 * generation and the complete requested identity, preserving the original
 * createdAt when a binding already exists. */
export declare function rotatePaseoSessionBinding(root: string, input: PaseoSessionBindingInputV1): Promise<PaseoSessionBindingV1>;
/** Load the durable binding for a participant. Missing bindings return
 * undefined; a present but unreadable, incomplete, or inconsistent record
 * fails closed. */
export declare function loadPaseoSessionBinding(root: string, operationId: string, participantId: string): Promise<PaseoSessionBindingV1 | undefined>;
export declare function assertPaseoSessionBinding(value: unknown): asserts value is PaseoSessionBindingV1;
/** Deterministic full-identity comparison. Every identity field must be
 * present in the expectation and equal to the durable record; the durable
 * record itself must be integrity-valid. Missing, malformed, or different
 * expectations never match, and no field acts as a wildcard. */
export declare function paseoSessionBindingMatches(binding: PaseoSessionBindingV1, expected: PaseoSessionBindingIdentityV1): boolean;
/** Runtime reuse decision: only an ACTIVE, integrity-valid binding whose
 * complete identity matches exactly may be reused. This function never
 * throws; anything unproven is not reusable. */
export declare function resolveReusablePaseoSession(binding: PaseoSessionBindingV1 | undefined, expected: PaseoSessionBindingIdentityV1): PaseoSessionBindingV1 | undefined;
