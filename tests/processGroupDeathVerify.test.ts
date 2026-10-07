import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import { cancelOperation } from "../src/operations/controller.js";
import { verifyProcessExit } from "../src/utils/process.js";
import { stopProcess } from "../src/workers/runtimeSessions.js";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { HumanDecisionLedgerV2 } from "../src/security/humanDecision.js";
import {
  bindResolvedOperationPolicy,
  currentControllerEpoch,
  loadOperation,
  patchOperation,
  type OperationRecordV2
} from "../src/operations/state.js";

// RED (Luna B1/B2): termination signals the whole process GROUP, but death
// verification and cancellation waits probe only the leader PID. A leader
// that exits while a same-group descendant survives passes the check and
// loses its durable handle -> unfenced live process.
// MECHANISM: DETERMINISTIC (kill(-pgid, 0) ESRCH polling, real processes).

const roots: string[] = [];
const groups: number[] = [];
afterEach(async () => {
  for (const pgid of groups.splice(0)) {
    try { process.kill(-pgid, "SIGKILL"); } catch { /* already dead */ }
  }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function track(child: ChildProcess): ChildProcess {
  if (child.pid) groups.push(child.pid);
  return child;
}

/** True while ANY member of the leader's group is alive (conservative). */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

/** Leader exits immediately after spawning a same-group grandchild. */
function spawnExitingLeader(grandchildIgnoresTerm: boolean, readyFile?: string): ChildProcess {
  const readySync = readyFile ? `require("node:fs").writeFileSync(${JSON.stringify(readyFile)}, "ready");` : "";
  const grandchild = grandchildIgnoresTerm
    ? `process.on("SIGTERM", () => {});${readySync}setTimeout(() => {}, 15_000);`
    : `setTimeout(() => {}, 15_000);`;
  const leader = `const { spawn } = require("node:child_process"); const g = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { detached: false, stdio: "ignore" }); g.unref(); process.exit(0);`;
  return track(spawn(process.execPath, ["-e", leader], { detached: true, stdio: "ignore" }));
}

/** Leader stays live (default TERM disposition) with a TERM-ignoring member. */
function spawnSeatedLeader(readyFile: string): ChildProcess {
  const grandchild = `process.on("SIGTERM", () => {});require("node:fs").writeFileSync(${JSON.stringify(readyFile)}, "ready");setTimeout(() => {}, 15_000);`;
  const leader = `const { spawn } = require("node:child_process"); const g = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { detached: false, stdio: "ignore" }); g.unref(); setTimeout(() => {}, 15_000);`;
  return track(spawn(process.execPath, ["-e", leader], { detached: true, stdio: "ignore" }));
}

/** Bounded wait until the grandchild proves its signal disposition is installed. */
async function waitForReady(file: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await fs.access(file); return; }
    catch { /* not yet */ }
    if (Date.now() >= deadline) throw new Error(`grandchild ready file ${file} never appeared`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-groupdeath-"));
  roots.push(root);
  return root;
}

function handlesDir(root: string, operationId: string): string {
  const safeId = operationId.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(root, ".harness", "operations", `${safeId}.processes`);
}

async function writeManagedHandle(root: string, operationId: string, pid: number): Promise<void> {
  await fs.mkdir(handlesDir(root, operationId), { recursive: true });
  await fs.writeFile(
    path.join(handlesDir(root, operationId), `${pid}.json`),
    JSON.stringify({ pid, processGroupId: pid, startedAt: new Date().toISOString() })
  );
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
    payload: { request: "process group death verification" },
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
    intent: "group death verification test", route: "DIRECT", minimumAssurance: "STANDARD",
    policyVersions: { resolvedOperationPolicy: "2" }, policyDigests: {}, validationPolicy: {}, reviewPolicy: {}, deliveryPolicy: {}, knowledgePolicy: {}, contextPolicy: {},
    allowedExternalEffects: [], humanDecisionRequirements: []
  });
  const bound = await bindResolvedOperationPolicy(root, operationId, policy);
  const ledger = new HumanDecisionLedgerV2(path.join(root, ".harness", "security", "human-decisions.json"));
  await ledger.record({
    operationId, candidate, operationExecutionRevision: bound.operationExecutionRevision!, policyDigest: policy.digest,
    controllerEpoch: currentControllerEpoch(bound), purpose: { kind: "OPERATION_CONTROL", command: "CANCEL" }, kind: "CANCEL",
    actorId, reason: "explicit group-death verification test request", createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000)
  });
}

