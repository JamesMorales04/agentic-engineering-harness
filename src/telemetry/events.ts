import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessProjectConfig } from "../core/types.js";
import { updateCurrentOperationPhase } from "../operations/state.js";
import { finishPhase, finishTracing, markSpanError, safeAttributes, startEventSpan } from "./tracing.js";
import { SpanStatusCode } from "@opentelemetry/api";

export async function recordEvent(root: string, config: HarnessProjectConfig, name: string, attributes: Record<string, unknown>): Promise<void> {
  const phase = operationPhaseForEvent(name);
  if (phase) await updateCurrentOperationPhase(root, phase);
  if (config.telemetry?.enabled === false) return;
  const at = new Date();
  const operationId = typeof attributes.operationId === "string" ? attributes.operationId : typeof attributes.taskId === "string" ? attributes.taskId : undefined;
  const localFile = path.resolve(root, config.telemetry?.localEventsFile ?? ".harness/telemetry/events.ndjson");
  const safe = safeAttributes(attributes);
  const started = startEventSpan(config, operationId, name, phase, { ...safe, "aeh.local_file": localFile });
  const failed = attributes.status === "FAIL" || attributes.status === "FAILED" || typeof attributes.error === "string";
  if (failed) markSpanError(started.span, typeof attributes.error === "string" ? attributes.error : undefined);
  else started.span.setStatus({ code: SpanStatusCode.OK });
  const spanContext = started.span.spanContext();
  started.span.end();
  await fs.mkdir(path.dirname(localFile), { recursive: true });
  await fs.appendFile(localFile, `${JSON.stringify({ at: at.toISOString(), name, traceId: spanContext.traceId, spanId: spanContext.spanId, parentSpanId: started.parentSpanId, status: failed ? "ERROR" : "OK", attributes: safe })}\n`);
  if (operationId && isPhaseTerminal(name, phase)) finishPhase(operationId, phase!);
  if (operationId && isOperationTerminal(name)) await finishTracing(config, operationId);
}

export function resetOperationTrace(operationId?: string): void { void operationId; /* SDK context owns propagation; retained for API compatibility. */ }

function operationPhaseForEvent(name: string): string | undefined {
  if (name === "harness.run.start") return "executing";
  if (name.includes("planner") || name.includes("wave")) return "planning";
  if (name.includes("verify") || name.includes("validation") || name.includes("graphify")) return "validation";
  if (name === "harness.repair.start" || name.includes("remediation")) return "remediation";
  if (name.includes("review")) return "review";
  if (name.includes("delivery")) return "delivery";
  if (name === "harness.audit.start") return "preparing-audit";
  if (name.includes("context")) return "context";
  if (name.includes("provenance")) return "provenance";
  return undefined;
}

function isPhaseTerminal(name: string, phase: string | undefined): boolean {
  if (!phase) return false;
  return (phase === "validation" && name === "harness.verify.finish") ||
    (phase === "review" && name === "harness.review.finish") ||
    (phase === "delivery" && name === "harness.delivery.finalize") ||
    (phase === "planning" && name === "harness.plan.ready");
}

function isOperationTerminal(name: string): boolean {
  return new Set(["harness.run.finish", "harness.audit.finish", "harness.change.finish", "harness.quick.finish", "operation.finish", "operation.completed", "operation.failed"]).has(name);
}
