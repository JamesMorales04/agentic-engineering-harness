import type { HarnessProjectConfig } from "../core/types.js";
import type { ContextBudget, ContextBudgetConfigLike } from "./types.js";
export declare const informationalContextDefaults: {
    readonly targetTokens: 8000;
    readonly softLimitTokens: 12000;
    readonly exceptionalTokens: 15000;
    readonly maxSources: 8;
    readonly sourceSummaryTokens: 96;
    readonly maxInitialBytesPerSource: 4000;
    readonly maxInitialBytesTotal: 20000;
};
export interface InformationalContextBudget {
    targetTokens: number;
    softLimitTokens: number;
    exceptionalTokens: number;
    maxSources: number;
    sourceSummaryTokens: number;
    maxInitialBytesPerSource: number;
    maxInitialBytesTotal: number;
}
export declare function resolveContextBudget(config: HarnessProjectConfig, role?: string, phase?: string): ContextBudget;
export declare function mergeBudgetConfig(...values: Array<ContextBudgetConfigLike | undefined>): ContextBudgetConfigLike;
/** Centralized lead budget for the operation-free repository informational route. */
export declare function resolveInformationalContextBudget(config: HarnessProjectConfig): InformationalContextBudget;
