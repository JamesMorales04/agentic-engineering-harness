import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  operationWorkspaceName,
  operationWorkspaceTitle,
  readOperationWorkspaceIntent,
  selectTripleBoundWorkspaces,
  upgradeOperationWorkspaceIntent,
  writeOperationWorkspaceIntent,
} from "../src/runtime/operationResources.js";
import { loadOperation, type OperationRecordV2 } from "../src/operations/state.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  vi.restoreAllMocks();
});

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-wsbind-r3-"));
  roots.push(root);
  await fs.mkdir(path.join(root, ".harness"), { recursive: true });
  return root;
}

function baseRecord(root: string, id: string, status: OperationRecordV2["status"]): OperationRecordV2 {
  const now = new Date().toISOString();
  return {
    version: 2, id, kind: "audit", status,
    phase: status === "QUEUED" ? "queued" : status === "RUNNING" ? "reviewing" : "finished",
    root, payload: { request: "r3 red" }, revision: 1, operationExecutionRevision: 1,
    createdAt: now, updatedAt: now, lastProgressAt: now,
    ...(status === "QUEUED" || status === "RUNNING" ? {} : { finishedAt: now }),
    intent: { classification: "AUDIT" },
    supervision: { required: false, materialized: false, generations: [] },
    stages: {}, participants: {},
    progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 },
  };
}

async function forceTerminal(root: string, id: string): Promise<OperationRecordV2> {
  await fs.mkdir(path.join(root, ".harness", "operations"), { recursive: true });
  await fs.writeFile(path.join(root, ".harness", "operations", `${id}.json`), `${JSON.stringify(baseRecord(root, id, "FAILED"), null, 2)}\n`, "utf8");
  return loadOperation(root, id);
}

const depsOf = (list: Array<{ workspaceId: string; title?: string; path?: string }>) => ({
  archiveWorkspace: vi.fn(async () => undefined),
  archiveAgent: vi.fn(async () => undefined),
  inspectAgent: vi.fn(async () => ({ status: "idle" })),
  terminateProcess: vi.fn(async () => undefined),
  removeStagingRoot: vi.fn(async () => undefined),
  listOwnedAgents: vi.fn(async () => [] as Array<{ id?: string; workspaceId?: string }>),
  listOwnedWorkspaces: vi.fn(async () => list),
  trace: vi.fn(async () => undefined) as never,
});

