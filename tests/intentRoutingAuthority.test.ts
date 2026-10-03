import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeProject } from "../src/core/init.js";
import { createIntentDecision } from "../src/audit/intentDecision.js";
import { handleOperationMcpRequest } from "../src/operations/mcp.js";
import { loadOperation } from "../src/operations/state.js";
import { startDetachedOperation } from "../src/operations/controller.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("semantic routing authority boundary", () => {
  it("uses the lead-selected informational route without asking a heuristic to veto it", async () => {
    const root = await project();
    vi.stubEnv("AEH_CONTROL_ROOT", root);
    const result = await handleOperationMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "aeh_informational_context", arguments: { request: "Find security problems in this repository, but only explain the existing evidence." } } });
    expect(result.structuredContent).toMatchObject({ intent: "informational" });
    expect(await fs.readdir(path.join(root, ".harness", "operations"))).toEqual([]);
    expect(await fs.readFile(path.resolve(process.cwd(), "src/operations/mcp.ts"), "utf8")).not.toContain("classifyEngineeringIntent");
  });

  it("does not expose controller-owned effects in the informational provider schema", async () => {
    const listed = await handleOperationMcpRequest({ method: "tools/list" });
    const informational = (listed.tools as Array<{ name: string; inputSchema: { properties: Record<string, unknown>; additionalProperties: boolean } }>).find((tool) => tool.name === "aeh_informational_context")!;
    expect(informational.inputSchema).toMatchObject({ additionalProperties: false, properties: { request: { type: "string" } } });
    expect(informational.inputSchema.properties).not.toHaveProperty("intentDecision");
    expect(informational.inputSchema.properties).not.toHaveProperty("effects");
  });

  it("persists the selected audit route while retaining controller ownership of policy", async () => {
    const root = await project();
    const decision = createIntentDecision("audit", "evaluate the repository", "lead-semantic", { userTurnId: "lead-1:turn-4" });
    const record = await startDetachedOperation(root, "audit", { request: "explain how validation works", intentDecision: decision }, { nodeExecutable: process.execPath, entryFile: process.argv[1] ?? "aeh", initiator: { kind: "LEAD", agentId: "lead-1", requestEventId: "jsonrpc:intent-routing-audit" } });
    const durable = await loadOperation(root, record.id);
    expect(durable.intent?.semanticDecision).toMatchObject({ intent: "audit", userTurnId: "lead-1:turn-4" });
    await expect(startDetachedOperation(root, "audit", { request: "anything", intentDecision: createIntentDecision("informational", "explain it", "lead-semantic") }, { nodeExecutable: process.execPath, entryFile: process.argv[1] ?? "aeh" })).rejects.toThrow("does not match");
  });
});

async function project(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-routing-authority-"));
  roots.push(root);
  await initializeProject(root);
  return root;
}
