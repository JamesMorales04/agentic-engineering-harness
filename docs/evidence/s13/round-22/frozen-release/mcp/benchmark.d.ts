import type { HarnessProjectConfig } from "../core/types.js";
export interface McpBenchmarkResult {
    server: string;
    type: "local" | "remote";
    available: boolean;
    baselineConfigTokens: number;
    permissionSurfaceScore: number;
    staleDataRisk: "low" | "medium" | "high";
    latencyMs?: {
        median: number;
        min: number;
        max: number;
        samples: number[];
    };
    notes: string[];
}
export interface McpBenchmarkReport {
    version: 1;
    generatedAt: string;
    results: McpBenchmarkResult[];
    packs: Record<string, string[]>;
}
export declare function benchmarkMcpCatalog(root: string, config: HarnessProjectConfig, names?: string[]): Promise<McpBenchmarkReport>;
export declare function resolveMcpPack(config: HarnessProjectConfig, pack: string): string[];