describe.skipIf(process.platform === "win32")("process group death verification (Luna B1/B2)", () => {
  it("proves group death, not leader death: the leader-scoped probe passes while a member survives", async () => {
    const leader = spawnExitingLeader(false);
    expect(leader.pid).toBeDefined();
    await once(leader, "exit");
    // Gap documentation: the leader-scoped probe reports death ...
    expect(await verifyProcessExit(leader.pid, 100)).toBe(true);
    // ... while the group is still alive.
    expect(groupAlive(leader.pid!)).toBe(true);
    // The fix: group-scoped verification reports live ...
    const { verifyProcessGroupExit } = await import("../src/utils/process.js");
    expect(await verifyProcessGroupExit(leader.pid, 100)).toBe(false);
    // ... and dead only after the whole group is gone.
    process.kill(-leader.pid!, "SIGKILL");
    expect(await verifyProcessGroupExit(leader.pid, 2_000)).toBe(true);
  }, 15_000);

  it("stopProcess escalates past an exited leader while a TERM-ignoring member survives", async () => {
    const dir = await tempRoot();
    const ready = path.join(dir, "grandchild.ready");
    const leader = spawnExitingLeader(true, ready);
    expect(leader.pid).toBeDefined();
    // Deterministic setup: only proceed once the survivor's TERM disposition
    // is installed, so TERM can never win by landing mid-exec.
    await waitForReady(ready);
    const result = await stopProcess(leader);
    // TERM was ignored by the survivor, so success requires KILL escalation
    // and a dead group — never an early return on the exited leader.
    expect(result.escalation).toBe("sigkill");
    expect(groupAlive(leader.pid!)).toBe(false);
  }, 15_000);

  it("cancellation fences (never silently clears) when a group member survives the leader", async () => {
    const root = await tempRoot();
    const id = "CANCEL-GROUPDEATH";
    await saveOwnedOperation(root, operation(root, id));
    await bindCancellationDecision(root, id, "human:groupdeath-test");
    const leader = spawnSeatedLeader(path.join(root, "grandchild.ready"));
    expect(leader.pid).toBeDefined();
    // Deterministic setup: the survivor's TERM disposition is installed
    // before cancellation signals, so TERM can never win by landing mid-exec.
    await waitForReady(path.join(root, "grandchild.ready"));
    await writeManagedHandle(root, id, leader.pid!);

    // Graceful-only terminator: signals the GROUP with TERM (delivery
    // confirmed) but never escalates — isolates the death WAIT's scope from
    // signal effectiveness. The seated leader dies on TERM; its
    // TERM-ignoring member survives.
    const signals: number[] = [];
    const run = vi.fn(async () => ({ exitCode: 0, stdout: "stopped", stderr: "", durationMs: 1 }));
    let message = "";
    try {
      await cancelOperation(root, id, {
        run: run as never,
        trace: vi.fn(async () => undefined) as never,
        humanActorId: "human:groupdeath-test",
        terminateProcessGroup: async (pid: number) => {
          process.kill(-pid, "SIGTERM");
          signals.push(pid);
        }
      });
    } catch (error) {
      message = String(error);
    }

    expect(signals).toEqual([leader.pid]);
    expect(message).toMatch(/AEH_CANCELLATION_FENCING_REQUIRED/);
    expect(message).toMatch(/AEH_ORPHAN_UNKILLABLE/);
    expect(groupAlive(leader.pid!)).toBe(true);
    // Fencing preserved: the durable handle survives for retry/rescan.
    expect((await fs.readdir(handlesDir(root, id)))).toHaveLength(1);
    expect((await loadOperation(root, id)).phase).toBe("cancellation-fencing-required");
  }, 30_000);
});
