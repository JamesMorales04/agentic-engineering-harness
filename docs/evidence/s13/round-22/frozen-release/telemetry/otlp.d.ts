import type { HarnessProjectConfig } from "../core/types.js";
export interface TraceContext {
    traceId: string;
    parentSpanId?: string;
    spanId: string;
}
/** Compatibility entry point backed by the official OpenTelemetry SDK. */
export declare function exportEventSpan(config: HarnessProjectConfig, name: string, attributes: Record<string, unknown>, _at?: Date, parent?: TraceContext): Promise<void>;
export declare function resolveEndpoint(config: HarnessProjectConfig): string | undefined;
