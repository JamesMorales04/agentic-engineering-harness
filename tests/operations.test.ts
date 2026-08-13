import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelOperation,
  createOperationId,
  extractWorkspaceId,
  startDetachedOperation
} from "../src/operations/controller.js";
import {
  loadOperation,
  patchOperation,
  registerOperationAgent,
  saveOperation,
  transitionOperationToTerminal,
  type OperationRecord
} from "../src/operations/state.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-operation-test-"));
  roots.push(root);
  return root;
}

async function seed(
  root: string,
  overrides: Partial<OperationRecord> = {}
): Promise<OperationRecord> {
  const record: OperationRecord = {
    version: 1,
    id: "AUDIT-1",
    kind: "audit",
    status: "QUEUED",
    phase: "queued",
    root,
    payload: { request: "review" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  };
  await saveOperation(root, record);
  return record;
}

describe("operation controller state", () => {
  it("persists operation records atomically", async () => {
    const root = await tempRoot();
    const record = await seed(root);
    expect(await loadOperation(root, record.id)).toEqual(record);
  });

  it("serializes concurrent patches without corrupting the operation file", async () => {
    const root = await tempRoot();
    const record = await seed(root, { status: "RUNNING", phase: "executing" });
    await Promise.all([
      patchOperation(root, record.id, { phase: "planning" }),
      patchOperation(root, record.id, { workspaceId: "workspace-op" }),
      patchOperation(root, record.id, { workspaceWarning: "diagnostic" })
    ]);
    const current = await loadOperation(root, record.id);
    expect(current.status).toBe("RUNNING");
    expect(current.workspaceId).toBe("workspace-op");
    expect(current.workspaceWarning).toBe("diagnostic");
    expect(["planning", "executing"]).toContain(current.phase);
  });

  it("serializes concurrent agent registration without losing participants", async () => {
    const root = await tempRoot();
    const record = await seed(root, { status: "RUNNING", phase: "review" });
    await Promise.all([
      registerOperationAgent(root, record.id, {
        id: "reviewer-1",
        role: "security-reviewer",
        transport: "sdk"
      }),
      registerOperationAgent(root, record.id, {
        id: "reviewer-2",
        role: "architecture-reviewer",
        transport: "sdk"
      })
    ]);
    const current = await loadOperation(root, record.id);
    expect(current.agents?.map((agent) => agent.id).sort()).toEqual([
      "reviewer-1",
      "reviewer-2"
    ]);
  });

  it("grants exactly one concurrent caller ownership of the terminal transition", async () => {
    const root = await tempRoot();
    const record = await seed(root, { status: "RUNNING", phase: "reviewing" });
    const [success, cancellation] = await Promise.all([
      transitionOperationToTerminal(root, record.id, {
        status: "SUCCEEDED",
        phase: "finished",
        finishedAt: "2026-08-13T00:00:00.000Z",
        result: { status: "PASS" }
      }),
      transitionOperationToTerminal(root, record.id, {
        status: "CANCELLED",
        phase: "cancelled",
        finishedAt: "2026-08-13T00:00:01.000Z"
      })
    ]);

    expect([success.transitioned, cancellation.transitioned].sort()).toEqual([false, true]);
    const current = await loadOperation(root, record.id);
    expect(["SUCCEEDED", "CANCELLED"]).toContain(current.status);
    expect(success.record.status).toBe(current.status);
    expect(cancellation.record.status).toBe(current.status);
  });

  it("does not let late phase/final patches resurrect a cancelled operation", async () => {
    const root = await tempRoot();
    const record = await seed(root, {
      status: "CANCELLED",
      phase: "cancelled",
      finishedAt: "2026-08-12T21:00:00.000Z"
    });
    await patchOperation(root, record.id, {
      status: "SUCCEEDED",
      phase: "finished",
      result: { status: "PASS" }
    });
    await patchOperation(root, record.id, { phase: "review" });
    const current = await loadOperation(root, record.id);
    expect(current.status).toBe("CANCELLED");
    expect(current.phase).toBe("cancelled");
    expect(current.finishedAt).toBe("2026-08-12T21:00:00.000Z");
  });

  it("cancels registered agents without requiring a Paseo list discovery", async () => {
    const root = await tempRoot();
    const record = await seed(root, {
      status: "RUNNING",
      phase: "review",
      agents: [
        {
          id: "reviewer-1",
          role: "security-reviewer",
          transport: "sdk",
          registeredAt: new Date().toISOString()
        },
        {
          id: "reviewer-2",
          role: "architecture-reviewer",
          transport: "sdk",
          registeredAt: new Date().toISOString()
        }
      ]
    });
    const run = vi.fn(async (command: string) => {
      if (command === "paseo stop 'reviewer-1'" || command === "paseo stop 'reviewer-2'") {
        return { exitCode: 0, stdout: "stopped", stderr: "", durationMs: 1 };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const trace = vi.fn(async () => undefined);

    const cancelled = await cancelOperation(root, record.id, {
      run: run as never,
      trace: trace as never
    });
    expect(cancelled.status).toBe("CANCELLED");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.some(([command]) => String(command).includes("paseo ls"))).toBe(false);
    expect(trace).toHaveBeenCalledWith(
      root,
      "cleanup.discovery",
      expect.objectContaining({ source: "operation-state", agentCount: 2 })
    );
  });

  it("starts a detached controller process and records its pid", async () => {
    const root = await tempRoot();
    const unref = vi.fn();
    const spawnProcess = vi.fn(() => ({ pid: 4242, unref }));
    const record = await startDetachedOperation(
      root,
      "audit",
      { request: "review" },
      {
        nodeExecutable: "/usr/bin/node",
        entryFile: "/pkg/dist/main.js",
        spawnProcess: spawnProcess as never
      }
    );
    expect(record).toEqual(
      expect.objectContaining({
        kind: "audit",
        status: "QUEUED",
        phase: "dispatched",
        pid: 4242
      })
    );
    expect(spawnProcess).toHaveBeenCalledWith(
      "/usr/bin/node",
      ["/pkg/dist/main.js", "operation", "execute", record.id, root],
      expect.objectContaining({ detached: true, stdio: "ignore" })
    );
    expect(unref).toHaveBeenCalledTimes(1);
    expect((await loadOperation(root, record.id)).pid).toBe(4242);
  });

  it("extracts workspace ids from nested Paseo JSON", () => {
    expect(
      extractWorkspaceId(
        JSON.stringify({
          requestId: "x",
          workspace: { id: "workspace-abc", cwd: "/repo" }
        })
      )
    ).toBe("workspace-abc");
  });

  it("creates stable-shaped operation ids", () => {
    expect(createOperationId("audit", "same-seed")).toMatch(
      /^AUDIT-\d{8}T\d{6}Z-[a-f0-9]{8}$/
    );
  });
});
