import readline from "node:readline";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { outputJsonSchema } from "../agents/outputContracts.js";
import { acceptStructuredResult, loadStructuredResultChannel } from "./resultGateway.js";

interface JsonRpcRequest { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown>; }

export async function serveResultSinkMcp(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let request: JsonRpcRequest;
    try { request = JSON.parse(line) as JsonRpcRequest; } catch { continue; }
    if (request.id === undefined || request.id === null) continue;
    try { write({ jsonrpc: "2.0", id: request.id, result: await handleResultSinkRequest(request) }); }
    catch (error) { write({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }); }
  }
}

export async function handleResultSinkRequest(request: JsonRpcRequest): Promise<Record<string, unknown>> {
  const root = requiredEnv("AEH_RESULT_CONTROL_ROOT");
  const operationId = requiredEnv("AEH_RESULT_OPERATION_ID");
  const channelId = requiredEnv("AEH_RESULT_CHANNEL_ID");
  const channel = await loadStructuredResultChannel(root, operationId, channelId);

  if (request.method === "initialize") {
    return {
      protocolVersion: typeof request.params?.protocolVersion === "string" ? request.params.protocolVersion : "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "aeh-result-sink", version: "1" }
    };
  }
  if (request.method === "ping") return {};
  if (request.method === "tools/list") {
    return {
      tools: [{
        name: "aeh_submit_result",
        description: `Submit the final ${channel.contract} contract result for the current controller-activated AEH turn. This durable submission is authoritative; operation, agent, contract and destination are controller-bound and cannot be supplied by the caller.`,
        inputSchema: outputJsonSchema(channel.contract) ?? { type: "object", additionalProperties: true }
      }]
    };
  }
  if (request.method === "tools/call") {
    const params = request.params ?? {};
    if (params.name !== "aeh_submit_result") throw new Error(`Unknown result sink tool '${String(params.name ?? "")}'.`);
    const payload = object(params.arguments);
    const accepted = await acceptStructuredResult(root, operationId, channelId, payload, "mcp");
    return {
      content: [{ type: "text", text: `Accepted ${channel.contract} result ${accepted.sha256.slice(0, 12)} for the active AEH turn.` }],
      structuredContent: {
        status: "ACCEPTED",
        contract: channel.contract,
        artifact: accepted.artifact,
        sha256: accepted.sha256,
        turnId: accepted.turnId
      }
    };
  }
  throw new Error(`Unsupported MCP method: ${request.method ?? "<missing>"}`);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the AEH result sink.`);
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("aeh_submit_result arguments must be one JSON object matching the active output contract.");
  return value as Record<string, unknown>;
}
function write(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serveResultSinkMcp().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
}
