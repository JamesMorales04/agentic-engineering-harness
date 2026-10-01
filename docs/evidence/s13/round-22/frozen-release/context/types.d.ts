import { z } from "zod";
export declare const contextPreservationValues: readonly ["VERBATIM", "PROJECTABLE", "COMPRESSIBLE", "RETRIEVABLE", "DISCARDABLE"];
export type ContextPreservation = (typeof contextPreservationValues)[number];
export declare const contextKindValues: readonly ["instruction", "execution-envelope", "agent-charter", "skill", "normative", "source", "diff", "validation", "audit", "operation", "handoff", "tool-output", "memory", "repository-map", "raw-evidence", "delivery"];
export type ContextFragmentKind = (typeof contextKindValues)[number];
export interface ContextSource {
    artifact?: string;
    file?: string;
    sha256?: string;
}
export interface ContextFragment {
    id: string;
    kind: ContextFragmentKind;
    preservation: ContextPreservation;
    priority: number;
    content: string;
    source?: ContextSource;
    metadata?: Record<string, unknown>;
}
export interface ContextFragmentProjection extends Omit<ContextFragment, "content"> {
    content: string;
    estimatedTokens: number;
    originalTokens?: number;
    projected?: boolean;
    compressed?: boolean;
    compression?: {
        provider: string;
        providerVersion?: string;
        reversible: boolean;
        handle?: string;
    };
}
export interface ContextBudget {
    maxTokens: number;
    reserved: {
        instructions: number;
        normative: number;
        evidence: number;
        response: number;
    };
    role: string;
    phase: string;
}
export interface ContextEnvelope {
    version: 1;
    operationId: string;
    logicalAgent: string;
    phase: string;
    budget: {
        maximum: number;
        estimatedDelivered: number;
    };
    fragments: ContextFragmentProjection[];
    retrieval: {
        available: boolean;
        allowedFragmentIds: string[];
    };
    provenance: {
        sha256: string;
        createdAt: string;
        projectionVersion: string;
    };
}
export interface ContextMetrics {
    rawBytes: number;
    projectedBytes: number;
    deliveredBytes: number;
    estimatedRawTokens: number;
    estimatedDeliveredTokens: number;
    retrievedFragments: number;
    deliveredFragments: number;
    compressedFragments: number;
    discardedFragments: number;
    retrievalRequests: number;
    retrievalRetries: number;
    retrievalEscapes: number;
    compressionRatio?: number;
    projectionRatio?: number;
}
export interface ContextPreparationRequest {
    operationId: string;
    logicalAgent: string;
    role?: string;
    phase: string;
    fragments: ContextFragment[];
    capabilities?: {
        /** The transport exposes an authorized raw-fragment retrieval mechanism. */
        authorizedRetrieval?: boolean;
        /** The transport exposes the configured semantic repository provider. */
        semanticRetrieval?: boolean;
    };
}
export interface ContextPreparationResult {
    envelope: ContextEnvelope;
    rendered: string;
    metrics: ContextMetrics;
    retrieval: {
        root: string;
        operationId: string;
        logicalAgent: string;
        allowedFragmentIds: string[];
    };
}
export interface ContextBudgetConfigLike {
    inputTokens?: number;
    maxTokens?: number;
    reserved?: Partial<ContextBudget["reserved"]>;
}
export interface ContextPolicy {
    mode: "observe" | "enforce";
    defaultBudget: ContextBudgetConfigLike;
    agentBudgets: Record<string, ContextBudgetConfigLike>;
    phaseBudgets: Record<string, ContextBudgetConfigLike>;
    repositoryMap: {
        enabled: boolean;
        tokenBudget: number;
        maxGraphHops: number;
    };
    semanticRetrieval: {
        provider: string;
        required: boolean;
        editing: boolean;
    };
    compression: {
        provider: string;
        required: boolean;
        minTokens: number;
        reversible: boolean;
        command?: string;
    };
    retrieval: {
        maxRequestsPerTurn: number;
        maxTokensPerRequest: number;
        maxTotalTokensPerTurn: number;
    };
    outputPolicy: {
        enabled: boolean;
        modes: Record<string, "terse" | "compact" | "normal">;
    };
}
export declare const contextFragmentSchema: z.ZodObject<{
    id: z.ZodString;
    kind: z.ZodEnum<{
        source: "source";
        diff: "diff";
        instruction: "instruction";
        normative: "normative";
        operation: "operation";
        "repository-map": "repository-map";
        validation: "validation";
        handoff: "handoff";
        "raw-evidence": "raw-evidence";
        "execution-envelope": "execution-envelope";
        "agent-charter": "agent-charter";
        skill: "skill";
        audit: "audit";
        "tool-output": "tool-output";
        memory: "memory";
        delivery: "delivery";
    }>;
    preservation: z.ZodEnum<{
        VERBATIM: "VERBATIM";
        PROJECTABLE: "PROJECTABLE";
        COMPRESSIBLE: "COMPRESSIBLE";
        RETRIEVABLE: "RETRIEVABLE";
        DISCARDABLE: "DISCARDABLE";
    }>;
    priority: z.ZodNumber;
    content: z.ZodString;
    source: z.ZodOptional<z.ZodObject<{
        artifact: z.ZodOptional<z.ZodString>;
        file: z.ZodOptional<z.ZodString>;
        sha256: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
export declare const contextEnvelopeSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    operationId: z.ZodString;
    logicalAgent: z.ZodString;
    phase: z.ZodString;
    budget: z.ZodObject<{
        maximum: z.ZodNumber;
        estimatedDelivered: z.ZodNumber;
    }, z.core.$strip>;
    fragments: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        kind: z.ZodEnum<{
            source: "source";
            diff: "diff";
            instruction: "instruction";
            normative: "normative";
            operation: "operation";
            "repository-map": "repository-map";
            validation: "validation";
            handoff: "handoff";
            "raw-evidence": "raw-evidence";
            "execution-envelope": "execution-envelope";
            "agent-charter": "agent-charter";
            skill: "skill";
            audit: "audit";
            "tool-output": "tool-output";
            memory: "memory";
            delivery: "delivery";
        }>;
        preservation: z.ZodEnum<{
            VERBATIM: "VERBATIM";
            PROJECTABLE: "PROJECTABLE";
            COMPRESSIBLE: "COMPRESSIBLE";
            RETRIEVABLE: "RETRIEVABLE";
            DISCARDABLE: "DISCARDABLE";
        }>;
        priority: z.ZodNumber;
        content: z.ZodString;
        source: z.ZodOptional<z.ZodObject<{
            artifact: z.ZodOptional<z.ZodString>;
            file: z.ZodOptional<z.ZodString>;
            sha256: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        estimatedTokens: z.ZodNumber;
        originalTokens: z.ZodOptional<z.ZodNumber>;
        projected: z.ZodOptional<z.ZodBoolean>;
        compressed: z.ZodOptional<z.ZodBoolean>;
        compression: z.ZodOptional<z.ZodObject<{
            provider: z.ZodString;
            providerVersion: z.ZodOptional<z.ZodString>;
            reversible: z.ZodBoolean;
            handle: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    retrieval: z.ZodObject<{
        available: z.ZodBoolean;
        allowedFragmentIds: z.ZodArray<z.ZodString>;
    }, z.core.$strip>;
    provenance: z.ZodObject<{
        sha256: z.ZodString;
        createdAt: z.ZodString;
        projectionVersion: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare function assertContextFragment(value: unknown): ContextFragment;
export declare function assertContextEnvelope(value: unknown): ContextEnvelope;
