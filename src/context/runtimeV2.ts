import { canonicalSerialize, sha256Canonical, sha256Utf8 } from "../core/digest.js";

/** A line range is inclusive and uses one-based source line numbers. */
export interface ContextLineRangeV1 {
  startLine: number;
  endLine: number;
}

export interface ContextSymbolRangeV1 {
  symbol: string;
  range: ContextLineRangeV1;
  /** The complete symbol path, when a parser can provide one. */
  symbolPath?: string[];
}

export type ContextShardLocatorV1 =
  | { kind: "range"; file: string; range: ContextLineRangeV1 }
  | { kind: "symbol"; file: string; symbol: string; range?: ContextLineRangeV1; symbolPath?: string[] };

export interface ContextShardV1 {
  version: 1;
  shardId: string;
  file: string;
  content: string;
  /** Digest of the complete source, when the shard came from a larger source. */
  sourceDigest?: string;
  contentDigest: string;
  locator: ContextShardLocatorV1;
  symbols?: ContextSymbolRangeV1[];
}

export interface ContextPayloadV1 {
  content: string;
  digest: string;
  locator: ContextShardLocatorV1;
  range: ContextLineRangeV1;
  estimatedTokens: number;
}

/**
 * A ref is addressable before it is delivered.  In particular, `payload` is
 * absent for a JIT ref; knowing that a shard may be retrieved is not the same
 * thing as putting its contents in a prompt.
 */
export interface ContextRefV1 {
  version: 1;
  refId: string;
  operationId: string;
  projectId?: string;
  candidateRevisionDigest?: string;
  sessionId?: string;
  shardId: string;
  locator: ContextShardLocatorV1;
  authorized: true;
  addressable: true;
  delivered: boolean;
  delivery: "addressable" | "delivered";
  authorizationGrantId: string;
  participantId: string;
  payload?: ContextPayloadV1;
}

export interface ContextRefAuthorizationV1 {
  version: 1;
  grantId: string;
  operationId: string;
  participantId: string;
  projectId?: string;
  candidateRevisionDigest?: string;
  sessionId?: string;
  allowedShardIds: string[];
  issuedAt: string;
  expiresAt: string;
  grantDigest: string;
}

export interface ContextSelectionV1 {
  shardId: string;
  file: string;
  locator: ContextShardLocatorV1;
  range: ContextLineRangeV1;
  content: string;
  digest: string;
  sourceDigest?: string;
  estimatedTokens: number;
}

export interface ContextRefInputV1 {
  operationId: string;
  projectId?: string;
  candidateRevisionDigest?: string;
  shardId: string;
  locator: ContextShardLocatorV1;
  sessionId?: string;
  refId?: string;
  /** Controller-issued authorization; refs are never self-authorized. */
  authorization?: ContextRefAuthorizationV1;
}

export interface ContextContinuationV1 {
  version: 1;
  continuationId: string;
  operationId: string;
  projectId?: string;
  candidateRevisionDigest?: string;
  previousSessionId: string;
  nextSessionId: string;
  previousTurnId: string;
  nextTurnId?: string;
  sequence: number;
  contextRefIds: string[];
  promptManifestDigest?: string;
  bindingDigest: string;
}

export interface ContextContinuationInputV1 {
  continuationId?: string;
  operationId: string;
  projectId?: string;
  candidateRevisionDigest?: string;
  previousSessionId: string;
  nextSessionId: string;
  previousTurnId: string;
  nextTurnId?: string;
  sequence: number;
  contextRefIds?: string[];
  promptManifestDigest?: string;
}

export interface ExecutionBudgetV1 {
  version: 1;
  operationId: string;
  projectId?: string;
  candidateRevisionDigest?: string;
  maxTokens: number;
  consumedTokens: number;
  remainingTokens: number;
  sessionUsage: Record<string, number>;
}

export interface PromptManifestEntryV1 {
  id: string;
  content?: string;
  digest?: string;
  role?: string;
  source?: string;
}

export interface PromptManifestV1 {
  version: 1;
  staticPrefix: PromptManifestEntryV1[];
  dynamic: PromptManifestEntryV1[];
  staticDigest: string;
  dynamicDigest: string;
  /** Digest of the stable prompt prefix; independent of dynamic entries. */
  prefixDigest: string;
  digest: string;
}

