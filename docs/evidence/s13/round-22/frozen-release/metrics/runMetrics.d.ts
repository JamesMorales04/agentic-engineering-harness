import type { HarnessProjectConfig, RunMetrics, UsageMetrics } from "../core/types.js";
export declare function countHumanInterventions(root: string, config: HarnessProjectConfig, taskId: string, since: string): Promise<number>;
export declare function buildRunMetrics(input: {
    firstPassSuccess: boolean;
    repairCount: number;
    humanInterventions: number;
    durationMs: number;
    usage?: UsageMetrics;
}): RunMetrics;
