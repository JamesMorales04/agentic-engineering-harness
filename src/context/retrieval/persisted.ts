import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessProjectConfig } from "../../core/types.js";
import { assertContextEnvelope } from "../types.js";
import { ContextRetrievalGateway, type RetrievalRequest } from "./gateway.js";
import { authorizeRetrieval } from "./authorization.js";
import { recordEvent } from "../../telemetry/events.js";

export async function retrievePersistedContext(root: string, config: HarnessProjectConfig, operationId: string, logicalAgent: string, request: RetrievalRequest) {
  const envelopePath = path.resolve(root, ".harness", "context", safeSegment(operationId), "envelope.json");
  const envelope = assertContextEnvelope(JSON.parse(await fs.readFile(envelopePath, "utf8")));
  if (envelope.operationId !== operationId) throw new Error("CONTEXT_RETRIEVAL_OPERATION_MISMATCH: envelope belongs to another operation.");
  if (envelope.logicalAgent !== logicalAgent) throw new Error("CONTEXT_RETRIEVAL_AGENT_MISMATCH: fragment is not authorized for this logical agent.");
  const limits = config.context?.retrieval ?? {};
  const gateway = new ContextRetrievalGateway(authorizeRetrieval({ root, operationId, logicalAgent, allowedFragmentIds: envelope.retrieval.allowedFragmentIds, fragments: envelope.fragments }), { maxRequestsPerTurn: limits.maxRequestsPerTurn ?? 8, maxTokensPerRequest: limits.maxTokensPerRequest ?? 6_000, maxTotalTokensPerTurn: limits.maxTotalTokensPerTurn ?? 20_000 });
  const result = await gateway.retrieve(request);
  if (config.telemetry?.enabled !== false) await recordEvent(root, config, "harness.context.retrieve_original", { operationId, logicalAgent, fragmentId: request.fragmentId, estimatedTokens: result.estimatedTokens, repeated: result.repeated, artifact: result.artifact, sha256: result.sha256 });
  return result;
}

function safeSegment(value: string): string { const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, ""); return sanitized || "operation"; }
