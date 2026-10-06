import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import { cancelOperation } from "../src/operations/controller.js";
import {
  buildCancellationPidSet,
  findDescendantProcessIds
} from "../src/operations/controller.js";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { HumanDecisionLedgerV2 } from "../src/security/humanDecision.js";
import {
  bindResolvedOperationPolicy,
  currentControllerEpoch,
  loadOperation,
  patchOperation,
  type OperationRecordV2
} from "../src/operations/state.js";

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
  }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-cancel-pid-scope-"));
  roots.push(root);
  return root;
}

function operation(root: string, id: string): OperationRecordV2 {
  const now = new Date().toISOString();
  return {
    version: 2,
    id,
    kind: "audit",
    status: "RUNNING",
    phase: "reviewing",
    root,
    payload: { request: "cancellation pid scope" },
    revision: 1,
    createdAt: now,
    updatedAt: now,
    lastProgressAt: now,
    supervision: { required: false, materialized: false, generations: [] },
    stages: {},
    participants: {},
    progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 }
  };
}

async function bindCancellationDecision(root: string, operationId: string, actorId: string): Promise<void> {
  const current = await loadOperation(root, operationId);
  const candidate = current.candidateRevision!;
  const policy = compileResolvedOperationPolicy({
    projectId: candidate.projectId!, operationId,
    operationExecutionRevision: current.operationExecutionRevision!,
    candidateRevision: candidate.revision,
    candidateDigest: candidate.identityDigest,
    controllerEpoch: currentControllerEpoch(current),
    intent: "cancellation pid scope test", route: "DIRECT", minimumAssurance: "STANDARD",
    policyVersions: { resolvedOperationPolicy: "2" }, policyDigests: {}, validationPolicy: {}, reviewPolicy: {}, deliveryPolicy: {}, knowledgePolicy: {}, contextPolicy: {},
    allowedExternalEffects: [], humanDecisionRequirements: []
  });
  const bound = await bindResolvedOperationPolicy(root, operationId, policy);
  const ledger = new HumanDecisionLedgerV2(path.join(root, ".harness", "security", "human-decisions.json"));
  await ledger.record({
    operationId, candidate, operationExecutionRevision: bound.operationExecutionRevision!, policyDigest: policy.digest,
    controllerEpoch: currentControllerEpoch(bound), purpose: { kind: "OPERATION_CONTROL", command: "CANCEL" }, kind: "CANCEL",
    actorId, reason: "explicit cancellation pid-scope test request", createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000)
  });
}

