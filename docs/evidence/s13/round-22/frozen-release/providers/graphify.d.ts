import type { HarnessProjectConfig } from "../core/types.js";
import type { CodeIntelligenceProvider, CodeImpactReport } from "./types.js";
import { runShell } from "../utils/process.js";
export interface GraphifyGenerationMetadata {
    version: 1;
    provider: "graphify";
    providerVersion: string;
    gitCommit?: string;
    sourceFingerprint: string;
    graphSha256: string;
    generatedAt: string;
}
export declare const GRAPHIFY_VERSION: string;
/** Graphify owns generation/freshness; all consumers use graphifyModel.ts. */
export declare class GraphifyCodeIntelligenceProvider implements CodeIntelligenceProvider {
    private readonly config?;
    private readonly executor;
    readonly name = "graphify";
    constructor(config?: HarnessProjectConfig | undefined, executor?: typeof runShell);
    doctor(root: string): Promise<{
        ok: boolean;
        message: string;
    }>;
    build(root: string): Promise<void>;
    refresh(root: string): Promise<void>;
    update(root: string): Promise<void>;
    load(root: string): Promise<unknown | undefined>;
    isFresh(root: string): Promise<boolean>;
    impact(root: string): Promise<CodeImpactReport>;
    private generate;
    private targetConfiguredGraph;
    private graphPath;
    private metadataPath;
    private readMetadata;
    private providerVersion;
}
