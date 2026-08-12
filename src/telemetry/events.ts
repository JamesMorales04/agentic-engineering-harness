import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "@opentelemetry/api";
import type { HarnessProjectConfig } from "../core/types.js";
import { exportEventSpan } from "./otlp.js";

export async function recordEvent(root: string, config: HarnessProjectConfig, name: string, attributes: Record<string, unknown>): Promise<void> {
  if (config.telemetry?.enabled === false) return;
  const at = new Date();
  const tracer = trace.getTracer("agentic-engineering-harness");
  const span = tracer.startSpan(name);
  for (const [key, value] of Object.entries(attributes)) {
    if (["string", "number", "boolean"].includes(typeof value)) span.setAttribute(key, value as string | number | boolean);
  }
  span.end();

  const relative = config.telemetry?.localEventsFile ?? ".harness/telemetry/events.ndjson";
  const file = path.resolve(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify({ at: at.toISOString(), name, attributes })}\n`);

  try { await exportEventSpan(config, name, attributes, at); }
  catch (error) {
    if (config.telemetry?.required) throw error;
    await fs.appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), name: "harness.telemetry.export.error", attributes: { sourceEvent: name, error: String(error) } })}\n`);
  }
}
