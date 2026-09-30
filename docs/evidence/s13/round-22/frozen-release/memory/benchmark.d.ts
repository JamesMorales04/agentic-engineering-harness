import type { HarnessProjectConfig } from "../core/types.js";
export interface MemoryBenchmarkCase {
    version: 1;
    id: string;
    query: string;
    expectedTerms: string[];
    forbiddenTerms: string[];
}
export interface MemoryBenchmarkCaseResult {
    caseId: string;
    success: boolean;
    latencyMs: number;
    recall: number;
    contamination: number;
    score: number;
    output: string;
}
export interface MemoryBenchmarkProviderResult {
    provider: string;
    score: number;
    averageRecall: number;
    averageContamination: number;
    averageLatencyMs: number;
    cases: MemoryBenchmarkCaseResult[];
}
export interface MemoryBenchmarkReport {
    version: 1;
    createdAt: string;
    project: string;
    providers: MemoryBenchmarkProviderResult[];
}
export declare function runMemoryBenchmark(root: string, config: HarnessProjectConfig): Promise<MemoryBenchmarkReport>;
export declare function scoreMemoryOutput(item: MemoryBenchmarkCase, success: boolean, latencyMs: number, output: string): MemoryBenchmarkCaseResult;
