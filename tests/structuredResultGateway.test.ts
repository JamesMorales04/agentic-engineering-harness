import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activateStructuredResultTurn,
  activateStructuredResultTurnForAgent,
  acceptedStructuredResultForAgent,
  bindStructuredResultChannel,
  loadStructuredResultChannel,
  provisionStructuredResultChannel,
  reconcileStructuredResult
} from "../src/workers/resultGateway.js";
import { commitStructuredResult } from "../src/workers/resultCommit.js";
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
    const first = await commitStructuredResult(root, operationId, channelId, reviewerPayload(), "mcp");
    const second = await commitStructuredResult(root, operationId, channelId, reviewerPayload(), "mcp");

    expect(second.artifact).toBe(first.artifact);
    expect(second.sha256).toBe(first.sha256);
    const envelope = JSON.parse(await fs.readFile(path.join(root, first.artifact), "utf8")) as Record<string, unknown>;
    expect(envelope).toEqual(expect.objectContaining({ kind: "agent-result", contract: "reviewer", source: "mcp", payloadSha256: first.sha256 }));
    expect(envelope.payload).toEqual(reviewerPayload());
  });

  it("keeps the first accepted result authoritative when a later valid payload differs", async () => {
    const { root, operationId, channelId } = await fixture();
    const first = await commitStructuredResult(root, operationId, channelId, reviewerPayload("PASS"), "mcp");
    await expect(commitStructuredResult(root, operationId, channelId, reviewerPayload("FAIL"), "mcp")).rejects.toThrow("CONFLICTING_RESULT");
    const channel = await loadStructuredResultChannel(root, operationId, channelId);
    expect(channel.activeTurn).toEqual(expect.objectContaining({ status: "ACCEPTED", artifact: first.artifact, sha256: first.sha256 }));
  });

  it("rejects an accepted artifact whose payload or identity was tampered with", async () => {
    const { root, operationId, channelId } = await fixture();
    const accepted = await commitStructuredResult(root, operationId, channelId, reviewerPayload(), "mcp");
    const artifactPath = path.join(root, accepted.artifact);
    const artifact = JSON.parse(await fs.readFile(artifactPath, "utf8")) as Record<string, unknown>;
    artifact.payload = reviewerPayload("FAIL");
    await fs.writeFile(artifactPath, `${JSON.stringify(artifact)}\n`);
    await expect(acceptedStructuredResultForAgent(root, "agent-1")).rejects.toThrow(/AEH_RESULT_INTEGRITY/);
  });

  it("rejects a valid result from a different operation revision or supervisor generation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-result-provenance-"));
    roots.push(root);
    const channel = await provisionStructuredResultChannel(root, { operationId: "AUDIT-PROVENANCE", logicalAgent: "security-reviewer", role: "reviewer", contract: "reviewer", operationRevision: 7, supervisorGeneration: 3 });
    await bindStructuredResultChannel(root, "AUDIT-PROVENANCE", channel.channelId, "agent-provenance");
    await activateStructuredResultTurn(root, "AUDIT-PROVENANCE", channel.channelId, "review");
    await commitStructuredResult(root, "AUDIT-PROVENANCE", channel.channelId, reviewerPayload(), "mcp");
    await expect(acceptedStructuredResultForAgent(root, "agent-provenance", { operationRevision: 8 })).rejects.toThrow(/operation revision/);
    await expect(acceptedStructuredResultForAgent(root, "agent-provenance", { supervisorGeneration: 4 })).rejects.toThrow(/supervisor generation/);
    await expect(acceptedStructuredResultForAgent(root, "agent-provenance", { operationRevision: 7, supervisorGeneration: 3 })).resolves.toBeTruthy();
  });

  it("fails closed when a resumed turn has no bound result channel", async () => {
    const { root } = await fixture();
    await expect(activateStructuredResultTurnForAgent(root, "unbound-agent")).rejects.toThrow(/no structured result channel is bound/);
  });

  it("rejects schema-invalid submissions without losing the active turn", async () => {
    const { root, operationId, channelId } = await fixture();
    await expect(commitStructuredResult(root, operationId, channelId, { verdict: "MAYBE" }, "mcp")).rejects.toThrow("SCHEMA_VALIDATION_FAILED");
    expect((await loadStructuredResultChannel(root, operationId, channelId)).activeTurn?.status).toBe("REJECTED");
    const accepted = await commitStructuredResult(root, operationId, channelId, reviewerPayload(), "mcp");
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

  it("does not reuse an accepted result from a prior captured turn", async () => {
    const { root, operationId } = await fixture();
    const first = await reconcileStructuredResult(root, {
      operationId,
      agentId: "agent-1",
      logicalAgent: "security-reviewer",
      role: "reviewer",
      contract: "reviewer",
      phase: "review",
      stdout: JSON.stringify(reviewerPayload("PASS")),
      stderr: ""
    });
    const second = await reconcileStructuredResult(root, {
      operationId,
      agentId: "agent-1",
      logicalAgent: "security-reviewer",
      role: "reviewer",
      contract: "reviewer",
      phase: "review",
      stdout: JSON.stringify(reviewerPayload("FAIL")),
      stderr: ""
    });

    expect(first.accepted?.payload).toEqual(reviewerPayload("PASS"));
    expect(second.accepted?.payload).toEqual(reviewerPayload("FAIL"));
    expect(second.accepted?.turnId).not.toBe(first.accepted?.turnId);
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
