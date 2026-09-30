import type { HarnessProjectConfig, ValidationFinding } from "../core/types.js";
import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { type CandidateWorkspaceIdentityEvidenceV1 } from "../candidates/identity.js";
export declare const PROVIDER_LANE_EVIDENCE_VERSION: 1;
export declare const PROVIDER_LANE_EVIDENCE_REQUIRED: "PROVIDER_LANE_EVIDENCE_REQUIRED";
export declare const PROVIDER_LANE_EVIDENCE_STALE: "PROVIDER_LANE_EVIDENCE_STALE";
export declare const PROVIDER_LANE_EVIDENCE_TAMPERED: "PROVIDER_LANE_EVIDENCE_TAMPERED";
export declare const PROVIDER_LANE_CANDIDATE_BINDING_REQUIRED: "PROVIDER_LANE_CANDIDATE_BINDING_REQUIRED";
export declare const PROVIDER_LANE_REFERENCE_REQUIRED: "PROVIDER_LANE_REFERENCE_REQUIRED";
export declare const VISUAL_REFERENCE_BASELINE_REQUIRED: "VISUAL_REFERENCE_BASELINE_REQUIRED";
export declare const VISUAL_COMPARISON_CONFIG_REQUIRED: "VISUAL_COMPARISON_CONFIG_REQUIRED";
export declare const providerEvidenceLaneValues: readonly ["CONTRACT", "INTEGRATION", "BROWSER", "VISUAL"];
export type ProviderEvidenceLaneV1 = (typeof providerEvidenceLaneValues)[number];
export declare function providerLaneUnavailableBlocker(lane: ProviderEvidenceLaneV1): string;
export type ProviderLaneArtifactKindV1 = "raw" | "report" | "screenshot" | "trace" | "video" | "log" | "diff" | "baseline";
export interface ProviderLaneArtifactV1 {
    kind: ProviderLaneArtifactKindV1;
    path: string;
    digest: string;
    bytes: number;
    sanitized: boolean;
}
export interface ProviderIdentityV1 {
    name: string;
    version: string;
    runtime?: string;
    executable?: string;
}
/** Comparison configuration the provider actually ran, bound to the lane evidence. */
export interface ProviderLaneComparisonV1 {
    tool: string;
    name?: string;
    options: Record<string, unknown>;
}
export interface ProviderLaneEvidenceV1 {
    version: 1;
    lane: ProviderEvidenceLaneV1;
    checkId: string;
    candidate: {
        candidateId: string;
        revision: number;
        identityDigest: string;
    };
    workspace: CandidateWorkspaceIdentityEvidenceV1;
    provider: ProviderIdentityV1;
    commandDigest: string;
    status: "PASS" | "FAIL" | "WARN";
    summary: string;
    findingCount: number;
    findings: ValidationFinding[];
    artifacts: ProviderLaneArtifactV1[];
    rawArtifact: string;
    rawArtifactDigest: string;
    startedAt: string;
    finishedAt: string;
    blockers: string[];
    comparison?: ProviderLaneComparisonV1;
    artifact: string;
    digest: string;
}
export interface PersistProviderLaneEvidenceInputV1 {
    root: string;
    config: HarnessProjectConfig;
    lane: ProviderEvidenceLaneV1;
    checkId: string;
    candidate: CandidateRevisionV1;
    provider: ProviderIdentityV1;
    command: string;
    status: "PASS" | "FAIL" | "WARN";
    summary: string;
    findings: ValidationFinding[];
    rawArtifactText: string;
    artifacts?: Array<{
        kind: ProviderLaneArtifactKindV1;
        path: string;
        sanitized?: boolean;
    }>;
    comparison?: ProviderLaneComparisonV1;
    startedAt: string;
    finishedAt: string;
    blockers?: string[];
}
export declare function providerLaneEvidenceDirectory(root: string, config: HarnessProjectConfig, lane: ProviderEvidenceLaneV1, candidate: Pick<CandidateRevisionV1, "candidateId" | "revision" | "identityDigest">): string;
export declare function providerLaneEvidenceArtifactPath(root: string, config: HarnessProjectConfig, lane: ProviderEvidenceLaneV1, candidate: Pick<CandidateRevisionV1, "candidateId" | "revision" | "identityDigest">, checkId: string): string;
export declare function persistProviderLaneEvidenceV1(input: PersistProviderLaneEvidenceInputV1): Promise<ProviderLaneEvidenceV1>;
export declare function loadProviderLaneEvidenceV1(root: string, config: HarnessProjectConfig, lane: ProviderEvidenceLaneV1, candidate: Pick<CandidateRevisionV1, "candidateId" | "revision" | "identityDigest">, checkId: string): Promise<ProviderLaneEvidenceV1 | undefined>;
export interface ProviderLaneEvidenceVerificationV1 {
    ok: boolean;
    blockers: string[];
    evidence?: ProviderLaneEvidenceV1;
}
export declare function verifyProviderLaneEvidenceV1(root: string, config: HarnessProjectConfig, evidence: ProviderLaneEvidenceV1, expected: CandidateRevisionV1): Promise<ProviderLaneEvidenceVerificationV1>;
export declare function requireProviderLaneEvidenceV1(root: string, config: HarnessProjectConfig, lane: ProviderEvidenceLaneV1, candidate: CandidateRevisionV1, checkId: string): Promise<ProviderLaneEvidenceV1>;
export interface RequireProviderLaneEvidenceForActionInputV1 {
    root: string;
    config: HarnessProjectConfig;
    lane: ProviderEvidenceLaneV1;
    candidate: CandidateRevisionV1;
    checkId: string;
    kind: string;
    actionSource: string;
    actionSelector: string;
}
/**
 * Fails closed unless the check that PASSed a specialized lane requirement was
 * executed by the matching provider/adapter and persisted candidate-bound lane
 * evidence. A project script, configured command, or raw provider command that
 * merely exited zero cannot satisfy a CONTRACT/INTEGRATION/BROWSER/VISUAL
 * requirement; only provider execution persists this evidence.
 */
export declare function requireProviderLaneEvidenceForActionV1(input: RequireProviderLaneEvidenceForActionInputV1): Promise<ProviderLaneEvidenceV1>;
