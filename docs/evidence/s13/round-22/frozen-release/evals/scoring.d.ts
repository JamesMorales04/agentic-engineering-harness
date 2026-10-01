import type { EvalCase, EvalResult } from "./types.js";
export declare function scoreEvalResult(evalCase: EvalCase, input: Omit<EvalResult, "score" | "scoreBreakdown">): Pick<EvalResult, "score" | "scoreBreakdown">;
export declare function rankEvalResults(results: EvalResult[]): EvalResult[];
/**
 * Deterministic projection of an eval result for reproducibility comparison.
 * Timestamps, absolute paths, and result file names are excluded because they
 * are not part of the scored observation.
 */
export declare function evalResultComparableV1(result: EvalResult): Record<string, unknown>;
