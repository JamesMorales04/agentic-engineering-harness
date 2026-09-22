import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { explorerOutputSchema } from "../src/agents/outputContracts.js";
import type { WorkerSession } from "../src/core/types.js";
import { requireDurableChangeHandoff } from "../src/operations/changeHandoff.js";
import { acceptStructuredResult, activateStructuredResultTurn, bindStructuredResultChannel, provisionStructuredResultChannel } from "../src/workers/resultGateway.js";

function session(id: string): WorkerSession {
  return { id, provider: "opencode", logicalAgent: "explorer", exitCode: 0, stdout: "", stderr: "", status: "idle" };
}

afterEach(() => {
  delete process.env.AEH_OPERATION_ID;
  delete process.env.AEH_CONTROL_ROOT;
});

describe("CHANGE durable handoff", () => {
  it("consumes an accepted explorer artifact even when captured stdout is empty", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-change-handoff-"));
    const operationId = "CHANGE-TEST";
    const agentId = "explorer-1";
    const channel = await provisionStructuredResultChannel(root, { operationId, logicalAgent: "explorer", role: "explorer", contract: "explorer" });
    await bindStructuredResultChannel(root, operationId, channel.channelId, agentId);
    await activateStructuredResultTurn(root, operationId, channel.channelId, "discovery");
    const payload = {
      summary: "Discovery completed",
      relevantFiles: [{ path: "src/operations/change.ts", symbols: ["runChangeOperation"], reason: "pipeline entry" }],
      findings: [{ id: "CON-001", status: "CONFIRMED", evidence: ["src/operations/change.ts:1"] }],
      moduleBoundaries: ["operations -> spec"],
      tests: ["tests/changeHandoff.test.ts"],
      dependencies: ["OpenSpec"],
      risks: [],
      openQuestions: []
    };
    const accepted = await acceptStructuredResult(root, operationId, channel.channelId, payload, "mcp");
    const handoff = await requireDurableChangeHandoff(root, "EXPLORER", session(agentId), explorerOutputSchema);
    expect(handoff.artifact).toBe(accepted.artifact);
    expect(handoff.payload.summary).toBe("Discovery completed");
  });

  it("consumes the handoff from the explicit control root when execution is isolated", async () => {
    const executionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-change-handoff-worktree-"));
    const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-change-handoff-control-"));
    const operationId = "CHANGE-CONTROL-ROOT";
    const agentId = "explorer-control-root";
    const channel = await provisionStructuredResultChannel(controlRoot, { operationId, logicalAgent: "explorer", role: "explorer", contract: "explorer" });
    await bindStructuredResultChannel(controlRoot, operationId, channel.channelId, agentId);
    await activateStructuredResultTurn(controlRoot, operationId, channel.channelId, "discovery");
    await acceptStructuredResult(controlRoot, operationId, channel.channelId, {
      summary: "Control-root discovery",
      relevantFiles: [],
      findings: [],
      moduleBoundaries: [],
      tests: [],
      dependencies: [],
      risks: [],
      openQuestions: []
    }, "mcp");

    const handoff = await requireDurableChangeHandoff(executionRoot, "EXPLORER", session(agentId), explorerOutputSchema, controlRoot);
    expect(handoff.payload.summary).toBe("Control-root discovery");
  });

  it("fails closed when an expected structured handoff is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-change-handoff-missing-"));
    await expect(requireDurableChangeHandoff(root, "EXPLORER", session("missing-agent"), explorerOutputSchema)).rejects.toThrow(/RESULT_ARTIFACT_MISSING/);
  });
});
