import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { spawnOperationMonitor } from "../src/operations/monitorProcess.js";
import { loadOperation, saveOperation, type OperationRecord } from "../src/operations/state.js";

describe("detached operation monitor", () => {
  it("records asynchronous monitor spawn errors without an unhandled child error", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-monitor-process-"));
    const operation: OperationRecord = {
      version: 1,
      id: "AUDIT-MONITOR-ERROR",
      kind: "audit",
      status: "RUNNING",
      phase: "executing",
      root,
      payload: { request: "review" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await saveOperation(root, operation);
    let onError: ((error: Error) => void) | undefined;
    const child = {
      pid: 5252,
      unref: vi.fn(),
      once: vi.fn((event: string, handler: (error: Error) => void) => {
        if (event === "error") onError = handler;
        return child;
      })
    };

    try {
      await spawnOperationMonitor(root, await loadOperation(root, operation.id), {
        nodeExecutable: "/usr/bin/node",
        entryFile: "/pkg/dist/main.js",
        spawnProcess: vi.fn(() => child) as never
      });
      onError?.(new Error("monitor EACCES"));
      await vi.waitFor(async () => expect((await loadOperation(root, operation.id)).cleanupWarnings).toContain("liveness monitor: monitor EACCES"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
