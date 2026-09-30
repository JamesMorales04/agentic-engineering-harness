import { z } from "zod";
export const contextPreservationValues = ["VERBATIM", "PROJECTABLE", "COMPRESSIBLE", "RETRIEVABLE", "DISCARDABLE"];
export const contextKindValues = ["instruction", "execution-envelope", "agent-charter", "skill", "normative", "source", "diff", "validation", "audit", "operation", "handoff", "tool-output", "memory", "repository-map", "raw-evidence", "delivery"];
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
export function assertContextFragment(value) {
    return contextFragmentSchema.parse(value);
}
export function assertContextEnvelope(value) {
    return contextEnvelopeSchema.parse(value);
}
//# sourceMappingURL=types.js.map