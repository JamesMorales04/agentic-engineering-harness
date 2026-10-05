import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ContextBudgetGateway } from "../src/context/gateway.js";
import { estimateTokens } from "../src/context/estimator.js";
import { buildAgentContextFragments } from "../src/workers/agentPrompt.js";
import type { AgentExecutionSelection } from "../src/agents/types.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";

function baseConfig(): HarnessProjectConfig {
  return {
    version: 1,
    project: { name: "supervisor-rotation-recovery" },
    telemetry: { enabled: false },
    context: {
      mode: "enforce",
      budgets: {
        default: { inputTokens: 16000 },
        agents: { "operation-supervisor": { inputTokens: 1500 } },
      },
      repositoryMap: { enabled: false },
      semanticRetrieval: { provider: "none", required: false },
      compression: { provider: "headroom", required: true, minTokens: 2000, reversible: true },
      retrieval: { maxRequestsPerTurn: 8, maxTokensPerRequest: 6000, maxTotalTokensPerTurn: 20000 },
    },
  };
}

function largeValidationReport(taskId: string): string {
  // Raw must exceed minTokens 2000 (approx 8000 chars) to hit the reversible gate,
  // while the deterministic PROJECTABLE summary stays small: the large passing-check
  // payload is omitted by projectValidation (only FAIL/WARN are projected).
  return JSON.stringify({
    version: 1,
    taskId,
    status: "FAIL",
    startedAt: "2026-10-05T00:00:00.000Z",
    finishedAt: "2026-10-05T00:01:00.000Z",
    checks: [
      {
        id: "diff.allowed-scope",
        category: "diff",
        status: "FAIL",
        message: `Files outside allowed scope: ${Array.from({ length: 20 }, (_, i) => `src/file-${i}.ts`).join(", ")}`,
        details: { outsideAllowed: Array.from({ length: 20 }, (_, i) => `src/file-${i}.ts`) },
      },
      {
        id: "command.npm-check",
        category: "command",
        status: "PASS",
        message: "npm-check passed.",
        details: {
          command: "npm run check",
          exitCode: 0,
          stdoutExcerpt: `passing-log ${"x".repeat(9000)}`,
        },
      },
    ],
    changedFiles: Array.from({ length: 20 }, (_, i) => `src/file-${i}.ts`),
    metadata: { project: "supervisor-rotation-recovery", baseRef: "main" },
  });
}

const supervisorSelection: AgentExecutionSelection = {
  logicalAgent: "operation-supervisor",
  role: "Operation Supervisor",
  description: "Own operation-local coordination.",
  domains: ["*"],
  runtimeName: "codex",
  runtimeAdapter: "codex",
  paseoProvider: "codex",
  modelAlias: "brain",
  modelId: "test/luna",
  modelName: "gpt-6-luna",
  transport: "paseo",
  skills: [],
  mcps: [],
  permissions: { read: "allow", write: "deny", shell: "allow", network: "deny", delegate: "allow", review: "allow", validate: "deny", gitWrite: "deny" },
  contextRequirements: { repositoryMap: "FORBIDDEN", semanticRetrieval: "FORBIDDEN", rawRetrieval: "FORBIDDEN", compression: "OPTIONAL" },
  args: [],
  runtimeCapabilities: {},
};

const workerSelection: AgentExecutionSelection = {
  logicalAgent: "implementer",
  role: "Implementer",
  description: "Bounded implementation charter.",
  domains: ["backend"],
  runtimeName: "opencode",
  runtimeAdapter: "opencode",
  paseoProvider: "opencode",
  modelAlias: "workhorse",
  modelId: "test/model",
  modelName: "model",
  transport: "direct",
  skills: [],
  mcps: [],
  permissions: { read: "allow", write: "allow", shell: "allow", network: "deny", delegate: "deny", gitWrite: "deny" },
  args: [],
  runtimeCapabilities: {},
};