describe("ROUND3 RED workspace binding (Luna R1/R2/S1)", () => {
  it("R1: exact ID present but triple-binding selection fails MUST retain intent (UNKNOWN, never clear, never fallback-match)", async () => {
    const root = await makeRoot();
    const id = "AUDIT-R3-R1";
    const record = await forceTerminal(root, id);
    await writeOperationWorkspaceIntent(root, id, { kind: "audit", title: operationWorkspaceTitle("audit", id), name: operationWorkspaceName("audit", id) });
    await upgradeOperationWorkspaceIntent(root, id, { workspaceId: "wks-mine", workspaceRoot: root });
    // Exact ID IS present in the exhaustive listing, but its title/path fails
    // the triple binding (renamed / moved). A decoy same-title/different-ID
    // workspace must never be fallback-matched either.
    const listed = [
      { workspaceId: "wks-mine", title: "user-renamed title", path: path.join(root, "user-renamed-checkout") },
      { workspaceId: "wks-decoy", title: operationWorkspaceTitle("audit", id), path: root },
    ];
    const deps = depsOf(listed);
    const selected = await selectTripleBoundWorkspaces(root, record, listed, deps);
    expect(selected, "R1: ID-present selection mismatch must claim nothing (no fallback)").toEqual([]);
    const intent = await readOperationWorkspaceIntent(root, id);
    expect(intent?.workspaceId, "R1: ID-present selection mismatch must RETAIN intent (UNKNOWN/retry)").toBe("wks-mine");
  });

  it("R2: no-ID intent + zero title matches MUST retain intent as UNKNOWN (never auto-clear)", async () => {
    const root = await makeRoot();
    const id = "AUDIT-R3-R2";
    const record = await forceTerminal(root, id);
    // ATTEMPT without the CLI-returned ID (crash in the upgrade window).
    await writeOperationWorkspaceIntent(root, id, { kind: "audit", title: operationWorkspaceTitle("audit", id), name: operationWorkspaceName("audit", id) });
    // Exhaustive listing with zero title matches: the unknown-ID workspace may
    // be renamed or title-less, so absence is NOT proven.
    const listed: Array<{ workspaceId: string; title?: string; path?: string }> = [];
    const deps = depsOf(listed);
    const selected = await selectTripleBoundWorkspaces(root, record, listed, deps);
    expect(selected).toEqual([]);
    const intent = await readOperationWorkspaceIntent(root, id);
    expect(intent, "R2: no-ID zero-title-matches must RETAIN intent as UNKNOWN (bounded leak, sweep-visible)").toBeDefined();
  });

  it("S1a: non-workspace sweep failures MUST NOT block startup (narrow to workspace-listing INCOMPLETE)", async () => {
    const resources = await import("../src/runtime/operationResources.js");
    const spy = vi.spyOn(resources, "reconcileTerminalOperationResources").mockResolvedValueOnce({
      version: 1,
      sweptAt: new Date().toISOString(),
      operationsScanned: 1,
      terminalOperationsReconciled: 0,
      terminalOperationsCurrent: 0,
      liveOperationsPreserved: 0,
      failures: [{ operationId: "AUDIT-OLD", error: "terminal orphaned resources remain" }],
    } as never);
    const { startDetachedOperation } = await import("../src/operations/controller.js");
    const root = await makeRoot();
    const spawnProcess = vi.fn(() => ({ pid: 4242, unref: vi.fn() })) as never;
    try {
      const record = await startDetachedOperation(root, "audit", { request: "s1a red" }, {
        nodeExecutable: "/usr/bin/node",
        entryFile: "/pkg/dist/main.js",
        spawnProcess,
      });
      expect(record.id).toBeTruthy();
      expect(spawnProcess, "S1a: non-workspace failures must retain prior behavior (warn, not block)").toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("S1b: non-workspace thrown reconciliation error MUST NOT block startup", async () => {
    const resources = await import("../src/runtime/operationResources.js");
    const spy = vi.spyOn(resources, "reconcileTerminalOperationResources").mockRejectedValueOnce(
      new Error("RESOURCE_CLEANUP_FAILED: agent archive transport blew up")
    );
    const { startDetachedOperation } = await import("../src/operations/controller.js");
    const root = await makeRoot();
    const spawnProcess = vi.fn(() => ({ pid: 4242, unref: vi.fn() })) as never;
    try {
      const record = await startDetachedOperation(root, "audit", { request: "s1b red" }, {
        nodeExecutable: "/usr/bin/node",
        entryFile: "/pkg/dist/main.js",
        spawnProcess,
      });
      expect(record.id).toBeTruthy();
      expect(spawnProcess, "S1b: non-workspace throw must not block startup").toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("S1c: workspace-listing INCOMPLETE sweep failures MUST still block startup", async () => {
    const resources = await import("../src/runtime/operationResources.js");
    const { WORKSPACE_SWEEP_INCOMPLETE_CODE, WorkspaceSweepIncompleteError } = await import("../src/runtime/operationResources.js");
    // Unforgeable provenance: genuine sweep failures carry the branded `cause`
    // (bare `{code}` without `cause` never blocks).
    const genuineCause = new WorkspaceSweepIncompleteError("workspace listing transport failed: boom");
    const spy = vi.spyOn(resources, "reconcileTerminalOperationResources").mockResolvedValueOnce({
      version: 1,
      sweptAt: new Date().toISOString(),
      operationsScanned: 1,
      terminalOperationsReconciled: 0,
      terminalOperationsCurrent: 0,
      liveOperationsPreserved: 0,
      failures: [{ operationId: "AUDIT-OLD", error: "AEH_WORKSPACE_SWEEP_INCOMPLETE: workspace listing transport failed: boom", code: WORKSPACE_SWEEP_INCOMPLETE_CODE, cause: genuineCause }],
    } as never);
    const { startDetachedOperation } = await import("../src/operations/controller.js");
    const root = await makeRoot();
    const spawnProcess = vi.fn(() => ({ pid: 4242, unref: vi.fn() })) as never;
    try {
      await expect(
        startDetachedOperation(root, "audit", { request: "s1c red" }, {
          nodeExecutable: "/usr/bin/node",
          entryFile: "/pkg/dist/main.js",
          spawnProcess,
        })
      ).rejects.toThrow(/AEH_WORKSPACE_SWEEP_INCOMPLETE/);
      expect(spawnProcess).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
