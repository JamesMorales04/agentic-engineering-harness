import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const runtime = vi.hoisted(() => ({ materialize: vi.fn() }));
vi.mock("../src/paseo/runtime.js", () => ({
  materializeManagedPaseoAgent: runtime.materialize,
  launchManagedPaseoAgent: vi.fn(),
  continueManagedPaseoAgent: vi.fn(),
  stopManagedPaseoAgent: vi.fn()
}));
vi.mock("../src/security/executionLease.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/security/executionLease.js")>(),
  prepareExecutionAuthority: vi.fn(async () => undefined)
}));

import { materializeAgentPrompt } from "../src/workers/agentPrompt.js";
import { materializePaseoSdkAgentWithClient, type PaseoSdkAgentOptions } from "../src/paseo/sdk.js";
import { saveOperation } from "../src/operations/state.js";

const originalEnv = {
  id: process.env.AEH_OPERATION_ID,
  kind: process.env.AEH_OPERATION_KIND,
  workspace: process.env.AEH_OPERATION_WORKSPACE_ID,
  control: process.env.AEH_CONTROL_ROOT
};

afterEach(() => {
  restore("AEH_OPERATION_ID", originalEnv.id);
  restore("AEH_OPERATION_KIND", originalEnv.kind);
  restore("AEH_OPERATION_WORKSPACE_ID", originalEnv.workspace);
  restore("AEH_CONTROL_ROOT", originalEnv.control);
  runtime.materialize.mockReset();
});

describe("AEH independent Paseo participants", () => {
  it("materializes supervisor and worker with semantic parent metadata but no provider parent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-independent-participants-"));
    const operationId = "CHANGE-INDEPENDENT-PARTICIPANTS";
    const captured: Record<string, unknown>[] = [];
    const client = {
      agents: {
        create: vi.fn(async (options: Record<string, unknown>) => {
          captured.push(options);
          const n = captured.length;
          return {
            id: `paseo-session-${n}`,
            workspaceId: "workspace-operation",
            status: "idle",
            latest: () => ({ id: `paseo-session-${n}`, status: "idle", workspaceId: "workspace-operation" })
          };
        })
      },
      connect: vi.fn(),
      close: vi.fn()
    };

    try {
      const now = new Date().toISOString();
      await saveOperation(root, {
        version: 2, id: operationId, kind: "change", status: "RUNNING", phase: "implementation", root,
        workspaceRoot: root, workspaceId: "workspace-operation", payload: { request: "independent agents" },
        revision: 1, operationExecutionRevision: 1, createdAt: now, updatedAt: now, lastProgressAt: now,
        intent: { request: "independent agents", classification: "CHANGE", priority: 50 },
        lead: { agentId: "archived-lead-session", source: "test", generation: 1, boundAt: now, acknowledgedRevision: 1, acknowledgedAt: now, archivedAt: now } as never,
        supervision: { required: false, materialized: false, generations: [] }, stages: {}, participants: {},
        progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
        notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 }
      } as never);
      process.env.AEH_OPERATION_ID = operationId;
      process.env.AEH_OPERATION_KIND = "change";
      process.env.AEH_OPERATION_WORKSPACE_ID = "workspace-operation";
      process.env.AEH_CONTROL_ROOT = root;

      runtime.materialize.mockImplementation(async (_root: string, options: PaseoSdkAgentOptions) => {
        const result = await materializePaseoSdkAgentWithClient(client as never, options);
        return { ...result, exitCode: 0, stdout: "", stderr: "", transport: "sdk" } as never;
      });

      const config = { version: 1, project: { name: "demo" }, orchestration: { provider: "paseo", worker: {} } } as never;
      const contract = { version: 1, task: { id: operationId, title: "independent participants" }, routing: { intent: "change" } } as never;
      const base = {
        paseoProvider: "opencode", transport: "paseo", runtimeAdapter: "opencode", runtimeName: "opencode",
        modelName: "mimo", modelId: "opencode-go/mimo", runtimeCapabilities: {}, skills: [], mcps: [],
        permissions: { read: "allow", write: "deny", shell: "deny", network: "deny" }
      } as never;

      await materializeAgentPrompt(root, config, contract, { ...base, logicalAgent: "operation-supervisor", role: "Operation Supervisor" }, {
        phase: "supervision", supervisorAgent: true
      });
      await materializeAgentPrompt(root, config, contract, { ...base, logicalAgent: "reviewer", role: "Reviewer" }, {
        phase: "review", parentAgentId: "missing-supervisor-session"
      });

      expect(captured).toHaveLength(2);
      expect(captured[0]).toEqual(expect.objectContaining({
        cwd: root,
        workspaceId: "workspace-operation",
        labels: expect.objectContaining({ "aeh.parent-agent": "archived-lead-session", "aeh.role": "operation-supervisor" })
      }));
      expect(captured[1]).toEqual(expect.objectContaining({
        cwd: root,
        workspaceId: "workspace-operation",
        labels: expect.objectContaining({ "aeh.parent-agent": "missing-supervisor-session", "aeh.role": "reviewer" })
      }));
      for (const options of captured) {
        expect(options).not.toHaveProperty("parent");
        expect(options).not.toHaveProperty("callerAgentId");
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
