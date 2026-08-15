import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessProjectConfig } from "../core/types.js";
import { sha256 } from "../context/provenance.js";
import { buildRepositoryContextMap } from "../context/repository/map.js";
import type { UserFacingClaim } from "../operations/evidence.js";

const MAX_FILES = 8;
const MAX_BYTES_PER_FILE = 4_000;
const MAX_TOTAL_BYTES = 20_000;
const STOP_WORDS = new Set("the a an and or but for with this that how what does is are was were here repository system explain describe help me understand quiero como funciona esta este del los las una un que hace donde usa use works implemented implementation validation validator validators architecture system flow problems problem review audit explain".split(" "));

export interface InformationalSource {
  path: string;
  excerpt: string;
  sha256: string;
}

export interface InformationalAnswer {
  intent: "informational";
  provenance: UserFacingClaim["source"][];
  inspected: { provider: string; files: string[]; bounded: true };
  claims: UserFacingClaim[];
  sources: InformationalSource[];
  human: string;
}

/**
 * Read-only, bounded repository grounding for conversational questions. This
 * path deliberately does not create an OperationRecord, TaskContract, report,
 * reviewer session, or delivery artifact.
 */
export async function answerInformationalRequest(root: string, config: HarnessProjectConfig, request: string): Promise<InformationalAnswer> {
  const rendered = await buildRepositoryContextMap(root, config, {});
  const terms = queryTerms(request);
  const candidates = rendered.map.nodes
    .map((node) => ({ node, score: relevance(node.file, node.symbol, terms) }))
    .sort((a, b) => b.score - a.score || a.node.file.localeCompare(b.node.file) || (a.node.symbol ?? "").localeCompare(b.node.symbol ?? ""));
  const selected = candidates.filter((item) => item.score > 0).slice(0, MAX_FILES);
  const fallback = selected.length ? selected : candidates.slice(0, MAX_FILES);
  const sources: InformationalSource[] = [];
  let totalBytes = 0;
  for (const item of fallback) {
    if (totalBytes >= MAX_TOTAL_BYTES) break;
    const relative = normalizeRelative(item.node.file);
    if (!relative) continue;
    const content = await readBoundedSource(root, relative, Math.min(MAX_BYTES_PER_FILE, MAX_TOTAL_BYTES - totalBytes));
    if (!content) continue;
    totalBytes += Buffer.byteLength(content, "utf8");
    sources.push({ path: relative, excerpt: content, sha256: sha256(content) });
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
  return { intent: "informational", provenance: ["repository-context"], inspected: { provider: rendered.map.provider, files: sources.map((source) => source.path), bounded: true }, claims, sources, human };
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

function compactExcerpt(content: string): string {
  const lines = content.split(/\r?\n/).filter((line) => line.trim()).slice(0, 18);
  return lines.join("\n").slice(0, 1_200);
}
