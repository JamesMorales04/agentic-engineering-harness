import type { HarnessProjectConfig } from "../core/types.js";
import { type BuildIdentityV1 } from "../build/identity.js";
import { type CandidateRevisionV1 } from "../operations/v2Contracts.js";
export declare const PROVENANCE_MANIFEST_VERSION: 2;
export declare const PROVENANCE_BUILDER_ID = "https://github.com/JamesMorales04/agentic-engineering-harness";
export interface ProvenanceOptions {
    artifact: string;
    taskId?: string;
    sbom?: boolean;
    sign?: boolean;
}
export interface ProvenanceManifestEntry {
    path: string;
    sha256: string;
    kind: string;
}
export interface ProvenanceManifest {
    version: typeof PROVENANCE_MANIFEST_VERSION;
    buildIdentity: BuildIdentityV1;
    candidate?: CandidateRevisionV1;
    policyDigest: string;
    generatedAt: string;
    taskId?: string;
    subject: {
        path: string;
        sha256: string;
    };
    entries: ProvenanceManifestEntry[];
    lineage?: {
        operationId?: string;
        gitCommit?: string;
        required: string[];
        members: string[];
    };
    attestations?: {
        statement: string;
        predicate: string;
        bundle?: string;
    };
}
export interface ProvenanceResult {
    artifact: string;
    sha256: string;
    statementFile: string;
    predicateFile: string;
    manifestFile: string;
    sbomFile?: string;
    bundleFile?: string;
}
export interface SupplyChainGateContextV1 {
    candidate: CandidateRevisionV1;
    artifactPath: string;
}
export interface SupplyChainGateResult {
    ok: boolean;
    failures: string[];
    manifestFile?: string;
    statementFile?: string;
    bundleFile?: string;
    sbomFile?: string;
}
export declare function generateProvenance(root: string, config: HarnessProjectConfig, options: ProvenanceOptions): Promise<ProvenanceResult>;
export declare function buildSlsaPredicate(input: {
    project: string;
    artifact: string;
    taskId?: string;
    commit: string;
    remote: string;
    runDigest?: string;
    reportDigest?: string;
    artifactManifestSha256?: string;
    sbomSha256?: string;
    artifactSha256?: string;
    buildIdentity?: BuildIdentityV1;
    candidate?: CandidateRevisionV1;
    policyDigest?: string;
    buildType: string;
    invocationId: string;
    startedOn: string;
    finishedOn: string;
}): Record<string, unknown>;
export declare function buildProvenanceManifest(root: string, config: HarnessProjectConfig, taskId: string | undefined, artifact: string, sbomFile?: string, suppliedCandidate?: CandidateRevisionV1): Promise<ProvenanceManifest>;
export declare function verifyProvenanceManifest(root: string, manifestFile: string, verificationPublicKey?: string): Promise<{
    ok: boolean;
    failures: string[];
}>;
export declare function verifyCosignBundle(root: string, statementFile: string, bundleFile: string, key?: string): Promise<boolean>;
/** Deterministic S7 gate. It is inert unless supply-chain policy requires evidence. */
export declare function verifySupplyChainGate(root: string, config: HarnessProjectConfig, context?: SupplyChainGateContextV1): Promise<SupplyChainGateResult>;
export declare function isStrictSupplyChainPolicy(config: HarnessProjectConfig): boolean;
export declare function provenancePolicyDigest(config: HarnessProjectConfig): string;
export declare function sha256File(file: string): Promise<string>;
export declare function currentCandidateForTask(root: string, taskId: string, config: HarnessProjectConfig): Promise<CandidateRevisionV1 | undefined>;
