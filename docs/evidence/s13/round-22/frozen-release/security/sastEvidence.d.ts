import type { HarnessProjectConfig, ValidationFinding } from "../core/types.js";
import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { type CandidateWorkspaceIdentityEvidenceV1 } from "../candidates/identity.js";
import type { IsolationExecutionEvidenceV1 } from "./isolation.js";
export declare const SAST_EVIDENCE_VERSION: 1;
export declare const SAST_EVIDENCE_REQUIRED: "SAST_EVIDENCE_REQUIRED";
export declare const SAST_EVIDENCE_STALE: "SAST_EVIDENCE_STALE";
export declare const SAST_EVIDENCE_TAMPERED: "SAST_EVIDENCE_TAMPERED";
export declare const SAST_PROVIDER_UNAVAILABLE: "SAST_PROVIDER_UNAVAILABLE";
export declare const SAST_CANDIDATE_BINDING_REQUIRED: "SAST_CANDIDATE_BINDING_REQUIRED";
export type SastAdapterV1 = "opengrep" | "trivy";
export declare const SAST_ADAPTERS: readonly SastAdapterV1[];
export interface SastToolIdentityV1 {
    name: string;
    version: string;
    executable?: string;
}
export interface SastEvidenceV1 {
    version: 1;
    checkId: string;
    adapter: SastAdapterV1;
    candidate: {
        candidateId: string;
        revision: number;
        identityDigest: string;
    };
    workspace: CandidateWorkspaceIdentityEvidenceV1;
    tool: SastToolIdentityV1;
    commandDigest: string;
    isolation?: IsolationExecutionEvidenceV1;
    status: "PASS" | "FAIL" | "WARN";
    findingCount: number;
    findings: ValidationFinding[];
    rawArtifact: string;
    rawArtifactDigest: string;
    startedAt: string;
    finishedAt: string;
    blockers: string[];
    artifact: string;
    digest: string;
}
export interface PersistSastEvidenceInputV1 {
    root: string;
    config: HarnessProjectConfig;
    checkId: string;
    adapter: SastAdapterV1;
    candidate: CandidateRevisionV1;
    command: string;
    tool: SastToolIdentityV1;
    status: "PASS" | "FAIL" | "WARN";
    findings: ValidationFinding[];
    rawArtifactText: string;
    isolation?: IsolationExecutionEvidenceV1;
    startedAt: string;
    finishedAt: string;
    blockers?: string[];
}
export declare function sastEvidenceDirectory(root: string, config: HarnessProjectConfig, candidate: Pick<CandidateRevisionV1, "candidateId" | "revision" | "identityDigest">): string;
export declare function sastEvidenceArtifactPath(root: string, config: HarnessProjectConfig, candidate: Pick<CandidateRevisionV1, "candidateId" | "revision" | "identityDigest">, checkId: string): string;
export declare function persistSastEvidenceV1(input: PersistSastEvidenceInputV1): Promise<SastEvidenceV1>;
export declare function loadSastEvidenceV1(root: string, config: HarnessProjectConfig, candidate: Pick<CandidateRevisionV1, "candidateId" | "revision" | "identityDigest">, checkId: string): Promise<SastEvidenceV1 | undefined>;
export interface SastEvidenceVerificationV1 {
    ok: boolean;
    blockers: string[];
    evidence?: SastEvidenceV1;
}
export declare function verifySastEvidenceV1(root: string, config: HarnessProjectConfig, evidence: SastEvidenceV1, expected: CandidateRevisionV1): Promise<SastEvidenceVerificationV1>;
export declare function requireSastEvidenceV1(root: string, config: HarnessProjectConfig, candidate: CandidateRevisionV1, checkId: string): Promise<SastEvidenceV1>;
export declare function extractSastToolVersion(adapter: SastAdapterV1, output: string): string;
