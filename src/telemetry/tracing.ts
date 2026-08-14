import fs from "node:fs/promises";
import path from "node:path";
import { context, SpanStatusCode, trace, type Context, type Span } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { AlwaysOnSampler, BatchSpanProcessor, SimpleSpanProcessor, type ReadableSpan, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { HarnessProjectConfig } from "../core/types.js";
import { resolveEndpoint } from "./otlp.js";

const instrumentationName = "agentic-engineering-harness";
const roots = new Map<string, Span>();
const phases = new Map<string, Map<string, Span>>();
let provider: NodeTracerProvider | undefined;
let providerConfig: HarnessProjectConfig | undefined;

export function ensureTracing(config: HarnessProjectConfig): NodeTracerProvider {
  if (provider) return provider;
  providerConfig = config;
  const processors: SpanProcessor[] = [new LocalSpanProcessor()];
  if (config.telemetry?.exporter === "otlp-http-json") {
    const endpoint = resolveEndpoint(config);
    if (!endpoint) throw new Error("OTLP exporter is enabled but no endpoint is configured.");
    processors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint, headers: config.telemetry.headers })));
  }
  provider = new NodeTracerProvider({
    sampler: new AlwaysOnSampler(),
    resource: resourceFromAttributes({ "service.name": config.telemetry?.serviceName ?? process.env.OTEL_SERVICE_NAME ?? config.project.name, "service.version": "0.6.29" }),
    spanProcessors: processors
  });
  provider.register({ contextManager: new AsyncLocalStorageContextManager() });
  return provider;
}

export function tracer(config: HarnessProjectConfig) {
  return ensureTracing(config).getTracer(instrumentationName, "0.6.29");
}

export function startOperationSpan(config: HarnessProjectConfig, operationId: string, attributes: Record<string, unknown>): { span: Span; context: Context } {
  const span = tracer(config).startSpan("aeh.operation", { attributes: safeAttributes({ ...attributes, operationId }) });
  roots.set(operationId, span);
  phases.set(operationId, new Map());
  return { span, context: trace.setSpan(context.active(), span) };
}

export function startEventSpan(config: HarnessProjectConfig, operationId: string | undefined, name: string, phase: string | undefined, attributes: Record<string, unknown>): { span: Span; parentSpanId?: string } {
  let root = operationId ? roots.get(operationId) : undefined;
  if (!root && operationId) root = startOperationSpan(config, operationId, { synthetic: true, ...attributes }).span;
  const rootContext = root ? trace.setSpan(context.active(), root) : context.active();
  let parent = root;
  if (operationId && phase && root) {
    const operationPhases = phases.get(operationId) ?? new Map<string, Span>();
    phases.set(operationId, operationPhases);
    let phaseSpan = operationPhases.get(phase);
    if (!phaseSpan) {
      phaseSpan = tracer(config).startSpan(`aeh.phase.${phase}`, { attributes: safeAttributes(attributes) }, rootContext);
      phaseSpan.setAttribute("aeh.phase", phase);
      operationPhases.set(phase, phaseSpan);
    }
    parent = phaseSpan;
  }
  const parentContext = parent ? trace.setSpan(context.active(), parent) : context.active();
  const span = tracer(config).startSpan(name, { attributes: safeAttributes(attributes) }, parentContext);
  return { span, parentSpanId: parent?.spanContext().spanId };
}

export async function finishTracing(config: HarnessProjectConfig, operationId?: string): Promise<void> {
  if (operationId) {
    for (const span of phases.get(operationId)?.values() ?? []) span.end();
    phases.delete(operationId);
    roots.get(operationId)?.end();
    roots.delete(operationId);
  }
  await provider?.forceFlush();
}

export function resetTracing(): void { roots.clear(); phases.clear(); }

export function markSpanError(span: Span, error?: unknown): void {
  span.setStatus({ code: SpanStatusCode.ERROR, message: error ? String(error).slice(0, 500) : "operation failed" });
  if (error) span.recordException(error instanceof Error ? error : new Error(String(error).slice(0, 500)));
}

export function safeAttributes(attributes: Record<string, unknown>): Record<string, string | number | boolean | string[]> {
  const blocked = /prompt|source.?code|diff|stdout|stderr|raw.?log|secret|token|credential|password/i;
  const result: Record<string, string | number | boolean | string[]> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (blocked.test(key) || value === undefined || value === null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") result[key] = typeof value === "string" ? value.slice(0, 500) : value;
    else if (Array.isArray(value) && value.every((item) => ["string", "number", "boolean"].includes(typeof item))) result[key] = value.slice(0, 20).map(String);
  }
  return result;
}

class LocalSpanProcessor implements SpanProcessor {
  private pending = new Set<Promise<void>>();
  onStart(): void { /* no-op */ }
  onEnd(span: ReadableSpan): void {
    const file = typeof span.attributes["aeh.local_file"] === "string" ? String(span.attributes["aeh.local_file"]) : undefined;
    if (!file) return;
    const record = { at: new Date(span.startTime[0] * 1000 + span.startTime[1] / 1_000_000).toISOString(), name: span.name, traceId: span.spanContext().traceId, spanId: span.spanContext().spanId, parentSpanId: span.parentSpanContext?.spanId, durationMs: (span.duration[0] * 1000) + span.duration[1] / 1_000_000, status: span.status.code === SpanStatusCode.ERROR ? "ERROR" : "OK", attributes: safeAttributes(span.attributes as Record<string, unknown>) };
    delete record.attributes["aeh.local_file"];
    const write = fs.mkdir(path.dirname(file), { recursive: true }).then(() => fs.appendFile(file, `${JSON.stringify(record)}\n`, "utf8"));
    this.pending.add(write); void write.finally(() => this.pending.delete(write));
  }
  async forceFlush(): Promise<void> { await Promise.all(this.pending); }
  async shutdown(): Promise<void> { await this.forceFlush(); }
}

export function configuredTelemetry(): HarnessProjectConfig | undefined { return providerConfig; }
