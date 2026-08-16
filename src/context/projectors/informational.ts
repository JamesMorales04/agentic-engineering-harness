import { estimateTokens } from "../estimator.js";
import { sha256 } from "../provenance.js";
import type { InformationalContextBudget } from "../budget.js";
import type { UserFacingClaim } from "../../operations/evidence.js";

export interface InformationalProjectionSourceInput {
  path: string;
  ref: string;
  sha256: string;
  fileSha256?: string;
  relevance: string;
  content: string;
}

export interface InformationalProjectedSource {
  path: string;
  ref: string;
  sha256: string;
  fileSha256?: string;
  relevance: string;
  summary: string;
}

export interface InformationalProjectionMetrics {
  rawEvidenceTokens: number;
  legacyPayloadTokens: number;
  projectedPayloadTokens: number;
  informationalPayloadTokens: number;
  duplicatePayloadTokensAvoided: number;
  sourceCount: number;
  projectedSourceCount: number;
  deferredSourceCount: number;
  targetTokens: number;
  softLimitTokens: number;
  exceptionalTokens: number;
  headroomAttempted: boolean;
  headroomApplied: boolean;
}

export interface InformationalContextProjection {
  claims: UserFacingClaim[];
  sources: InformationalProjectedSource[];
  summary: string;
  human: string;
  metrics: InformationalProjectionMetrics;
}

/**
 * Project repository evidence into a lead-sized informational result. Raw
 * source bytes are intentionally absent; every claim and source points to a
 * live repository-relative evidence ref instead.
 */
export function projectInformationalContext(
  request: string,
  provider: string,
  input: InformationalProjectionSourceInput[],
  budget: InformationalContextBudget
): InformationalContextProjection {
  const unique = deduplicateSources(input);
  const projectedSources = unique.map((source) => ({
    path: source.path,
    ref: source.ref,
    sha256: source.sha256,
    ...(source.fileSha256 ? { fileSha256: source.fileSha256 } : {}),
    relevance: source.relevance,
    summary: summarizeSource(source.content, request, budget.sourceSummaryTokens)
  }));
  const sourceCount = unique.length;
  const rawEvidenceTokens = unique.reduce((sum, source) => sum + estimateTokens(source.content), 0);
  const baseClaims: UserFacingClaim[] = [
    { text: `The answer is grounded in a bounded read-only repository context containing ${sourceCount} source file(s).`, source: "repository-context", verified: true, evidenceRefs: unique.map((source) => source.ref), priority: 80 },
    { text: "No engineering operation, audit report, findings, TaskContract, or delivery artifact was created for this informational request.", source: "repository-context", verified: true, priority: 100 }
  ];
  const sources = fitSources(projectedSources, baseClaims, provider, budget);
  const claims = baseClaims.map((claim) => ({ ...claim, evidenceRefs: claim.evidenceRefs?.filter((ref) => sources.some((source) => source.ref === ref)) }));
  const summary = summarizeProjection(sources, request, budget.exceptionalTokens);
  const human = [
    "INFORMATIONAL — repository-grounded answer (no engineering lifecycle created).",
    sources.length ? `The compact projection contains ${sources.length} verified source summary(ies); deeper source detail is available by explicit evidence reference.` : "No readable matching source was available; no implementation claim is asserted.",
    "Evidence provenance: repository-context. Source details remain available by reference and are retrieved only when needed."
  ].join("\n\n");
  const projectedAnswer = { intent: "informational", provenance: ["repository-context"], inspected: { provider, fileCount: sourceCount, bounded: true }, claims, sources, summary, human };
  const projectedPayloadTokens = estimateTokens(JSON.stringify(projectedAnswer));
  const informationalPayloadTokens = projectedPayloadTokens + estimateTokens("Bounded repository-grounded informational answer available in structuredContent.");
  const legacyPayloadTokens = estimateLegacyInformationalTokens(input, provider);
  return {
    claims,
    sources,
    summary,
    human,
    metrics: {
      rawEvidenceTokens,
      legacyPayloadTokens,
      projectedPayloadTokens,
      informationalPayloadTokens,
      duplicatePayloadTokensAvoided: Math.max(0, legacyPayloadTokens - informationalPayloadTokens),
      sourceCount,
      projectedSourceCount: sources.length,
      deferredSourceCount: sources.filter((source) => source.summary.startsWith("Summary deferred")).length,
      targetTokens: budget.targetTokens,
      softLimitTokens: budget.softLimitTokens,
      exceptionalTokens: budget.exceptionalTokens,
      headroomAttempted: false,
      headroomApplied: false
    }
  };
}

