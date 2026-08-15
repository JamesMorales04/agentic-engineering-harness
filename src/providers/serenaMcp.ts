import { spawn } from "node:child_process";
import readline from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface SerenaMcpContractResult {
  initialized: boolean;
  toolNames: string[];
  semanticTool: string;
  retrievalText: string;
}

export async function runSerenaMcpContract(root: string, command = "serena"): Promise<SerenaMcpContractResult> {
  const child = spawn(command, ["start-mcp-server", "--context", "ide-assistant", "--project", root], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let nextId = 1;
  const lineReader = readline.createInterface({ input: child.stdout });
  lineReader.on("line", (line) => {
    try {
      const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
      if (typeof message.id !== "number") return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message ?? "Serena MCP request failed"));
      else request.resolve(message.result);
    } catch {
      // Serena diagnostics belong on stderr; malformed stdout is handled by
      // the request timeout rather than being treated as a valid response.
    }
  });
  child.on("error", (error) => {
    for (const request of pending.values()) request.reject(error instanceof Error ? error : new Error(String(error)));
    pending.clear();
  });
  try {
    const initialized = await request(child, pending, nextId++, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "aeh-provider-contract", version: "1" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
    const listed = await request(child, pending, nextId++, "tools/list", {});
    const tools = Array.isArray(listed?.tools) ? listed.tools as Array<{ name?: string }> : [];
    const toolNames = tools.flatMap((tool) => typeof tool.name === "string" ? [tool.name] : []);
    const semanticTool = ["get_symbols_overview", "find_symbol", "find_referencing_symbols"].find((name) => toolNames.includes(name));
    if (!semanticTool) throw new Error("Serena MCP did not expose a semantic read-only tool.");
    const args = semanticTool === "get_symbols_overview"
      ? { relative_path: "src/serena-fixture.ts", max_answer_chars: 4_000 }
      : { name_path_pattern: "SerenaFixtureSymbol", relative_path: "src/serena-fixture.ts", max_matches: 5 };
    const called = await request(child, pending, nextId++, "tools/call", { name: semanticTool, arguments: args });
    const retrievalText = JSON.stringify(called);
    if (!retrievalText.includes("SerenaFixtureSymbol")) throw new Error("Serena semantic retrieval did not return the fixture symbol.");
    return { initialized: Boolean(initialized), toolNames, semanticTool, retrievalText };
  } finally {
    lineReader.close();
    child.stdin.end();
    await stop(child);
  }
}

function request(child: ChildProcessWithoutNullStreams, pending: Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>, id: number, method: string, params: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Serena MCP request '" + method + "' timed out."));
    }, 45_000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(); }, 5_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}
