import type { HarnessProjectConfig } from "../core/types.js";
import type { ContextCompressionProvider } from "./compression/types.js";
import type { ContextPreparationRequest, ContextPreparationResult } from "./types.js";
export interface ContextBudgetGatewayOptions {
    compressor?: ContextCompressionProvider;
    persist?: boolean;
    telemetry?: boolean;
}
export declare class ContextBudgetGateway {
    private readonly root;
    private readonly config;
    private readonly compressor?;
    private readonly persist;
    private readonly telemetry;
    constructor(root: string, config: HarnessProjectConfig, options?: ContextBudgetGatewayOptions);
    prepare(request: ContextPreparationRequest): Promise<ContextPreparationResult>;
    private optimizeFragment;
    private persistRawFragment;
    private persistEnvelope;
    private emitTelemetry;
}
export declare function prepareContext(root: string, config: HarnessProjectConfig, request: ContextPreparationRequest, options?: ContextBudgetGatewayOptions): Promise<ContextPreparationResult>;
export declare function recoveryHandle(operationId: string, fragmentId: string, sourceSha256: string): string;
export declare function contextEnvelopePath(root: string, operationId: string, logicalAgent: string, phase: string): string;
