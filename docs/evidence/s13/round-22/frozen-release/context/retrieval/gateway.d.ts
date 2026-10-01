import type { RetrievalAuthorization } from "./authorization.js";
export interface RetrievalRequest {
    fragmentId: string;
    section?: "raw" | "source";
    maxTokens?: number;
}
export interface RetrievalResult {
    fragmentId: string;
    content: string;
    artifact: string;
    sha256: string;
    estimatedTokens: number;
    repeated: boolean;
}
export interface RetrievalLimits {
    maxRequestsPerTurn: number;
    maxTokensPerRequest: number;
    maxTotalTokensPerTurn: number;
}
export declare class ContextRetrievalGateway {
    private readonly authorization;
    private readonly limits;
    private requests;
    private totalTokens;
    private readonly seen;
    constructor(authorization: RetrievalAuthorization, limits: RetrievalLimits);
    get metrics(): {
        requests: number;
        repeated: number;
        totalTokens: number;
    };
    retrieve(request: RetrievalRequest): Promise<RetrievalResult>;
}
