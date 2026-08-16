import { estimateTokens } from "../estimator.js";
import type { InformationalContextBudget } from "../budget.js";
import type { UserFacingClaim } from "../../operations/evidence.js";

export interface InformationalProjectionSourceInput {
  path: string;
  ref: string;
  sha256: string;
  relevance: string;
  content: string;
}

export interface InformationalProjectedSource {
  path: string;
  ref: string;
  sha256: string;
  relevance: string;
  summary: string;
}

export interface InformationalProjectionMetrics {
  rawEvidenceTokens: number;
  legacyEstimatedTokens: number;
  projectedTokens: number;
  injectedTokens: number;
  duplicateTokensAvoided: number;
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
 * source bytes are intentionally absent; every claim and source points to the
 * content-addressed evidence store instead.
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
    relevance: source.relevance,
    summary: summarizeSource(source.content, request, budget.sourceSummaryTokens)
  }));
  const sourceCount = unique.length;
  const rawEvidenceTokens = unique.reduce((sum, source) => sum + estimateTokens(source.content), 0);
  const criticalClaims = criticalEvidenceClaims(unique);
  const baseClaims: UserFacingClaim[] = [
    { text: `The answer is grounded in a bounded read-only repository context containing ${sourceCount} source file(s).`, source: "repository-context", verified: true, evidenceRefs: unique.map((source) => source.ref), priority: 80 },
    { text: "No engineering operation, audit report, findings, TaskContract, or delivery artifact was created for this informational request.", source: "repository-context", verified: true, priority: 100 },
    ...criticalClaims
  ];
  const sources = fitSources(projectedSources, baseClaims, provider, budget);
  const claims = baseClaims.map((claim) => ({ ...claim, evidenceRefs: claim.evidenceRefs?.filter((ref) => sources.some((source) => source.ref === ref)) }));
  const summary = summarizeProjection(sources, request, budget.exceptionalTokens);
  const human = [
    "INFORMATIONAL — repository-grounded answer (no engineering lifecycle created).",
    `The compact projection contains ${sources.length} verified source summary(ies) and claim reference(s) for the lead; deeper source detail is available on demand.`,
    sources.length ? `Sources: ${sources.map((source) => `${source.path} (${source.ref})`).join(", ")}.` : "No readable matching source was available; no implementation claim is asserted.",
    "Evidence provenance: repository-context. Source details remain available by reference and are retrieved only when needed."
  ].join("\n\n");
  const projectedAnswer = { intent: "informational", provenance: ["repository-context"], inspected: { provider, fileCount: sourceCount, bounded: true }, claims, sources, summary, human };
  const projectedTokens = estimateTokens(JSON.stringify(projectedAnswer));
  const injectedTokens = estimateTokens(JSON.stringify(projectedAnswer)) + estimateTokens("Bounded repository-grounded informational answer available in structuredContent.");
  const legacyEstimatedTokens = estimateLegacyInformationalTokens(unique, provider);
  return {
    claims,
    sources,
    summary,
    human,
    metrics: {
      rawEvidenceTokens,
      legacyEstimatedTokens,
      projectedTokens,
      injectedTokens,
      duplicateTokensAvoided: Math.max(0, legacyEstimatedTokens - injectedTokens),
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

/** Deterministic estimate of the former lead-visible representation, useful for before/after telemetry and regression tests. */
export function estimateLegacyInformationalTokens(input: InformationalProjectionSourceInput[], provider = "filesystem"): number {
  const unique = deduplicateSources(input);
  const sources = unique.map((source) => ({ path: source.path, excerpt: source.content, sha256: source.sha256 }));
  const excerptText = unique.slice(0, 4).map((source) => `\n${source.path}:\n${source.content}`).join("\n");
  const human = [
    "INFORMATIONAL — repository-grounded answer (no engineering lifecycle created).",
    `I used the bounded repository-context surface to orient this explanation. Relevant files:\n${unique.map((source) => `- ${source.path}`).join("\n")}`,
    `The selected source excerpts are the evidence for the explanation; they are repository context, not audit findings.${excerptText}`,
    "Evidence provenance: repository-context. This answer is explanatory, not an evaluation of correctness or safety."
  ].join("\n\n");
  return estimateTokens(JSON.stringify({ intent: "informational", provenance: ["repository-context"], inspected: { provider, files: unique.map((source) => source.path), bounded: true }, claims: ["legacy claims"], sources, human }));
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
  const critical = lines.filter((line) => /\b(blocker|critical|fail|failed|warn|warning|security|uncertain|error|exception|vulnerability|unsafe)\b/i.test(line));
  const relevant = lines.filter((line) => terms.some((term) => line.toLowerCase().includes(term)));
  const structural = lines.filter((line) => /^(export|import|class|interface|type|function|async function|const|let|enum|public|private|protected)\b/.test(line));
  const selected = [...new Set([...critical, ...relevant, ...structural, ...lines.slice(0, 2)])].map((line) => truncate(line, 260));
  const bounded = fitTokenLines(selected, maxTokens);
  return bounded || "No concise implementation signal was available; use the evidence reference for a targeted source read.";
}

function criticalEvidenceClaims(sources: InformationalProjectionSourceInput[]): UserFacingClaim[] {
  const claims: UserFacingClaim[] = [];
  const seenCategories = new Set<string>();
  const categoryPattern: Array<[string, RegExp]> = [["blocker", /\b(blocker|critical|fail|failed)\b/i], ["pass", /\b(pass|passed|success|succeeded)\b/i], ["warning", /\b(warn|warning)\b/i], ["security", /\b(security|vulnerability|unsafe)\b/i], ["uncertainty", /\b(uncertain|unknown|incomplete)\b/i]];
  for (const source of sources) {
    const signals = source.content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const [category, pattern] of categoryPattern) {
      const signal = signals.find((line) => pattern.test(line));
      if (!signal || seenCategories.has(category)) continue;
      seenCategories.add(category);
      claims.push({ text: `${source.path}: ${truncate(signal, 280)}`, source: "repository-context", verified: true, evidenceRefs: [source.ref], priority: category === "blocker" ? 100 : 90 });
    }
  }
  return claims;
}

function fitSources(sources: InformationalProjectedSource[], claims: UserFacingClaim[], provider: string, budget: InformationalContextBudget): InformationalProjectedSource[] {
  let selected = [...sources];
  if (estimateProjectionTokens(selected, claims, provider) > budget.exceptionalTokens) {
    // Keep every reference addressable. Defer only non-critical prose so a
    // summary budget can never make an otherwise relevant source unreachable.
    selected = selected.map((source) => claims.some((claim) => claim.evidenceRefs?.includes(source.ref) && (claim.priority ?? 0) >= 90) ? source : { ...source, summary: "Summary deferred; retrieve this evidence reference for targeted detail." });
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
