import type { HarnessProjectConfig } from "../core/types.js";
import type { ContextCompressionProvider } from "../context/compression/types.js";
import { type InformationalProjectionMetrics, type InformationalProjectedSource } from "../context/projectors/informational.js";
import type { UserFacingClaim } from "../operations/evidence.js";
export type InformationalSource = InformationalProjectedSource;
export interface InformationalAnswer {
    intent: "informational";
    provenance: UserFacingClaim["source"][];
    inspected: {
        provider: string;
        fileCount: number;
        bounded: true;
    };
    claims: UserFacingClaim[];
    sources: InformationalSource[];
    summary: string;
    human: string;
    telemetry: InformationalProjectionMetrics;
}
export interface InformationalAnswerOptions {
    compressor?: ContextCompressionProvider;
}
/**
 * Read-only, bounded repository grounding for conversational questions. This
 * path deliberately does not create an OperationRecord, TaskContract, report,
 * reviewer session, or delivery artifact.
 */
export declare function answerInformationalRequest(root: string, config: HarnessProjectConfig, request: string, options?: InformationalAnswerOptions): Promise<InformationalAnswer>;
export declare function selectInformationalCandidates(candidates: Array<{
    node: {
        file: string;
        symbol?: string;
    };
    score: number;
}>, maxSources: number): Array<{
    node: {
        file: string;
        symbol?: string;
    };
    score: number;
}>;
