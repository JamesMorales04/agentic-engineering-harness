import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Minimal in-process loopback OTLP/HTTP receiver for deterministic local
 * export verification. It needs no hosted collector or credential and only
 * decodes the JSON OTLP payloads the production exporter sends.
 */
export interface OtlpReceiverRequest {
  method: string;
  path: string;
  contentType?: string;
  body: unknown;
  receivedAt: string;
}

export interface OtlpSpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  attributes: Record<string, string | number | boolean>;
  status?: string;
}

export interface OtlpReceiver {
  endpoint: string;
  requests: OtlpReceiverRequest[];
  resourceAttributes(): Array<Record<string, string | number | boolean>>;
  spans(): OtlpSpanRecord[];
  close(): Promise<void>;
}

export async function startOtlpReceiver(): Promise<OtlpReceiver> {
  const requests: OtlpReceiverRequest[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = raw;
      try { body = JSON.parse(raw); } catch { /* retain raw body for diagnostics */ }
      requests.push({
        method: request.method ?? "UNKNOWN",
        path: request.url ?? "/",
        contentType: typeof request.headers["content-type"] === "string" ? request.headers["content-type"] : undefined,
        body,
        receivedAt: new Date().toISOString()
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    resourceAttributes(): Array<Record<string, string | number | boolean>> {
      return requests.flatMap((entry) => resourceSpans(entry.body).map((resourceSpan) => decodeAttributes(resourceSpan.resource?.attributes)));
    },
    spans(): OtlpSpanRecord[] {
      return requests.flatMap((entry) => resourceSpans(entry.body).flatMap((resourceSpan) => scopeSpans(resourceSpan).flatMap((scopeSpan) => (scopeSpan.spans ?? []).map((span) => ({
        traceId: String(span.traceId ?? ""),
        spanId: String(span.spanId ?? ""),
        ...(typeof span.parentSpanId === "string" && span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
        name: String(span.name ?? ""),
        attributes: decodeAttributes(span.attributes),
        ...(typeof span.status?.code === "number" ? { status: span.status.code === 2 ? "ERROR" : "OK" } : {})
      })))));
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

interface RawResourceSpan { resource?: { attributes?: unknown[] }; scopeSpans?: Array<{ spans?: RawSpan[] }>; }
interface RawSpan { traceId?: unknown; spanId?: unknown; parentSpanId?: unknown; name?: unknown; attributes?: unknown[]; status?: { code?: number } }

function resourceSpans(body: unknown): RawResourceSpan[] {
  if (!body || typeof body !== "object") return [];
  const value = (body as { resourceSpans?: unknown }).resourceSpans;
  return Array.isArray(value) ? value as RawResourceSpan[] : [];
}

function scopeSpans(resourceSpan: RawResourceSpan): Array<{ spans?: RawSpan[] }> {
  return Array.isArray(resourceSpan.scopeSpans) ? resourceSpan.scopeSpans : [];
}

function decodeAttributes(attributes: unknown): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  if (!Array.isArray(attributes)) return result;
  for (const entry of attributes) {
    if (!entry || typeof entry !== "object") continue;
    const { key, value } = entry as { key?: unknown; value?: Record<string, unknown> };
    if (typeof key !== "string" || !value || typeof value !== "object") continue;
    if (typeof value.stringValue === "string") result[key] = value.stringValue;
    else if (typeof value.intValue === "number") result[key] = value.intValue;
    else if (typeof value.intValue === "string" && Number.isFinite(Number(value.intValue))) result[key] = Number(value.intValue);
    else if (typeof value.boolValue === "boolean") result[key] = value.boolValue;
    else if (typeof value.doubleValue === "number") result[key] = value.doubleValue;
  }
  return result;
}
