import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  operationWorkspaceTitle,
  reconcileOperationResources,
  reconcileTerminalOperationResources,
  selectOwnedWorkspaces
} from "../src/runtime/operationResources.js";
import { loadOperation, type OperationRecordV2 } from "../src/operations/state.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-workspace-discovery-"));
  roots.push(root);
  await fs.mkdir(path.join(root, ".harness"), { recursive: true });
  return root;
}

function baseRecord(root: string, id: string, status: OperationRecordV2["status"]): OperationRecordV2 {
  const now = new Date().toISOString();
  return {
    version: 2,
    id,
    kind: "audit",
    status,
    phase: status === "QUEUED" ? "queued" : "finished",
    root,
    payload: { request: "workspace discovery" },
    revision: 1,
    operationExecutionRevision: 1,
    createdAt: now,
    updatedAt: now,
    lastProgressAt: now,
    ...(status === "QUEUED" ? {} : { finishedAt: now }),
    intent: { classification: "AUDIT" },
    supervision: { required: false, materialized: false, generations: [] },
    stages: {},
    participants: {},
    progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 }
  };
}

/** Terminal op with zero durable ownership: the crash-window shape (create succeeded, record/registry writes never landed). */
async function forceSurfacelessTerminal(root: string, id: string): Promise<OperationRecordV2> {
  await fs.mkdir(path.join(root, ".harness", "operations"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".harness", "operations", `${id}.json`),
    `${JSON.stringify(baseRecord(root, id, "FAILED"), null, 2)}\n`,
    "utf8"
  );
  return loadOperation(root, id);
}

const passThroughDeps = () => ({
  archiveWorkspace: vi.fn(async (_root: string, _workspaceId: string) => undefined),
  archiveAgent: vi.fn(async (_root: string, _agentId: string) => undefined),
  inspectAgent: vi.fn(async (_root: string, _agentId: string) => ({ status: "idle" })),
  terminateProcess: vi.fn(async (_pid: number) => undefined),
  removeStagingRoot: vi.fn(async (_target: string) => undefined),
  listOwnedAgents: vi.fn(async (_root: string, _operationId: string) => [] as Array<{ id?: string; workspaceId?: string }>),
  listOwnedWorkspaces: vi.fn(async (_root: string) => [] as Array<{ workspaceId: string; title?: string; path?: string }>)
});

describe("operation workspace title discovery (E-NEW-3)", () => {
  it("recovers a worktree orphaned between workspace create and durable registration", async () => {
    const root = await makeRoot();
    const id = "AUDIT-E3";
    await forceSurfacelessTerminal(root, id);
    const deps = passThroughDeps();
    deps.listOwnedWorkspaces.mockResolvedValue([
      { workspaceId: "wks-orphan", title: operationWorkspaceTitle("audit", id), path: path.join(root, "wt-orphan") }
    ]);

    const receipt = await reconcileOperationResources(root, id, deps);

    expect(deps.archiveWorkspace).toHaveBeenCalledWith(root, "wks-orphan");
    expect(receipt.cleanupComplete).toBe(true);
    expect(receipt.dispositions.some((item) => item.kind === "paseo-workspace" && item.identity === "wks-orphan" && item.outcome === "reconciled")).toBe(true);
  });

  it("never claims a sibling operation workspace", async () => {
    const root = await makeRoot();
    const id = "AUDIT-E3";
    await forceSurfacelessTerminal(root, id);
    const deps = passThroughDeps();
    deps.listOwnedWorkspaces.mockResolvedValue([
      { workspaceId: "wks-orphan", title: operationWorkspaceTitle("audit", id) },
      { workspaceId: "wks-sibling", title: operationWorkspaceTitle("audit", "AUDIT-E3-SIBLING") },
      { workspaceId: "wks-unrelated", title: "some developer scratch" }
    ]);

    await reconcileOperationResources(root, id, deps);

    expect(deps.archiveWorkspace).toHaveBeenCalledTimes(1);
    expect(deps.archiveWorkspace).toHaveBeenCalledWith(root, "wks-orphan");
  });

  it("the terminal sweep discovers a surfaceless operation's orphaned worktree", async () => {
    const root = await makeRoot();
    const id = "AUDIT-E3-SWEEP";
    await forceSurfacelessTerminal(root, id);
    const deps = passThroughDeps();
    deps.listOwnedWorkspaces.mockResolvedValue([
      { workspaceId: "wks-sweep-orphan", title: operationWorkspaceTitle("audit", id) }
    ]);

    const sweep = await reconcileTerminalOperationResources(root, deps);

    expect(deps.archiveWorkspace).toHaveBeenCalledWith(root, "wks-sweep-orphan");
    expect(sweep.terminalOperationsReconciled).toBe(1);
    expect(sweep.failures).toEqual([]);
  });

  it("matches only the exact minted title, never a sibling id prefix", () => {
    const listed = [
      { workspaceId: "wks-exact", title: "AEH AUDIT · AUDIT-E3" },
      { workspaceId: "wks-prefix", title: "AEH AUDIT · AUDIT-E3-SIBLING" },
      { workspaceId: "wks-substring", title: "AEH AUDIT · XAUDIT-E3" },
      { workspaceId: "wks-other-kind", title: "AEH CHANGE · AUDIT-E3" },
      { workspaceId: "wks-untitled" }
    ];
    expect(selectOwnedWorkspaces(listed, "audit", "AUDIT-E3").map((ws) => ws.workspaceId)).toEqual(["wks-exact"]);
  });
});
