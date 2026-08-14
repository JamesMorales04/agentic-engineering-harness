import readline from "node:readline";
import { loadProjectConfig } from "../../core/config.js";
import { contextRetrievalToolDescription } from "./mcp.js";
import { retrievePersistedContext } from "./persisted.js";

export async function serveContextRetrievalMcp(): Promise<void> {
  const root = process.env.AEH_CONTEXT_ROOT?.trim() || process.cwd();
  const operationId = process.env.AEH_CONTEXT_OPERATION_ID?.trim();
  const logicalAgent = process.env.AEH_LOGICAL_AGENT?.trim();
  if (!operationId || !logicalAgent) throw new Error("AEH context MCP requires AEH_CONTEXT_OPERATION_ID and AEH_LOGICAL_AGENT.");
  const config = await loadProjectConfig(root);
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let request: { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
    try { request = JSON.parse(line) as typeof request; } catch { continue; }
    if (request.id === undefined || request.id === null) continue;
    try { write({ jsonrpc: "2.0", id: request.id, result: await handle(request, root, config, operationId, logicalAgent) }); }
    catch (error) { write({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }); }
  }
}

async function handle(request: { method?: string; params?: Record<string, unknown> }, root: string, config: Awaited<ReturnType<typeof loadProjectConfig>>, operationId: string, logicalAgent: string): Promise<Record<string, unknown>> {
  if (request.method === "initialize") return { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "aeh-context-retrieval", version: "1" } };
  if (request.method === "ping") return {};
  if (request.method === "tools/list") return { tools: [contextRetrievalToolDescription()] };
  if (request.method !== "tools/call") throw new Error(`Unsupported MCP method: ${request.method ?? "<missing>"}`);
  const params = request.params ?? {}; if (params.name !== "aeh_context_retrieve") throw new Error(`Unknown context tool '${String(params.name)}'.`);
  const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments as Record<string, unknown> : {};
  if (typeof args.fragmentId !== "string" || !args.fragmentId.trim()) throw new Error("fragmentId is required.");
  const result = await retrievePersistedContext(root, config, operationId, logicalAgent, { fragmentId: args.fragmentId, section: args.section === "source" ? "source" : "raw", maxTokens: typeof args.maxTokens === "number" ? args.maxTokens : undefined });
  return { content: [{ type: "text", text: result.content }], structuredContent: result };
}

function write(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
