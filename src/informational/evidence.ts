import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { estimateTokens } from "../context/estimator.js";

const DEFAULT_RETRIEVAL_TOKENS = 1_200;
const MAX_RETRIEVAL_TOKENS = 6_000;
const MAX_RETURNED_BYTES = 256_000;
const HASH_BUFFER_BYTES = 64 * 1024;

export interface InformationalEvidenceRange {
  startByte: number;
  endByte: number;
}

export interface InformationalEvidenceRefOptions {
  /** Hash of the live file, independent of the selected evidence range. */
  fileSha256?: string;
  /** A later bounded range to return while preserving the original locator. */
  requestedRange?: InformationalEvidenceRange;
}

export interface ParsedInformationalEvidenceRef {
  path: string;
  /** Hash of the selected range, or of the complete file for a legacy ref. */
  sha256: string;
  fileSha256?: string;
  range?: InformationalEvidenceRange;
  requestedRange?: InformationalEvidenceRange;
}

export interface InformationalEvidenceResult {
  ref: string;
  path: string;
  /** The selected-range identity carried by the ref. */
  sha256: string;
  fileSha256?: string;
  content: string;
  estimatedTokens: number;
  truncated: boolean;
  range?: InformationalEvidenceRange;
  selectedRange?: InformationalEvidenceRange;
}

/**
 * Build a repository-relative reference. New references carry both the
 * selected chunk identity and a whole-file identity, so a caller can ask for
 * a later range without confusing that range's hash with the original one.
 * The optional arguments preserve the old range-only format for callers that
 * have not yet adopted file identity.
 */
export function informationalEvidenceRef(filePath: string, contentSha256: string, range?: InformationalEvidenceRange, options: InformationalEvidenceRefOptions = {}): string {
  assertDigest(contentSha256, "content SHA-256");
  if (options.fileSha256 !== undefined) assertDigest(options.fileSha256, "file SHA-256");
  validateRange(range, "selected");
  validateRange(options.requestedRange, "requested");
  if (options.requestedRange && !options.fileSha256) throw new Error("INFORMATIONAL_EVIDENCE_REF_INVALID: a requested retrieval range requires file identity.");
  const params = [`sha256=${contentSha256}`];
  if (options.fileSha256) params.push(`file-sha256=${options.fileSha256}`);
  if (range) params.push(`range=${formatRange(range)}`);
  if (options.requestedRange) params.push(`read=${formatRange(options.requestedRange)}`);
  return `repo://${encodeURIComponent(filePath).replaceAll("%2F", "/")}#${params.join("&")}`;
}

