import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessProjectConfig } from "../core/types.js";
import { recordEvent } from "../telemetry/events.js";
import { resolveContextBudget } from "./budget.js";
import { canLossyCompress, classifyFragment, isRequired as isRequiredFragment } from "./classifier.js";
import { estimateBytes, estimateTokens } from "./estimator.js";
import { buildContextEnvelope, renderContextEnvelope } from "./envelope.js";
import { resolveContextPolicy } from "./policy.js";
import { sha256 } from "./provenance.js";
import { projectAudit, projectDiff, projectOperation, projectSource, projectValidation } from "./projectors/index.js";
import { authorizeRetrieval } from "./retrieval/authorization.js";
import { ContextRetrievalGateway } from "./retrieval/gateway.js";
import { HeadroomCompressionProvider } from "./compression/headroom.js";
import { recordContextMetrics } from "./telemetry.js";
import type { ContextCompressionProvider } from "./compression/types.js";
import type { ContextEnvelope, ContextFragment, ContextFragmentProjection, ContextMetrics, ContextPreparationRequest, ContextPreparationResult } from "./types.js";

export interface ContextBudgetGatewayOptions { compressor?: ContextCompressionProvider; persist?: boolean; telemetry?: boolean; }

export class ContextBudgetGateway {
  private readonly compressor: ContextCompressionProvider;
  private readonly persist: boolean;
  private readonly telemetry: boolean;

  constructor(private readonly root: string, private readonly config: HarnessProjectConfig, options: ContextBudgetGatewayOptions = {}) {
    this.compressor = options.compressor ?? new HeadroomCompressionProvider(config.context?.compression?.command ? { command: config.context.compression.command } : {});
    this.persist = options.persist ?? true;
    this.telemetry = options.telemetry ?? true;
  }

  async prepare(request: ContextPreparationRequest): Promise<ContextPreparationResult> {
    const policy = resolveContextPolicy(this.config);
    const budget = resolveContextBudget(this.config, request.role ?? request.logicalAgent, request.phase);
    const durable = await Promise.all(request.fragments.map((fragment) => this.persistRawFragment(request.operationId, fragment)));
    const rawBytes = durable.reduce((sum, fragment) => sum + estimateBytes(fragment.content), 0);
    const rawTokens = durable.reduce((sum, fragment) => sum + estimateTokens(fragment.content), 0);
    const candidates: Array<{ raw: ContextFragment; optimized: ContextFragmentProjection }> = [];

    for (const fragment of durable) {
      classifyFragment(fragment);
      const optimized = await this.optimizeFragment(fragment, request.operationId, policy.compression.minTokens);
      candidates.push({ raw: fragment, optimized });
    }

    const enforced = policy.mode === "enforce";
    const delivered = enforced ? selectWithinBudget(candidates.map((candidate) => candidate.optimized), budget.maxTokens - budget.reserved.response) : durable.map(projectSource);
    const deliveredIds = new Set(delivered.map((fragment) => fragment.id));
    const discarded = durable.filter((fragment) => !deliveredIds.has(fragment.id));
    const envelope = buildContextEnvelope({ version: 1, operationId: request.operationId, logicalAgent: request.logicalAgent, phase: request.phase, budget: { maximum: budget.maxTokens, estimatedDelivered: delivered.reduce((sum, fragment) => sum + fragment.estimatedTokens, 0) }, fragments: delivered, retrieval: { available: delivered.length > 0, allowedFragmentIds: delivered.map((fragment) => fragment.id) } });
    if (this.persist) await this.persistEnvelope(request.operationId, envelope);
    const rendered = renderContextEnvelope(envelope);
    const metrics = metricsFor(durable, candidates.map((candidate) => candidate.optimized), delivered, discarded);
    const retrieval = new ContextRetrievalGateway(authorizeRetrieval({ root: this.root, operationId: request.operationId, logicalAgent: request.logicalAgent, allowedFragmentIds: delivered.map((fragment) => fragment.id), fragments: durable }), policy.retrieval);

    if (this.telemetry && this.config.telemetry?.enabled !== false) await this.emitTelemetry(request, metrics, envelope);
    return { envelope, rendered, metrics, retrieval: { root: this.root, operationId: request.operationId, logicalAgent: request.logicalAgent, allowedFragmentIds: [...envelope.retrieval.allowedFragmentIds] } };
  }