export interface PromptManifestInputV1 {
  staticPrefix?: PromptManifestEntryV1[];
  staticEntries?: PromptManifestEntryV1[];
  dynamic?: PromptManifestEntryV1[];
  dynamicEntries?: PromptManifestEntryV1[];
}

const HEX_DIGEST = /^[a-f0-9]{64}$/;

export function stableJsonV1(value: unknown): string {
  return canonicalSerialize(value);
}

export function digestV1(value: unknown): string {
  return sha256Canonical(value);
}

function requireText(value: string, name: string): void {
  if (!value.trim()) throw new Error(`CONTEXT_RUNTIME_V2_INVALID: ${name} must not be empty.`);
}

function assertLineRange(range: ContextLineRangeV1): void {
  if (!Number.isInteger(range.startLine) || !Number.isInteger(range.endLine) || range.startLine < 1 || range.endLine < range.startLine) {
    throw new Error("CONTEXT_RUNTIME_V2_INVALID: line ranges must be positive, inclusive, and ordered.");
  }
}

function normalizeFile(file: string): string {
  requireText(file, "file");
  return file.replaceAll("\\", "/");
}

function assertLocator(locator: ContextShardLocatorV1): void {
  const file = normalizeFile(locator.file);
  if (file.startsWith("/") || file.split("/").includes("..")) throw new Error("CONTEXT_RUNTIME_V2_INVALID: locator file must be repository-relative.");
  if (locator.kind === "range") assertLineRange(locator.range);
  else {
    requireText(locator.symbol, "symbol");
    if (locator.range) assertLineRange(locator.range);
    if (locator.symbolPath && (!locator.symbolPath.length || locator.symbolPath.some((part) => !part.trim()))) throw new Error("CONTEXT_RUNTIME_V2_INVALID: symbolPath must contain non-empty names.");
  }
}

function normalizeLocator(locator: ContextShardLocatorV1): ContextShardLocatorV1 {
  assertLocator(locator);
  if (locator.kind === "range") return { kind: "range", file: normalizeFile(locator.file), range: { ...locator.range } };
  return {
    kind: "symbol",
    file: normalizeFile(locator.file),
    symbol: locator.symbol,
    ...(locator.range ? { range: { ...locator.range } } : {}),
    ...(locator.symbolPath ? { symbolPath: [...locator.symbolPath] } : {})
  };
}

function estimateTokens(value: string): number {
  return value.length === 0 ? 0 : Math.ceil(value.trim().split(/\s+/).filter(Boolean).length * 1.25);
}

export function createContextShard(input: Omit<ContextShardV1, "version" | "contentDigest"> & { contentDigest?: string }): ContextShardV1 {
  requireText(input.shardId, "shardId");
  const file = normalizeFile(input.file);
  const locator = normalizeLocator(input.locator);
  if (locator.file !== file) throw new Error("CONTEXT_RUNTIME_V2_INVALID: shard locator file must match shard file.");
  const contentDigest = input.contentDigest ?? digestText(input.content);
  if (!HEX_DIGEST.test(contentDigest)) throw new Error("CONTEXT_RUNTIME_V2_INVALID: contentDigest must be a SHA-256 digest.");
  return { version: 1, shardId: input.shardId, file, content: input.content, ...(input.sourceDigest ? { sourceDigest: input.sourceDigest } : {}), contentDigest, locator, ...(input.symbols ? { symbols: input.symbols.map((symbol) => ({ ...symbol, range: { ...symbol.range }, ...(symbol.symbolPath ? { symbolPath: [...symbol.symbolPath] } : {}) })) } : {}) };
}

export function digestText(value: string): string {
  return sha256Utf8(value);
}

export function rangeShardLocator(file: string, range: ContextLineRangeV1): ContextShardLocatorV1 {
  const locator: ContextShardLocatorV1 = { kind: "range", file: normalizeFile(file), range: { ...range } };
  assertLocator(locator);
  return locator;
}

