import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fakeSdk = vi.hoisted(() => ({ path: "" }));
vi.mock("../src/paseo/sdkResolve.js", () => ({
  resolvePaseoSdkFromCli: vi.fn(async () => ({ resolved: fakeSdk.path, diagnostics: [] }))
}));

import { materializePaseoSdkAgent } from "../src/paseo/sdk.js";
import { loadStructuredResultChannel, provisionStructuredResultChannel, resultSinkMcpServerDefinition } from "../src/workers/resultGateway.js";

const roots: string[] = [];
afterEach(async () => {
  delete (globalThis as Record<string, unknown>).__aehPaseoCreateOptions;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Paseo pending execution identity", () => {
  it("installs an inert result sink before materialization and binds the returned actual agent id", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-paseo-pending-identity-"));
    roots.push(root);
    fakeSdk.path = path.join(root, "fake-paseo-sdk.mjs");
    await fs.writeFile(fakeSdk.path, [
      "export function createPaseoClient() {",
      "  return { connect: async () => {}, close: async () => {}, agents: {",
      "    create: async (options) => { globalThis.__aehPaseoCreateOptions = options; return { id: 'actual-provider-agent-id', workspaceId: null, status: 'idle' }; },",
      "    ref: () => ({}), list: async () => ({ entries: [] })",
      "  } };",
      "}"
    ].join("\n"));

    const operationId = "OP-PASEO-PENDING";
    const logicalAgent = "security-reviewer";
    const role = "Reviewer";
    const taskId = "TASK-PENDING";
    const contract = "reviewer";
    const pending = await provisionStructuredResultChannel(root, { operationId, logicalAgent, role, taskId, contract });
    const options = {
      cwd: root,
      provider: "codex",
      model: "test-model",
      title: "pending reviewer",
      labels: {
        "aeh.operation": operationId,
        "aeh.role": logicalAgent,
        "aeh.canonical.role": role,
        "aeh.task": taskId,
        "aeh.output.contract": contract,
        "aeh.result.channel": pending.channelId,
        "aeh.execution.binding.phase": "PENDING_SESSION"
      },
      mcpServers: { "aeh-result": resultSinkMcpServerDefinition(root, operationId, pending.channelId) },
      toolPolicy: { preapproved: [{ kind: "mcp" as const, server: "aeh-result", tool: "aeh_submit_result" }] },
      waitForFinish: false
    };

    const result = await materializePaseoSdkAgent(root, options);
    const launched = (globalThis as Record<string, unknown>).__aehPaseoCreateOptions as Record<string, unknown>;
    const config = launched.config as Record<string, unknown>;
    const channel = await loadStructuredResultChannel(root, operationId, pending.channelId);

    expect(result.id).toBe("actual-provider-agent-id");
    expect(launched.initialPrompt).toBeUndefined();
    expect(launched.labels).toMatchObject({ "aeh.result.channel": pending.channelId, "aeh.execution.binding.phase": "PENDING_SESSION" });
    expect(config.mcpServers).toHaveProperty("aeh-result");
    expect(config.toolPolicy).toEqual(options.toolPolicy);
    expect(channel).toMatchObject({ agentId: "actual-provider-agent-id", provenance: { status: "UNSUPPORTED" } });
    expect(channel.activeTurn).toBeUndefined();
  });
});
