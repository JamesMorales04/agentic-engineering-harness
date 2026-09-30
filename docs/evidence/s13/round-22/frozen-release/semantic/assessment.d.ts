import { z } from "zod";
import type { AgentExecutionSelection, ResolvedAgentTopology } from "../agents/types.js";
export declare const semanticAssessmentTypeValues: readonly ["INTENT", "ROUTE", "STACK", "ISSUE", "FAILURE", "CANDIDATE_IMPACT", "VALIDATION_NEED"];
export type SemanticAssessmentTypeV1 = (typeof semanticAssessmentTypeValues)[number];
export declare const semanticAssessmentTypeSchema: z.ZodEnum<{
    CANDIDATE_IMPACT: "CANDIDATE_IMPACT";
    INTENT: "INTENT";
    ROUTE: "ROUTE";
    STACK: "STACK";
    ISSUE: "ISSUE";
    FAILURE: "FAILURE";
    VALIDATION_NEED: "VALIDATION_NEED";
}>;
export declare const reasoningClassValues: readonly ["LIGHT", "STANDARD", "DEEP"];
export type ReasoningClassV1 = (typeof reasoningClassValues)[number];
export declare const reasoningClassSchema: z.ZodEnum<{
    STANDARD: "STANDARD";
    LIGHT: "LIGHT";
    DEEP: "DEEP";
}>;
export declare const assessmentContextClassValues: readonly ["SMALL", "STANDARD", "LARGE"];
export type AssessmentContextClassV1 = (typeof assessmentContextClassValues)[number];
export declare const assessmentContextClassSchema: z.ZodEnum<{
    STANDARD: "STANDARD";
    LARGE: "LARGE";
    SMALL: "SMALL";
}>;
export declare const assessmentRiskClassValues: readonly ["LOW", "STANDARD", "HIGH", "CRITICAL"];
export type AssessmentRiskClassV1 = (typeof assessmentRiskClassValues)[number];
export declare const assessmentRiskClassSchema: z.ZodEnum<{
    STANDARD: "STANDARD";
    CRITICAL: "CRITICAL";
    HIGH: "HIGH";
    LOW: "LOW";
}>;
export declare const decisionMechanismValues: readonly ["DETERMINISTIC", "MODEL", "HYBRID"];
export type DecisionMechanismV1 = (typeof decisionMechanismValues)[number];
export declare const decisionMechanismSchema: z.ZodEnum<{
    MODEL: "MODEL";
    DETERMINISTIC: "DETERMINISTIC";
    HYBRID: "HYBRID";
}>;
export interface AssessmentRequirementV1 {
    reasoningClass: ReasoningClassV1;
    structuredOutputRequired: boolean;
    independenceRequired: boolean;
    externalKnowledgeRequired: boolean;
    maxContextClass: AssessmentContextClassV1;
    riskClass: AssessmentRiskClassV1;
}
export interface SemanticAssessmentBindingV1 {
    projectId: string;
    repositoryDigest: string;
    repositoryRootDigest?: string;
    operationId?: string;
    candidateId?: string;
    candidateRevision?: number;
    candidateDigest?: string;
    intentDigest?: string;
}
export declare const semanticAssessmentBindingV1Schema: z.ZodObject<{
    projectId: z.ZodString;
    repositoryDigest: z.ZodString;
    repositoryRootDigest: z.ZodOptional<z.ZodString>;
    operationId: z.ZodOptional<z.ZodString>;
    candidateId: z.ZodOptional<z.ZodString>;
    candidateRevision: z.ZodOptional<z.ZodNumber>;
    candidateDigest: z.ZodOptional<z.ZodString>;
    intentDigest: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export interface SemanticEvidenceItemV1 {
    ref: string;
    content: string;
}
export declare const semanticEvidenceReceiptKindValues: readonly ["REQUEST", "OBSERVED_FACT", "REPOSITORY_FILE", "CANDIDATE_FILE", "OPERATION_ARTIFACT"];
export type SemanticEvidenceReceiptKindV1 = (typeof semanticEvidenceReceiptKindValues)[number];
export interface SemanticEvidenceReceiptV1 {
    version: 1;
    reader: "aeh-controller-v1";
    kind: SemanticEvidenceReceiptKindV1;
    ref: string;
    path?: string;
    contentDigest: string;
    contentBytes: number;
    boundaryDigest: string;
    receiptDigest: string;
}
export declare function semanticEvidenceBoundaryDigest(binding: SemanticAssessmentBindingV1): string;
/** Create a receipt for exact controller-supplied bytes; file callers must first enforce the repository/candidate read boundary. */
export declare function createSemanticEvidenceReceiptV1(input: {
    binding: SemanticAssessmentBindingV1;
    ref: string;
    content: string;
    kind: SemanticEvidenceReceiptKindV1;
    path?: string;
}): SemanticEvidenceReceiptV1;
export interface SemanticAssessmentRequestV1 {
    version: 1;
    assessmentType: SemanticAssessmentTypeV1;
    evidenceRefs: string[];
    compactEvidence: SemanticEvidenceItemV1[];
    evidenceReceipts: SemanticEvidenceReceiptV1[];
    requiredOutputSchema: string;
    reasoningRequirement: AssessmentRequirementV1;
    binding: SemanticAssessmentBindingV1;
    budget: {
        maxInputTokens?: number;
        maxOutputTokens?: number;
        deadlineMs?: number;
    };
    policyRevision: string;
}
export declare const semanticAssessmentRequestV1Schema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    assessmentType: z.ZodEnum<{
        CANDIDATE_IMPACT: "CANDIDATE_IMPACT";
        INTENT: "INTENT";
        ROUTE: "ROUTE";
        STACK: "STACK";
        ISSUE: "ISSUE";
        FAILURE: "FAILURE";
        VALIDATION_NEED: "VALIDATION_NEED";
    }>;
    evidenceRefs: z.ZodArray<z.ZodString>;
    compactEvidence: z.ZodArray<z.ZodObject<{
        ref: z.ZodString;
        content: z.ZodString;
    }, z.core.$strict>>;
    evidenceReceipts: z.ZodArray<z.ZodObject<{
        version: z.ZodLiteral<1>;
        reader: z.ZodLiteral<"aeh-controller-v1">;
        kind: z.ZodEnum<{
            OPERATION_ARTIFACT: "OPERATION_ARTIFACT";
            REQUEST: "REQUEST";
            OBSERVED_FACT: "OBSERVED_FACT";
            REPOSITORY_FILE: "REPOSITORY_FILE";
            CANDIDATE_FILE: "CANDIDATE_FILE";
        }>;
        ref: z.ZodString;
        path: z.ZodOptional<z.ZodString>;
        contentDigest: z.ZodString;
        contentBytes: z.ZodNumber;
        boundaryDigest: z.ZodString;
        receiptDigest: z.ZodString;
    }, z.core.$strict>>;
    requiredOutputSchema: z.ZodLiteral<"semantic-assessment-v1">;
    reasoningRequirement: z.ZodObject<{
        reasoningClass: z.ZodEnum<{
            STANDARD: "STANDARD";
            LIGHT: "LIGHT";
            DEEP: "DEEP";
        }>;
        structuredOutputRequired: z.ZodBoolean;
        independenceRequired: z.ZodBoolean;
        externalKnowledgeRequired: z.ZodBoolean;
        maxContextClass: z.ZodEnum<{
            STANDARD: "STANDARD";
            LARGE: "LARGE";
            SMALL: "SMALL";
        }>;
        riskClass: z.ZodEnum<{
            STANDARD: "STANDARD";
            CRITICAL: "CRITICAL";
            HIGH: "HIGH";
            LOW: "LOW";
        }>;
    }, z.core.$strict>;
    binding: z.ZodObject<{
        projectId: z.ZodString;
        repositoryDigest: z.ZodString;
        repositoryRootDigest: z.ZodOptional<z.ZodString>;
        operationId: z.ZodOptional<z.ZodString>;
        candidateId: z.ZodOptional<z.ZodString>;
        candidateRevision: z.ZodOptional<z.ZodNumber>;
        candidateDigest: z.ZodOptional<z.ZodString>;
        intentDigest: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    budget: z.ZodObject<{
        maxInputTokens: z.ZodOptional<z.ZodNumber>;
        maxOutputTokens: z.ZodOptional<z.ZodNumber>;
        deadlineMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>;
    policyRevision: z.ZodString;
}, z.core.$strict>;
export declare const candidateReviewDimensionSchema: z.ZodEnum<{
    operations: "operations";
    architecture: "architecture";
    security: "security";
    "authentication/authorization": "authentication/authorization";
    "public API": "public API";
    "migration/schema": "migration/schema";
    "dependency/supply chain": "dependency/supply chain";
    "UI/browser": "UI/browser";
    "UI/visual": "UI/visual";
    concurrency: "concurrency";
    "behavior.correctness": "behavior.correctness";
}>;
declare const semanticJudgmentSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"INTENT">;
    intent: z.ZodEnum<{
        audit: "audit";
        informational: "informational";
        change: "change";
    }>;
    confidence: z.ZodNumber;
    evidenceRefs: z.ZodArray<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"ROUTE">;
    recommendedRoute: z.ZodEnum<{
        DIRECT: "DIRECT";
        DELEGATED: "DELEGATED";
        FORMAL_SDD: "FORMAL_SDD";
    }>;
    scopeClarity: z.ZodEnum<{
        HIGH: "HIGH";
        LOW: "LOW";
        MEDIUM: "MEDIUM";
    }>;
    decompositionNeed: z.ZodBoolean;
    coordinationNeed: z.ZodBoolean;
    architectureUncertainty: z.ZodBoolean;
    productUncertainty: z.ZodBoolean;
    formalizationNeed: z.ZodEnum<{
        NONE: "NONE";
        REQUIRED: "REQUIRED";
        RECOMMENDED: "RECOMMENDED";
    }>;
    semanticRiskSignals: z.ZodArray<z.ZodString>;
    evidenceRefs: z.ZodArray<z.ZodString>;
    unknowns: z.ZodArray<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"FAILURE">;
    classification: z.ZodEnum<{
        PATCH_CONTEXT_MISMATCH: "PATCH_CONTEXT_MISMATCH";
        TOOL_FAILURE: "TOOL_FAILURE";
        MISSING_CONTEXT: "MISSING_CONTEXT";
        WRONG_AGENT: "WRONG_AGENT";
        VALIDATION_FAILURE: "VALIDATION_FAILURE";
        REVIEW_FAILURE: "REVIEW_FAILURE";
        AMBIGUOUS_OUTPUT: "AMBIGUOUS_OUTPUT";
        CONFLICTING_RESULTS: "CONFLICTING_RESULTS";
    }>;
    evidenceRefs: z.ZodArray<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"STACK">;
    languages: z.ZodArray<z.ZodString>;
    frameworks: z.ZodArray<z.ZodString>;
    packageManagers: z.ZodArray<z.ZodString>;
    databases: z.ZodArray<z.ZodString>;
    toolchains: z.ZodArray<z.ZodString>;
    signals: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        evidenceRef: z.ZodString;
    }, z.core.$strict>>;
    testFrameworks: z.ZodArray<z.ZodString>;
    migrationMechanisms: z.ZodArray<z.ZodString>;
    buildSystems: z.ZodArray<z.ZodString>;
    versions: z.ZodRecord<z.ZodString, z.ZodString>;
    projectSkillRoots: z.ZodArray<z.ZodString>;
    evidenceRefs: z.ZodArray<z.ZodString>;
    unknowns: z.ZodArray<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"ISSUE">;
    classification: z.ZodEnum<{
        ready: "ready";
        requires_product_decision: "requires_product_decision";
        spec_contradiction: "spec_contradiction";
    }>;
    requestedOutcome: z.ZodString;
    explicitRequirements: z.ZodArray<z.ZodObject<{
        statement: z.ZodString;
        evidenceRefs: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
    evidenceRefs: z.ZodArray<z.ZodString>;
    unknowns: z.ZodArray<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"CANDIDATE_IMPACT">;
    changedFiles: z.ZodArray<z.ZodString>;
    changeKinds: z.ZodArray<z.ZodEnum<{
        source: "source";
        test: "test";
        schema: "schema";
        config: "config";
        docs: "docs";
        dependency: "dependency";
        infrastructure: "infrastructure";
        security: "security";
    }>>;
    reviewDimensions: z.ZodArray<z.ZodEnum<{
        operations: "operations";
        architecture: "architecture";
        security: "security";
        "authentication/authorization": "authentication/authorization";
        "public API": "public API";
        "migration/schema": "migration/schema";
        "dependency/supply chain": "dependency/supply chain";
        "UI/browser": "UI/browser";
        "UI/visual": "UI/visual";
        concurrency: "concurrency";
        "behavior.correctness": "behavior.correctness";
    }>>;
    requiresIndependentReview: z.ZodBoolean;
    evidenceRefs: z.ZodArray<z.ZodString>;
    unknowns: z.ZodArray<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"VALIDATION_NEED">;
    property: z.ZodString;
    rationale: z.ZodString;
    scope: z.ZodArray<z.ZodString>;
    evidenceRefs: z.ZodArray<z.ZodString>;
    unknowns: z.ZodArray<z.ZodString>;
}, z.core.$strict>], "type">;
export type SemanticAssessmentJudgmentV1 = z.infer<typeof semanticJudgmentSchema>;
export type SemanticStackJudgmentV1 = Extract<SemanticAssessmentJudgmentV1, {
    type: "STACK";
}>;
export type SemanticIssueJudgmentV1 = Extract<SemanticAssessmentJudgmentV1, {
    type: "ISSUE";
}>;
export type SemanticCandidateImpactJudgmentV1 = Extract<SemanticAssessmentJudgmentV1, {
    type: "CANDIDATE_IMPACT";
}>;
export type SemanticValidationNeedJudgmentV1 = Extract<SemanticAssessmentJudgmentV1, {
    type: "VALIDATION_NEED";
}>;
export declare const semanticAssessmentPayloadV1Schema: z.ZodObject<{
    judgment: z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"INTENT">;
        intent: z.ZodEnum<{
            audit: "audit";
            informational: "informational";
            change: "change";
        }>;
        confidence: z.ZodNumber;
        evidenceRefs: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"ROUTE">;
        recommendedRoute: z.ZodEnum<{
            DIRECT: "DIRECT";
            DELEGATED: "DELEGATED";
            FORMAL_SDD: "FORMAL_SDD";
        }>;
        scopeClarity: z.ZodEnum<{
            HIGH: "HIGH";
            LOW: "LOW";
            MEDIUM: "MEDIUM";
        }>;
        decompositionNeed: z.ZodBoolean;
        coordinationNeed: z.ZodBoolean;
        architectureUncertainty: z.ZodBoolean;
        productUncertainty: z.ZodBoolean;
        formalizationNeed: z.ZodEnum<{
            NONE: "NONE";
            REQUIRED: "REQUIRED";
            RECOMMENDED: "RECOMMENDED";
        }>;
        semanticRiskSignals: z.ZodArray<z.ZodString>;
        evidenceRefs: z.ZodArray<z.ZodString>;
        unknowns: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"FAILURE">;
        classification: z.ZodEnum<{
            PATCH_CONTEXT_MISMATCH: "PATCH_CONTEXT_MISMATCH";
            TOOL_FAILURE: "TOOL_FAILURE";
            MISSING_CONTEXT: "MISSING_CONTEXT";
            WRONG_AGENT: "WRONG_AGENT";
            VALIDATION_FAILURE: "VALIDATION_FAILURE";
            REVIEW_FAILURE: "REVIEW_FAILURE";
            AMBIGUOUS_OUTPUT: "AMBIGUOUS_OUTPUT";
            CONFLICTING_RESULTS: "CONFLICTING_RESULTS";
        }>;
        evidenceRefs: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"STACK">;
        languages: z.ZodArray<z.ZodString>;
        frameworks: z.ZodArray<z.ZodString>;
        packageManagers: z.ZodArray<z.ZodString>;
        databases: z.ZodArray<z.ZodString>;
        toolchains: z.ZodArray<z.ZodString>;
        signals: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            evidenceRef: z.ZodString;
        }, z.core.$strict>>;
        testFrameworks: z.ZodArray<z.ZodString>;
        migrationMechanisms: z.ZodArray<z.ZodString>;
        buildSystems: z.ZodArray<z.ZodString>;
        versions: z.ZodRecord<z.ZodString, z.ZodString>;
        projectSkillRoots: z.ZodArray<z.ZodString>;
        evidenceRefs: z.ZodArray<z.ZodString>;
        unknowns: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"ISSUE">;
        classification: z.ZodEnum<{
            ready: "ready";
            requires_product_decision: "requires_product_decision";
            spec_contradiction: "spec_contradiction";
        }>;
        requestedOutcome: z.ZodString;
        explicitRequirements: z.ZodArray<z.ZodObject<{
            statement: z.ZodString;
            evidenceRefs: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>;
        evidenceRefs: z.ZodArray<z.ZodString>;
        unknowns: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"CANDIDATE_IMPACT">;
        changedFiles: z.ZodArray<z.ZodString>;
        changeKinds: z.ZodArray<z.ZodEnum<{
            source: "source";
            test: "test";
            schema: "schema";
            config: "config";
            docs: "docs";
            dependency: "dependency";
            infrastructure: "infrastructure";
            security: "security";
        }>>;
        reviewDimensions: z.ZodArray<z.ZodEnum<{
            operations: "operations";
            architecture: "architecture";
            security: "security";
            "authentication/authorization": "authentication/authorization";
            "public API": "public API";
            "migration/schema": "migration/schema";
            "dependency/supply chain": "dependency/supply chain";
            "UI/browser": "UI/browser";
            "UI/visual": "UI/visual";
            concurrency: "concurrency";
            "behavior.correctness": "behavior.correctness";
        }>>;
        requiresIndependentReview: z.ZodBoolean;
        evidenceRefs: z.ZodArray<z.ZodString>;
        unknowns: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"VALIDATION_NEED">;
        property: z.ZodString;
        rationale: z.ZodString;
        scope: z.ZodArray<z.ZodString>;
        evidenceRefs: z.ZodArray<z.ZodString>;
        unknowns: z.ZodArray<z.ZodString>;
    }, z.core.$strict>], "type">;
    claims: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        statement: z.ZodString;
        status: z.ZodEnum<{
            CONFLICTING: "CONFLICTING";
            SUPPORTED: "SUPPORTED";
            UNCERTAIN: "UNCERTAIN";
        }>;
        evidenceRefs: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
    assumptions: z.ZodArray<z.ZodString>;
    unknowns: z.ZodArray<z.ZodString>;
    recommendations: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        statement: z.ZodString;
        evidenceRefs: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
    knowledgeGaps: z.ZodArray<z.ZodObject<{
        competency: z.ZodString;
        reason: z.ZodString;
        blocking: z.ZodBoolean;
        evidenceRefs: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type SemanticAssessmentPayloadV1 = z.infer<typeof semanticAssessmentPayloadV1Schema>;
export interface SemanticAssessorIdentityV1 {
    version: 1;
    role: "Semantic Assessor";
    logicalAgent: string;
    topologyProfile?: string;
    modelAlias: string;
    modelId: string;
    modelName: string;
    modelProvider?: string;
    runtimeName: string;
    runtimeAdapter: string;
    paseoProvider: string;
    variant?: string;
    identityDigest: string;
}
export interface ResolvedSemanticAssessorV1 {
    identity: SemanticAssessorIdentityV1;
    selection: AgentExecutionSelection;
}
export interface SemanticPaseoSessionIdentityV1 {
    provider: string;
    agentId: string;
    workspaceId?: string;
    transport: "sdk" | "cli";
}
export interface SemanticAssessmentV1 extends SemanticAssessmentPayloadV1 {
    version: 1;
    assessmentType: SemanticAssessmentTypeV1;
    mechanism: "MODEL";
    binding: SemanticAssessmentBindingV1;
    policyRevision: string;
    evidenceRefs: string[];
    evidenceReceipts: SemanticEvidenceReceiptV1[];
    evidenceDigest: string;
    assessor: SemanticAssessorIdentityV1;
    paseoSession: SemanticPaseoSessionIdentityV1;
    assessmentDigest: string;
    cacheIdentity: string;
    cacheDisposition: "FRESH" | "HIT";
}
export interface SemanticAssessmentTelemetryV1 {
    assessmentType: SemanticAssessmentTypeV1;
    assessorId: string;
    paseoAgentId: string;
    evidenceDigest: string;
    assessmentDigest: string;
    cacheHit: boolean;
}
export interface SemanticAssessmentCacheV1 {
    get(key: string): Promise<SemanticAssessmentV1 | undefined>;
    set(key: string, value: SemanticAssessmentV1): Promise<void>;
}
export declare class InMemorySemanticAssessmentCacheV1 implements SemanticAssessmentCacheV1 {
    private readonly values;
    get(key: string): Promise<SemanticAssessmentV1 | undefined>;
    set(key: string, value: SemanticAssessmentV1): Promise<void>;
}
/** Durable controller-owned storage for complete, provenance-bearing assessments. */
export declare class FileSemanticAssessmentCacheV1 implements SemanticAssessmentCacheV1 {
    private readonly directory;
    constructor(root: string);
    get(key: string): Promise<SemanticAssessmentV1 | undefined>;
    set(key: string, value: SemanticAssessmentV1): Promise<void>;
}
export interface SemanticAssessmentRunnerResultV1 {
    payload: unknown;
    paseoSession: SemanticPaseoSessionIdentityV1;
    /** Bounded, sanitized fingerprint of the raw model reply for failure diagnosis. Never authority. */
    rawReply?: SemanticReplyFingerprintV1;
}
export interface SemanticReplyFingerprintV1 {
    version: 1;
    lengthBytes: number;
    sha256: string;
    head: string;
}
/**
 * Bounded, sanitized fingerprint of a rejected raw model reply. It records length, digest and a
 * short control-character-free prefix so the next assessor failure is diagnosable without
 * persisting or re-interpreting raw model prose.
 */
export declare function semanticReplyFingerprintV1(raw: string): SemanticReplyFingerprintV1;
export declare function semanticReplyDiagnosticV1(diagnostic: {
    sessionId?: string;
    fingerprint?: SemanticReplyFingerprintV1;
}): string;
/** Production runners must execute the selected AEH agent through Paseo; provider inference calls are not this interface. */
export interface SemanticAssessmentRunnerV1 {
    assess(input: {
        request: SemanticAssessmentRequestV1;
        assessor: SemanticAssessorIdentityV1;
        repair?: {
            attempt: number;
            reason: string;
        };
    }): Promise<SemanticAssessmentRunnerResultV1>;
}
export interface SemanticAssessmentServiceOptionsV1 {
    assessor: ResolvedSemanticAssessorV1;
    runner: SemanticAssessmentRunnerV1;
    policyRevision: string;
    cache?: SemanticAssessmentCacheV1;
    onTelemetry?: (event: SemanticAssessmentTelemetryV1) => Promise<void> | void;
}
export interface SemanticAssessmentAttemptOptionsV1 {
    /**
     * Caps provider turns launched inside this single call. Defaults to
     * MAX_SEMANTIC_PAYLOAD_ATTEMPTS. A composing caller that owns its own bounded correction loop
     * passes 1 so nested retries cannot multiply real-model attempts.
     */
    attemptBudget?: number;
}
export declare const semanticCapabilityPolicyRevisionV1 = "core-semantic-capability-policy-v1";
/**
 * Bound a topology-configured Paseo thinking option by the request's declared reasoning class.
 * The topology remains the upper bound; the assessment request cannot raise reasoning above it.
 * Deterministic and provider-appropriate: LIGHT requests must not launch a max-reasoning turn.
 */
export declare function boundSemanticThinkingOptionV1(variant: string | undefined, reasoningClass: ReasoningClassV1): string | undefined;
/** Model-backed semantic assessment deadline that accommodates a cold real provider launch (Paseo + CLI agent) without weakening any authority or acceptance semantics. */
export declare const semanticModelDeadlineMsV1 = 300000;
/**
 * Bounded retry for non-authoritative invalid model output. A real local model occasionally
 * returns prose, truncated JSON, or a schema-incomplete payload; one bounded re-ask is allowed
 * before the assessment fails closed. Provider unavailability, policy, evidence, and authority
 * failures are never retried.
 */
export declare const MAX_SEMANTIC_PAYLOAD_ATTEMPTS = 2;
export declare const semanticCapabilityPolicyV1: Readonly<Record<SemanticAssessmentTypeV1, {
    maxInputTokens: number;
    maxOutputTokens: number;
    maxDeadlineMs: number;
    maxReasoningClass: ReasoningClassV1;
    maxContextClass: AssessmentContextClassV1;
    maxRiskClass: AssessmentRiskClassV1;
}>>;
export declare function resolveSemanticAssessor(topology: ResolvedAgentTopology): ResolvedSemanticAssessorV1;
export declare function semanticEvidenceReceiptDigest(receipt: SemanticEvidenceReceiptV1): string;
export declare function semanticAssessmentEvidenceDigest(request: Pick<SemanticAssessmentRequestV1, "evidenceRefs" | "compactEvidence" | "evidenceReceipts">): string;
export declare class SemanticAssessmentServiceV1 {
    private readonly options;
    private readonly cache;
    constructor(options: SemanticAssessmentServiceOptionsV1);
    assess(request: SemanticAssessmentRequestV1, options?: SemanticAssessmentAttemptOptionsV1): Promise<SemanticAssessmentV1>;
    private emitTelemetry;
}
export declare function createSemanticAssessmentServiceV1(options: SemanticAssessmentServiceOptionsV1): SemanticAssessmentServiceV1;
export interface DecisionMechanismAssessmentV1 {
    version: 1;
    mechanism: DecisionMechanismV1;
    rationale: string;
    deterministicFacts: string[];
    semanticJudgment?: string;
    controlledAction?: string;
}
export {};
