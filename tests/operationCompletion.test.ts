import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadOperationCompletionTarget,
  notifyOperationCompletion,
  registerOperationCompletionTarget
} from "../src/operations/completion.js";
import { cancelOperation, startDetachedOperation } from "../src/operations/controller.js";
import { saveOperation, type OperationRecord } from "../src/operations/state.js";

const roots: string[] = [];
const originalAgentId = process.env.PASEO_AGENT_ID;

afterEach(async () => {
  if (originalAgentId === undefined) delete process.env.PASEO_AGENT_ID;
  else process.env.PASEO_AGENT_ID = originalAgentId;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-operation-completion-"));
  roots.push(root);
  return root;
}

function terminal(root: string, overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    version: 1,
    id: "AUDIT-1",
    kind: "audit",
    status: "SUCCEEDED",
    phase: "finished",
    root,
    payload: { request: "review" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    result: { report: ".harness/audits/AUDIT-1.json", status: "PASS" },
    ...overrides
  };
}

describe("operation completion callbacks", () => {
  it("sends exactly one continuation callback to the registered lead", async () => {
    const root = await tempRoot();
    await registerOperationCompletionTarget(root, "AUDIT-1", "lead-1", "lead-state", vi.fn(async () => undefined));
    const dispatch = vi.fn(async () => ({
      id: "lead-1",
      exitCode: 0,
      stdout: "",
      stderr: "",
      status: "working",
      transport: "sdk" as const
    }));
    const trace = vi.fn(async () => undefined);

    const first = await notifyOperationCompletion(root, terminal(root), {
      dispatch: dispatch as never,
      trace: trace as never
    });
    const second = await notifyOperationCompletion(root, terminal(root), {
      dispatch: dispatch as never,
      trace: trace as never
    });

    expect(first?.status).toBe("SENT");
    expect(second?.status).toBe("SENT");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][1]).toBe("lead-1");
    expect(String(dispatch.mock.calls[0][2])).toContain("[AEH_OPERATION_COMPLETED]");
    expect(String(dispatch.mock.calls[0][2])).toContain("Do not start a duplicate");
    expect(String(dispatch.mock.calls[0][2])).toContain(".harness/audits/AUDIT-1.json");
    expect(trace).toHaveBeenCalledWith(
      root,
      "operation.callback.sent",
      expect.objectContaining({ operationId: "AUDIT-1", agentId: "lead-1" })
    );
  });

  it("persists callback delivery failure without changing the operation result", async () => {
    const root = await tempRoot();
    await registerOperationCompletionTarget(root, "AUDIT-1", "lead-1", "lead-state", vi.fn(async () => undefined));
    const dispatch = vi.fn(async () => ({
      id: "lead-1",
      exitCode: 1,
      stdout: "",
      stderr: "daemon unavailable",
      status: "failed",
      transport: "sdk" as const
    }));

    const completion = await notifyOperationCompletion(root, terminal(root), {
      dispatch: dispatch as never,
      trace: vi.fn(async () => undefined) as never
    });

    expect(completion).toEqual(expect.objectContaining({
      status: "FAILED",
      agentId: "lead-1",
      error: "daemon unavailable"
    }));
    expect(terminal(root).status).toBe("SUCCEEDED");
  });

  it("keeps detached CLI operations valid when no managed lead identity exists", async () => {
    const root = await tempRoot();
    delete process.env.PASEO_AGENT_ID;
    const unref = vi.fn();
    const record = await startDetachedOperation(root, "audit", { request: "review" }, {
      nodeExecutable: "/usr/bin/node",
      entryFile: "/pkg/dist/main.js",
      spawnProcess: vi.fn(() => ({ pid: 1234, unref })) as never
    });

    expect(record.status).toBe("QUEUED");
    expect(await loadOperationCompletionTarget(root, record.id)).toBeUndefined();
  });

  it("serializes concurrent terminal callbacks so only one dispatch is accepted", async () => {
    const root = await tempRoot();
    const operation = terminal(root, { id: "AUDIT-CONCURRENT" });
    const trace = vi.fn(async () => undefined);
    await registerOperationCompletionTarget(root, operation.id, "lead-1", "test", trace);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const dispatch = vi.fn(async () => { await gate; return { exitCode: 0, stdout: "accepted", stderr: "", durationMs: 1, transport: "sdk" as const }; });
    const first = notifyOperationCompletion(root, operation, { dispatch: dispatch as never, trace, retryDelaysMs: [0], sleep: async () => undefined });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    const second = notifyOperationCompletion(root, operation, { dispatch: dispatch as never, trace, retryDelaysMs: [0], sleep: async () => undefined });
    release();
    await Promise.all([first, second]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((await loadOperationCompletionTarget(root, operation.id))?.status).toBe("SENT");
  });

  it("disables a registered callback when detached controller spawn fails synchronously", async () => {
    const root = await tempRoot();
    const record = await startDetachedOperation(root, "audit", { request: "review" }, {
      nodeExecutable: "/usr/bin/node",
      entryFile: "/pkg/dist/main.js",
      completionAgentId: "lead-1",
      completionSource: "lead-state",
      spawnProcess: vi.fn(() => { throw new Error("spawn boom"); }) as never
    });

    expect(record.status).toBe("FAILED");
    expect(await loadOperationCompletionTarget(root, record.id)).toEqual(
      expect.objectContaining({ status: "DISABLED", agentId: "lead-1" })
    );
  });

  it("notifies the initiating lead after cancellation cleanup", async () => {
    const root = await tempRoot();
    const record = terminal(root, {
      status: "RUNNING",
      phase: "reviewing",
      finishedAt: undefined,
      result: undefined,
      agents: [{
        id: "reviewer-1",
        role: "security-reviewer",
        transport: "sdk",
        registeredAt: new Date().toISOString()
      }]
    });
    await saveOperation(root, record);
    const notifyCompletion = vi.fn(async () => undefined);
    const run = vi.fn(async () => ({ exitCode: 0, stdout: "stopped", stderr: "", durationMs: 1 }));

    const cancelled = await cancelOperation(root, record.id, {
      run: run as never,
      trace: vi.fn(async () => undefined) as never,
      notifyCompletion
    });

    expect(cancelled.status).toBe("CANCELLED");
    expect(notifyCompletion).toHaveBeenCalledTimes(1);
    expect(notifyCompletion).toHaveBeenCalledWith(root, expect.objectContaining({ status: "CANCELLED" }));
  });
});
