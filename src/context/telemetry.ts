import type { HarnessProjectConfig } from "../core/types.js";
import { recordEvent } from "../telemetry/events.js";
import type { ContextEnvelope, ContextMetrics } from "./types.js";

export async function recordContextMetrics(root: string, config: HarnessProjectConfig, envelope: ContextEnvelope, metrics: ContextMetrics): Promise<void> {
  const base = { operationId: envelope.operationId, logicalAgent: envelope.logicalAgent, phase: envelope.phase, envelopeSha256: envelope.provenance.sha256 };
  await recordEvent(root, config, "harness.context.project", { ...base, projectedBytes: metrics.projectedBytes, projectionRatio: metrics.projectionRatio ?? 0 });
  if (metrics.compressedFragments > 0) await recordEvent(root, config, "harness.context.compress", { ...base, compressedFragments: metrics.compressedFragments, compressionRatio: metrics.compressionRatio ?? 0 });
  await recordEvent(root, config, "harness.context.operation_summary", { ...base, rawBytes: metrics.rawBytes, deliveredBytes: metrics.deliveredBytes, estimatedRawTokens: metrics.estimatedRawTokens, estimatedDeliveredTokens: metrics.estimatedDeliveredTokens, deliveredFragments: metrics.deliveredFragments, discardedFragments: metrics.discardedFragments });
}
