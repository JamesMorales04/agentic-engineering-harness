import fs from "node:fs/promises";
import path from "node:path";
import { estimateTokens } from "../context/estimator.js";
import { sha256 } from "../context/provenance.js";

const EVIDENCE_DIRECTORY = path.posix.join(".harness", "informational", "evidence");
const DEFAULT_RETRIEVAL_TOKENS = 1_200;
const MAX_RETRIEVAL_TOKENS = 6_000;

export interface InformationalRawEvidence {
  path: string;
  content: string;
  sha256: string;
  relevance: string;
}

export interface StoredInformationalEvidence {
  path: string;
  ref: string;
  artifact: string;
  sha256: string;
  relevance: string;
}

export interface InformationalEvidenceResult {
  ref: string;
  path: string;
  artifact: string;
  sha256: string;
  content: string;
  estimatedTokens: number;
  truncated: boolean;
}

/**
 * Store authoritative informational evidence outside the lead projection.
 * The content-addressed artifact is reusable across turns and cannot be
 * replaced by a different payload without a hash mismatch.
 */
export async function persistInformationalEvidence(root: string, evidence: InformationalRawEvidence): Promise<StoredInformationalEvidence> {
  const contentSha256 = sha256(evidence.content);
  if (contentSha256 !== evidence.sha256) throw new Error(`Informational evidence hash mismatch for '${evidence.path}'.`);
  const artifact = path.posix.join(EVIDENCE_DIRECTORY, `${contentSha256}.raw`);
  const absolute = safePath(root, artifact);
  await assertNoSymlinkEscape(root, absolute);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const existing = await readArtifact(absolute);
  if (existing && sha256(existing) !== contentSha256) throw new Error(`Informational evidence artifact collision for '${artifact}'.`);
  if (!existing) {
    try { await fs.writeFile(absolute, evidence.content, { encoding: "utf8", flag: "wx" }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const winner = await readArtifact(absolute);
      if (!winner || sha256(winner) !== contentSha256) throw new Error(`Informational evidence artifact collision for '${artifact}'.`);
    }
  }
  return { path: evidence.path, ref: informationalEvidenceRef(evidence.path, contentSha256), artifact, sha256: contentSha256, relevance: evidence.relevance };
}

export function informationalEvidenceRef(filePath: string, contentSha256: string): string {
  return `repo://${encodePath(filePath)}#sha256=${contentSha256}`;
}

/** Retrieve one explicitly referenced source; no directory or arbitrary-path reads are allowed. */
export async function retrieveInformationalEvidence(root: string, ref: string, maxTokens = DEFAULT_RETRIEVAL_TOKENS): Promise<InformationalEvidenceResult> {
  const parsed = parseInformationalEvidenceRef(ref);
  const boundedTokens = Math.min(Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : DEFAULT_RETRIEVAL_TOKENS, MAX_RETRIEVAL_TOKENS);
  const artifact = path.posix.join(EVIDENCE_DIRECTORY, `${parsed.sha256}.raw`);
  const absolute = safePath(root, artifact);
  await assertNoSymlinkEscape(root, absolute);
  const raw = await fs.readFile(absolute, "utf8");
  const actual = sha256(raw);
  if (actual !== parsed.sha256) throw new Error(`INFORMATIONAL_EVIDENCE_HASH_MISMATCH: ${artifact}.`);
  const originalTokens = estimateTokens(raw);
  const content = originalTokens <= boundedTokens ? raw : boundedLines(raw, boundedTokens);
  return { ref, path: parsed.path, artifact, sha256: actual, content, estimatedTokens: estimateTokens(content), truncated: content !== raw };
}

export function parseInformationalEvidenceRef(ref: string): { path: string; sha256: string } {
  const match = /^repo:\/\/(.+)#sha256=([a-f0-9]{64})$/.exec(ref.trim());
  if (!match?.[1] || !match[2]) throw new Error("INFORMATIONAL_EVIDENCE_REF_INVALID: expected repo://<path>#sha256=<sha256>." );
  const decoded = decodePath(match[1]);
  if (!decoded || decoded.startsWith("/") || decoded.split("/").includes("..")) throw new Error("INFORMATIONAL_EVIDENCE_REF_INVALID: source path is not repository-relative.");
  return { path: decoded, sha256: match[2] };
}

function boundedLines(value: string, maxTokens: number): string {
  const lines = value.split(/\r?\n/); const selected: string[] = []; let used = 0;
  for (const line of lines) {
    const next = estimateTokens(`${line}\n`);
    if (used + next > maxTokens) break;
    selected.push(line); used += next;
  }
  return `${selected.join("\n")}\n[bounded informational evidence; request the reference again with a larger authorized budget for more]`;
}

function encodePath(value: string): string { return value.split("/").map((part) => encodeURIComponent(part)).join("/"); }
function decodePath(value: string): string { return value.split("/").map((part) => decodeURIComponent(part)).join("/"); }
async function readArtifact(absolute: string): Promise<Buffer | undefined> { try { return await fs.readFile(absolute); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
function safePath(root: string, relative: string): string {
  if (path.isAbsolute(relative)) throw new Error("Informational evidence paths must be relative to the repository root.");
  const absoluteRoot = path.resolve(root); const absolute = path.resolve(absoluteRoot, relative);
  if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${path.sep}`)) throw new Error("Informational evidence path escapes the repository root.");
  return absolute;
}
async function assertNoSymlinkEscape(root: string, absolute: string): Promise<void> {
  const absoluteRoot = path.resolve(root); let cursor = absolute;
  while (cursor !== absoluteRoot && cursor.startsWith(`${absoluteRoot}${path.sep}`)) {
    try { if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error("Informational evidence paths cannot traverse symbolic links."); }
    catch (error) { if (error instanceof Error && error.message.includes("cannot traverse")) throw error; if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    cursor = path.dirname(cursor);
  }
  if (cursor !== absoluteRoot) throw new Error("Informational evidence path escapes the repository root.");
}
