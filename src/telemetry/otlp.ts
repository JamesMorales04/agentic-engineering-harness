import crypto from "node:crypto";
import type { HarnessProjectConfig } from "../core/types.js";

export async function exportEventSpan(config: HarnessProjectConfig, name: string, attributes: Record<string, unknown>, at = new Date()): Promise<void> {
  if (config.telemetry?.exporter !== "otlp-http-json") return;
  const endpoint = resolveEndpoint(config);
  if (!endpoint) throw new Error("OTLP exporter is enabled but no endpoint is configured.");
  const nanos = (BigInt(at.getTime()) * 1_000_000n).toString();
  const payload = {
    resourceSpans: [{
      resource: { attributes: [attribute("service.name", config.telemetry?.serviceName ?? process.env.OTEL_SERVICE_NAME ?? config.project.name)] },
      scopeSpans: [{
        scope: { name: "agentic-engineering-harness", version: "0.3.0" },
        spans: [{
          traceId: crypto.randomBytes(16).toString("hex"), spanId: crypto.randomBytes(8).toString("hex"), name, kind: 1,
          startTimeUnixNano: nanos, endTimeUnixNano: nanos,
          attributes: Object.entries(attributes).flatMap(([key, value]) => value === undefined || value === null ? [] : [attribute(key, value)]),
          status: { code: 1 }
        }]
      }]
    }]
  };
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", ...environmentHeaders(), ...(config.telemetry?.headers ?? {}) },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`OTLP exporter returned HTTP ${response.status}: ${await response.text()}`);
}

export function resolveEndpoint(config: HarnessProjectConfig): string | undefined {
  const signal = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (signal) return signal;
  const configured = config.telemetry?.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!configured) return undefined;
  return `${configured.replace(/\/$/, "")}/v1/traces`;
}

function attribute(key: string, value: unknown): { key: string; value: Record<string, string | boolean> } {
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number") return Number.isInteger(value) ? { key, value: { intValue: String(value) } } : { key, value: { doubleValue: String(value) } };
  return { key, value: { stringValue: typeof value === "string" ? value : JSON.stringify(value) } };
}

function environmentHeaders(): Record<string, string> {
  const raw = process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ?? process.env.OTEL_EXPORTER_OTLP_HEADERS;
  if (!raw) return {};
  return Object.fromEntries(raw.split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return index < 0 ? [part, ""] : [part.slice(0, index), part.slice(index + 1)];
  }));
}
