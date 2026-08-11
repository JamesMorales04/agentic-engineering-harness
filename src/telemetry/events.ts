import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "@opentelemetry/api";
import type { HarnessProjectConfig } from "../core/types.js";

export async function recordEvent(root: string, config: HarnessProjectConfig, name: string, attributes: Record<string, unknown>): Promise<void> {
  if (config.telemetry?.enabled === false) return;
  const tracer = trace.getTracer("agentic-engineering-harness");
  const span = tracer.startSpan(name);
  for (const [key, value] of Object.entries(attributes)) {
    if (["string", "number", "boolean"].includes(typeof value)) {
      span.setAttribute(key, value as string | number | boolean);
    }
  }
  span.end();

  const relative = config.telemetry?.localEventsFile ?? ".harness/telemetry/events.ndjson";
  const file = path.resolve(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), name, attributes })}\n`);
}
