import type { AgentProviderResult, CertificationCapability, CertificationOracle } from "./types.js";
/** One deterministic journey-evidence result keyed by a capability `requiredEvidence` id. */
export interface CapabilityJourneyEvidence {
    ok: boolean;
    detail?: unknown;
}
export interface CapabilityJourneyVerificationContext {
    candidateRoot: string;
    actor?: AgentProviderResult;
}
export type CapabilityJourneyVerifier = (context: CapabilityJourneyVerificationContext) => Promise<Record<string, CapabilityJourneyEvidence>>;
/** A command the real provider actor must have executed successfully for the journey to count. */
export interface CapabilityActorCommandRequirement {
    label?: string;
    contains: string;
    output?: RegExp;
}
export interface CapabilityJourneyOracleOptions {
    id: string;
    capability: CertificationCapability;
    verify: CapabilityJourneyVerifier;
    actorCommands?: CapabilityActorCommandRequirement[];
}
interface ActorCommandExecution {
    command: string;
    exitCode: unknown;
    output: string;
}
/**
 * Deterministic oracle for one capability journey over a freshly packed candidate.
 *
 * The verifier may only read durable artifacts produced inside the disposable candidate
 * fixture. The provider transcript is consulted only to prove that the real provider
 * actually executed the declared journey command; it can never satisfy required evidence
 * on its own.
 */
export declare function createCapabilityJourneyOracle(options: CapabilityJourneyOracleOptions): CertificationOracle;
/** Extract successful/failed command executions recorded by the real provider (Codex `item.completed` JSONL). */
export declare function actorCommandExecutions(actor?: AgentProviderResult): ActorCommandExecution[];
export {};