export function symbolShardLocator(file: string, symbol: string, range?: ContextLineRangeV1, symbolPath?: string[]): ContextShardLocatorV1 {
  const locator: ContextShardLocatorV1 = { kind: "symbol", file: normalizeFile(file), symbol, ...(range ? { range: { ...range } } : {}), ...(symbolPath ? { symbolPath: [...symbolPath] } : {}) };
  assertLocator(locator);
  return locator;
}

function locatorRange(locator: ContextShardLocatorV1, shard: ContextShardV1): ContextLineRangeV1 {
  if (locator.kind === "range") return locator.range;
  if (locator.range) return locator.range;
  const requestedPath = locator.symbolPath?.join(".") ?? locator.symbol;
  const candidates = (shard.symbols ?? []).filter((candidate) => {
    const path = candidate.symbolPath?.join(".") ?? candidate.symbol;
    return path === requestedPath || (!candidate.symbolPath && candidate.symbol === locator.symbol);
  });
  if (candidates.length) {
    // Prefer the most specific (deepest/smallest) exact match deterministically.
    candidates.sort((left, right) => (right.symbolPath?.length ?? 0) - (left.symbolPath?.length ?? 0) || (left.range.endLine - left.range.startLine) - (right.range.endLine - right.range.startLine) || left.range.startLine - right.range.startLine);
    return candidates[0].range;
  }
  if (shard.locator.kind === "symbol") {
    const shardPath = shard.locator.symbolPath?.join(".") ?? shard.locator.symbol;
    if (shardPath === requestedPath && shard.locator.range) return shard.locator.range;
  }
  throw new Error(`CONTEXT_RUNTIME_V2_SYMBOL_NOT_FOUND: '${locator.symbol}'.`);
}

function intersectRange(requested: ContextLineRangeV1, available: ContextLineRangeV1): ContextLineRangeV1 {
  const range = { startLine: Math.max(requested.startLine, available.startLine), endLine: Math.min(requested.endLine, available.endLine) };
  if (range.startLine > range.endLine) throw new Error("CONTEXT_RUNTIME_V2_RANGE_UNAVAILABLE: requested range is outside the shard.");
  return range;
}

export function selectContextShard(shard: ContextShardV1, locator: ContextShardLocatorV1): ContextSelectionV1 {
  const normalized = normalizeLocator(locator);
  if (normalized.file !== normalizeFile(shard.file)) throw new Error("CONTEXT_RUNTIME_V2_RANGE_UNAVAILABLE: locator file does not match shard.");
  const requested = locatorRange(normalized, shard);
  const available = shard.locator.kind === "range" || shard.locator.range
    ? shard.locator.range!
    : { startLine: 1, endLine: Math.max(1, shard.content.split(/\r?\n/).length) };
  const selected = intersectRange(requested, available);
  const sourceStart = available.startLine;
  const lines = shard.content.split(/\r?\n/);
  const start = selected.startLine - sourceStart;
  const end = selected.endLine - sourceStart + 1;
  if (start < 0 || end > lines.length) throw new Error("CONTEXT_RUNTIME_V2_RANGE_UNAVAILABLE: requested range is not present in shard content.");
  const content = lines.slice(start, end).join("\n");
  return { shardId: shard.shardId, file: shard.file, locator: normalized, range: selected, content, digest: digestText(content), ...(shard.sourceDigest ? { sourceDigest: shard.sourceDigest } : {}), estimatedTokens: estimateTokens(content) };
}

export const selectShardRange = selectContextShard;

function authorizationGrantValue(grant: Omit<ContextRefAuthorizationV1, "grantDigest">): unknown {
  return { version: grant.version, grantId: grant.grantId, operationId: grant.operationId, participantId: grant.participantId, projectId: grant.projectId, candidateRevisionDigest: grant.candidateRevisionDigest, sessionId: grant.sessionId, allowedShardIds: [...grant.allowedShardIds].sort(), issuedAt: grant.issuedAt, expiresAt: grant.expiresAt };
}