describe("supervisor rotation recovery lease (CHANGE-20261005T000520Z rev 109)", () => {
  it("reproduces the systematic gate: COMPRESSIBLE validation-evidence >=2000tok without authorized retrieval throws", async () => {
    const content = largeValidationReport("TASK-LARGE");
    expect(estimateTokens(content)).toBeGreaterThanOrEqual(2000);
    const gateway = new ContextBudgetGateway("/tmp", baseConfig(), { persist: false, telemetry: false });
    await expect(
      gateway.prepare({
        operationId: "CHANGE-20261005T000520Z-be9f5ac1",
        logicalAgent: "operation-supervisor",
        role: "Operation Supervisor",
        phase: "supervision",
        fragments: [{ id: "validation-evidence", kind: "validation", preservation: "COMPRESSIBLE", priority: 75, content }],
        capabilities: { authorizedRetrieval: false },
      })
    ).rejects.toThrow("CONTEXT_COMPRESSION_REVERSIBILITY_UNAVAILABLE");
  });

  it("keeps fail-closed for workers: COMPRESSIBLE without retrieval still throws", async () => {
    const content = largeValidationReport("TASK-WORKER");
    const gateway = new ContextBudgetGateway("/tmp", baseConfig(), { persist: false, telemetry: false });
    await expect(
      gateway.prepare({
        operationId: "OP-WORKER",
        logicalAgent: "implementer",
        role: "Implementer",
        phase: "implementation",
        fragments: [{ id: "validation-evidence", kind: "validation", preservation: "COMPRESSIBLE", priority: 75, content }],
        capabilities: { authorizedRetrieval: false },
      })
    ).rejects.toThrow("CONTEXT_COMPRESSION_REVERSIBILITY_UNAVAILABLE");
  });

  it("routes supervisor validation-evidence to deterministic PROJECTABLE when retrieval is forbidden and compression is optional", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-supervisor-recovery-"));
    try {
      const taskId = "TASK-SUPERVISOR";
      await fs.mkdir(path.join(root, ".harness", "reports"), { recursive: true });
      await fs.writeFile(path.join(root, ".harness", "reports", `${taskId}.json`), largeValidationReport(taskId));
      const contract: TaskContract = { version: 1, task: { id: taskId, title: "supervisor rotation" } };
      const prepared = await buildAgentContextFragments(root, baseConfig(), contract, supervisorSelection, "Coordinate the operation", {
        phase: "supervision",
        supervisorAgent: true,
      });
      const fragment = prepared.fragments.find((item) => item.id === "validation-evidence");
      expect(fragment).toBeDefined();
      expect(fragment?.preservation).toBe("PROJECTABLE");
      expect(fragment?.metadata).toMatchObject({ artifact: `.harness/reports/${taskId}.json` });
      expect(prepared.capabilities.authorizedRetrieval).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps worker validation-evidence COMPRESSIBLE so reversible compression still applies", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-worker-compressible-"));
    try {
      const taskId = "TASK-WORKER-2";
      await fs.mkdir(path.join(root, ".harness", "reports"), { recursive: true });
      await fs.writeFile(path.join(root, ".harness", "reports", `${taskId}.json`), largeValidationReport(taskId));
      const contract: TaskContract = { version: 1, task: { id: taskId, title: "worker" } };
      const prepared = await buildAgentContextFragments(root, baseConfig(), contract, workerSelection, "Implement the task", {
        phase: "implementation",
      });
      const fragment = prepared.fragments.find((item) => item.id === "validation-evidence");
      expect(fragment).toBeDefined();
      expect(fragment?.preservation).toBe("COMPRESSIBLE");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("delivers the replacement-supervisor supervision turn without compressing validation evidence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-supervisor-deliver-"));
    try {
      const taskId = "TASK-ROTATION";
      const content = largeValidationReport(taskId);
      expect(estimateTokens(content)).toBeGreaterThanOrEqual(2000);
      await fs.mkdir(path.join(root, ".harness", "reports"), { recursive: true });
      await fs.writeFile(path.join(root, ".harness", "reports", `${taskId}.json`), content);
      const contract: TaskContract = { version: 1, task: { id: taskId, title: "rotation" } };
      const prepared = await buildAgentContextFragments(root, baseConfig(), contract, supervisorSelection, "Coordinate the operation", {
        phase: "supervision",
        supervisorAgent: true,
      });
      const gateway = new ContextBudgetGateway(root, baseConfig(), { telemetry: false });
      const result = await gateway.prepare({
        operationId: taskId,
        logicalAgent: supervisorSelection.logicalAgent,
        role: supervisorSelection.role,
        phase: "supervision",
        fragments: prepared.fragments,
        capabilities: prepared.capabilities,
      });
      const delivered = result.envelope.fragments.find((item) => item.id === "validation-evidence");
      expect(delivered).toBeDefined();
      expect(delivered?.compressed).not.toBe(true);
      expect(delivered?.projected).toBe(true);
      expect(delivered?.content).toContain(`taskId=${taskId}`);
      expect(delivered?.source?.artifact).toBeDefined();
      expect(delivered?.source?.sha256).toMatch(/^[a-f0-9]{64}$/);
      const raw = await fs.readFile(path.join(root, delivered!.source!.artifact!), "utf8");
      expect(raw).toBe(content);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
