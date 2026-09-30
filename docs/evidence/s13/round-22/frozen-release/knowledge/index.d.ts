export type KnowledgeModeV1 = "OFFLINE" | "DOCS_ONLY" | "TRUSTED_DISCOVERY";
export declare const knowledgeSufficiencyStatusValues: readonly ["VERIFIED", "GROUNDED", "PRIOR_ONLY", "PARTIAL", "MISSING", "STALE", "CONFLICTING"];
export type KnowledgeSufficiencyStatusV1 = (typeof knowledgeSufficiencyStatusValues)[number];
export interface KnowledgeSourceV1 {
    uri: string;
    kind: "official" | "repository" | "public-code" | "unknown";
    version?: string;
}
export interface KnowledgeClaimV1 {
    id: string;
    statement: string;
    competency: string;
    confidence: "high" | "medium" | "low";
}
export interface KnowledgePackV1 {
    version: 1;
    cacheKey: string;
    topic: string;
    claims: KnowledgeClaimV1[];
    sources: KnowledgeSourceV1[];
    retrievedAt: string;
    packDigest: string;
}
/** Untrusted Librarian proposal. It carries no trust assertion. */
export interface SkillCandidateV1 {
    version: 1;
    id: string;
    competency: string;
    procedure: string[];
    sourcePackDigest: string;
    procedureEvidence: Array<{
        stepIndex: number;
        claimIds: string[];
        sourceUris: string[];
    }>;
}
export interface GroundedProcedureStepV1 {
    stepIndex: number;
    procedureDigest: string;
    claims: Array<{
        claimId: string;
        claimDigest: string;
        sourceUris: string[];
    }>;
}
/** Created only by SkillTrustGate after validating the candidate and its pack. */
export interface AcceptedEphemeralSkillV1 extends SkillCandidateV1 {
    groundedProcedure: GroundedProcedureStepV1[];
    trustDecision: {
        version: 1;
        status: "ACCEPTED";
        mode: KnowledgeModeV1;
        packDigest: string;
        policyDigest: string;
        cacheKey: string;
        decisionDigest: string;
    };
}
export interface KnowledgeGapV1 {
    version: 1;
    cacheKey: string;
    missingCompetencies: string[];
    mode: KnowledgeModeV1;
    librarianRequired: boolean;
    reason: string;
    status: Extract<KnowledgeSufficiencyStatusV1, "MISSING" | "PARTIAL" | "STALE" | "CONFLICTING">;
}
export interface KnowledgeResolutionV1 {
    gate: "SUFFICIENT" | "GAP";
    status: KnowledgeSufficiencyStatusV1;
    gap?: KnowledgeGapV1;
    pack?: KnowledgePackV1;
    cacheHit: boolean;
    acceptedSkill?: AcceptedEphemeralSkillV1;
}
/** Raw Librarian output. The trust gate consumes this proposal after pack validation. */
export interface KnowledgeLookupResultV1 {
    pack: KnowledgePackV1;
    skillCandidate?: SkillCandidateV1;
}
export interface KnowledgeCacheEntryV1 {
    key: string;
    pack: KnowledgePackV1;
}
export interface KnowledgeCacheV1 {
    get(key: string): Promise<KnowledgePackV1 | undefined>;
    set(entry: KnowledgeCacheEntryV1): Promise<void>;
}
/** Process-local cache for bounded tests and callers that do not need persistence. */
export declare class InMemoryKnowledgeCacheV1 implements KnowledgeCacheV1 {
    private readonly entries;
    get(key: string): Promise<KnowledgePackV1 | undefined>;
    set(entry: KnowledgeCacheEntryV1): Promise<void>;
}
/** One immutable, atomically replaced file per policy-bound cache key. */
export declare class FileKnowledgeCacheV1 implements KnowledgeCacheV1 {
    private readonly directory;
    constructor(directory: string);
    get(key: string): Promise<KnowledgePackV1 | undefined>;
    set(entry: KnowledgeCacheEntryV1): Promise<void>;
    private fileFor;
}
export declare function knowledgeSourcePolicyDigest(mode: KnowledgeModeV1): string;
export declare function evaluateKnowledgeGate(input: {
    requiredCompetencies: readonly string[];
    knownCompetencies: readonly string[];
    stackDigest?: string;
    versions?: Readonly<Record<string, string>>;
    mode?: KnowledgeModeV1;
}): KnowledgeGapV1 | undefined;
export declare function resolveKnowledgeGate(input: {
    requiredCompetencies: readonly string[];
    knownCompetencies: readonly string[];
    stackDigest?: string;
    versions?: Readonly<Record<string, string>>;
    mode?: KnowledgeModeV1;
    cache?: KnowledgeCacheV1;
    lookup?: (gap: KnowledgeGapV1) => Promise<KnowledgePackV1 | KnowledgeLookupResultV1>;
}): Promise<KnowledgeResolutionV1>;
export declare function validateKnowledgePack(pack: KnowledgePackV1, gap: KnowledgeGapV1): KnowledgePackV1;
/** Deterministic trust gate for an operation-local skill derived from accepted knowledge. */
export declare function applySkillTrustGate(candidate: SkillCandidateV1 | undefined, pack: KnowledgePackV1, gap: KnowledgeGapV1): AcceptedEphemeralSkillV1 | undefined;
export declare function validateAcceptedEphemeralSkill(skill: AcceptedEphemeralSkillV1, pack: KnowledgePackV1, gap: KnowledgeGapV1): AcceptedEphemeralSkillV1;
export declare function assertSkillTrustDecision(skill: AcceptedEphemeralSkillV1): void;
export declare function knowledgePack(input: Omit<KnowledgePackV1, "version" | "packDigest">): KnowledgePackV1;