export function createContextAuthorizationGrant(input: Omit<ContextRefAuthorizationV1, "version" | "grantDigest">): ContextRefAuthorizationV1 {
  requireText(input.grantId, "authorization.grantId");
  requireText(input.operationId, "authorization.operationId");
  requireText(input.participantId, "authorization.participantId");
  if (!input.allowedShardIds.length || input.allowedShardIds.some((id) => !id.trim())) throw new Error("CONTEXT_RUNTIME_V2_AUTHORIZATION_REQUIRED: allowedShardIds must not be empty.");
  const issued = new Date(input.issuedAt).getTime();
  const expires = new Date(input.expiresAt).getTime();
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) throw new Error("CONTEXT_RUNTIME_V2_AUTHORIZATION_INVALID: grant interval is invalid.");
  const unsigned = { version: 1 as const, ...input, allowedShardIds: [...new Set(input.allowedShardIds)].sort() };
  return { ...unsigned, grantDigest: digestV1(authorizationGrantValue(unsigned)) };
}

function assertAuthorizationGrant(grant: ContextRefAuthorizationV1, input: ContextRefInputV1): void {
  if (grant.version !== 1 || grant.grantDigest !== digestV1(authorizationGrantValue(grant))) throw new Error("CONTEXT_RUNTIME_V2_AUTHORIZATION_INVALID: grant digest is invalid.");
  if (grant.operationId !== input.operationId) throw new Error("CONTEXT_RUNTIME_V2_BINDING_REJECTED: authorization operation does not match the context ref.");
  if (input.projectId !== grant.projectId || input.candidateRevisionDigest !== grant.candidateRevisionDigest || input.sessionId !== grant.sessionId) throw new Error("CONTEXT_RUNTIME_V2_BINDING_REJECTED: authorization identity does not match the context ref.");
  if (!grant.allowedShardIds.includes(input.shardId)) throw new Error(`CONTEXT_RUNTIME_V2_UNAUTHORIZED: shard '${input.shardId}' is not authorized by the controller grant.`);
  if (new Date(grant.expiresAt).getTime() <= Date.now()) throw new Error("CONTEXT_RUNTIME_V2_AUTHORIZATION_EXPIRED: controller grant has expired.");
}

export function createContextRef(input: ContextRefInputV1): ContextRefV1 {
  requireText(input.operationId, "operationId");
  requireText(input.shardId, "shardId");
  if (!input.authorization) throw new Error("CONTEXT_RUNTIME_V2_AUTHORIZATION_REQUIRED: context refs require a controller-issued authorization grant.");
  assertAuthorizationGrant(input.authorization, input);
  const locator = normalizeLocator(input.locator);
  return { version: 1, refId: input.refId ?? digestV1({ operationId: input.operationId, projectId: input.projectId, candidateRevisionDigest: input.candidateRevisionDigest, sessionId: input.sessionId, shardId: input.shardId, locator, authorizationGrantId: input.authorization.grantId }), operationId: input.operationId, ...(input.projectId ? { projectId: input.projectId } : {}), ...(input.candidateRevisionDigest ? { candidateRevisionDigest: input.candidateRevisionDigest } : {}), ...(input.sessionId ? { sessionId: input.sessionId } : {}), shardId: input.shardId, locator, authorized: true, addressable: true, delivered: false, delivery: "addressable", authorizationGrantId: input.authorization.grantId, participantId: input.authorization.participantId };
}

export const authorizeContextRef = createContextRef;
export const createAddressableContextRef = createContextRef;

export function deliverContextPayload(ref: ContextRefV1, shard: ContextShardV1): ContextRefV1 {
  if (!ref.authorized || !ref.addressable) throw new Error("CONTEXT_RUNTIME_V2_UNAUTHORIZED: context ref is not addressable.");
  if (ref.operationId !== (shard as ContextShardV1 & { operationId?: string }).operationId && (shard as ContextShardV1 & { operationId?: string }).operationId) throw new Error("CONTEXT_RUNTIME_V2_BINDING_REJECTED: shard belongs to another operation.");
  if (ref.shardId !== shard.shardId) throw new Error("CONTEXT_RUNTIME_V2_REF_MISMATCH: shard does not match context ref.");
  const selected = selectContextShard(shard, ref.locator);
  const payload: ContextPayloadV1 = { content: selected.content, digest: selected.digest, locator: selected.locator, range: selected.range, estimatedTokens: selected.estimatedTokens };
  return { ...ref, delivered: true, delivery: "delivered", payload };
}

export const deliverContextShard = deliverContextPayload;

