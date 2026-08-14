import { context, trace, type SpanContext } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { AlwaysOnSampler, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { HarnessProjectConfig } from "../core/types.js";

export interface TraceContext { traceId: string; parentSpanId?: string; spanId: string; }

/** Compatibility entry point backed by the official OpenTelemetry SDK. */
export async function exportEventSpan(config: HarnessProjectConfig, name: string, attributes: Record<string, unknown>, _at = new Date(), parent?: TraceContext): Promise<void> {
  if (config.telemetry?.exporter !== "otlp-http-json") return;
  const endpoint = resolveEndpoint(config);
  if (!endpoint) throw new Error("OTLP exporter is enabled but no endpoint is configured.");
  const provider = new NodeTracerProvider({
    sampler: new AlwaysOnSampler(),
    resource: resourceFromAttributes({ "service.name": config.telemetry?.serviceName ?? process.env.OTEL_SERVICE_NAME ?? config.project.name }),
    spanProcessors: [new SimpleSpanProcessor(new OTLPTraceExporter({ url: endpoint, headers: config.telemetry.headers }))]
  });
  const parentContext = parent ? trace.setSpanContext(context.active(), spanContext(parent)) : context.active();
  const span = provider.getTracer("agentic-engineering-harness").startSpan(name, { attributes: safeAttributes(attributes) }, parentContext);
  span.setStatus({ code: 1 });
  span.end();
  await provider.forceFlush();
  await provider.shutdown();
}

export function resolveEndpoint(config: HarnessProjectConfig): string | undefined {
  const signal = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (signal) return signal;
  const configured = config.telemetry?.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!configured) return undefined;
  return configured.endsWith("/v1/traces") ? configured : `${configured.replace(/\/$/, "")}/v1/traces`;
}

function spanContext(value: TraceContext): SpanContext { return { traceId: value.traceId, spanId: value.parentSpanId ?? value.spanId, traceFlags: 1, isRemote: true }; }
function safeAttributes(attributes: Record<string, unknown>): Record<string, string | number | boolean> { return Object.fromEntries(Object.entries(attributes).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value)).map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 500) : value])) as Record<string, string | number | boolean>; }
