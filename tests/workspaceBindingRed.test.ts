import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultListOwnedWorkspaces,
  operationWorkspaceName,
  operationWorkspaceTitle,
  readOperationWorkspaceIntent,
  reconcileOperationResources,
  selectTripleBoundWorkspaces,
  upgradeOperationWorkspaceIntent,
  writeOperationWorkspaceIntent,
} from "../src/runtime/operationResources.js";
import { loadOperation, type OperationRecordV2 } from "../src/operations/state.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-wsbind-red-"));
  roots.push(root);
  await fs.mkdir(path.join(root, ".harness"), { recursive: true });
  return root;
}

function baseRecord(root: string, id: string, status: OperationRecordV2["status"]): OperationRecordV2 {
  const now = new Date().toISOString();
  return {
    version: 2, id, kind: "audit", status,
    phase: status === "QUEUED" ? "queued" : status === "RUNNING" ? "reviewing" : "finished",
    root, payload: { request: "red" }, revision: 1, operationExecutionRevision: 1,
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

describe("RED workspace binding", () => {
  it("B1: forge/race duplicate with same title+slug is NOT both accepted (ID decisive)", async () => {
    const root = await makeRoot();
    const id = "AUDIT-RED-B1";
    const record = await forceTerminal(root, id);
    await writeOperationWorkspaceIntent(root, id, { kind: "audit", title: operationWorkspaceTitle("audit", id), name: operationWorkspaceName("audit", id) });
    await upgradeOperationWorkspaceIntent(root, id, { workspaceId: "wks-mine", workspaceRoot: root });
    const title = operationWorkspaceTitle("audit", id);
    const slug = operationWorkspaceName("audit", id);
    const { paseoManagedWorktreesRoot } = await import("../src/runtime/operationResources.js");
    const listed = [
      { workspaceId: "wks-mine", title, path: path.join(paseoManagedWorktreesRoot(), slug) },
      { workspaceId: "wks-race", title, path: path.join(paseoManagedWorktreesRoot(), slug) },
    ];
    const deps = depsOf(listed);
    const selected = await selectTripleBoundWorkspaces(root, record, listed, deps);
    expect(selected.map((w) => w.workspaceId)).toEqual(["wks-mine"]);
  });

  it("B2: nonzero create MUST retain intent for recovery", async () => {
    const { ensureOperationWorkspace } = await import("../src/operations/controller.js");
    const { saveOperation, claimControllerEpoch, bindResolvedOperationPolicy } = await import("../src/operations/state.js");
    const { compileResolvedOperationPolicy } = await import("../src/architecture/executionIdentity.js");
    const { currentControllerEpoch } = await import("../src/operations/state.js");
    const root = await makeRoot();
    const id = "AUDIT-RED-B2";
    process.env.AEH_OPERATION_ID = id;
    process.env.AEH_CONTROL_ROOT = root;
    process.env.AEH_OPERATION_STATE_REDIRECT = "1";
    try {
      await saveOperation(root, { version: 1, id, kind: "audit", status: "RUNNING", phase: "reviewing", root, payload: { request: "b2" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as never);
      const withCandidate = await loadOperation(root, id);
      const owned = await claimControllerEpoch(root, id, `controller:${id}`, { pid: process.pid });
      const candidate = (await loadOperation(root, id)).candidateRevision!;
      const policy = compileResolvedOperationPolicy({
        projectId: candidate.projectId!, operationId: id,
        operationExecutionRevision: owned.operationExecutionRevision!, candidateRevision: candidate.revision,
        candidateDigest: candidate.identityDigest, controllerEpoch: currentControllerEpoch(owned),
        intent: "red b2", route: "DIRECT", minimumAssurance: "STANDARD",
        policyVersions: {}, policyDigests: {}, validationPolicy: {}, reviewPolicy: {},
        deliveryPolicy: { allowedActions: [] }, knowledgePolicy: {}, contextPolicy: {},
        allowedExternalEffects: [], humanDecisionRequirements: [],
      });
      await bindResolvedOperationPolicy(root, id, policy);
      const record = await loadOperation(root, id);
      const run = vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "boom", durationMs: 1 }));
      const trace = vi.fn(async () => undefined) as never;
      const config = { project: { name: "red" } } as never;
      await ensureOperationWorkspace(root, record, config, run as never, trace).catch(() => undefined);
      const intent = await readOperationWorkspaceIntent(root, id);
      expect(intent, "intent must survive nonzero create so the orphan stays discoverable").toBeDefined();
    } finally {
      delete process.env.AEH_OPERATION_ID;
      delete process.env.AEH_CONTROL_ROOT;
      delete process.env.AEH_OPERATION_STATE_REDIRECT;
      delete process.env.AEH_CONTROLLER_EPOCH;
      delete process.env.AEH_CONTROLLER_TOKEN;
    }
  });

  it("B3: listing failure MUST surface incomplete sweep, never []", async () => {
    const failingRun = vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "ls failed", durationMs: 1 }));
    await expect(defaultListOwnedWorkspaces(failingRun as never)("root")).rejects.toThrow(/INCOMPLETE_SWEEP|SWEEP_INCOMPLETE/);
    const root = await makeRoot();
    const id = "AUDIT-RED-B3";
    await forceTerminal(root, id);
    await writeOperationWorkspaceIntent(root, id, { kind: "audit", title: operationWorkspaceTitle("audit", id), name: operationWorkspaceName("audit", id) });
    const deps = depsOf([]);
    deps.listOwnedWorkspaces.mockRejectedValue(new Error("AEH_WORKSPACE_SWEEP_INCOMPLETE: list failed"));
    const { reconcileTerminalOperationResources } = await import("../src/runtime/operationResources.js");
    const sweep = await reconcileTerminalOperationResources(root, deps);
    expect(sweep.failures.length).toBeGreaterThan(0);
    expect(sweep.terminalOperationsCurrent).toBe(0);
  });
});
