import { z } from "zod";

export const contextPreservationValues = ["VERBATIM", "PROJECTABLE", "COMPRESSIBLE", "RETRIEVABLE", "DISCARDABLE"] as const;
export type ContextPreservation = (typeof contextPreservationValues)[number];
export const contextKindValues = ["instruction", "execution-envelope", "agent-charter", "skill", "normative", "source", "diff", "validation", "audit", "operation", "handoff", "tool-output", "memory", "repository-map", "raw-evidence", "delivery"] as const;
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
  compression?: { provider: string; providerVersion?: string; reversible: boolean; handle?: string };
}

export interface ContextBudget {
  maxTokens: number;
  reserved: { instructions: number; normative: number; evidence: number; response: number };
  role: string;
  phase: string;
}

export interface ContextEnvelope {
  version: 1;
  operationId: string;
  logicalAgent: string;
  phase: string;
  budget: { maximum: number; estimatedDelivered: number };
  fragments: ContextFragmentProjection[];
  retrieval: { available: boolean; allowedFragmentIds: string[] };
  provenance: { sha256: string; createdAt: string; projectionVersion: string };
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
  retrieval: { root: string; operationId: string; logicalAgent: string; allowedFragmentIds: string[] };
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
  repositoryMap: { enabled: boolean; tokenBudget: number; maxGraphHops: number };
  semanticRetrieval: { provider: string; required: boolean; editing: boolean };
  compression: { provider: string; required: boolean; minTokens: number; reversible: boolean; command?: string };
  retrieval: { maxRequestsPerTurn: number; maxTokensPerRequest: number; maxTotalTokensPerTurn: number };
  outputPolicy: { enabled: boolean; modes: Record<string, "terse" | "compact" | "normal"> };
}

export const contextFragmentSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(contextKindValues),
  preservation: z.enum(contextPreservationValues),
  priority: z.number().finite(),
  content: z.string(),
  source: z.object({ artifact: z.string().optional(), file: z.string().optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const contextEnvelopeSchema = z.object({
  version: z.literal(1),
  operationId: z.string().min(1),
  logicalAgent: z.string().min(1),
  phase: z.string().min(1),
  budget: z.object({ maximum: z.number().int().positive(), estimatedDelivered: z.number().int().nonnegative() }),
  fragments: z.array(contextFragmentSchema.extend({ estimatedTokens: z.number().int().nonnegative(), originalTokens: z.number().int().nonnegative().optional(), projected: z.boolean().optional(), compressed: z.boolean().optional(), compression: z.object({ provider: z.string(), providerVersion: z.string().optional(), reversible: z.boolean(), handle: z.string().optional() }).optional() })),
  retrieval: z.object({ available: z.boolean(), allowedFragmentIds: z.array(z.string()) }),
  provenance: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.string(), projectionVersion: z.string() })
});

export function assertContextFragment(value: unknown): ContextFragment {
  return contextFragmentSchema.parse(value) as ContextFragment;
}

export function assertContextEnvelope(value: unknown): ContextEnvelope {
  return contextEnvelopeSchema.parse(value) as ContextEnvelope;
}
