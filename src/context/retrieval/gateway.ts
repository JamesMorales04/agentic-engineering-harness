import fs from "node:fs/promises";
import path from "node:path";
import { estimateTokens } from "../estimator.js";
import { sha256 } from "../provenance.js";
import type { ContextFragment } from "../types.js";
import type { RetrievalAuthorization } from "./authorization.js";

export interface RetrievalRequest { fragmentId: string; section?: "raw" | "source"; maxTokens?: number; }
export interface RetrievalResult { fragmentId: string; content: string; artifact: string; sha256: string; estimatedTokens: number; repeated: boolean; }
export interface RetrievalLimits { maxRequestsPerTurn: number; maxTokensPerRequest: number; maxTotalTokensPerTurn: number; }

export class ContextRetrievalGateway {
  private requests = 0;
  private totalTokens = 0;
  private readonly seen = new Set<string>();

  constructor(private readonly authorization: RetrievalAuthorization, private readonly limits: RetrievalLimits) {}

  get metrics(): { requests: number; repeated: number; totalTokens: number } { return { requests: this.requests, repeated: [...this.seen].length < this.requests ? this.requests - [...this.seen].length : 0, totalTokens: this.totalTokens }; }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    if (!this.authorization.allowedFragmentIds.includes(request.fragmentId)) throw new Error(`CONTEXT_RETRIEVAL_UNAUTHORIZED: fragment '${request.fragmentId}' is not authorized for operation '${this.authorization.operationId}'.`);
    if (this.requests >= this.limits.maxRequestsPerTurn) throw new Error("CONTEXT_RETRIEVAL_BUDGET_EXCEEDED: maximum requests per turn reached.");
    const fragment = this.authorization.fragments.get(request.fragmentId);
    if (!fragment) throw new Error(`CONTEXT_RETRIEVAL_NOT_FOUND: fragment '${request.fragmentId}'.`);
    const artifact = fragment.source?.artifact;
    if (!artifact) throw new Error(`CONTEXT_RETRIEVAL_NO_ARTIFACT: fragment '${request.fragmentId}' has no durable raw artifact.`);
    const absolute = await safeArtifactPath(this.authorization.root, artifact);
    const raw = await fs.readFile(absolute, "utf8");
    const expected = fragment.source?.sha256;
    const actual = sha256(raw);
    if (expected && expected !== actual) throw new Error(`CONTEXT_RETRIEVAL_HASH_MISMATCH: ${artifact}.`);
    const maxTokens = Math.min(request.maxTokens ?? this.limits.maxTokensPerRequest, this.limits.maxTokensPerRequest);
    const tokens = estimateTokens(raw);
    if (this.totalTokens + Math.min(tokens, maxTokens) > this.limits.maxTotalTokensPerTurn) throw new Error("CONTEXT_RETRIEVAL_BUDGET_EXCEEDED: maximum tokens per turn reached.");
    if (request.section && request.section !== "raw") throw new Error(`Unsupported context retrieval section '${request.section}'.`);
    this.requests += 1;
    const repeated = this.seen.has(request.fragmentId);
    this.seen.add(request.fragmentId);
    const content = tokens <= maxTokens ? raw : boundedLines(raw, maxTokens);
    this.totalTokens += estimateTokens(content);
    return { fragmentId: request.fragmentId, content, artifact, sha256: actual, estimatedTokens: estimateTokens(content), repeated };
  }
}

async function safeArtifactPath(root: string, artifact: string): Promise<string> {
  if (path.isAbsolute(artifact)) throw new Error("CONTEXT_RETRIEVAL_PATH_REJECTED: artifact paths must be relative to the operation root.");
  const absoluteRoot = path.resolve(root); const absolute = path.resolve(absoluteRoot, artifact);
  if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${path.sep}`)) throw new Error("CONTEXT_RETRIEVAL_PATH_REJECTED: artifact escapes the operation root.");
  let cursor = absolute;
  while (cursor !== absoluteRoot && cursor.startsWith(`${absoluteRoot}${path.sep}`)) {
    try {
      if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error("CONTEXT_RETRIEVAL_PATH_REJECTED: artifact paths cannot traverse symbolic links.");
    } catch (error) {
      if (error instanceof Error && error.message.includes("cannot traverse")) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    cursor = path.dirname(cursor);
  }
  if (cursor !== absoluteRoot) throw new Error("CONTEXT_RETRIEVAL_PATH_REJECTED: artifact escapes the operation root.");
  return absolute;
}

function boundedLines(value: string, maxTokens: number): string {
  const lines = value.split(/\r?\n/); const selected: string[] = []; let used = 0;
  for (const line of lines) { const next = estimateTokens(`${line}\n`); if (used + next > maxTokens) break; selected.push(line); used += next; }
  return `${selected.join("\n")}\n[bounded retrieval excerpt; retrieve again with a larger authorized budget for the complete raw artifact]`;
}