/** Deterministic estimate of the exact former lead-visible representation from main. */
export function estimateLegacyInformationalTokens(input: InformationalProjectionSourceInput[], provider = "filesystem"): number {
  const sources: Array<{ path: string; excerpt: string; sha256: string }> = [];
  let totalBytes = 0;
  for (const source of input.slice(0, 8)) {
    if (totalBytes >= 20_000) break;
    const excerpt = source.content.slice(0, Math.min(4_000, 20_000 - totalBytes));
    if (!excerpt) continue;
    totalBytes += Buffer.byteLength(excerpt, "utf8");
    sources.push({ path: source.path, excerpt, sha256: sha256(excerpt) });
  }
  const claims: UserFacingClaim[] = [
    { text: `The answer is grounded in a bounded read-only repository context containing ${sources.length} source file(s).`, source: "repository-context", verified: true },
    { text: "No engineering operation, audit report, findings, TaskContract, or delivery artifact was created for this informational request.", source: "repository-context", verified: true }
  ];
  const pathLines = sources.length ? sources.map((source) => `- ${source.path}`).join("\n") : "- No matching readable source file was available; repository-map metadata was still consulted.";
  const excerptText = sources.slice(0, 4).map((source) => `\n${source.path}:\n${compactExcerpt(source.excerpt)}`).join("\n");
  const human = [
    "INFORMATIONAL — repository-grounded answer (no engineering lifecycle created).",
    `I used the bounded repository-context surface to orient this explanation. Relevant files:\n${pathLines}`,
    sources.length ? `The selected source excerpts are the evidence for the explanation; they are repository context, not audit findings.${excerptText}` : "The repository context map did not expose a readable matching source file, so no implementation claim is asserted.",
    "Evidence provenance: repository-context. This answer is explanatory, not an evaluation of correctness or safety."
  ].join("\n\n");
  return estimateTokens(JSON.stringify({ intent: "informational", provenance: ["repository-context"], inspected: { provider, files: sources.map((source) => source.path), bounded: true }, claims, sources, human }));
}

function deduplicateSources(input: InformationalProjectionSourceInput[]): InformationalProjectionSourceInput[] {
  const seen = new Set<string>(); const result: InformationalProjectionSourceInput[] = [];
  for (const source of input) {
    const key = `${source.path}\u0000${source.sha256}`;
    if (seen.has(key)) continue;
    seen.add(key); result.push(source);
  }
  return result;
}

function summarizeSource(content: string, request: string, maxTokens: number): string {
  const terms = request.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 3);
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const relevant = lines.filter((line) => terms.some((term) => line.toLowerCase().includes(term)));
  const structural = lines.filter((line) => /^(export|import|class|interface|type|function|async function|const|let|enum|public|private|protected)\b/.test(line));
  const selected = [...new Set([...relevant, ...structural, ...lines.slice(0, 2)])].map((line) => truncate(line, 260));
  const bounded = fitTokenLines(selected, maxTokens);
  return bounded ? `Implementation signals: ${bounded}` : "No concise implementation signal was available; use the evidence reference for a targeted source read.";
}

function fitSources(sources: InformationalProjectedSource[], claims: UserFacingClaim[], provider: string, budget: InformationalContextBudget): InformationalProjectedSource[] {
  let selected = [...sources];
  if (estimateProjectionTokens(selected, claims, provider) > budget.exceptionalTokens) {
    // Keep every reference addressable. Defer prose so a summary budget can
    // never make an otherwise relevant source unreachable.
    selected = selected.map((source) => ({ ...source, summary: "Summary deferred; retrieve this evidence reference for targeted detail." }));
  }
  if (estimateProjectionTokens(selected, claims, provider) > budget.softLimitTokens) {
    selected = selected.map((source) => ({ ...source, summary: fitTokenLines(source.summary.split(/\r?\n/), Math.min(96, budget.sourceSummaryTokens)) }));
  }
  return selected;
}

function summarizeProjection(sources: InformationalProjectedSource[], request: string, maxTokens: number): string {
  if (!sources.length) return "The repository context map did not expose a readable matching source file.";
  const question = request.trim().replace(/\s+/g, " ");
  const text = `The bounded repository inspection selected ${sources.length} relevant source file(s) for “${truncate(question, 180)}”. ${sources.map((source) => `${source.path}: ${source.summary.replace(/\n/g, " ")}`).join(" ")}`;
  return fitTokenLines([text], Math.min(maxTokens, 280));
}

function estimateProjectionTokens(sources: InformationalProjectedSource[], claims: UserFacingClaim[], provider: string): number {
  return estimateTokens(JSON.stringify({ intent: "informational", provenance: ["repository-context"], inspected: { provider, fileCount: sources.length, bounded: true }, claims, sources, summary: summarizeProjection(sources, "repository question", 280) }));
}

function fitTokenLines(lines: string[], maxTokens: number): string {
  const selected: string[] = []; let used = 0;
  for (const line of lines) {
    const remaining = maxTokens - used; if (remaining <= 0) break;
    const clipped = truncateByTokens(line, remaining);
    if (!clipped) break;
    selected.push(clipped); used += estimateTokens(`${clipped}\n`);
  }
  return selected.join("\n");
}

function truncateByTokens(value: string, maxTokens: number): string {
  if (estimateTokens(value) <= maxTokens) return value;
  const maxChars = Math.max(1, maxTokens * 4 - 3);
  return `${value.slice(0, maxChars)}…`;
}

function truncate(value: string, maxCharacters: number): string { return value.length <= maxCharacters ? value : `${value.slice(0, maxCharacters - 1)}…`; }

function compactExcerpt(content: string): string {
  const lines = content.split(/\r?\n/).filter((line) => line.trim()).slice(0, 18);
  return lines.join("\n").slice(0, 1_200);
}
