import { context, SpanStatusCode, trace, type Context, type Span } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { AlwaysOnSampler, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { HarnessProjectConfig } from "../core/types.js";
import { resolveEndpoint } from "./otlp.js";

const instrumentationName = "agentic-engineering-harness";
const roots = new Map<string, Span>();
const phases = new Map<string, Map<string, Span>>();
const activePhases = new Map<string, string>();
const providers = new Map<string, NodeTracerProvider>();
let contextManagerRegistered = false;
let firstConfig: HarnessProjectConfig | undefined;

export function ensureTracing(config: HarnessProjectConfig): NodeTracerProvider {
  const key = providerKey(config);
  const existing = providers.get(key);
  if (existing) return existing;
  const processors = config.telemetry?.exporter === "otlp-http-json"
    ? (() => {
        const endpoint = resolveEndpoint(config);
        if (!endpoint) throw new Error("OTLP exporter is enabled but no endpoint is configured.");
        return [new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint, headers: config.telemetry.headers }))];
      })()
    : [];
  const next = new NodeTracerProvider({
    sampler: new AlwaysOnSampler(),
    resource: resourceFromAttributes({ "service.name": config.telemetry?.serviceName ?? process.env.OTEL_SERVICE_NAME ?? config.project.name, "service.version": "0.6.29" }),
    spanProcessors: processors
  });
  if (!contextManagerRegistered) {
    next.register({ contextManager: new AsyncLocalStorageContextManager() });
    contextManagerRegistered = true;
  }
  providers.set(key, next);
  firstConfig ??= config;
  return next;
}

export function tracer(config: HarnessProjectConfig) {
  return ensureTracing(config).getTracer(instrumentationName, "0.6.29");
}

export function startOperationSpan(config: HarnessProjectConfig, operationId: string, attributes: Record<string, unknown>): { span: Span; context: Context } {
  const span = tracer(config).startSpan("aeh.operation", { attributes: safeAttributes({ ...attributes, operationId }) });
  roots.set(operationId, span);
  phases.set(operationId, new Map());
  activePhases.delete(operationId);
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
    const previous = activePhases.get(operationId);
    if (previous && previous !== phase) finishPhase(operationId, previous);
    let phaseSpan = operationPhases.get(phase);
    if (!phaseSpan) {
      phaseSpan = tracer(config).startSpan(`aeh.phase.${phase}`, { attributes: safeAttributes(attributes) }, rootContext);
      phaseSpan.setAttribute("aeh.phase", phase);
      operationPhases.set(phase, phaseSpan);
    }
    activePhases.set(operationId, phase);
    parent = phaseSpan;
  }
  const parentContext = parent ? trace.setSpan(context.active(), parent) : context.active();
  const span = tracer(config).startSpan(name, { attributes: safeAttributes(attributes) }, parentContext);
  return { span, parentSpanId: parent?.spanContext().spanId };
}

export function finishPhase(operationId: string, phase: string): void {
  const phaseSpan = phases.get(operationId)?.get(phase);
  if (!phaseSpan) return;
  phaseSpan.end();
  phases.get(operationId)?.delete(phase);
  if (activePhases.get(operationId) === phase) activePhases.delete(operationId);
}

export async function finishTracing(config: HarnessProjectConfig, operationId?: string): Promise<void> {
  if (operationId) {
    for (const phase of phases.get(operationId)?.keys() ?? []) finishPhase(operationId, phase);
    phases.delete(operationId);
    activePhases.delete(operationId);
    roots.get(operationId)?.end();
    roots.delete(operationId);
  }
  await Promise.all([...providers.values()].map((provider) => provider.forceFlush()));
  void config;
}

export function resetTracing(): void {
  roots.clear();
  phases.clear();
  activePhases.clear();
  for (const provider of providers.values()) void provider.shutdown();
  providers.clear();
  firstConfig = undefined;
  contextManagerRegistered = false;
  trace.disable();
}

export function markSpanError(span: Span, error?: unknown): void {
  span.setStatus({ code: SpanStatusCode.ERROR, message: error ? String(error).slice(0, 500) : "operation failed" });
  if (error) span.recordException(error instanceof Error ? error : new Error(String(error).slice(0, 500)));
}

const metricKeys = new Set(["inputtokens", "outputtokens", "totaltokens", "cachedinputtokens", "estimatedrawtokens", "estimateddeliveredtokens"]);
const sensitiveKey = /(?:access|bearer|api|auth|secret|credential|password|private|signing|session).*(?:token|key|secret|credential|password)|(?:authorization|cookie|clientsecret)/i;

export function safeAttributes(attributes: Record<string, unknown>): Record<string, string | number | boolean | string[]> {
  const result: Record<string, string | number | boolean | string[]> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    const normalized = key.toLowerCase();
    const metric = metricKeys.has(normalized);
    if (sensitiveKey.test(key) || (!metric && /token/i.test(key)) || /prompt|source.?code|diff|stdout|stderr|raw.?log/i.test(key)) continue;
    if (typeof value === "number") {
      if (Number.isFinite(value) && Math.abs(value) <= 1_000_000_000) result[key] = value;
    } else if (typeof value === "string" || typeof value === "boolean") {
      result[key] = typeof value === "string" ? value.slice(0, 500) : value;
    } else if (Array.isArray(value) && value.every((item) => ["string", "number", "boolean"].includes(typeof item))) {
      result[key] = value.slice(0, 20).map(String);
    }
  }
  return result;
}

export function configuredTelemetry(): HarnessProjectConfig | undefined { return firstConfig; }

function providerKey(config: HarnessProjectConfig): string {
  return JSON.stringify({ exporter: config.telemetry?.exporter ?? "none", endpoint: config.telemetry?.endpoint ?? "", serviceName: config.telemetry?.serviceName ?? process.env.OTEL_SERVICE_NAME ?? config.project.name, headers: config.telemetry?.headers ?? {} });
}
