import type { HarnessProjectConfig } from "../core/types.js";
import type { EvalResult } from "./types.js";
export interface ConfidenceInterval {
    low: number;
    high: number;
    level: number;
}
export interface MetricSummary {
    count: number;
    mean: number;
    median: number;
    standardDeviation: number;
    confidence: ConfidenceInterval;
}
export interface VariantStatistics {
    variant: string;
    runs: number;
    passRate: number;
    passRateConfidence: ConfidenceInterval;
    score: MetricSummary;
    durationMs?: MetricSummary;
    totalTokens?: MetricSummary;
    costUsd?: MetricSummary;
    repairs?: MetricSummary;
    humanInterventions?: MetricSummary;
}
export interface EvalDashboard {
    version: 1;
    caseId: string;
    generatedAt: string;
    confidenceLevel: number;
    variants: VariantStatistics[];
}
export declare function runRepeatedEval(root: string, config: HarnessProjectConfig, caseId: string, variant: string | undefined, runs?: number): Promise<EvalDashboard>;
export declare function buildEvalDashboard(root: string, config: HarnessProjectConfig, caseId: string): Promise<EvalDashboard>;
export declare function aggregateVariant(variant: string, results: EvalResult[], level?: number): VariantStatistics;
export declare function summarize(values: number[], level?: number): MetricSummary;
export declare function wilson(successes: number, count: number, level?: number): ConfidenceInterval;