  private async optimizeFragment(fragment: ContextFragment, operationId: string, minCompressionTokens: number): Promise<ContextFragmentProjection> {
    const originalTokens = estimateTokens(fragment.content);
    if (isRequiredFragment(fragment)) return projectSource(fragment);
    if (fragment.preservation === "DISCARDABLE") return { ...fragment, content: "", estimatedTokens: 0, originalTokens, projected: true };
    if (fragment.preservation === "RETRIEVABLE") {
      const content = `[Retrievable ${fragment.kind} '${fragment.id}' (${originalTokens} tokens); use aeh_context_retrieve for the authorized raw artifact.]`;
      return { ...fragment, content, estimatedTokens: estimateTokens(content), originalTokens, projected: true };
    }
    let projected: ContextFragmentProjection;
    switch (fragment.kind) {
      case "validation": projected = projectValidation(fragment); break;
      case "audit": projected = projectAudit(fragment); break;
      case "operation": projected = projectOperation(fragment); break;
      case "diff": projected = projectDiff(fragment); break;
      case "source": projected = projectSource(fragment); break;
      case "repository-map": projected = projectSource(fragment); break;
      case "tool-output": projected = genericProjection(fragment); break;
      case "memory": projected = genericProjection(fragment); break;
      case "instruction":
      case "normative": projected = projectSource(fragment); break;
      default: projected = projectSource(fragment);
    }
    if (canLossyCompress(fragment) && originalTokens >= minCompressionTokens) {
      const compression = await this.compressor.compress(this.root, { operationId, fragment, maxTokens: Math.max(1, Math.floor(originalTokens * 0.7)), sourceSha256: fragment.source?.sha256 ?? sha256(fragment.content) });
      if (compression.compressedTokens < projected.estimatedTokens) return { ...projected, content: compression.content, estimatedTokens: compression.compressedTokens, compressed: true, compression: { provider: compression.provider, providerVersion: compression.providerVersion, reversible: compression.reversible, handle: compression.handle } };
    }
    return projected;
  }

