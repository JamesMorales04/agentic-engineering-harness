import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  operationWorkspaceName,
  operationWorkspaceTitle,
  paseoManagedWorktreesRoot,
  readOperationWorkspaceIntent,
  selectTripleBoundWorkspaces,
  writeOperationWorkspaceIntent,
  upgradeOperationWorkspaceIntent,
} from "../src/runtime/operationResources.js";
import { loadOperation, type OperationRecordV2 } from "../src/operations/state.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  vi.restoreAllMocks();
});

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-wsbind-r2-"));
  roots.push(root);
  await fs.mkdir(path.join(root, ".harness"), { recursive: true });
  return root;
}

function baseRecord(root: string, id: string, status: OperationRecordV2["status"]): OperationRecordV2 {
  const now = new Date().toISOString();
  return {
    version: 2, id, kind: "audit", status,
    phase: status === "QUEUED" ? "queued" : status === "RUNNING" ? "reviewing" : "finished",
    root, payload: { request: "r2 red" }, revision: 1, operationExecutionRevision: 1,
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

describe("ROUND2 RED workspace binding (Luna re-review W1/W2/W3)", () => {
  it("W1: intent ATTEMPT without workspaceId MUST NOT fall back to title/name/path (UNKNOWN)", async () => {
    const root = await makeRoot();
    const id = "AUDIT-R2-W1";
    const record = await forceTerminal(root, id);
    // ATTEMPT exists (pre-registered before CLI create) but the CLI-returned
    // ID was never recorded (crash in the upgrade window).
    await writeOperationWorkspaceIntent(root, id, { kind: "audit", title: operationWorkspaceTitle("audit", id), name: operationWorkspaceName("audit", id) });
    const title = operationWorkspaceTitle("audit", id);
    const slug = operationWorkspaceName("audit", id);
    const listed = [
      { workspaceId: "wks-unknown", title, path: path.join(paseoManagedWorktreesRoot(), slug) },
    ];
    const deps = depsOf(listed);
    const selected = await selectTripleBoundWorkspaces(root, record, listed, deps);
    // Fail-closed: without the create-recorded ID nothing is claimable, even
    // though title+slug+managed-path all match. Requires exhaustive-listing
    // proof to declare absence; never a title fallback claim.
    expect(selected, "W1: intent without workspaceId must forbid title fallback").toEqual([]);
  });

  it("W2: exhaustive listing proving no match MUST clear the stale intent sidecar", async () => {
    const root = await makeRoot();
    const id = "AUDIT-R2-W2";
    const record = await forceTerminal(root, id);
    await writeOperationWorkspaceIntent(root, id, { kind: "audit", title: operationWorkspaceTitle("audit", id), name: operationWorkspaceName("audit", id) });
    await upgradeOperationWorkspaceIntent(root, id, { workspaceId: "wks-mine", workspaceRoot: root });
    // Exhaustive listing (throwing lister contract: success means complete)
    // proves the recorded ID is absent.
    const listed: Array<{ workspaceId: string; title?: string; path?: string }> = [];
    const deps = depsOf(listed);
    const selected = await selectTripleBoundWorkspaces(root, record, listed, deps);
    expect(selected).toEqual([]);
    const intent = await readOperationWorkspaceIntent(root, id);
    expect(intent, "W2: proven absence must clear the stale intent sidecar").toBeUndefined();
  });

  it("W3: startDetachedOperation MUST propagate preliminary reconciliation failures (coded error)", async () => {
    const resources = await import("../src/runtime/operationResources.js");
    const { WorkspaceSweepIncompleteError } = await import("../src/runtime/operationResources.js");
    const spy = vi.spyOn(resources, "reconcileTerminalOperationResources").mockRejectedValueOnce(
      new WorkspaceSweepIncompleteError("workspace listing transport failed: boom")
    );
    const { startDetachedOperation } = await import("../src/operations/controller.js");
    const root = await makeRoot();
    const spawnProcess = vi.fn(() => ({ pid: 4242, unref: vi.fn() })) as never;
    try {
      await expect(
        startDetachedOperation(root, "audit", { request: "w3 red" }, {
          nodeExecutable: "/usr/bin/node",
          entryFile: "/pkg/dist/main.js",
          spawnProcess,
        })
      ).rejects.toThrow(/AEH_[A-Z_]+/);
    } finally {
      spy.mockRestore();
    }
    // Startup must not have dispatched a controller when reconciliation is incomplete.
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});
