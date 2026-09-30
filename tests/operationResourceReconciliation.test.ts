import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isAehError } from "../src/core/errors.js";
import { sha256Utf8 } from "../src/core/digest.js";
import { createManagedRuntime } from "../src/runtime/managed.js";
import {
  DEFAULT_OPERATION_RESOURCE_POLICY,
  assertProviderSessionCapacity,
  listOperationResources,
  markOperationResourceReleased,
  operationResourcePolicy,
  operationResourceReceiptFile,
  operationResourceRegistryFile,
  readOperationResourceReceipt,
  reconcileOperationResources,
  reconcileTerminalOperationResources,
  registerOperationResource
} from "../src/runtime/operationResources.js";
import {
  claimControllerEpoch,
  loadOperation,
  patchOperation,
  saveOperation,
  transitionOperationToTerminal,
  type OperationRecordV2
} from "../src/operations/state.js";
import { executeOperation } from "../src/operations/controller.js";
import type { ProcessResult } from "../src/utils/process.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-resource-regression-"));
  roots.push(root);
  await fs.mkdir(path.join(root, ".harness"), { recursive: true });
  return root;
}

function baseRecord(root: string, id: string, status: OperationRecordV2["status"] = "QUEUED"): OperationRecordV2 {
  const now = new Date().toISOString();
  return {
    version: 2,
    id,
    kind: "audit",
    status,
    phase: status === "QUEUED" ? "queued" : "finished",
    root,
    payload: { request: "resource regression" },
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

async function forceTerminal(root: string, id: string, status: "SUCCEEDED" | "FAILED", overrides: Partial<OperationRecordV2> = {}): Promise<OperationRecordV2> {
  await fs.mkdir(path.join(root, ".harness", "operations"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".harness", "operations", `${id}.json`),
    `${JSON.stringify({ ...baseRecord(root, id, status), ...overrides }, null, 2)}\n`,
    "utf8"
  );
  return loadOperation(root, id);
}

function fakeRun(commands: string[]): typeof import("../src/utils/process.js").runShell {
  return (async (command: string) => {
    commands.push(command);
    return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 } satisfies ProcessResult;
  }) as unknown as typeof import("../src/utils/process.js").runShell;
}

const passThroughDeps = () => ({
  archiveWorkspace: vi.fn(async (_root: string, _workspaceId: string) => undefined),
  archiveAgent: vi.fn(async (_root: string, _agentId: string) => undefined),
  inspectAgent: vi.fn(async (_root: string, _agentId: string) => ({ status: "idle" })),
  terminateProcess: vi.fn(async (_pid: number) => undefined),
  removeStagingRoot: vi.fn(async (_target: string) => undefined),
  listOwnedAgents: vi.fn(async (_root: string, _operationId: string) => [] as Array<{ id?: string; workspaceId?: string }>)
});

describe("operation resource ownership and terminal/recovery reconciliation", () => {
  it("A. terminal operation + durably owned resources reconcile to released state with a receipt", async () => {
    const root = await makeRoot();
    const id = "AUDIT-A";
    await saveOperation(root, baseRecord(root, id));
    await claimControllerEpoch(root, id, "test-controller");
    await patchOperation(root, id, { status: "RUNNING", phase: "preparing" });
    await registerOperationResource(root, id, { kind: "paseo-workspace", identity: "workspace-a", path: path.join(root, "wt-a") });
    await registerOperationResource(root, id, { kind: "staging-root", identity: path.join(os.tmpdir(), "aeh-direct-test-a"), path: path.join(os.tmpdir(), "aeh-direct-test-a") });
    await transitionOperationToTerminal(root, id, { status: "SUCCEEDED", phase: "finished", finishedAt: new Date().toISOString() });

    const deps = passThroughDeps();
    const receipt = await reconcileOperationResources(root, id, deps);

    expect(receipt.operationTerminal).toBe(true);
    expect(receipt.cleanupComplete).toBe(true);
    expect(receipt.errors).toEqual([]);
    expect(deps.archiveWorkspace).toHaveBeenCalledWith(root, "workspace-a");
    expect(deps.removeStagingRoot).toHaveBeenCalledWith(path.join(os.tmpdir(), "aeh-direct-test-a"));
    const resources = await listOperationResources(root, id);
    expect(resources.map((resource) => resource.state).sort()).toEqual(["ARCHIVED", "REMOVED"]);
    expect(receipt.classification.terminalOrphans).toBe(2);
    expect(receipt.classification.liveOwned).toBe(0);
    const raw = JSON.parse(await fs.readFile(operationResourceReceiptFile(root, id), "utf8")) as { candidateDigest?: string; operationId: string };
    expect(raw.operationId).toBe(id);
    expect(raw.candidateDigest).toBe((await loadOperation(root, id)).candidateRevision?.identityDigest);
    expect((await readOperationResourceReceipt(root, id))?.cleanupComplete).toBe(true);
  });

  it("B. live/non-terminal operation resources are preserved untouched", async () => {
    const root = await makeRoot();
    const id = "AUDIT-B";
    await saveOperation(root, baseRecord(root, id));
    await claimControllerEpoch(root, id, "test-controller");
    await patchOperation(root, id, { status: "RUNNING", phase: "preparing" });
    await registerOperationResource(root, id, { kind: "paseo-workspace", identity: "workspace-b", path: path.join(root, "wt-b") });

    const deps = passThroughDeps();
    const receipt = await reconcileOperationResources(root, id, deps);

    expect(receipt.operationTerminal).toBe(false);
    expect(receipt.classification.liveOwned).toBe(1);
    expect(receipt.cleanupComplete).toBe(false);
    expect(deps.archiveWorkspace).not.toHaveBeenCalled();
    const resources = await listOperationResources(root, id);
    expect(resources[0]?.state).toBe("OWNED");
  });

  it("C. unknown/unowned or shared resources are preserved and reported", async () => {
    const root = await makeRoot();
    const id = "AUDIT-C";
    await forceTerminal(root, id, "FAILED", { workspaceId: "workspace-c", workspaceRoot: path.join(root, "wt-c") });
    await registerOperationResource(root, id, { kind: "paseo-workspace", identity: "workspace-c", path: path.join(root, "wt-c"), reclaim: "RETAIN_SHARED" });
    await registerOperationResource(root, id, { kind: "staging-root", identity: path.join(os.tmpdir(), "aeh-unowned-c"), path: path.join(os.tmpdir(), "aeh-unowned-c"), reclaim: "RETAIN_SHARED" });

    const deps = passThroughDeps();
    const receipt = await reconcileOperationResources(root, id, deps);

    expect(receipt.classification.unknownOrUnowned).toBeGreaterThanOrEqual(2);
    expect(deps.archiveWorkspace).not.toHaveBeenCalled();
    expect(deps.removeStagingRoot).not.toHaveBeenCalled();
    expect(receipt.dispositions.some((item) => item.outcome === "preserved-shared")).toBe(true);
  });

  it("D. crash/restart after terminalization but before cleanup reconciles through the restart entry", async () => {
    const root = await makeRoot();
    const id = "AUDIT-D";
    await forceTerminal(root, id, "FAILED", { workspaceId: "workspace-d", workspaceRoot: path.join(root, "wt-d"), workspaceDisposition: "OPERATION_OWNED" });
    const commands: string[] = [];
    await executeOperation(root, id, { run: fakeRun(commands), listOperationAgents: async () => [] });

    expect(commands.some((command) => command.includes("workspace archive") && command.includes("workspace-d"))).toBe(true);
    const receipt = await readOperationResourceReceipt(root, id);
    expect(receipt?.cleanupComplete).toBe(true);
    const resources = await listOperationResources(root, id);
    expect(resources.find((resource) => resource.identity === "workspace-d")?.state).toBe("ARCHIVED");

    // The project-level recovery sweep is also a no-op on an already-current receipt.
    const sweep = await reconcileTerminalOperationResources(root);
    expect(sweep.terminalOperationsCurrent).toBe(1);
    expect(sweep.failures).toEqual([]);
  });

  it("E. repeated reconciliation is idempotent and reports already-reconciled", async () => {
    const root = await makeRoot();
    const id = "AUDIT-E";
    await forceTerminal(root, id, "FAILED", { workspaceId: "workspace-e", workspaceRoot: path.join(root, "wt-e"), workspaceDisposition: "OPERATION_OWNED" });
    const first = passThroughDeps();
    await reconcileOperationResources(root, id, first);
    const second = passThroughDeps();
    const receipt = await reconcileOperationResources(root, id, second);

    expect(second.archiveWorkspace).not.toHaveBeenCalled();
    expect(receipt.cleanupComplete).toBe(true);
    expect(receipt.dispositions.every((item) => item.alreadyReconciled)).toBe(true);
  });

  it("F. resources owned by another operation are not reclaimed", async () => {
    const root = await makeRoot();
    const owner = "AUDIT-F-OWNER";
    const other = "AUDIT-F-OTHER";
    await forceTerminal(root, owner, "FAILED");
    await forceTerminal(root, other, "FAILED");
    await registerOperationResource(root, owner, { kind: "paseo-workspace", identity: "workspace-owner", path: path.join(root, "wt-owner") });
    await registerOperationResource(root, other, { kind: "paseo-workspace", identity: "workspace-other", path: path.join(root, "wt-other") });
    // A foreign entry injected into the owner registry is not ownership proof.
    const file = operationResourceRegistryFile(root, owner);
    const registry = JSON.parse(await fs.readFile(file, "utf8")) as { resources: Array<Record<string, unknown>> };
    registry.resources.push({ version: 1, resourceId: "resource:foreign", kind: "paseo-workspace", identity: "workspace-foreign", operationId: other, reclaim: "ARCHIVE_ON_TERMINAL", owner: { source: "controller-registration" }, createdAt: new Date().toISOString(), state: "OWNED" });
    await fs.writeFile(file, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

    const deps = passThroughDeps();
    const receipt = await reconcileOperationResources(root, owner, deps);
    expect(deps.archiveWorkspace).toHaveBeenCalledTimes(1);
    expect(deps.archiveWorkspace).toHaveBeenCalledWith(root, "workspace-owner");
    expect(receipt.dispositions.some((item) => item.identity === "workspace-foreign")).toBe(false);
    const otherResources = await listOperationResources(root, other);
    expect(otherResources[0]?.state).toBe("OWNED");
  });

  it("G. participant/provider resources bind to the correct owner and never touch the lead session", async () => {
    const root = await makeRoot();
    const id = "AUDIT-G";
    const lead = "lead-user-session";
    const participant = "participant:aaaaaaaaaaaaaaaa";
    await forceTerminal(root, id, "FAILED", {
      workspaceId: "workspace-g",
      workspaceRoot: path.join(root, "wt-g"),
      workspaceDisposition: "OPERATION_OWNED",
      lead: { agentId: lead, generation: 1, boundAt: new Date().toISOString(), acknowledgedRevision: 1 },
      agents: [
        { id: "agent-supervisor", role: "operation-supervisor", registeredAt: new Date().toISOString() },
        { id: lead, role: "Lead", registeredAt: new Date().toISOString() },
        { id: participant, role: "Implementer", registeredAt: new Date().toISOString() }
      ],
      participants: {
        [participant]: {
          id: participant,
          status: "COMPLETED",
          registeredAt: new Date().toISOString(),
          executionBinding: { runtime: { sessionId: "agent-participant-session" } } as never
        }
      }
    });
    const deps = passThroughDeps();
    const receipt = await reconcileOperationResources(root, id, deps);

    const archived = deps.archiveAgent.mock.calls.map((call) => call[1] as string).sort();
    expect(archived).toContain("agent-supervisor");
    expect(archived).toContain("agent-participant-session");
    expect(archived).not.toContain(lead);
    expect(archived).not.toContain(participant);
    expect(receipt.dispositions.filter((item) => item.kind === "paseo-agent").map((item) => item.identity).sort()).toEqual(["agent-participant-session", "agent-supervisor"]);
  });

  it("H. cleanup receipt is durable and binds the exact operation and resource identities", async () => {
    const root = await makeRoot();
    const id = "AUDIT-H";
    await forceTerminal(root, id, "FAILED", { workspaceId: "workspace-h", workspaceRoot: path.join(root, "wt-h"), workspaceDisposition: "OPERATION_OWNED" });
    await reconcileOperationResources(root, id, passThroughDeps());
    const raw = await fs.readFile(operationResourceReceiptFile(root, id));
    const receipt = JSON.parse(raw.toString("utf8")) as { operationId: string; dispositions: Array<{ identity: string }>; reconciledAt: string };
    expect(receipt.operationId).toBe(id);
    expect(receipt.dispositions[0]?.identity).toBe("workspace-h");
    expect(sha256Utf8(raw)).toMatch(/^[a-f0-9]{64}$/);
    const reloaded = await readOperationResourceReceipt(root, id);
    expect(reloaded?.operationId).toBe(id);
    expect(reloaded?.reconciledAt).toBe(receipt.reconciledAt);
  });

  it("I. policy ceilings are deterministic and cannot be widened by model-shaped input", async () => {
    const root = await makeRoot();
    const id = "AUDIT-I";
    await forceTerminal(root, id, "FAILED");
    const policy = { maxOwnedResourcesPerOperation: 2, maxConcurrentProviderSessionsPerOperation: 2 };
    await registerOperationResource(root, id, { kind: "staging-root", identity: path.join(os.tmpdir(), "aeh-i-1"), path: path.join(os.tmpdir(), "aeh-i-1") }, { policy });
    await registerOperationResource(root, id, { kind: "staging-root", identity: path.join(os.tmpdir(), "aeh-i-2"), path: path.join(os.tmpdir(), "aeh-i-2") }, { policy });
    let failure: unknown;
    try {
      await registerOperationResource(root, id, { kind: "staging-root", identity: path.join(os.tmpdir(), "aeh-i-3"), path: path.join(os.tmpdir(), "aeh-i-3"), ...({ modelClaim: "unlimited" } as object) }, { policy });
    } catch (error) { failure = error; }
    expect(isAehError(failure) && failure.code === "RESOURCE_CEILING_EXHAUSTED").toBe(true);

    // Policy comes only from frozen configuration, never from a model-shaped object.
    expect(operationResourcePolicy({ orchestration: { operations: { resources: { maxOwnedResourcesPerOperation: 2 } } } }).maxOwnedResourcesPerOperation).toBe(2);
    expect(operationResourcePolicy({ orchestration: { operations: { resources: { modelClaim: 999 } } } }).maxOwnedResourcesPerOperation).toBe(DEFAULT_OPERATION_RESOURCE_POLICY.maxOwnedResourcesPerOperation);

    // Provider session ceiling is enforced from the durable lease registry.
    const runtimeRoot = await makeRoot();
    const runtime = await createManagedRuntime({ root: runtimeRoot, ownerId: "test-runtime" });
    await runtime.acquireProviderLease({
      provider: "opencode",
      workspaceId: "workspace-i",
      mode: "write",
      lifecycle: { operationId: id, candidateDigest: "a".repeat(64), operationExecutionRevision: 1, policyDigest: "b".repeat(64), controllerTokenDigest: "c".repeat(64), controllerEpoch: 1, providerStatus: "ACTIVE" }
    });
    let sessionFailure: unknown;
    try { await assertProviderSessionCapacity(runtimeRoot, id, 1); } catch (error) { sessionFailure = error; }
    expect(isAehError(sessionFailure) && sessionFailure.code === "RESOURCE_CEILING_EXHAUSTED").toBe(true);
  });

  it("J. repeated terminal operations do not accumulate active owned resources", async () => {
    const root = await makeRoot();
    const deps = passThroughDeps();
    for (let index = 1; index <= 3; index += 1) {
      const id = `AUDIT-J-${index}`;
      await forceTerminal(root, id, "FAILED", { workspaceId: `workspace-j-${index}`, workspaceRoot: path.join(root, `wt-j-${index}`), workspaceDisposition: "OPERATION_OWNED" });
      const receipt = await reconcileOperationResources(root, id, deps);
      expect(receipt.cleanupComplete).toBe(true);
    }
    expect(deps.archiveWorkspace).toHaveBeenCalledTimes(3);
    let active = 0;
    for (let index = 1; index <= 3; index += 1) {
      active += (await listOperationResources(root, `AUDIT-J-${index}`)).filter((resource) => resource.state === "OWNED").length;
    }
    expect(active).toBe(0);
  });

  it("K. a failed release stays visible and a later retry reconciles it (no error hiding)", async () => {
    const root = await makeRoot();
    const id = "AUDIT-K";
    await forceTerminal(root, id, "FAILED", { workspaceId: "workspace-k", workspaceRoot: path.join(root, "wt-k"), workspaceDisposition: "OPERATION_OWNED" });
    const failing = { ...passThroughDeps(), archiveWorkspace: vi.fn(async () => { throw new Error("provider busy"); }) };
    const failed = await reconcileOperationResources(root, id, failing);
    expect(failed.cleanupComplete).toBe(false);
    expect(failed.errors).toHaveLength(1);
    expect(failed.dispositions[0]?.outcome).toBe("failed");
    expect((await listOperationResources(root, id))[0]?.state).toBe("OWNED");

    const retry = await reconcileOperationResources(root, id, passThroughDeps());
    expect(retry.cleanupComplete).toBe(true);
    expect((await listOperationResources(root, id))[0]?.state).toBe("ARCHIVED");
  });

  it("M. agent workspace is discovered through exact session inspection when no record surface carries it", async () => {
    const root = await makeRoot();
    const id = "AUDIT-M";
    await forceTerminal(root, id, "FAILED", {
      workspaceId: "workspace-m",
      workspaceRoot: path.join(root, "wt-m"),
      workspaceDisposition: "OPERATION_OWNED",
      agents: [{ id: "agent-m", role: "Reviewer", registeredAt: new Date().toISOString() }]
    });
    const deps = {
      ...passThroughDeps(),
      inspectAgent: vi.fn(async (_root: string, agentId: string) => agentId === "agent-m" ? { status: "idle", workspaceId: "workspace-agent-m" } : { status: "archived" })
    };
    const receipt = await reconcileOperationResources(root, id, deps);
    expect(deps.archiveWorkspace.mock.calls.map((call) => call[1] as string).sort()).toEqual(["workspace-agent-m", "workspace-m"]);
    expect(receipt.cleanupComplete).toBe(true);
    expect(receipt.dispositions.some((item) => item.kind === "paseo-workspace" && item.identity === "workspace-agent-m" && item.outcome === "reconciled")).toBe(true);
  });

  it("L. in-line released resources are marked durable and do not re-reconcile", async () => {
    const root = await makeRoot();
    const id = "AUDIT-L";
    await forceTerminal(root, id, "FAILED");
    const staging = await registerOperationResource(root, id, { kind: "staging-root", identity: path.join(os.tmpdir(), "aeh-l-1"), path: path.join(os.tmpdir(), "aeh-l-1") });
    await markOperationResourceReleased(root, id, staging.resourceId, { action: "staging.remove" });
    const deps = passThroughDeps();
    const receipt = await reconcileOperationResources(root, id, deps);
    expect(deps.removeStagingRoot).not.toHaveBeenCalled();
    expect(receipt.dispositions[0]?.alreadyReconciled).toBe(true);
  });
});
