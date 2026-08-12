import readline from "node:readline";
import path from "node:path";
import process from "node:process";
import { loadProjectConfig } from "../core/config.js";
import { statusLeadContext } from "../paseo/context.js";
import { cancelOperation, startDetachedOperation } from "./controller.js";
import { loadOperation, type AuditOperationPayload, type RunOperationPayload } from "./state.js";

interface JsonRpcRequest { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown>; }

const tools = [
  {
    name: "aeh_operation_start_audit",
    description: "Start a detached Harness AUDIT for this lead's fixed project root and return its durable operation record immediately.",
    inputSchema: {
      type: "object",
      properties: {
        request: { type: "string" },
        files: { type: "array", items: { type: "string" } },
        domains: { type: "array", items: { type: "string" } },
        risk: { type: "string", enum: ["low", "medium", "high"] },
        reviewers: { type: "array", items: { type: "string" } }
      },
      required: ["request"],
      additionalProperties: false
    }
  },
  {
    name: "aeh_operation_start_run",
    description: "Start detached execution of an already prepared/sealed AEH task in this lead's fixed project root and return its operation record immediately.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" }, profile: { type: "string" } },
      required: ["taskId"],
      additionalProperties: false
    }
  },
  {
    name: "aeh_operation_status",
    description: "Read durable status/phase/result for an AEH operation in this lead's fixed project root without blocking the caller.",
    inputSchema: {
      type: "object",
      properties: { operationId: { type: "string" } },
      required: ["operationId"],
      additionalProperties: false
    }
  },
  {
    name: "aeh_operation_cancel",
    description: "Cancel a running AEH operation in this lead's fixed project root and persist CANCELLED state.",
    inputSchema: {
      type: "object",
      properties: { operationId: { type: "string" } },
      required: ["operationId"],
      additionalProperties: false
    }
  },
  {
    name: "aeh_context_status",
    description: "Read this managed lead's current Paseo AgentSnapshot usage and evaluate AEH context-pressure policy without shell/log parsing. Optionally pass agentId when the host does not expose PASEO_AGENT_ID to the MCP subprocess.",
    inputSchema: {
      type: "object",
      properties: { agentId: { type: "string" } },
      additionalProperties: false
    }
  }
] as const;

export async function serveOperationMcp(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let request: JsonRpcRequest;
    try { request = JSON.parse(line) as JsonRpcRequest; }
    catch { continue; }
    if (request.id === undefined || request.id === null) continue;
    try { write({ jsonrpc: "2.0", id: request.id, result: await handle(request) }); }
    catch (error) { write({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }); }
  }
}

async function handle(request: JsonRpcRequest): Promise<Record<string, unknown>> {
  if (request.method === "initialize") {
    return {
      protocolVersion: typeof request.params?.protocolVersion === "string" ? request.params.protocolVersion : "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "aeh-operation-controller", version: "2" }
    };
  }
  if (request.method === "ping") return {};
  if (request.method === "tools/list") return { tools };
  if (request.method === "tools/call") return callTool(request.params ?? {});
  throw new Error(`Unsupported MCP method: ${request.method ?? "<missing>"}`);
}

async function callTool(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const name = string(params.name, "tool name");
  const args = object(params.arguments);
  const root = controlRoot();
  if (name === "aeh_operation_start_audit") {
    const payload: AuditOperationPayload = {
      request: string(args.request, "request"),
      files: stringArray(args.files),
      domains: stringArray(args.domains),
      risk: risk(args.risk),
      reviewers: stringArray(args.reviewers)
    };
    return toolResult(await startDetachedOperation(root, "audit", payload, { nodeExecutable: process.execPath, entryFile: path.resolve(process.argv[1]) }));
  }
  if (name === "aeh_operation_start_run") {
    const payload: RunOperationPayload = { taskId: string(args.taskId, "taskId"), profile: optionalString(args.profile) };
    return toolResult(await startDetachedOperation(root, "run", payload, { nodeExecutable: process.execPath, entryFile: path.resolve(process.argv[1]) }));
  }
  if (name === "aeh_operation_status") return toolResult(await loadOperation(root, string(args.operationId, "operationId")));
  if (name === "aeh_operation_cancel") return toolResult(await cancelOperation(root, string(args.operationId, "operationId")));
  if (name === "aeh_context_status") {
    const agentId = optionalString(args.agentId) ?? process.env.PASEO_AGENT_ID?.trim();
    if (!agentId) throw new Error("aeh_context_status requires agentId because PASEO_AGENT_ID is not available to this MCP subprocess.");
    const config = await loadProjectConfig(root);
    return toolResult(await statusLeadContext(root, config, agentId));
  }
  throw new Error(`Unknown AEH operation tool '${name}'.`);
}

function controlRoot(): string { return path.resolve(process.env.AEH_CONTROL_ROOT?.trim() || process.cwd()); }
function toolResult(value: unknown): Record<string, unknown> { return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value }; }
function write(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function string(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`); return value.trim(); }
function optionalString(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function stringArray(value: unknown): string[] | undefined { if (value === undefined) return undefined; if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("Expected an array of strings."); return value as string[]; }
function risk(value: unknown): "low" | "medium" | "high" | undefined { if (value === undefined) return undefined; if (value === "low" || value === "medium" || value === "high") return value; throw new Error("risk must be low, medium or high."); }
