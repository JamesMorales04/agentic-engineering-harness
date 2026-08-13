import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acceptStructuredResult,
  activateStructuredResultTurn,
  bindStructuredResultChannel,
  loadStructuredResultChannel,
  provisionStructuredResultChannel,
  reconcileStructuredResult
} from "../src/workers/resultGateway.js";
import { handleResultSinkRequest } from "../src/workers/resultSinkMcp.js";

const roots: string[] = [];
const originalEnv = {
  AEH_RESULT_CONTROL_ROOT: process.env.AEH_RESULT_CONTROL_ROOT,
  AEH_RESULT_OPERATION_ID: process.env.AEH_RESULT_OPERATION_ID,
  AEH_RESULT_CHANNEL_ID: process.env.AEH_RESULT_CHANNEL_ID,
  AEH_OPERATION_ID: process.env.AEH_OPERATION_ID,
  AEH_CONTROL_ROOT: process.env.AEH_CONTROL_ROOT
};

afterEach(async () => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function reviewerPayload(verdict: "PASS" | "FAIL" = "PASS") {
  return { verdict, findings: [], finalizationSafety: verdict === "PASS" ? "SAFE" : "RISK_KNOWN", followUp: [] };
}

async function fixture() {
  delete process.env.AEH_OPERATION_ID;
  delete process.env.AEH_CONTROL_ROOT;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-result-gateway-"));
  roots.push(root);
  const operationId = "AUDIT-RESULT";
  const channel = await provisionStructuredResultChannel(root, {
    operationId,
    logicalAgent: "security-reviewer",
    role: "reviewer",
    contract: "reviewer"
  });
  await bindStructuredResultChannel(root, operationId, channel.channelId, "agent-1");
  await activateStructuredResultTurn(root, operationId, channel.channelId, "review");
  return { root, operationId, channelId: channel.channelId };
}

describe("StructuredResultGateway", () => {
  it("persists one schema-valid immutable result and accepts identical retries idempotently", async () => {
    const { root, operationId, channelId } = await fixture();
    const first = await acceptStructuredResult(root, operationId, channelId, reviewerPayload(), "mcp");
    const second = await acceptStructuredResult(root, operationId, channelId, reviewerPayload(), "mcp");

    expect(second.artifact).toBe(first.artifact);
    expect(second.sha256).toBe(first.sha256);
    const envelope = JSON.parse(await fs.readFile(path.join(root, first.artifact), "utf8")) as Record<string, unknown>;
    expect(envelope).toEqual(expect.objectContaining({ kind: "agent-result", contract: "reviewer", source: "mcp", payloadSha256: first.sha256 }));
    expect(envelope.payload).toEqual(reviewerPayload());
  });

  it("rejects a different valid payload after a turn was accepted", async () => {
    const { root, operationId, channelId } = await fixture();
    await acceptStructuredResult(root, operationId, channelId, reviewerPayload("PASS"), "mcp");
    await expect(acceptStructuredResult(root, operationId, channelId, reviewerPayload("FAIL"), "mcp")).rejects.toThrow("CONFLICTING_RESULT");
    expect((await loadStructuredResultChannel(root, operationId, channelId)).activeTurn?.status).toBe("CONFLICT");
  });

  it("rejects schema-invalid submissions without losing the active turn", async () => {
    const { root, operationId, channelId } = await fixture();
    await expect(acceptStructuredResult(root, operationId, channelId, { verdict: "MAYBE" }, "mcp")).rejects.toThrow("SCHEMA_VALIDATION_FAILED");
    expect((await loadStructuredResultChannel(root, operationId, channelId)).activeTurn?.status).toBe("REJECTED");
    const accepted = await acceptStructuredResult(root, operationId, channelId, reviewerPayload(), "mcp");
    expect(accepted.payload).toEqual(reviewerPayload());
  });

  it("persists a captured native/text result through the same gateway", async () => {
    const { root, operationId } = await fixture();
    const resolved = await reconcileStructuredResult(root, {
      operationId,
      agentId: "agent-2",
      logicalAgent: "architecture-reviewer",
      role: "reviewer",
      contract: "reviewer",
      phase: "review",
      stdout: JSON.stringify(reviewerPayload()),
      stderr: ""
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.accepted?.source).toBe("captured");
    expect(resolved.accepted?.artifact).toContain("/results/architecture-reviewer/");
  });

  it("exposes exactly one capability-scoped MCP tool with the active contract schema", async () => {
    const { root, operationId, channelId } = await fixture();
    process.env.AEH_RESULT_CONTROL_ROOT = root;
    process.env.AEH_RESULT_OPERATION_ID = operationId;
    process.env.AEH_RESULT_CHANNEL_ID = channelId;

    const listed = await handleResultSinkRequest({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const tools = listed.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("aeh_submit_result");
    expect(tools[0]?.inputSchema).toEqual(expect.objectContaining({ type: "object" }));

    const called = await handleResultSinkRequest({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "aeh_submit_result", arguments: reviewerPayload() } });
    expect(called.structuredContent).toEqual(expect.objectContaining({ status: "ACCEPTED", contract: "reviewer" }));
  });
});
