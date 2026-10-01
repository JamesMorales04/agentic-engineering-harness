import fs from "node:fs/promises";
import path from "node:path";
import { currentOperationContext, updateCurrentOperationPhase } from "../operations/state.js";
import { finishPhase, finishTracing, markSpanError, safeAttributes, startEventSpan } from "./tracing.js";
import { flushTelemetryMetrics } from "./metrics.js";
import { detectTelemetryIdentityViolation, resolveTelemetryCorrelation, telemetryCorrelationAttributes, telemetryCorrelationDigest } from "./identity.js";
import { SpanStatusCode } from "@opentelemetry/api";
/**
 * Record one bounded lifecycle event. When a durable operation context is
 * resolvable, the event is bound to the current candidate/execution identity.
 * A caller-supplied identity that does not match current durable truth is
 * marked with an explicit violation instead of being silently re-attributed.
 */
export async function recordEvent(root, config, name, attributes, identity) {
    const phase = operationPhaseForEvent(name);
    if (phase)
        await updateCurrentOperationPhase(root, phase);
    if (config.telemetry?.enabled === false)
        return;
    const at = new Date();
    const contextOperationId = currentOperationContext().id;
    const explicitOperationId = typeof attributes.operationId === "string" ? attributes.operationId : undefined;
    const operationId = explicitOperationId ?? identity?.operationId ?? contextOperationId ?? (typeof attributes.taskId === "string" ? attributes.taskId : undefined);
    const participantId = typeof attributes.participantId === "string" ? attributes.participantId : undefined;
    const current = await resolveTelemetryCorrelation(root, explicitOperationId ?? contextOperationId, participantId);
    const identityViolation = identity ? detectTelemetryIdentityViolation(current, identity) : undefined;
    const correlation = current;
    const identityAttributes = correlation ? telemetryCorrelationAttributes(correlation) : {};
    const localFile = path.resolve(root, config.telemetry?.localEventsFile ?? ".harness/telemetry/events.ndjson");
    const safe = safeAttributes(attributes);
    const started = startEventSpan(config, operationId, name, phase, {
        ...safe,
        ...identityAttributes,
        ...(identityViolation ? { "aeh.telemetry.identity.violation": identityViolation.kind } : {}),
        "aeh.local_file": localFile
    });
    const failed = attributes.status === "FAIL" || attributes.status === "FAILED" || typeof attributes.error === "string";
    if (failed)
        markSpanError(started.span, typeof attributes.error === "string" ? attributes.error : undefined);
    else
        started.span.setStatus({ code: SpanStatusCode.OK });
    const spanContext = started.span.spanContext();
    started.span.end();
    const record = {
        at: at.toISOString(),
        name,
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
        parentSpanId: started.parentSpanId,
        status: failed ? "ERROR" : "OK",
        attributes: safe,
        ...(correlation ? { identity: correlation, identityDigest: telemetryCorrelationDigest(correlation) } : {}),
        ...(identityViolation ? { identityViolation } : {})
    };
    await fs.mkdir(path.dirname(localFile), { recursive: true });
    await fs.appendFile(localFile, `${JSON.stringify(record)}\n`);
    if (operationId && isPhaseTerminal(name, phase))
        finishPhase(operationId, phase);
    if (operationId && isOperationTerminal(name)) {
        await finishTracing(config, operationId);
        await flushTelemetryMetrics(root);
    }
}
/** Read local telemetry events for deterministic verification. */
export async function readTelemetryEvents(root, config) {
    const relative = config?.telemetry?.localEventsFile ?? ".harness/telemetry/events.ndjson";
    try {
        const raw = await fs.readFile(path.resolve(root, relative), "utf8");
        return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    }
    catch {
        return [];
    }
}
export function resetOperationTrace(operationId) { void operationId; /* SDK context owns propagation; retained for API compatibility. */ }
function operationPhaseForEvent(name) {
    if (name === "harness.run.start")
        return "executing";
    if (name.includes("planner") || name.includes("wave"))
        return "planning";
    if (name.includes("verify") || name.includes("validation") || name.includes("graphify"))
        return "validation";
    if (name === "harness.repair.start" || name.includes("remediation"))
        return "remediation";
    if (name.includes("review"))
        return "review";
    if (name.includes("delivery"))
        return "delivery";
    if (name === "harness.audit.start")
        return "preparing-audit";
    if (name.includes("context"))
        return "context";
    if (name.includes("provenance"))
        return "provenance";
    return undefined;
}
function isPhaseTerminal(name, phase) {
    if (!phase)
        return false;
    return (phase === "validation" && name === "harness.verify.finish") ||
        (phase === "review" && name === "harness.review.finish") ||
        (phase === "delivery" && name === "harness.delivery.finalize") ||
        (phase === "planning" && name === "harness.plan.ready");
}
function isOperationTerminal(name) {
    return new Set(["harness.run.finish", "harness.audit.finish", "harness.change.finish", "operation.finish", "operation.completed", "operation.failed"]).has(name);
}
//# sourceMappingURL=events.js.map