import type { ContextMetrics } from "./types.js";

export interface ContextEvaluationSample { variant: "baseline" | "observe" | "enforce" | string; success: boolean; costUsd?: number; metrics: ContextMetrics; }
export interface ContextEvaluationSummary { variant: string; sampleSize: number; successfulOperations: number; successRate: number; medianDeliveredTokenReduction: number; uncachedInputReduction?: number; costPerSuccessfulOperation?: number; tokensPerSuccessfulOperation?: number; projectionEscapeRate: number; }

export function summarizeContextEvaluation(samples: ContextEvaluationSample[], variant: string): ContextEvaluationSummary {
  const selected = samples.filter((sample) => sample.variant === variant); const successful = selected.filter((sample) => sample.success); const reductions = selected.map((sample) => sample.metrics.estimatedRawTokens ? 1 - sample.metrics.estimatedDeliveredTokens / sample.metrics.estimatedRawTokens : 0).sort((a, b) => a - b);
  const costs = successful.map((sample) => sample.costUsd).filter((value): value is number => value !== undefined); const tokens = successful.map((sample) => sample.metrics.estimatedDeliveredTokens);
  return { variant, sampleSize: selected.length, successfulOperations: successful.length, successRate: selected.length ? successful.length / selected.length : 0, medianDeliveredTokenReduction: median(reductions), uncachedInputReduction: selected.length ? average(selected.map((sample) => sample.metrics.estimatedRawTokens ? 1 - sample.metrics.estimatedDeliveredTokens / sample.metrics.estimatedRawTokens : 0)) : undefined, costPerSuccessfulOperation: costs.length && successful.length ? costs.reduce((sum, value) => sum + value, 0) / successful.length : undefined, tokensPerSuccessfulOperation: tokens.length ? tokens.reduce((sum, value) => sum + value, 0) / tokens.length : undefined, projectionEscapeRate: selected.length ? average(selected.map((sample) => sample.metrics.retrievedFragments ? sample.metrics.retrievalEscapes / sample.metrics.retrievedFragments : 0)) : 0 };
}

function median(values: number[]): number { if (!values.length) return 0; const middle = Math.floor(values.length / 2); return values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2; }
function average(values: number[]): number { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
