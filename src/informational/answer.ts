import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessProjectConfig } from "../core/types.js";
import { resolveInformationalContextBudget } from "../context/budget.js";
import { HeadroomCompressionProvider } from "../context/compression/headroom.js";
import type { ContextCompressionProvider } from "../context/compression/types.js";
import type { ContextFragment } from "../context/types.js";
import { estimateTokens } from "../context/estimator.js";
import { buildRepositoryContextMap } from "../context/repository/map.js";
import { projectInformationalContext, type InformationalProjectionMetrics, type InformationalProjectedSource } from "../context/projectors/informational.js";
import { sha256 } from "../context/provenance.js";
import { recordEvent } from "../telemetry/events.js";
import { persistInformationalEvidence, type InformationalRawEvidence } from "./evidence.js";
import type { UserFacingClaim } from "../operations/evidence.js";

// The lead remains bounded by source count, while the durable evidence keeps
// the complete selected file (up to a per-file safety ceiling) for verification.
const MAX_BYTES_PER_FILE = 1_000_000;
const MAX_TOTAL_BYTES = 8_000_000;
const STOP_WORDS = new Set("the a an and or but for with this that how what does is are was were here repository explain describe help me understand quiero como funciona esta este del los las una un que hace donde usa use works implemented implementation".split(" "));

export type InformationalSource = InformationalProjectedSource;

export interface InformationalAnswer {
  intent: "informational";
  provenance: UserFacingClaim["source"][];
  inspected: { provider: string; fileCount: number; bounded: true };
  claims: UserFacingClaim[];
  sources: InformationalSource[];
  summary: string;
  human: string;
  telemetry: InformationalProjectionMetrics;
}

export interface InformationalAnswerOptions { compressor?: ContextCompressionProvider; }

/**
 * Read-only, bounded repository grounding for conversational questions. This
 * path deliberately does not create an OperationRecord, TaskContract, report,
 * reviewer session, or delivery artifact.
 */
export async function answerInformationalRequest(root: string, config: HarnessProjectConfig, request: string, options: InformationalAnswerOptions = {}): Promise<InformationalAnswer> {
  const rendered = await buildRepositoryContextMap(root, config, {});
  const budget = resolveInformationalContextBudget(config);
  const terms = queryTerms(request);
  const candidates = rendered.map.nodes
    .map((node) => ({ node, score: relevance(node.file, node.symbol, terms) }))
    .sort((a, b) => b.score - a.score || a.node.file.localeCompare(b.node.file) || (a.node.symbol ?? "").localeCompare(b.node.symbol ?? ""));
  const selected = candidates.filter((item) => item.score > 0).slice(0, budget.maxSources);
  const fallback = selected.length ? selected : candidates.slice(0, budget.maxSources);
  const rawSources: InformationalRawEvidence[] = [];
  let totalBytes = 0;
  for (const item of fallback) {
    if (totalBytes >= MAX_TOTAL_BYTES) break;
    const relative = normalizeRelative(item.node.file);
    if (!relative) continue;
    const content = await readBoundedSource(root, relative, Math.min(MAX_BYTES_PER_FILE, MAX_TOTAL_BYTES - totalBytes));
    if (!content) continue;
    totalBytes += Buffer.byteLength(content, "utf8");
    rawSources.push({ path: relative, content, sha256: sha256(content), relevance: `${item.score} — ${item.node.symbol ?? "repository-map match"}` });
  }

  const stored = await Promise.all(rawSources.map((source) => persistInformationalEvidence(root, source)));
  const initialProjection = projectInformationalContext(request, rendered.map.provider, stored.map((source, index) => ({ ...source, content: rawSources[index]?.content ?? "" })), budget);
  const projection = await applyHeadroomAfterProjection(root, config, request, initialProjection, budget, options.compressor);
  const answer: InformationalAnswer = {
    intent: "informational",
    provenance: ["repository-context"],
    inspected: { provider: rendered.map.provider, fileCount: rawSources.length, bounded: true },
    claims: projection.claims,
    sources: projection.sources,
    summary: projection.summary,
    human: projection.human,
    telemetry: projection.metrics
  };
  if (config.telemetry?.enabled !== false) {
    await recordEvent(root, config, "harness.context.informational", {
      rawEvidenceTokens: projection.metrics.rawEvidenceTokens,
      legacyEstimatedTokens: projection.metrics.legacyEstimatedTokens,
      projectedTokens: projection.metrics.projectedTokens,
      injectedTokens: projection.metrics.injectedTokens,
      duplicateTokensAvoided: projection.metrics.duplicateTokensAvoided,
      sourceCount: projection.metrics.sourceCount,
      projectedSourceCount: projection.metrics.projectedSourceCount,
      deferredSourceCount: projection.metrics.deferredSourceCount,
      provider: rendered.map.provider,
      retrieval: "reference-on-demand",
      headroom: config.context?.compression?.provider ?? "headroom",
      budgetTargetTokens: budget.targetTokens,
      budgetSoftLimitTokens: budget.softLimitTokens,
      budgetExceptionalTokens: budget.exceptionalTokens,
      headroomAttempted: projection.metrics.headroomAttempted,
      headroomApplied: projection.metrics.headroomApplied
    });
  }
  return answer;
}

