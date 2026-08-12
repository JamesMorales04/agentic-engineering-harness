import fs from "node:fs/promises";
import path from "node:path";
import { loadProjectConfig } from "../core/config.js";
import { recordEvent } from "../telemetry/events.js";

export interface PaseoTraceRecord {
  at: string;
  name: string;
  attributes: Record<string, unknown>;
}

/**
 * Paseo integration traces are always persisted locally because they are
 * operational evidence, even when OTLP export is disabled. When Harness
 * telemetry is configured the same event is also sent through the normal
 * recordEvent/OTLP path.
 */
export async function recordPaseoTrace(
  root: string,
  name: string,
  attributes: Record<string, unknown> = {}
): Promise<void> {
  const eventName = name.startsWith("harness.paseo.") ? name : `harness.paseo.${name}`;
  const record: PaseoTraceRecord = { at: new Date().toISOString(), name: eventName, attributes };
  const file = path.resolve(root, ".harness/telemetry/paseo.ndjson");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(record)}\n`);

  let config;
  try { config = await loadProjectConfig(root); }
  catch { return; }
  await recordEvent(root, config, eventName, attributes);
}
