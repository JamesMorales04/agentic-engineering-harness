import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  operationWorkspaceBinding,
  operationWorkspaceName,
  operationWorkspaceTitle,
  paseoManagedWorktreesRoot,
  reconcileOperationResources,
  reconcileTerminalOperationResources,
  selectOwnedWorkspaces,
  upgradeOperationWorkspaceIntent,
  writeOperationWorkspaceIntent
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
    phase: status === "QUEUED" ? "queued" : status === "RUNNING" ? "reviewing" : "finished",
    root,
    payload: { request: "workspace discovery" },
    revision: 1,
    operationExecutionRevision: 1,
    createdAt: now,
    updatedAt: now,
    lastProgressAt: now,
    ...(status === "QUEUED" || status === "RUNNING" ? {} : { finishedAt: now }),
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

async function forceLiveRunning(root: string, id: string): Promise<OperationRecordV2> {
  await fs.mkdir(path.join(root, ".harness", "operations"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".harness", "operations", `${id}.json`),
    `${JSON.stringify(baseRecord(root, id, "RUNNING"), null, 2)}\n`,
    "utf8"
  );
  return loadOperation(root, id);
}

/** Pre-register the deterministic create-started intent, as ensureOperationWorkspace does before the CLI create. */
async function writeIntent(root: string, kind: string, id: string): Promise<void> {
  await writeOperationWorkspaceIntent(root, id, {
    kind,
    title: operationWorkspaceTitle(kind, id),
    name: operationWorkspaceName(kind, id)
  });
}

/** Worktree-isolation orphan shape: cwd under the Paseo-managed worktrees root with the pre-registered slug leaf. */
function worktreeOrphanPath(kind: string, id: string): string {
  return path.join(paseoManagedWorktreesRoot(), operationWorkspaceName(kind, id));
}

const passThroughDeps = () => ({
  archiveWorkspace: vi.fn(async (_root: string, _workspaceId: string) => undefined),
  archiveAgent: vi.fn(async (_root: string, _agentId: string) => undefined),
  inspectAgent: vi.fn(async (_root: string, _agentId: string) => ({ status: "idle" })),
  terminateProcess: vi.fn(async (_pid: number) => undefined),
  removeStagingRoot: vi.fn(async (_target: string) => undefined),
  listOwnedAgents: vi.fn(async (_root: string, _operationId: string) => [] as Array<{ id?: string; workspaceId?: string }>),
  listOwnedWorkspaces: vi.fn(async (_root: string) => [] as Array<{ workspaceId: string; title?: string; path?: string }>),
  trace: vi.fn(async () => undefined) as never
});