function spawnSleeper(cwd: string): ChildProcess {
  const child = spawn("sleep", ["60"], { cwd, detached: true, stdio: "ignore" });
  child.unref();
  children.push(child);
  return child;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

describe("cancellation pid scope (A-NEW-4)", () => {
  it("does not signal a live process that merely shares the control-root cwd", async () => {
    const root = await tempRoot();
    const id = "CANCEL-PID-SCOPE";
    await saveOwnedOperation(root, operation(root, id));
    await bindCancellationDecision(root, id, "human:pid-scope-test");
    const owned = spawnSleeper(root);
    const sibling = spawnSleeper(root);
    expect(owned.pid).toBeDefined();
    expect(sibling.pid).toBeDefined();
    // Only the owned sleeper is the operation controller pid; the sibling is a
    // live foreign process whose only link is cwd === control root (the shape
    // of a sibling operation's controller/worker sharing the control root).
    await patchOperation(root, id, { pid: owned.pid! });

    const run = vi.fn(async () => ({ exitCode: 0, stdout: "stopped", stderr: "", durationMs: 1 }));
    await cancelOperation(root, id, {
      run: run as never,
      trace: vi.fn(async () => undefined) as never,
      humanActorId: "human:pid-scope-test"
    });

    expect((await loadOperation(root, id)).status).toBe("CANCELLED");
    expect(alive(owned.pid!)).toBe(false);
    expect(alive(sibling.pid!)).toBe(true);
  }, 30_000);

  it("restricts the cwd heuristic to managed-handle pids of this operation", async () => {
    const rootPid = 1000;
    const descendant = 1001;
    const outsider = 2001;
    const managed = 2002;
    const operationRoot = "/control/root";
    const stats: Record<number, number> = { [rootPid]: 1, [descendant]: rootPid, [outsider]: 1, [managed]: 1 };
    const procfs = {
      readdir: async (_dir: string) => ["1", String(rootPid), String(descendant), String(outsider), String(managed)],
      readFile: async (file: string) => {
        const pid = Number(path.basename(path.dirname(file)));
        const ppid = stats[pid] ?? 1;
        return `proc (${pid}) S ${ppid} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 0`;
      },
      realpath: async (file: string) => {
        const pid = Number(path.basename(path.dirname(file)));
        if (pid === outsider || pid === managed) return operationRoot;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
    };
    const live = new Set([rootPid, descendant, outsider, managed]);
    const originalKill = process.kill;
    (process as { kill: typeof process.kill }).kill = ((pid: number, signal?: number | NodeJS.Signals) => {
      if ((signal === undefined || signal === 0) && !live.has(pid)) {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
      return true;
    }) as typeof process.kill;
    try {
      const found = await findDescendantProcessIds(rootPid, operationRoot, {
        allowedCwdPids: new Set([managed]),
        procfs
      });
      expect(found).toContain(descendant);
      expect(found).toContain(managed);
      expect(found).not.toContain(outsider);
    } finally {
      (process as { kill: typeof process.kill }).kill = originalKill;
    }
  });

  it("never signals a pid owned by another operation", () => {
    const siblingPid = 4242;
    const set = buildCancellationPidSet({
      managedPids: [siblingPid],
      descendantPids: [siblingPid, 4343],
      recordPid: 4343,
      siblingOwnedPids: new Set([siblingPid]),
      selfPid: process.pid
    });
    expect(set).not.toContain(siblingPid);
    expect(set).toContain(4343);
  });

  it("fails closed with zero signals when the sibling-ownership scan fails", async () => {
    const root = await tempRoot();
    const id = "CANCEL-PID-FENCE";
    await saveOwnedOperation(root, operation(root, id));
    await bindCancellationDecision(root, id, "human:pid-scope-test");
    const targetPid = 48881;
    await patchOperation(root, id, { pid: targetPid });

    const signals: number[] = [];
    const run = vi.fn(async () => ({ exitCode: 0, stdout: "stopped", stderr: "", durationMs: 1 }));
    await expect(cancelOperation(root, id, {
      run: run as never,
      trace: vi.fn(async () => undefined) as never,
      humanActorId: "human:pid-scope-test",
      listSiblingOwnedProcessIds: async () => { throw new Error("EIO: sibling scan unavailable"); },
      terminateProcessGroup: async (pid: number) => { signals.push(pid); }
    })).rejects.toThrow(/AEH_CANCELLATION_FENCING_REQUIRED/);

    expect(signals).toEqual([]);
    expect((await loadOperation(root, id)).phase).toBe("cancellation-fencing-required");
  });

  it("does not signal a pid that became sibling-owned between scan and signal", async () => {
    const root = await tempRoot();
    const id = "CANCEL-PID-TOCTOU";
    await saveOwnedOperation(root, operation(root, id));
    await bindCancellationDecision(root, id, "human:pid-scope-test");
    const targetPid = 48882;
    await patchOperation(root, id, { pid: targetPid });

    // Scan-time snapshot is clean; at signal time the pid is sibling-owned
    // (pid reuse after the scan). The kill-time recheck must refuse to signal.
    let calls = 0;
    const signals: number[] = [];
    const run = vi.fn(async () => ({ exitCode: 0, stdout: "stopped", stderr: "", durationMs: 1 }));
    await expect(cancelOperation(root, id, {
      run: run as never,
      trace: vi.fn(async () => undefined) as never,
      humanActorId: "human:pid-scope-test",
      listSiblingOwnedProcessIds: async () => {
        calls += 1;
        return calls === 1 ? new Set<number>() : new Set<number>([targetPid]);
      },
      terminateProcessGroup: async (pid: number) => { signals.push(pid); }
    })).rejects.toThrow(/AEH_CANCELLATION_FENCING_REQUIRED/);

    expect(signals).not.toContain(targetPid);
    expect(signals).toEqual([]);
  });
});