function continuationBindingValue(value: Omit<ContextContinuationV1, "bindingDigest">): unknown {
  return { version: value.version, continuationId: value.continuationId, operationId: value.operationId, projectId: value.projectId, candidateRevisionDigest: value.candidateRevisionDigest, previousSessionId: value.previousSessionId, nextSessionId: value.nextSessionId, previousTurnId: value.previousTurnId, nextTurnId: value.nextTurnId, sequence: value.sequence, contextRefIds: value.contextRefIds, promptManifestDigest: value.promptManifestDigest };
}

export function bindContinuation(input: ContextContinuationInputV1): ContextContinuationV1 {
  for (const [value, name] of [[input.operationId, "operationId"], [input.previousSessionId, "previousSessionId"], [input.nextSessionId, "nextSessionId"], [input.previousTurnId, "previousTurnId"]] as const) requireText(value, name);
  if (!Number.isInteger(input.sequence) || input.sequence < 1) throw new Error("CONTEXT_RUNTIME_V2_INVALID: continuation sequence must be a positive integer.");
  const continuation: Omit<ContextContinuationV1, "bindingDigest"> = { version: 1, continuationId: input.continuationId ?? `${input.operationId}:${input.nextSessionId}:${input.sequence}`, operationId: input.operationId, ...(input.projectId ? { projectId: input.projectId } : {}), ...(input.candidateRevisionDigest ? { candidateRevisionDigest: input.candidateRevisionDigest } : {}), previousSessionId: input.previousSessionId, nextSessionId: input.nextSessionId, previousTurnId: input.previousTurnId, ...(input.nextTurnId ? { nextTurnId: input.nextTurnId } : {}), sequence: input.sequence, contextRefIds: [...new Set(input.contextRefIds ?? [])].sort(), ...(input.promptManifestDigest ? { promptManifestDigest: input.promptManifestDigest } : {}) };
  return { ...continuation, bindingDigest: digestV1(continuationBindingValue(continuation)) };
}

export interface ContinuationBindingExpectationV1 {
  operationId?: string;
  previousSessionId?: string;
  nextSessionId?: string;
  previousTurnId?: string;
  sequence?: number;
  availableRefs?: readonly ContextRefV1[];
}

export function assertContinuationBinding(continuation: ContextContinuationV1, expected: ContinuationBindingExpectationV1 = {}): void {
  const { bindingDigest, ...unsigned } = continuation;
  if (bindingDigest !== digestV1(continuationBindingValue(unsigned))) throw new Error("CONTEXT_RUNTIME_V2_BINDING_REJECTED: continuation binding digest is invalid.");
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (key === "availableRefs" || expectedValue === undefined) continue;
    if ((continuation as unknown as Record<string, unknown>)[key] !== expectedValue) throw new Error(`CONTEXT_RUNTIME_V2_BINDING_REJECTED: continuation ${key} does not match.`);
  }
  if (expected.availableRefs) {
    const refs = new Map(expected.availableRefs.map((ref) => [ref.refId, ref]));
    for (const refId of continuation.contextRefIds) {
      const ref = refs.get(refId);
      if (!ref || !ref.addressable || ref.operationId !== continuation.operationId) throw new Error(`CONTEXT_RUNTIME_V2_BINDING_REJECTED: context ref '${refId}' is not bound to the continuation.`);
    }
  }
}

export function isContinuationBindingValid(continuation: ContextContinuationV1, expected: ContinuationBindingExpectationV1 = {}): boolean {
  try { assertContinuationBinding(continuation, expected); return true; } catch { return false; }
}

export function createExecutionBudget(operationId: string, maxTokens: number, identity: { projectId?: string; candidateRevisionDigest?: string } = {}): ExecutionBudgetV1 {
  requireText(operationId, "operationId");
  if (!Number.isInteger(maxTokens) || maxTokens < 0) throw new Error("CONTEXT_RUNTIME_V2_INVALID: maxTokens must be a non-negative integer.");
  return { version: 1, operationId, ...(identity.projectId ? { projectId: identity.projectId } : {}), ...(identity.candidateRevisionDigest ? { candidateRevisionDigest: identity.candidateRevisionDigest } : {}), maxTokens, consumedTokens: 0, remainingTokens: maxTokens, sessionUsage: {} };
}

