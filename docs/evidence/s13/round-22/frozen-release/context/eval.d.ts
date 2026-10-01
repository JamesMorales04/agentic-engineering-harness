import type { ContextMetrics } from "./types.js";
export interface ContextEvaluationSample {
    variant: "baseline" | "observe" | "enforce" | string;
    success: boolean;
    costUsd?: number;
    metrics: ContextMetrics;
}
export interface ContextEvaluationSummary {
    variant: string;
    sampleSize: number;
    successfulOperations: number;
    successRate: number;
    medianDeliveredTokenReduction: number;
    uncachedInputReduction?: number;
    costPerSuccessfulOperation?: number;
    tokensPerSuccessfulOperation?: number;
    projectionEscapeRate: number;
}
export declare function summarizeContextEvaluation(samples: ContextEvaluationSample[], variant: string): ContextEvaluationSummary;
