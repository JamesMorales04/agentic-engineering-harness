import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "@opentelemetry/api";
import type { HarnessProjectConfig } from "../core/types.js";
import { updateCurrentOperationPhase } from "../operations/state.js";
import { exportEventSpan, type TraceContext } from "./otlp.js";

const operationTraces = new Map<string, { traceId: string; lastSpanId: string }>();

export async function recordEvent(root: string, config: HarnessProjectConfig, name: string, attributes: Record<string, unknown>): Promise<void> {
  const phase = operationPhaseForEvent(name);
  if (phase) await updateCurrentOperationPhase(root, phase);
  if (config.telemetry?.enabled === false) return;
  const at = new Date();
  const operationId = typeof attributes.operationId === "string" ? attributes.operationId : typeof attributes.taskId === "string" ? attributes.taskId : undefined;
  const operationTrace = operationId ? traceFor(operationId, name) : undefined;
  const tracer = trace.getTracer("agentic-engineering-harness");
  const span = tracer.startSpan(name);
  for (const [key, value] of Object.entries(attributes)) {
    if (["string", "number", "boolean"].includes(typeof value)) span.setAttribute(key, value as string | number | boolean);
  }
  span.end();

  const relative = config.telemetry?.localEventsFile ?? ".harness/telemetry/events.ndjson";
  const file = path.resolve(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify({ at: at.toISOString(), name, traceId: operationTrace?.traceId, spanId: operationTrace?.spanId, parentSpanId: operationTrace?.parentSpanId, attributes })}\n`);

  try { await exportEventSpan(config, name, attributes, at, operationTrace); }
  catch (error) {
    if (config.telemetry?.required) throw error;
    await fs.appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), name: "harness.telemetry.export.error", attributes: { sourceEvent: name, error: String(error) } })}\n`);
  }
}

export function resetOperationTrace(operationId?: string): void { if (operationId) operationTraces.delete(operationId); else operationTraces.clear(); }

function traceFor(operationId: string, name: string): TraceContext {
  const existing = operationTraces.get(operationId);
  const root = !existing || /(?:operation|run|audit)\.start$/.test(name);
  const traceId = root ? crypto.randomBytes(16).toString("hex") : existing.traceId;
  const parentSpanId = root ? undefined : existing.lastSpanId;
  const spanId = crypto.randomBytes(8).toString("hex");
  operationTraces.set(operationId, { traceId, lastSpanId: spanId });
  return { traceId, parentSpanId, spanId };
}

function operationPhaseForEvent(name: string): string | undefined {
  if (name === "harness.run.start") return "executing";
  if (name.includes("planner") || name.includes("wave")) return "planning";
  if (name === "harness.repair.start" || name.includes("remediation")) return "remediation";
  if (name.includes("review")) return "review";
  if (name.includes("delivery")) return "delivery";
  if (name === "harness.audit.start") return "preparing-audit";
  return undefined;
}
