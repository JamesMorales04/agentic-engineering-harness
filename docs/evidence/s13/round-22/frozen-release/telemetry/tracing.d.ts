import { type Context, type Span } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { HarnessProjectConfig } from "../core/types.js";
export declare function ensureTracing(config: HarnessProjectConfig): NodeTracerProvider;
export declare function tracer(config: HarnessProjectConfig): import("@opentelemetry/api").Tracer;
export declare function startOperationSpan(config: HarnessProjectConfig, operationId: string, attributes: Record<string, unknown>): {
    span: Span;
    context: Context;
};
export declare function startEventSpan(config: HarnessProjectConfig, operationId: string | undefined, name: string, phase: string | undefined, attributes: Record<string, unknown>): {
    span: Span;
    parentSpanId?: string;
};
export declare function finishPhase(operationId: string, phase: string): void;
export declare function finishTracing(config: HarnessProjectConfig, operationId?: string): Promise<void>;
export declare function resetTracing(): void;
export declare function markSpanError(span: Span, error?: unknown): void;
export declare function safeAttributes(attributes: Record<string, unknown>): Record<string, string | number | boolean | string[]>;
export declare function configuredTelemetry(): HarnessProjectConfig | undefined;
