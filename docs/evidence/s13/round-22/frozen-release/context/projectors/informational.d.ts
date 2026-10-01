import type { InformationalContextBudget } from "../budget.js";
import type { UserFacingClaim } from "../../operations/evidence.js";
export interface InformationalProjectionSourceInput {
    path: string;
    ref: string;
    sha256: string;
    fileSha256?: string;
    relevance: string;
    content: string;
}
export interface InformationalProjectedSource {
    path: string;
    ref: string;
    sha256: string;
    fileSha256?: string;
    relevance: string;
    summary: string;
}
export interface InformationalProjectionMetrics {
    rawEvidenceTokens: number;
    legacyPayloadTokens: number;
    projectedPayloadTokens: number;
    informationalPayloadTokens: number;
    duplicatePayloadTokensAvoided: number;
    sourceCount: number;
    projectedSourceCount: number;
    deferredSourceCount: number;
    targetTokens: number;
    softLimitTokens: number;
    exceptionalTokens: number;
    headroomAttempted: boolean;
    headroomApplied: boolean;
}
export interface InformationalContextProjection {
    claims: UserFacingClaim[];
    sources: InformationalProjectedSource[];
    summary: string;
    human: string;
    metrics: InformationalProjectionMetrics;
}
/**
 * Project repository evidence into a lead-sized informational result. Raw
 * source bytes are intentionally absent; every claim and source points to a
 * live repository-relative evidence ref instead.
 */
export declare function projectInformationalContext(request: string, provider: string, input: InformationalProjectionSourceInput[], budget: InformationalContextBudget): InformationalContextProjection;
/** Deterministic estimate of the exact former lead-visible representation from main. */
export declare function estimateLegacyInformationalTokens(input: InformationalProjectionSourceInput[], provider?: string): number;