describe("operation workspace title discovery (E-NEW-3)", () => {
  it("recovers a worktree orphaned between workspace create and durable registration", async () => {
    const root = await makeRoot();
    const id = "AUDIT-E3";
    await forceSurfacelessTerminal(root, id);
    // Crash-window orphan: ID recorded synchronously with the create receipt,
    // but the durable record/registry writes never landed (post-upgrade crash
    // is the only recoverable window; a pre-upgrade attempt without an ID is
    // UNKNOWN and never claimed).
    await writeIntent(root, "audit", id);
    await upgradeOperationWorkspaceIntent(root, id, { workspaceId: "wks-orphan", workspaceRoot: worktreeOrphanPath("audit", id) });
    const deps = passThroughDeps();
    deps.listOwnedWorkspaces.mockResolvedValue([
      { workspaceId: "wks-orphan", title: operationWorkspaceTitle("audit", id), path: worktreeOrphanPath("audit", id) }
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
    await writeIntent(root, "audit", id);
    await upgradeOperationWorkspaceIntent(root, id, { workspaceId: "wks-orphan", workspaceRoot: worktreeOrphanPath("audit", id) });
    const deps = passThroughDeps();
    deps.listOwnedWorkspaces.mockResolvedValue([
      { workspaceId: "wks-orphan", title: operationWorkspaceTitle("audit", id), path: worktreeOrphanPath("audit", id) },
      { workspaceId: "wks-sibling", title: operationWorkspaceTitle("audit", "AUDIT-E3-SIBLING"), path: worktreeOrphanPath("audit", "AUDIT-E3-SIBLING") },
      { workspaceId: "wks-unrelated", title: "some developer scratch", path: path.join(root, "scratch") }
    ]);

    await reconcileOperationResources(root, id, deps);

    expect(deps.archiveWorkspace).toHaveBeenCalledTimes(1);
    expect(deps.archiveWorkspace).toHaveBeenCalledWith(root, "wks-orphan");
  });

  it("the terminal sweep discovers a surfaceless operation's orphaned worktree", async () => {
    const root = await makeRoot();
    const id = "AUDIT-E3-SWEEP";
    await forceSurfacelessTerminal(root, id);
    await writeIntent(root, "audit", id);
    await upgradeOperationWorkspaceIntent(root, id, { workspaceId: "wks-sweep-orphan", workspaceRoot: root });
    const deps = passThroughDeps();
    deps.listOwnedWorkspaces.mockResolvedValue([
      { workspaceId: "wks-sweep-orphan", title: operationWorkspaceTitle("audit", id), path: root }
    ]);

    const sweep = await reconcileTerminalOperationResources(root, deps);

    expect(deps.archiveWorkspace).toHaveBeenCalledWith(root, "wks-sweep-orphan");
    expect(sweep.terminalOperationsReconciled).toBe(1);
    expect(sweep.failures).toEqual([]);
  });

  it("matches only the exact minted title, never a sibling id prefix", () => {
    const binding = operationWorkspaceBinding("audit", "AUDIT-E3", "/control/root");
    const listed = [
      { workspaceId: "wks-exact", title: "AEH AUDIT · AUDIT-E3", path: "/control/root" },
      { workspaceId: "wks-prefix", title: "AEH AUDIT · AUDIT-E3-SIBLING", path: "/control/root" },
      { workspaceId: "wks-substring", title: "AEH AUDIT · XAUDIT-E3", path: "/control/root" },
      { workspaceId: "wks-other-kind", title: "AEH CHANGE · AUDIT-E3", path: "/control/root" },
      { workspaceId: "wks-untitled", path: "/control/root" }
    ];
    expect(selectOwnedWorkspaces(listed, binding).map((ws) => ws.workspaceId)).toEqual(["wks-exact"]);
  });

  it("requires the name leaf and a managed cwd: title alone never claims", () => {
    const binding = operationWorkspaceBinding("audit", "AUDIT-E3", "/control/root");
    const listed = [
      // Title matches but the cwd leaf is not the pre-registered name.
      { workspaceId: "wks-leaf-mismatch", title: binding.title, path: "/control/root/wt-other" },
      // Title and leaf match but the cwd sits outside every managed root.
      { workspaceId: "wks-outside", title: binding.title, path: path.join(os.tmpdir(), binding.name) },
      // Title matches but no cwd at all.
      { workspaceId: "wks-pathless", title: binding.title },
      // Full triple: title + slug leaf + managed worktrees root.
      { workspaceId: "wks-worktree", title: binding.title, path: path.join(paseoManagedWorktreesRoot(), binding.name) }
    ];
    expect(selectOwnedWorkspaces(listed, binding).map((ws) => ws.workspaceId)).toEqual(["wks-worktree"]);
  });

  it("never claims a same-title workspace without a pre-registered intent", async () => {
    const root = await makeRoot();
    const id = "AUDIT-E3-NOINTENT";
    await forceSurfacelessTerminal(root, id);
    // No intent: a user-created or renamed same-title workspace must be ignored.
    const deps = passThroughDeps();
    deps.listOwnedWorkspaces.mockResolvedValue([
      { workspaceId: "wks-fake", title: operationWorkspaceTitle("audit", id), path: root }
    ]);

    await reconcileOperationResources(root, id, deps);

    expect(deps.archiveWorkspace).not.toHaveBeenCalled();
    expect(deps.trace).toHaveBeenCalledWith(
      root,
      "operation.workspace.discovery-ignored",
      expect.objectContaining({ operationId: id, reason: "title match without pre-registered workspace intent" })
    );
  });

  it("never claims a same-title workspace outside the managed roots even with an intent", async () => {
    const root = await makeRoot();
    const id = "AUDIT-E3-OUTSIDE";
    await forceSurfacelessTerminal(root, id);
    await writeIntent(root, "audit", id);
    const deps = passThroughDeps();
    deps.listOwnedWorkspaces.mockResolvedValue([
      {
        workspaceId: "wks-outside",
        title: operationWorkspaceTitle("audit", id),
        // Leaf matches the pre-registered name, but the cwd is outside every
        // managed root: 2-of-3 is ignored, never archived.
        path: path.join(os.tmpdir(), operationWorkspaceName("audit", id))
      }
    ]);

    await reconcileOperationResources(root, id, deps);

    expect(deps.archiveWorkspace).not.toHaveBeenCalled();
  });

  it("never claims a same-title workspace with a non-matching name leaf", async () => {
    const root = await makeRoot();
    const id = "AUDIT-E3-BADNAME";
    await forceSurfacelessTerminal(root, id);
    await writeIntent(root, "audit", id);
    const deps = passThroughDeps();
    deps.listOwnedWorkspaces.mockResolvedValue([
      {
        workspaceId: "wks-badname",
        title: operationWorkspaceTitle("audit", id),
        path: path.join(root, "user-renamed-checkout")
      }
    ]);

    await reconcileOperationResources(root, id, deps);

    expect(deps.archiveWorkspace).not.toHaveBeenCalled();
  });

  it("preserves a live operation's triple-bound workspace instead of archiving", async () => {
    const root = await makeRoot();
    const id = "AUDIT-E3-LIVE";
    await forceLiveRunning(root, id);
    await writeIntent(root, "audit", id);
    await upgradeOperationWorkspaceIntent(root, id, { workspaceId: "wks-live", workspaceRoot: root });
    const deps = passThroughDeps();
    deps.listOwnedWorkspaces.mockResolvedValue([
      { workspaceId: "wks-live", title: operationWorkspaceTitle("audit", id), path: root }
    ]);

    const receipt = await reconcileOperationResources(root, id, deps);

    expect(deps.archiveWorkspace).not.toHaveBeenCalled();
    expect(receipt.dispositions.some((item) => item.kind === "paseo-workspace" && item.identity === "wks-live" && item.outcome === "preserved-live")).toBe(true);
  });
});
