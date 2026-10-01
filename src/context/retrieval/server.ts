import crypto from "node:crypto";
import readline from "node:readline";
import { loadProjectConfig } from "../../core/config.js";
import { recordEvent } from "../../telemetry/events.js";
import { retrieveAuthorizedContext } from "../authorizationV2.js";
import { contextRetrievalToolDescription } from "./mcp.js";

export async function serveContextRetrievalMcp(): Promise<void> {
  const root = process.env.AEH_CONTEXT_ROOT?.trim() || process.cwd();
  const operationId = process.env.AEH_CONTEXT_OPERATION_ID?.trim();
  const logicalAgent = process.env.AEH_LOGICAL_AGENT?.trim();
  const participantId = process.env.AEH_CONTEXT_PARTICIPANT_ID?.trim();
  const controlRoot = process.env.AEH_CONTEXT_CONTROL_ROOT?.trim() || process.env.AEH_CONTROL_ROOT?.trim() || root;
  const phase = process.env.AEH_CONTEXT_PHASE?.trim() || "work";
  if (!operationId || !logicalAgent || !participantId) throw new Error("AEH context MCP requires AEH_CONTEXT_OPERATION_ID, AEH_LOGICAL_AGENT, and controller-bound AEH_CONTEXT_PARTICIPANT_ID.");
  const config = await loadProjectConfig(root);
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let request: { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
    try { request = JSON.parse(line) as typeof request; } catch { continue; }
    if (request.id === undefined || request.id === null) continue;
    try { write({ jsonrpc: "2.0", id: request.id, result: await handle(request, root, controlRoot, config, operationId, participantId, logicalAgent, phase) }); }
    catch (error) { write({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }); }
  }
}

async function handle(request: { method?: string; params?: Record<string, unknown> }, root: string, controlRoot: string, config: Awaited<ReturnType<typeof loadProjectConfig>>, operationId: string, participantId: string, logicalAgent: string, phase: string): Promise<Record<string, unknown>> {
  if (request.method === "initialize") return { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "aeh-context-retrieval", version: "1" } };
  if (request.method === "ping") return {};
  if (request.method === "tools/list") return { tools: [contextRetrievalToolDescription()] };
  if (request.method !== "tools/call") throw new Error(`Unsupported MCP method: ${request.method ?? "<missing>"}`);
  const params = request.params ?? {}; if (params.name !== "aeh_context_retrieve") throw new Error(`Unknown context tool '${String(params.name)}'.`);
  const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments as Record<string, unknown> : {};
  if (typeof args.refId !== "string" || !args.refId.trim()) throw new Error("refId is required.");
  if (args.maxTokens !== undefined && (!Number.isSafeInteger(args.maxTokens) || (args.maxTokens as number) < 1)) throw new Error("maxTokens must be a positive integer.");
  const sessionId = process.env.PASEO_AGENT_ID?.trim() || process.env.AEH_CONTEXT_SESSION_ID?.trim();
  const result = await retrieveAuthorizedContext(root, controlRoot, operationId, participantId, sessionId, logicalAgent, phase, {
    refId: args.refId,
    requestId: crypto.randomUUID(),
    maxTokens: typeof args.maxTokens === "number" ? args.maxTokens : undefined
  });
  if (config.telemetry?.enabled !== false) await recordEvent(root, config, "harness.context.retrieve_original", { operationId, logicalAgent, participantId, sessionId: sessionId ?? "", refId: result.receipt.refId, estimatedTokens: result.estimatedTokens, repeated: result.repeated, artifact: result.artifact, sha256: result.sha256, receiptDigest: result.receipt.receiptDigest });
  return { content: [{ type: "text", text: result.content }], structuredContent: result };
}

function write(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