async function applyHeadroomAfterProjection(root: string, config: HarnessProjectConfig, request: string, projection: ReturnType<typeof projectInformationalContext>, budget: ReturnType<typeof resolveInformationalContextBudget>, supplied?: ContextCompressionProvider): Promise<ReturnType<typeof projectInformationalContext>> {
  // Deterministic projection is the normal path. Headroom only sees the
  // already-deduplicated supporting summary when it would exceed the lead
  // target; claims, refs and critical signals remain outside the compressor.
  if (projection.metrics.projectedTokens <= budget.targetTokens) return projection;
  if ((config.context?.compression?.provider ?? "headroom") !== "headroom") return { ...projection, metrics: { ...projection.metrics, headroomAttempted: false, headroomApplied: false } };
  const compressor = supplied ?? new HeadroomCompressionProvider(config.context?.compression?.command ? { command: config.context.compression.command } : {});
  const content = projection.summary;
  const fragment: ContextFragment = { id: "informational-summary", kind: "tool-output", preservation: "COMPRESSIBLE", priority: 20, content };
  const sourceSha256 = sha256(content);
  try {
    const compressed = await compressor.compress(root, { operationId: `informational-${sha256(request).slice(0, 16)}`, fragment, maxTokens: Math.min(budget.targetTokens, Math.max(1, Math.floor(projection.metrics.projectedTokens * 0.6))), sourceSha256, reversible: false });
    if (compressed.compressedTokens >= estimateTokens(content)) return { ...projection, metrics: { ...projection.metrics, headroomAttempted: true, headroomApplied: false } };
    const projectedTokens = Math.max(0, projection.metrics.projectedTokens - estimateTokens(content) + compressed.compressedTokens);
    const injectedTokens = Math.max(0, projection.metrics.injectedTokens - estimateTokens(content) + compressed.compressedTokens);
    return { ...projection, summary: compressed.content, metrics: { ...projection.metrics, projectedTokens, injectedTokens, duplicateTokensAvoided: Math.max(0, projection.metrics.legacyEstimatedTokens - injectedTokens), headroomAttempted: true, headroomApplied: true } };
  } catch {
    // The deterministic projection is already safe and referential. A missing
    // optional compressor must not turn a read-only explanation into a failed
    // route or remove critical evidence.
    return { ...projection, metrics: { ...projection.metrics, headroomAttempted: true, headroomApplied: false } };
  }
}

function queryTerms(request: string): string[] {
  const normalized = request.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const terms = new Set(normalized.split(/[^a-z0-9]+/).filter((term) => term.length >= 3 && !STOP_WORDS.has(term)));
  if ([...terms].some((term) => ["validation", "validator", "validators", "validacion", "validadores"].includes(term))) {
    for (const term of ["validation", "validator", "validators", "validate", "evidence", "report", "audit", "verify"]) terms.add(term);
  }
  if ([...terms].some((term) => ["architecture", "arquitectura", "implemented", "implementacion", "flow", "flujo"].includes(term))) {
    for (const term of ["architecture", "context", "operations", "validation", "audit"]) terms.add(term);
  }
  return [...terms];
}

function relevance(file: string, symbol: string | undefined, terms: string[]): number {
  const value = `${file} ${symbol ?? ""}`.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return terms.reduce((score, term) => score + (value.includes(term) ? (file.includes(term) ? 4 : 2) : 0), 0);
}

function normalizeRelative(value: string): string | undefined {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) return undefined;
  return normalized;
}

async function readBoundedSource(root: string, relative: string, limit: number): Promise<string | undefined> {
  const projectRoot = await fs.realpath(root).catch(() => path.resolve(root));
  const absolute = path.resolve(projectRoot, relative);
  if (absolute !== projectRoot && !absolute.startsWith(`${projectRoot}${path.sep}`)) return undefined;
  const real = await fs.realpath(absolute).catch(() => undefined);
  if (!real || (real !== projectRoot && !real.startsWith(`${projectRoot}${path.sep}`))) return undefined;
  const stat = await fs.stat(real).catch(() => undefined);
  if (!stat?.isFile() || stat.size > 1_000_000) return undefined;
  return (await fs.readFile(real, "utf8")).slice(0, Math.max(1, limit));
}
