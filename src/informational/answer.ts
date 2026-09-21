import crypto from "node:crypto";
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
import { informationalEvidenceRef } from "./evidence.js";
import type { UserFacingClaim } from "../operations/evidence.js";

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
  const uniqueCandidates = deduplicateCandidates(candidates);
  const selected = uniqueCandidates.filter((item) => item.score > 0).slice(0, budget.maxSources);
  const fallback = selected.length ? selected : uniqueCandidates.slice(0, budget.maxSources);
  const rawSources: Array<{ path: string; ref: string; sha256: string; fileSha256: string; relevance: string; content: string }> = [];
  let totalBytes = 0;
  for (const item of fallback) {
    if (totalBytes >= budget.maxInitialBytesTotal) break;
    const relative = normalizeRelative(item.node.file);
    if (!relative) continue;
    const source = await readBoundedSource(root, relative, Math.min(budget.maxInitialBytesPerSource, budget.maxInitialBytesTotal - totalBytes));
    if (!source) continue;
    totalBytes += source.bytes.byteLength;
    const digest = sha256(source.bytes);
    rawSources.push({ path: relative, ref: informationalEvidenceRef(relative, digest, source.range, { fileSha256: source.fileSha256 }), content: source.content, sha256: digest, fileSha256: source.fileSha256, relevance: `${item.score} — ${item.node.symbol ?? "repository-map match"}` });
  }

  const initialProjection = projectInformationalContext(request, rendered.map.provider, rawSources, budget);
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
  return answer;
}

async function applyHeadroomAfterProjection(root: string, config: HarnessProjectConfig, request: string, projection: ReturnType<typeof projectInformationalContext>, budget: ReturnType<typeof resolveInformationalContextBudget>, supplied?: ContextCompressionProvider): Promise<ReturnType<typeof projectInformationalContext>> {
  // Deterministic projection is the normal path. Headroom only sees the
  // already-deduplicated supporting summary when it would exceed the lead
  // target; claims, refs and epistemic qualifications remain outside the compressor.
  if (projection.metrics.projectedPayloadTokens <= budget.targetTokens) return projection;
  if ((config.context?.compression?.provider ?? "headroom") !== "headroom") return { ...projection, metrics: { ...projection.metrics, headroomAttempted: false, headroomApplied: false } };
  const compressor = supplied ?? new HeadroomCompressionProvider(config.context?.compression?.command ? { command: config.context.compression.command } : {});
  const content = projection.summary;
  const fragment: ContextFragment = { id: "informational-summary", kind: "tool-output", preservation: "COMPRESSIBLE", priority: 20, content };
  const sourceSha256 = sha256(content);
  try {
    const compressed = await compressor.compress(root, { operationId: `informational-${sha256(request).slice(0, 16)}`, fragment, maxTokens: Math.min(budget.targetTokens, Math.max(1, Math.floor(projection.metrics.projectedPayloadTokens * 0.6))), sourceSha256, reversible: false });
    if (compressed.compressedTokens >= estimateTokens(content)) return { ...projection, metrics: { ...projection.metrics, headroomAttempted: true, headroomApplied: false } };
    const projectedPayloadTokens = Math.max(0, projection.metrics.projectedPayloadTokens - estimateTokens(content) + compressed.compressedTokens);
    const informationalPayloadTokens = Math.max(0, projection.metrics.informationalPayloadTokens - estimateTokens(content) + compressed.compressedTokens);
    return { ...projection, summary: compressed.content, metrics: { ...projection.metrics, projectedPayloadTokens, informationalPayloadTokens, duplicatePayloadTokensAvoided: Math.max(0, projection.metrics.legacyPayloadTokens - informationalPayloadTokens), headroomAttempted: true, headroomApplied: true } };
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

export function selectInformationalCandidates(candidates: Array<{ node: { file: string; symbol?: string }; score: number }>, maxSources: number): Array<{ node: { file: string; symbol?: string }; score: number }> {
  const seen = new Set<string>();
  return candidates.filter((item) => {
    const relative = normalizeRelative(item.node.file);
    if (!relative || seen.has(relative)) return false;
    seen.add(relative);
    return true;
  }).slice(0, maxSources);
}

function deduplicateCandidates(candidates: Array<{ node: { file: string; symbol?: string }; score: number }>): Array<{ node: { file: string; symbol?: string }; score: number }> {
  return selectInformationalCandidates(candidates, Number.MAX_SAFE_INTEGER);
}

function normalizeRelative(value: string): string | undefined {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:[\\/]/.test(normalized) || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..") || path.posix.normalize(normalized) !== normalized) return undefined;
  return normalized;
}

async function readBoundedSource(root: string, relative: string, limit: number): Promise<{ content: string; bytes: Buffer; range: { startByte: number; endByte: number }; fileSha256: string } | undefined> {
  const projectRoot = await fs.realpath(root).catch(() => path.resolve(root));
  const absolute = path.resolve(projectRoot, relative);
  if (absolute !== projectRoot && !absolute.startsWith(`${projectRoot}${path.sep}`)) return undefined;
  const real = await fs.realpath(absolute).catch(() => undefined);
  if (!real || (real !== projectRoot && !real.startsWith(`${projectRoot}${path.sep}`))) return undefined;
  const stat = await fs.stat(real).catch(() => undefined);
  if (!stat?.isFile() || stat.size === 0) return undefined;
  const handle = await fs.open(real, "r");
  const digest = crypto.createHash("sha256");
  const initial = Buffer.alloc(Math.max(1, Math.min(limit, stat.size)));
  const hashBuffer = Buffer.alloc(64 * 1024);
  try {
    let position = 0;
    let captured = 0;
    while (true) {
      const result = await handle.read(hashBuffer, 0, hashBuffer.byteLength, position);
      if (!result.bytesRead) break;
      const chunk = hashBuffer.subarray(0, result.bytesRead);
      digest.update(chunk);
      if (captured < initial.byteLength) {
        const amount = Math.min(initial.byteLength - captured, chunk.byteLength);
        chunk.copy(initial, captured, 0, amount);
        captured += amount;
      }
      position += result.bytesRead;
    }
    const after = await fs.stat(real).catch(() => undefined);
    if (!after?.isFile() || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) return undefined;
    const bytes = initial.subarray(0, captured);
    return { content: bytes.toString("utf8"), bytes, range: { startByte: 0, endByte: captured }, fileSha256: digest.digest("hex") };
  } finally {
    await handle.close();
  }
}