export function parseInformationalEvidenceRef(ref: string): ParsedInformationalEvidenceRef {
  try {
    const match = /^repo:\/\/([^#]+)#([^#]+)$/.exec(ref);
    if (!match) throw new Error("expected repo://<relative-path>#<evidence-query>.");
    const relative = decodeURIComponent(match[1] ?? "");
    assertRepositoryRelativePath(relative);
    const params = new URLSearchParams(match[2]);
    const allowed = new Set(["sha256", "file-sha256", "range", "read"]);
    for (const key of params.keys()) if (!allowed.has(key) || params.getAll(key).length !== 1) throw new Error("contains an unknown or repeated parameter");

    const sha256 = params.get("sha256");
    if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("requires sha256=<sha256>");
    const fileSha256 = params.get("file-sha256") ?? undefined;
    if (fileSha256 !== undefined && !/^[a-f0-9]{64}$/.test(fileSha256)) throw new Error("file-sha256 must be a SHA-256 digest");
    const range = parseRange(params.get("range"), "selected");
    const requestedRange = parseRange(params.get("read"), "requested");
    if (requestedRange && !fileSha256) throw new Error("a requested retrieval range requires file identity");
    return { path: relative, sha256, ...(fileSha256 ? { fileSha256 } : {}), ...(range ? { range } : {}), ...(requestedRange ? { requestedRange } : {}) };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("INFORMATIONAL_EVIDENCE_REF_INVALID:")) throw error;
    throw new Error(`INFORMATIONAL_EVIDENCE_REF_INVALID: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Retrieve a bounded live repository range. New refs verify the whole-file
 * identity with a streaming hash and independently verify the selected chunk;
 * only the requested bytes are retained for delivery. There is deliberately
 * no evidence persistence or cache here: a ref authorizes inspection of the
 * live repository, not an artifact lookup.
 */
export async function retrieveInformationalEvidence(root: string, ref: string, maxTokens = DEFAULT_RETRIEVAL_TOKENS): Promise<InformationalEvidenceResult> {
  const parsed = parseInformationalEvidenceRef(ref);
  const real = await resolveRepositoryFile(root, parsed.path);
  const before = await fs.stat(real).catch(() => undefined);
  if (!before?.isFile()) throw new Error(`INFORMATIONAL_EVIDENCE_SOURCE_UNAVAILABLE: '${parsed.path}' is not a readable file.`);

  const selectedRange = parsed.range ?? (parsed.fileSha256 ? undefined : { startByte: 0, endByte: before.size });
  if (selectedRange) assertRangeWithinFile(selectedRange, before.size, "selected");
  const requestedRange = parsed.requestedRange ?? parsed.range;
  if (requestedRange) assertRangeWithinFile(requestedRange, before.size, "requested");

  let actualFileSha256: string | undefined;
  if (parsed.fileSha256) {
    actualFileSha256 = await hashFile(real);
    if (actualFileSha256 !== parsed.fileSha256) throw staleError(parsed.path, parsed.fileSha256, actualFileSha256);
  }

  const actualSelectedSha256 = selectedRange ? await hashFileRange(real, selectedRange) : actualFileSha256 ?? await hashFile(real);
  if (actualSelectedSha256 !== parsed.sha256) throw staleError(parsed.path, parsed.sha256, actualSelectedSha256);

  const target = requestedRange ?? { startByte: 0, endByte: before.size };
  const targetLength = target.endByte - target.startByte;
  const bytes = await readBytes(real, target.startByte, Math.min(targetLength, MAX_RETURNED_BYTES));
  if (bytes.byteLength !== Math.min(targetLength, MAX_RETURNED_BYTES)) throw new Error(`INFORMATIONAL_EVIDENCE_STALE: source '${parsed.path}' changed while it was being retrieved.`);
  const after = await fs.stat(real).catch(() => undefined);
  if (!after?.isFile() || statFingerprint(before) !== statFingerprint(after)) throw new Error(`INFORMATIONAL_EVIDENCE_STALE: source '${parsed.path}' changed while it was being retrieved.`);

  const tokenLimit = Math.min(MAX_RETRIEVAL_TOKENS, Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : DEFAULT_RETRIEVAL_TOKENS);
  const raw = bytes.toString("utf8");
  const content = boundedLines(raw, tokenLimit);
  const returnedRange = requestedRange ?? parsed.range;
  return {
    ref,
    path: parsed.path,
    sha256: parsed.sha256,
    ...(actualFileSha256 ? { fileSha256: actualFileSha256 } : {}),
    content,
    estimatedTokens: estimateTokens(content),
    truncated: content.length < raw.length || targetLength > bytes.byteLength,
    ...(returnedRange ? { range: { ...returnedRange } } : {}),
    ...(parsed.range ? { selectedRange: { ...parsed.range } } : {})
  };
}

async function resolveRepositoryFile(root: string, relative: string): Promise<string> {
  const projectRoot = await fs.realpath(root).catch(() => path.resolve(root));
  const absolute = path.resolve(projectRoot, relative);
  if (absolute !== projectRoot && !absolute.startsWith(`${projectRoot}${path.sep}`)) throw new Error("INFORMATIONAL_EVIDENCE_SOURCE_UNAVAILABLE: evidence path escapes the repository.");
  const real = await fs.realpath(absolute).catch(() => undefined);
  if (!real || (real !== projectRoot && !real.startsWith(`${projectRoot}${path.sep}`))) throw new Error(`INFORMATIONAL_EVIDENCE_SOURCE_UNAVAILABLE: '${relative}' is outside the repository.`);
  return real;
}

async function readBytes(filePath: string, start: number, length: number): Promise<Buffer> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const handle = await fs.open(filePath, "r");
  const buffer = Buffer.alloc(HASH_BUFFER_BYTES);
  try {
    let position = 0;
    while (true) {
      const result = await handle.read(buffer, 0, buffer.byteLength, position);
      if (!result.bytesRead) break;
      hash.update(buffer.subarray(0, result.bytesRead));
      position += result.bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function hashFileRange(filePath: string, range: InformationalEvidenceRange): Promise<string> {
  const hash = crypto.createHash("sha256");
  const handle = await fs.open(filePath, "r");
  const buffer = Buffer.alloc(Math.min(HASH_BUFFER_BYTES, Math.max(1, range.endByte - range.startByte)));
  try {
    let position = range.startByte;
    let remaining = range.endByte - range.startByte;
    while (remaining > 0) {
      const result = await handle.read(buffer, 0, Math.min(buffer.byteLength, remaining), position);
      if (!result.bytesRead) break;
      hash.update(buffer.subarray(0, result.bytesRead));
      position += result.bytesRead;
      remaining -= result.bytesRead;
    }
    if (remaining !== 0) throw new Error("INFORMATIONAL_EVIDENCE_STALE: source ended before the selected range could be verified.");
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function assertRepositoryRelativePath(relative: string): void {
  const segments = relative.replaceAll("\\", "/").split("/");
  if (!relative || relative.includes("\\") || path.posix.isAbsolute(relative) || /^[A-Za-z]:[\\/]/.test(relative) || segments.includes("..") || segments.some((segment) => !segment || segment === ".") || path.posix.normalize(relative) !== relative) {
    throw new Error("INFORMATIONAL_EVIDENCE_REF_INVALID: evidence path must be a normalized repository-relative path.");
  }
}

function parseRange(value: string | null, label: string): InformationalEvidenceRange | undefined {
  if (value === null) return undefined;
  const match = /^(\d+)-(\d+)$/.exec(value);
  if (!match) throw new Error(`INFORMATIONAL_EVIDENCE_REF_INVALID: ${label} range must be a non-negative start-end byte interval.`);
  const startByte = Number(match[1]);
  const endByte = Number(match[2]);
  validateRange({ startByte, endByte }, label);
  return { startByte, endByte };
}

function validateRange(range: InformationalEvidenceRange | undefined, label: string): void {
  if (range && (!Number.isSafeInteger(range.startByte) || !Number.isSafeInteger(range.endByte) || range.startByte < 0 || range.endByte < range.startByte)) throw new Error(`INFORMATIONAL_EVIDENCE_REF_INVALID: ${label} range must be a non-negative start-end byte interval.`);
}

function assertRangeWithinFile(range: InformationalEvidenceRange, size: number, label: string): void {
  if (range.startByte > size || range.endByte > size) throw new Error(`INFORMATIONAL_EVIDENCE_STALE: source no longer contains the requested ${label} range.`);
}

function formatRange(range: InformationalEvidenceRange): string { return `${range.startByte}-${range.endByte}`; }

function assertDigest(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`INFORMATIONAL_EVIDENCE_REF_INVALID: ${label} must be a SHA-256 digest.`);
}

function staleError(filePath: string, expected: string, actual: string): Error {
  return new Error(`INFORMATIONAL_EVIDENCE_STALE: source '${filePath}' no longer matches expected SHA-256 ${expected}; got ${actual}.`);
}

function statFingerprint(stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function boundedLines(value: string, maxTokens: number): string {
  if (estimateTokens(value) <= maxTokens) return value;
  const lines: string[] = [];
  let used = 0;
  for (const line of value.split(/\r?\n/)) {
    const next = estimateTokens(`${line}\n`);
    if (used + next > maxTokens) break;
    lines.push(line);
    used += next;
  }
  return lines.join("\n");
}
