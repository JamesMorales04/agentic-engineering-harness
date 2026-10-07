import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_SWEEP_INCOMPLETE_CODE,
  WorkspaceSweepIncompleteError,
  defaultListOwnedWorkspaces,
  isWorkspaceSweepIncompleteError,
  isWorkspaceSweepIncompleteFailure,
} from "../src/runtime/operationResources.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  vi.restoreAllMocks();
});

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-wsbind-r4-"));
  roots.push(root);
  await fs.mkdir(path.join(root, ".harness"), { recursive: true });
  return root;
}

describe("ROUND4 workspace binding S1 structured gating (Luna blocker)", () => {
  it("S1-structured-thrown: crafted non-workspace error containing the marker text must NOT block startup", async () => {
    const resources = await import("../src/runtime/operationResources.js");
    const spy = vi.spyOn(resources, "reconcileTerminalOperationResources").mockRejectedValueOnce(
      new Error("RESOURCE_CLEANUP_FAILED: agent archive transport blew up; unrelated log line AEH_WORKSPACE_SWEEP_INCOMPLETE seen in user output")
    );
    const { startDetachedOperation } = await import("../src/operations/controller.js");
    const root = await makeRoot();
    const spawnProcess = vi.fn(() => ({ pid: 4242, unref: vi.fn() })) as never;
    try {
      const record = await startDetachedOperation(root, "audit", { request: "r4 over-match thrown" }, {
        nodeExecutable: "/usr/bin/node",
        entryFile: "/pkg/dist/main.js",
        spawnProcess,
      });
      expect(record.id).toBeTruthy();
      expect(spawnProcess, "over-match thrown error must not block startup").toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("S1-structured-failures: crafted non-workspace sweep failure containing the marker text (no code) must NOT block startup", async () => {
    const resources = await import("../src/runtime/operationResources.js");
    const spy = vi.spyOn(resources, "reconcileTerminalOperationResources").mockResolvedValueOnce({
      version: 1,
      sweptAt: new Date().toISOString(),
      operationsScanned: 1,
      terminalOperationsReconciled: 0,
      terminalOperationsCurrent: 0,
      liveOperationsPreserved: 0,
      failures: [{ operationId: "AUDIT-OLD", error: "agent archive failed; embedded AEH_WORKSPACE_SWEEP_INCOMPLETE from unrelated log" }],
    } as never);
    const { startDetachedOperation } = await import("../src/operations/controller.js");
    const root = await makeRoot();
    const spawnProcess = vi.fn(() => ({ pid: 4242, unref: vi.fn() })) as never;
    try {
      const record = await startDetachedOperation(root, "audit", { request: "r4 over-match failures" }, {
        nodeExecutable: "/usr/bin/node",
        entryFile: "/pkg/dist/main.js",
        spawnProcess,
      });
      expect(record.id).toBeTruthy();
      expect(spawnProcess, "over-match sweep failure without code must not block startup").toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("S1-structured-genuine-thrown: genuine workspace-listing INCOMPLETE (coded class) must still block startup", async () => {
    const resources = await import("../src/runtime/operationResources.js");
    const spy = vi.spyOn(resources, "reconcileTerminalOperationResources").mockRejectedValueOnce(
      new WorkspaceSweepIncompleteError("workspace listing transport failed: boom")
    );
    const { startDetachedOperation } = await import("../src/operations/controller.js");
    const root = await makeRoot();
    const spawnProcess = vi.fn(() => ({ pid: 4242, unref: vi.fn() })) as never;
    try {
      const error = await startDetachedOperation(root, "audit", { request: "r4 genuine thrown" }, {
        nodeExecutable: "/usr/bin/node",
        entryFile: "/pkg/dist/main.js",
        spawnProcess,
      }).then(() => undefined, (caught) => caught);
      expect(error, "genuine INCOMPLETE must still block startup").toBeDefined();
      expect(isWorkspaceSweepIncompleteError(error), "thrown startup block must carry the structured classification").toBe(true);
      expect(String((error as Error).message)).toMatch(/AEH_WORKSPACE_SWEEP_INCOMPLETE/);
      expect(spawnProcess).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("S1-structured-genuine-failures: genuine workspace-listing INCOMPLETE sweep failure (code field) must still block startup", async () => {
    const resources = await import("../src/runtime/operationResources.js");
    const spy = vi.spyOn(resources, "reconcileTerminalOperationResources").mockResolvedValueOnce({
      version: 1,
      sweptAt: new Date().toISOString(),
      operationsScanned: 1,
      terminalOperationsReconciled: 0,
      terminalOperationsCurrent: 0,
      liveOperationsPreserved: 0,
      failures: [{ operationId: "AUDIT-OLD", error: `${WORKSPACE_SWEEP_INCOMPLETE_CODE}: workspace listing transport failed: boom`, code: WORKSPACE_SWEEP_INCOMPLETE_CODE }],
    } as never);
    const { startDetachedOperation } = await import("../src/operations/controller.js");
    const root = await makeRoot();
    const spawnProcess = vi.fn(() => ({ pid: 4242, unref: vi.fn() })) as never;
    try {
      const error = await startDetachedOperation(root, "audit", { request: "r4 genuine failures" }, {
        nodeExecutable: "/usr/bin/node",
        entryFile: "/pkg/dist/main.js",
        spawnProcess,
      }).then(() => undefined, (caught) => caught);
      expect(error, "genuine coded sweep failure must still block startup").toBeDefined();
      expect(isWorkspaceSweepIncompleteError(error), "sweep-failure startup block must carry the structured classification").toBe(true);
      expect(String((error as Error).message)).toMatch(/AEH_WORKSPACE_SWEEP_INCOMPLETE/);
      expect(spawnProcess).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("S1-structured-producer: defaultListOwnedWorkspaces throws ONLY the coded class (never a bare substring)", async () => {
    const failingRun = vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "ls failed", durationMs: 1 }));
    const error = await defaultListOwnedWorkspaces(failingRun as never)("root").then(() => undefined, (caught) => caught);
    expect(error).toBeInstanceOf(WorkspaceSweepIncompleteError);
    expect(isWorkspaceSweepIncompleteError(error)).toBe(true);
    expect((error as WorkspaceSweepIncompleteError).code).toBe(WORKSPACE_SWEEP_INCOMPLETE_CODE);
    // The marker stays in the message for observability, but gating never reads it.
    expect(String((error as Error).message)).toMatch(/AEH_WORKSPACE_SWEEP_INCOMPLETE/);
    expect(isWorkspaceSweepIncompleteFailure({ code: (error as WorkspaceSweepIncompleteError).code })).toBe(true);
    expect(isWorkspaceSweepIncompleteFailure({})).toBe(false);
    expect(isWorkspaceSweepIncompleteError(new Error("unrelated AEH_WORKSPACE_SWEEP_INCOMPLETE embedding"))).toBe(false);
  });
});
