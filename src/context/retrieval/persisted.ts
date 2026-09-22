import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessProjectConfig } from "../../core/types.js";
import { verifyContextEnvelope } from "../envelope.js";
import { assertContextEnvelope } from "../types.js";
import { contextEnvelopePath } from "../gateway.js";
import { ContextRetrievalGateway, type RetrievalRequest } from "./gateway.js";
import { authorizeRetrieval } from "./authorization.js";
import { recordEvent } from "../../telemetry/events.js";

export async function retrievePersistedContext(root: string, config: HarnessProjectConfig, operationId: string, logicalAgent: string, request: RetrievalRequest, phase?: string, existingGateway?: ContextRetrievalGateway) {
  const gateway = existingGateway ?? await createPersistedContextGateway(root, config, operationId, logicalAgent, phase);
  const result = await gateway.retrieve(request);
  if (config.telemetry?.enabled !== false) await recordEvent(root, config, "harness.context.retrieve_original", { operationId, logicalAgent, fragmentId: request.fragmentId, estimatedTokens: result.estimatedTokens, repeated: result.repeated, artifact: result.artifact, sha256: result.sha256 });
  return result;
}

export async function createPersistedContextGateway(root: string, config: HarnessProjectConfig, operationId: string, logicalAgent: string, phase?: string): Promise<ContextRetrievalGateway> {
  const scopedPath = contextEnvelopePath(root, operationId, logicalAgent, phase ?? "work");
  const legacyPath = path.resolve(root, ".harness", "context", safeSegment(operationId), "envelope.json");
  const envelopePath = await exists(scopedPath) ? scopedPath : legacyPath;
  const envelope = assertContextEnvelope(JSON.parse(await fs.readFile(envelopePath, "utf8")));
  if (!verifyContextEnvelope(envelope)) throw new Error("CONTEXT_RETRIEVAL_PROVENANCE_MISMATCH: persisted context envelope integrity verification failed.");
  if (envelope.operationId !== operationId) throw new Error("CONTEXT_RETRIEVAL_OPERATION_MISMATCH: envelope belongs to another operation.");
  if (envelope.logicalAgent !== logicalAgent) throw new Error("CONTEXT_RETRIEVAL_AGENT_MISMATCH: fragment is not authorized for this logical agent.");
  const limits = config.context?.retrieval ?? {};
  return new ContextRetrievalGateway(authorizeRetrieval({ root, operationId, logicalAgent, allowedFragmentIds: envelope.retrieval.allowedFragmentIds, fragments: envelope.fragments }), { maxRequestsPerTurn: limits.maxRequestsPerTurn ?? 8, maxTokensPerRequest: limits.maxTokensPerRequest ?? 6_000, maxTotalTokensPerTurn: limits.maxTotalTokensPerTurn ?? 20_000 });
}

function safeSegment(value: string): string { const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, ""); return sanitized || "operation"; }
async function exists(file: string): Promise<boolean> { try { await fs.access(file); return true; } catch { return false; } }