export function startBudgetSession(budget: ExecutionBudgetV1, sessionId: string): ExecutionBudgetV1 {
  requireText(sessionId, "sessionId");
  return { ...budget, sessionUsage: { ...budget.sessionUsage, [sessionId]: budget.sessionUsage[sessionId] ?? 0 } };
}

export function consumeExecutionBudget(budget: ExecutionBudgetV1, sessionId: string, tokens: number): ExecutionBudgetV1 {
  requireText(sessionId, "sessionId");
  if (!Number.isInteger(tokens) || tokens < 0) throw new Error("CONTEXT_RUNTIME_V2_INVALID: consumed tokens must be a non-negative integer.");
  if (tokens > budget.remainingTokens) throw new Error("CONTEXT_RUNTIME_V2_BUDGET_EXCEEDED: operation-wide execution budget exhausted.");
  return { ...budget, consumedTokens: budget.consumedTokens + tokens, remainingTokens: budget.remainingTokens - tokens, sessionUsage: { ...budget.sessionUsage, [sessionId]: (budget.sessionUsage[sessionId] ?? 0) + tokens } };
}

export const recordExecutionUsage = consumeExecutionBudget;

export function assertBudgetAvailable(budget: ExecutionBudgetV1, tokens: number): void {
  if (!Number.isInteger(tokens) || tokens < 0 || tokens > budget.remainingTokens) throw new Error("CONTEXT_RUNTIME_V2_BUDGET_EXCEEDED: operation-wide execution budget exhausted.");
}

function normalizePromptEntry(entry: PromptManifestEntryV1): Record<string, string> {
  requireText(entry.id, "prompt entry id");
  const contentDigest = entry.digest ?? digestText(entry.content ?? "");
  if (!HEX_DIGEST.test(contentDigest)) throw new Error(`CONTEXT_RUNTIME_V2_INVALID: prompt entry '${entry.id}' has an invalid digest.`);
  return { id: entry.id, contentDigest, ...(entry.role ? { role: entry.role } : {}), ...(entry.source ? { source: entry.source } : {}) };
}

export function stablePrefixDigest(prefix: PromptManifestV1 | readonly PromptManifestEntryV1[] | string): string {
  if (typeof prefix === "string") return digestV1({ kind: "prompt-prefix", content: prefix });
  if (!Array.isArray(prefix)) return (prefix as PromptManifestV1).prefixDigest;
  return digestV1({ kind: "prompt-prefix", entries: prefix.map(normalizePromptEntry) });
}

export function computeStaticPromptDigest(entries: readonly PromptManifestEntryV1[]): string {
  return stablePrefixDigest(entries);
}

export function computeDynamicPromptDigest(entries: readonly PromptManifestEntryV1[]): string {
  return digestV1({ kind: "prompt-dynamic", entries: entries.map(normalizePromptEntry) });
}

export function computePromptManifestDigest(manifest: Pick<PromptManifestV1, "staticDigest" | "dynamicDigest">): string {
  return digestV1({ kind: "prompt-manifest", staticDigest: manifest.staticDigest, dynamicDigest: manifest.dynamicDigest });
}

export function createPromptManifest(input: PromptManifestInputV1 = {}): PromptManifestV1 {
  const staticPrefix = [...(input.staticPrefix ?? input.staticEntries ?? [])].map((entry) => ({ ...entry }));
  const dynamic = [...(input.dynamic ?? input.dynamicEntries ?? [])].map((entry) => ({ ...entry }));
  const staticDigest = computeStaticPromptDigest(staticPrefix);
  const dynamicDigest = computeDynamicPromptDigest(dynamic);
  return { version: 1, staticPrefix, dynamic, staticDigest, dynamicDigest, prefixDigest: staticDigest, digest: computePromptManifestDigest({ staticDigest, dynamicDigest }) };
}

export function verifyPromptManifestDigest(manifest: PromptManifestV1): boolean {
  return manifest.staticDigest === computeStaticPromptDigest(manifest.staticPrefix)
    && manifest.dynamicDigest === computeDynamicPromptDigest(manifest.dynamic)
    && manifest.prefixDigest === manifest.staticDigest
    && manifest.digest === computePromptManifestDigest(manifest);
}