  private async persistRawFragment(operationId: string, fragment: ContextFragment): Promise<ContextFragment> {
    if (!this.persist) return { ...fragment, source: { ...fragment.source, sha256: fragment.source?.sha256 ?? sha256(fragment.content) } };
    const relative = fragment.source?.artifact ?? path.posix.join(".harness", "context", safeSegment(operationId), `${safeSegment(fragment.id)}.raw`);
    const absolute = safePath(this.root, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    let actual: string;
    try {
      const existing = await fs.readFile(absolute);
      actual = sha256(existing);
      if (fragment.source?.sha256 && fragment.source.sha256 !== actual) throw new Error(`Context source hash mismatch for '${relative}'.`);
      if (!fragment.source?.sha256 && existing.toString("utf8") !== fragment.content) throw new Error(`Context source artifact '${relative}' does not match the supplied content.`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("Context source")) throw error;
      await fs.writeFile(absolute, fragment.content, { encoding: "utf8", flag: "wx" }).catch(async (writeError: unknown) => {
        if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
      });
      actual = sha256(fragment.content);
    }
    return { ...fragment, source: { ...fragment.source, artifact: relative, sha256: actual } };
  }

  private async persistEnvelope(operationId: string, envelope: ContextEnvelope): Promise<void> {
    const file = safePath(this.root, path.posix.join(".harness", "context", safeSegment(operationId), "envelope.json"));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  }

  private async emitTelemetry(request: ContextPreparationRequest, metrics: ContextMetrics, envelope: ContextEnvelope): Promise<void> {
    const attributes = { operationId: request.operationId, logicalAgent: request.logicalAgent, phase: request.phase, envelopeSha256: envelope.provenance.sha256, rawBytes: metrics.rawBytes, projectedBytes: metrics.projectedBytes, deliveredBytes: metrics.deliveredBytes, estimatedRawTokens: metrics.estimatedRawTokens, estimatedDeliveredTokens: metrics.estimatedDeliveredTokens, deliveredFragments: metrics.deliveredFragments, compressedFragments: metrics.compressedFragments, discardedFragments: metrics.discardedFragments, projectionRatio: metrics.projectionRatio ?? 0, compressionRatio: metrics.compressionRatio ?? 0 };
    await recordEvent(this.root, this.config, "harness.context.prepare", attributes);
    await recordContextMetrics(this.root, this.config, envelope, metrics);
    await recordEvent(this.root, this.config, "harness.context.deliver", { ...attributes, retrievalAvailable: envelope.retrieval.available });
  }
}

export async function prepareContext(root: string, config: HarnessProjectConfig, request: ContextPreparationRequest, options: ContextBudgetGatewayOptions = {}): Promise<ContextPreparationResult> {
  return new ContextBudgetGateway(root, config, options).prepare(request);
}

function selectWithinBudget(fragments: ContextFragmentProjection[], maxTokens: number): ContextFragmentProjection[] {
  const ordered = [...fragments].filter((fragment) => fragment.estimatedTokens > 0).sort((a, b) => Number(isRequiredProjection(b)) - Number(isRequiredProjection(a)) || b.priority - a.priority || a.id.localeCompare(b.id));
  const selected: ContextFragmentProjection[] = []; let used = 0;
  for (const fragment of ordered) {
    if (used + fragment.estimatedTokens <= maxTokens) { selected.push(fragment); used += fragment.estimatedTokens; continue; }
    if (isRequiredProjection(fragment)) throw new Error(`CONTEXT_BUDGET_EXCEEDED: required fragment '${fragment.id}' cannot be delivered without loss.`);
  }
  return selected;
}

function genericProjection(fragment: ContextFragment): ContextFragmentProjection {
  const lines = fragment.content.split(/\r?\n/); const selected = lines.length <= 64 ? lines : [...lines.slice(0, 16), ...lines.filter((line) => /error|fail|warn|diagnostic|exception|stack/i.test(line)).slice(0, 32), ...lines.slice(-16)];
  const content = [...new Set(selected)].join("\n") + (lines.length > selected.length ? "\n[non-authoritative repetitive lines projected; raw artifact is retrievable]" : "");
  return { ...fragment, content, estimatedTokens: estimateTokens(content), originalTokens: estimateTokens(fragment.content), projected: lines.length > selected.length };
}

function metricsFor(raw: ContextFragment[], optimized: ContextFragmentProjection[], delivered: ContextFragmentProjection[], discarded: ContextFragment[]): ContextMetrics {
  const rawTokens = raw.reduce((sum, fragment) => sum + estimateTokens(fragment.content), 0); const projectedTokens = optimized.reduce((sum, fragment) => sum + estimateTokens(fragment.content), 0); const deliveredTokens = delivered.reduce((sum, fragment) => sum + fragment.estimatedTokens, 0);
  const rawBytes = raw.reduce((sum, fragment) => sum + estimateBytes(fragment.content), 0); const projectedBytes = optimized.reduce((sum, fragment) => sum + estimateBytes(fragment.content), 0); const deliveredBytes = delivered.reduce((sum, fragment) => sum + estimateBytes(fragment.content), 0);
  const compressed = optimized.filter((fragment) => fragment.compressed).length;
  return { rawBytes, projectedBytes, deliveredBytes, estimatedRawTokens: rawTokens, estimatedDeliveredTokens: deliveredTokens, retrievedFragments: 0, deliveredFragments: delivered.length, compressedFragments: compressed, discardedFragments: discarded.length, retrievalRequests: 0, retrievalRetries: 0, retrievalEscapes: 0, compressionRatio: rawTokens ? deliveredTokens / rawTokens : undefined, projectionRatio: rawTokens ? projectedTokens / rawTokens : undefined };
}

function safeSegment(value: string): string { const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, ""); return sanitized || "fragment"; }
function safePath(root: string, relative: string): string { if (path.isAbsolute(relative)) throw new Error("Context artifact paths must be relative to the project root."); const absoluteRoot = path.resolve(root); const absolute = path.resolve(absoluteRoot, relative); if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${path.sep}`)) throw new Error("Context artifact path escapes the project root."); return absolute; }
function isRequiredProjection(fragment: ContextFragmentProjection): boolean { return fragment.preservation === "VERBATIM" || fragment.kind === "normative"; }
