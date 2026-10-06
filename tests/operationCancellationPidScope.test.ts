import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import { cancelOperation, expireOperationAtHardDeadline, listSiblingOwnedProcessIds as realListSiblingOwnedProcessIds } from "../src/operations/controller.js";
import {
  buildCancellationPidSet,
  findDescendantProcessIds
} from "../src/operations/controller.js";
import { terminateManagedProcessGroup } from "../src/utils/process.js";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { HumanDecisionLedgerV2 } from "../src/security/humanDecision.js";
import {
  bindResolvedOperationPolicy,
  currentControllerEpoch,
  loadOperation,
  patchOperation,
  updateOperationMetadata,
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

  it("fails closed (never empty-success) when the operations directory is missing", async () => {
    // Cancellation already loaded the target record, so a missing operations
    // directory cannot prove "no siblings" — the scan must throw instead of
    // reporting an empty (unproven) exclusion set.
    const ghost = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-cancel-ghost-"));
    roots.push(ghost);
    await expect(realListSiblingOwnedProcessIds(ghost, "CANCEL-KNOWN-OP")).rejects.toThrow(
      /AEH_CANCELLATION_FENCING_REQUIRED/
    );
  });

  it("aborts cancellation with zero signals when the sibling scan observes a missing operations directory", async () => {
    const root = await tempRoot();
    const id = "CANCEL-PID-MISSING-DIR";
    await saveOwnedOperation(root, operation(root, id));
    await bindCancellationDecision(root, id, "human:pid-scope-test");
    const targetPid = 48883;
    await patchOperation(root, id, { pid: targetPid });
    // The scan observes a state root with no operations directory (the
    // concurrent-disappearance shape); the target record is already loaded by
    // cancellation, so empty-success would bypass the fail-closed gate.
    const ghost = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-cancel-ghost-"));
    roots.push(ghost);

    const signals: number[] = [];
    const run = vi.fn(async () => ({ exitCode: 0, stdout: "stopped", stderr: "", durationMs: 1 }));
    await expect(cancelOperation(root, id, {
      run: run as never,
      trace: vi.fn(async () => undefined) as never,
      humanActorId: "human:pid-scope-test",
      listSiblingOwnedProcessIds: async (_stateRoot: string, operationId: string) =>
        realListSiblingOwnedProcessIds(ghost, operationId),
      terminateProcessGroup: async (pid: number) => { signals.push(pid); }
    })).rejects.toThrow(/AEH_CANCELLATION_FENCING_REQUIRED/);

    expect(signals).toEqual([]);
    expect((await loadOperation(root, id)).phase).toBe("cancellation-fencing-required");
  });

  it("aborts the whole cancellation when a kill-time sibling rescan fails (later targets unsignaled)", async () => {
    const root = await tempRoot();
    const id = "CANCEL-KILL-ABORT";
    await saveOwnedOperation(root, operation(root, id));
    await bindCancellationDecision(root, id, "human:pid-scope-test");
    const pids = [48771, 48772, 48773];
    await patchOperation(root, id, { pid: pids[0] });
    // Two additional durable targets via managed-process handles; all three
    // pids are durable (record pid + managed set) so the kill-time recheck
    // reaches the sibling rescan before any liveness short-circuit.
    const safeId = id.replace(/[^A-Za-z0-9._-]/g, "_");
    const handlesDir = path.join(root, ".harness", "operations", `${safeId}.processes`);
    await fs.mkdir(handlesDir, { recursive: true });
    for (const pid of pids.slice(1)) {
      await fs.writeFile(
        path.join(handlesDir, `${pid}.json`),
        JSON.stringify({ pid, processGroupId: pid, startedAt: new Date().toISOString() })
      );
    }
    // Fake liveness: the targets are "alive" until the test seam "kills" them.
    const live = new Set(pids);
    const originalKill = process.kill;
    (process as { kill: typeof process.kill }).kill = ((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === undefined || signal === 0) {
        if (!live.has(pid)) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        return true;
      }
      live.delete(pid);
      return true;
    }) as typeof process.kill;
    try {
      // Call 1 is the initial scan (clean); call 2 is the first target's
      // recheck (clean, so it is signaled); call 3 fails — every later target
      // must remain unsignaled after the abort.
      let calls = 0;
      const signals: number[] = [];
      const run = vi.fn(async () => ({ exitCode: 0, stdout: "stopped", stderr: "", durationMs: 1 }));
      let message = "";
      try {
        await cancelOperation(root, id, {
          run: run as never,
          trace: vi.fn(async () => undefined) as never,
          humanActorId: "human:pid-scope-test",
          listSiblingOwnedProcessIds: async () => {
            calls += 1;
            if (calls === 3) throw new Error("EIO: kill-time scan unavailable");
            return new Set<number>();
          },
          terminateProcessGroup: async (pid: number) => { signals.push(pid); live.delete(pid); }
        });
      } catch (error) {
        message = String(error);
      }
      expect(message).toMatch(/AEH_CANCELLATION_FENCING_REQUIRED/);
      // Exactly one target was signaled before the abort; no further signals.
      expect(signals).toHaveLength(1);
      for (const pid of pids) {
        if (pid !== signals[0]) expect(signals).not.toContain(pid);
      }
      // Honest partial record: the error names the already-signaled target.
      expect(message).toContain(String(signals[0]));
      expect((await loadOperation(root, id)).phase).toBe("cancellation-fencing-required");
    } finally {
      (process as { kill: typeof process.kill }).kill = originalKill;
    }
  });
});

async function writeManagedHandle(root: string, operationId: string, pid: number): Promise<void> {
  const safeId = operationId.replace(/[^A-Za-z0-9._-]/g, "_");
  const handlesDir = path.join(root, ".harness", "operations", `${safeId}.processes`);
  await fs.mkdir(handlesDir, { recursive: true });
  await fs.writeFile(
    path.join(handlesDir, `${pid}.json`),
    JSON.stringify({ pid, processGroupId: pid, startedAt: new Date().toISOString() })
  );
}

async function waitUntilDead(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { process.kill(pid, 0); }
    catch { return; }
    if (Date.now() >= deadline) throw new Error(`pid ${pid} remained live`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("cancellation sibling managed-handle fencing (Luna-a)", () => {
  it("includes sibling managed-handle pids in the exclusion set", async () => {
    const root = await tempRoot();
    await saveOwnedOperation(root, operation(root, "OP-A"));
    await saveOwnedOperation(root, operation(root, "OP-B"));
    await writeManagedHandle(root, "OP-B", 48891);
    const owned = await realListSiblingOwnedProcessIds(root, "OP-A");
    expect(owned.has(48891)).toBe(true);
  });

  it("throws fencing-required when a sibling handle file is unreadable", async () => {
    const root = await tempRoot();
    await saveOwnedOperation(root, operation(root, "OP-A"));
    await saveOwnedOperation(root, operation(root, "OP-C"));
    const safeId = "OP-C".replace(/[^A-Za-z0-9._-]/g, "_");
    const handlesDir = path.join(root, ".harness", "operations", `${safeId}.processes`);
    await fs.mkdir(handlesDir, { recursive: true });
    await fs.writeFile(path.join(handlesDir, "999.json"), "corrupt{{{not-json");
    await expect(realListSiblingOwnedProcessIds(root, "OP-A")).rejects.toThrow(
      /AEH_CANCELLATION_FENCING_REQUIRED/
    );
  });

  it("does not signal a pid owned via a sibling's stale managed handle (reuse)", async () => {
    const root = await tempRoot();
    const id = "CANCEL-SIBLING-HANDLE";
    await saveOwnedOperation(root, operation(root, id));
    await bindCancellationDecision(root, id, "human:pid-scope-test");
    // The sibling exited long ago leaving a stale handle; its pid number has
    // since been reused by this live process (the reuse shape). Our operation
    // also names it through its own managed handle, which authorizes signaling
    // via managedPidSet unless the sibling exclusion proves otherwise.
    const reused = spawnSleeper(root);
    expect(reused.pid).toBeDefined();
    await writeManagedHandle(root, id, reused.pid!);
    await saveOwnedOperation(root, operation(root, "SIBLING-STALE"));
    await writeManagedHandle(root, "SIBLING-STALE", reused.pid!);

    const run = vi.fn(async () => ({ exitCode: 0, stdout: "stopped", stderr: "", durationMs: 1 }));
    await cancelOperation(root, id, {
      run: run as never,
      trace: vi.fn(async () => undefined) as never,
      humanActorId: "human:pid-scope-test"
    });

    expect((await loadOperation(root, id)).status).toBe("CANCELLED");
    expect(alive(reused.pid!)).toBe(true);
  }, 30_000);

  it("fails closed with zero signals when a sibling handle file is unreadable", async () => {
    const root = await tempRoot();
    const id = "CANCEL-SIBLING-HANDLE-CORRUPT";
    await saveOwnedOperation(root, operation(root, id));
    await bindCancellationDecision(root, id, "human:pid-scope-test");
    const target = spawnSleeper(root);
    expect(target.pid).toBeDefined();
    await writeManagedHandle(root, id, target.pid!);
    await saveOwnedOperation(root, operation(root, "SIBLING-CORRUPT"));
    const safeId = "SIBLING-CORRUPT".replace(/[^A-Za-z0-9._-]/g, "_");
    const handlesDir = path.join(root, ".harness", "operations", `${safeId}.processes`);
    await fs.mkdir(handlesDir, { recursive: true });
    await fs.writeFile(path.join(handlesDir, "999.json"), "corrupt{{{not-json");

    const signals: number[] = [];
    const run = vi.fn(async () => ({ exitCode: 0, stdout: "stopped", stderr: "", durationMs: 1 }));
    await expect(cancelOperation(root, id, {
      run: run as never,
      trace: vi.fn(async () => undefined) as never,
      humanActorId: "human:pid-scope-test",
      terminateProcessGroup: async (pid: number) => { signals.push(pid); }
    })).rejects.toThrow(/AEH_CANCELLATION_FENCING_REQUIRED/);

    expect(signals).toEqual([]);
    expect(alive(target.pid!)).toBe(true);
    expect((await loadOperation(root, id)).phase).toBe("cancellation-fencing-required");
  }, 30_000);
});

describe("honest signal confirmation (Luna-b)", () => {
  it("reports an already-dead pid as ESRCH instead of confirmed delivery", async () => {
    const victim = spawnSleeper(await tempRoot());
    const deadPid = victim.pid!;
    victim.kill("SIGKILL");
    await waitUntilDead(deadPid);
    await expect(terminateManagedProcessGroup(deadPid)).rejects.toMatchObject({ code: "ESRCH" });
  }, 30_000);

  it("confirms delivery for a live process", async () => {
    await tempRoot();
    const victim = spawnSleeper(os.tmpdir());
    const pid = victim.pid!;
    await terminateManagedProcessGroup(pid);
    expect(alive(pid)).toBe(false);
  }, 30_000);

  it("records delivery failure as failed (not signaled) in the kill-time abort", async () => {
    const root = await tempRoot();
    const id = "CANCEL-SIGNAL-FAILED";
    await saveOwnedOperation(root, operation(root, id));
    await bindCancellationDecision(root, id, "human:pid-scope-test");
    const first = 48781;
    const second = 48782;
    await patchOperation(root, id, { pid: second });
    await writeManagedHandle(root, id, first);
    const live = new Set([first, second]);
    const originalKill = process.kill;
    (process as { kill: typeof process.kill }).kill = ((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === undefined || signal === 0) {
        if (!live.has(pid)) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        return true;
      }
      live.delete(pid);
      return true;
    }) as typeof process.kill;
    try {
      // Call 1 is the initial scan (clean); call 2 is the first target's
      // recheck (clean, but delivery fails); call 3 fails — the abort must
      // report the first target as failed, never as signaled.
      let calls = 0;
      const signals: number[] = [];
      const run = vi.fn(async () => ({ exitCode: 0, stdout: "stopped", stderr: "", durationMs: 1 }));
      let message = "";
      try {
        await cancelOperation(root, id, {
          run: run as never,
          trace: vi.fn(async () => undefined) as never,
          humanActorId: "human:pid-scope-test",
          listSiblingOwnedProcessIds: async () => {
            calls += 1;
            if (calls === 3) throw new Error("EIO: kill-time scan unavailable");
            return new Set<number>();
          },
          terminateProcessGroup: async (pid: number) => {
            if (pid === first) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
            signals.push(pid);
          }
        });
      } catch (error) {
        message = String(error);
      }
      expect(message).toMatch(/AEH_CANCELLATION_FENCING_REQUIRED/);
      expect(signals).toEqual([]);
      // The failed target is reported as failed — never as signaled.
      expect(message).toContain(String(first));
      expect(message).toMatch(/failed/);
      expect(message).toMatch(/0 pid\(s\) with confirmed signal delivery/);
      expect((await loadOperation(root, id)).phase).toBe("cancellation-fencing-required");
    } finally {
      (process as { kill: typeof process.kill }).kill = originalKill;
    }
  });

  it("records a race-exited pid as already-dead (not signaled) in the kill-time abort", async () => {
    const root = await tempRoot();
    const id = "CANCEL-SIGNAL-DEAD";
    await saveOwnedOperation(root, operation(root, id));
    await bindCancellationDecision(root, id, "human:pid-scope-test");
    const first = 48783;
    const second = 48784;
    await patchOperation(root, id, { pid: second });
    await writeManagedHandle(root, id, first);
    const live = new Set([first, second]);
    const originalKill = process.kill;
    (process as { kill: typeof process.kill }).kill = ((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === undefined || signal === 0) {
        if (!live.has(pid)) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        return true;
      }
      live.delete(pid);
      return true;
    }) as typeof process.kill;
    try {
      let calls = 0;
      const signals: number[] = [];
      const run = vi.fn(async () => ({ exitCode: 0, stdout: "stopped", stderr: "", durationMs: 1 }));
      let message = "";
      try {
        await cancelOperation(root, id, {
          run: run as never,
          trace: vi.fn(async () => undefined) as never,
          humanActorId: "human:pid-scope-test",
          listSiblingOwnedProcessIds: async () => {
            calls += 1;
            if (calls === 3) throw new Error("EIO: kill-time scan unavailable");
            return new Set<number>();
          },
          terminateProcessGroup: async (pid: number) => {
            if (pid === first) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
            signals.push(pid);
          }
        });
      } catch (error) {
        message = String(error);
      }
      expect(message).toMatch(/AEH_CANCELLATION_FENCING_REQUIRED/);
      expect(signals).toEqual([]);
      expect(message).toContain(String(first));
      expect(message).toMatch(/already-dead/);
      expect(message).toMatch(/0 pid\(s\) with confirmed signal delivery/);
      expect((await loadOperation(root, id)).phase).toBe("cancellation-fencing-required");
    } finally {
      (process as { kill: typeof process.kill }).kill = originalKill;
    }
  });
});

describe("hard-deadline watchdog pid ownership (Luna-c)", () => {
  async function bindExpiredLiveness(root: string, operationId: string): Promise<void> {
    const current = await loadOperation(root, operationId);
    const candidate = current.candidateRevision!;
    const policy = compileResolvedOperationPolicy({
      projectId: candidate.projectId!, operationId,
      operationExecutionRevision: current.operationExecutionRevision!,
      candidateRevision: candidate.revision,
      candidateDigest: candidate.identityDigest,
      controllerEpoch: currentControllerEpoch(current),
      intent: "watchdog pid ownership test", route: "DIRECT", minimumAssurance: "STANDARD",
      policyVersions: { resolvedOperationPolicy: "2" }, policyDigests: {}, validationPolicy: {}, reviewPolicy: {}, deliveryPolicy: {}, knowledgePolicy: {}, contextPolicy: {},
      allowedExternalEffects: [], humanDecisionRequirements: []
    });
    await bindResolvedOperationPolicy(root, operationId, policy);
    const bound = await loadOperation(root, operationId);
    const hardDeadlineMs = bound.resolvedOperationPolicy!.executionLiveness.hardDeadlineMs;
    await updateOperationMetadata(root, operationId, () => ({
      createdAt: new Date(Date.now() - hardDeadlineMs - 1_000).toISOString()
    }));
  }

  it("does not signal record.pid when it is a live foreign-cwd process", async () => {
    const root = await tempRoot();
    const foreign = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-watchdog-foreign-"));
    roots.push(foreign);
    const id = "WATCHDOG-FOREIGN";
    await saveOwnedOperation(root, operation(root, id));
    await bindExpiredLiveness(root, id);
    const stranger = spawnSleeper(foreign);
    expect(stranger.pid).toBeDefined();
    await patchOperation(root, id, { pid: stranger.pid! });

    const signals: number[] = [];
    const traces: Array<[string, unknown]> = [];
    const terminal = await expireOperationAtHardDeadline(root, id, new Date(), undefined, {
      run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 })) as never,
      trace: (async (_root: string, type: string, detail?: unknown) => { traces.push([type, detail]); }) as never,
      notifyCompletion: async () => undefined,
      terminateProcessGroup: async (pid: number) => { signals.push(pid); }
    });

    expect(terminal.status).toBe("FAILED");
    expect(signals).toEqual([]);
    expect(alive(stranger.pid!)).toBe(true);
    expect(traces.some(([type]) => type === "operation.hard-deadline.pid-skipped")).toBe(true);
  }, 30_000);

  it("sends no signal for a dead record.pid and still terminalizes", async () => {
    const root = await tempRoot();
    const id = "WATCHDOG-DEAD";
    await saveOwnedOperation(root, operation(root, id));
    await bindExpiredLiveness(root, id);
    const victim = spawnSleeper(root);
    const deadPid = victim.pid!;
    victim.kill("SIGKILL");
    await waitUntilDead(deadPid);
    await patchOperation(root, id, { pid: deadPid });

    const deliveries: number[] = [];
    const originalKill = process.kill;
    (process as { kill: typeof process.kill }).kill = ((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal !== undefined && signal !== 0) {
        deliveries.push(Math.abs(pid));
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
      return (originalKill as typeof process.kill)(pid, signal as never);
    }) as typeof process.kill;
    try {
      const traces: Array<[string, unknown]> = [];
      const terminal = await expireOperationAtHardDeadline(root, id, new Date(), undefined, {
        run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 })) as never,
        trace: (async (_root: string, type: string, detail?: unknown) => { traces.push([type, detail]); }) as never,
        notifyCompletion: async () => undefined,
        terminateProcessGroup: async (pid: number) => { deliveries.push(pid); }
      });
      expect(terminal.status).toBe("FAILED");
      expect(deliveries).toEqual([]);
      expect(traces.some(([type]) => type === "operation.hard-deadline.pid-skipped")).toBe(true);
    } finally {
      (process as { kill: typeof process.kill }).kill = originalKill;
    }
  }, 30_000);

  it("still signals record.pid when cwd matches the control root", async () => {
    const root = await tempRoot();
    const id = "WATCHDOG-OWN";
    await saveOwnedOperation(root, operation(root, id));
    await bindExpiredLiveness(root, id);
    const owned = spawnSleeper(root);
    expect(owned.pid).toBeDefined();
    await patchOperation(root, id, { pid: owned.pid! });

    const signals: number[] = [];
    const terminal = await expireOperationAtHardDeadline(root, id, new Date(), undefined, {
      run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 })) as never,
      trace: vi.fn(async () => undefined) as never,
      notifyCompletion: async () => undefined,
      terminateProcessGroup: async (pid: number) => { signals.push(pid); }
    });

    expect(terminal.status).toBe("FAILED");
    expect(signals).toEqual([owned.pid!]);
  }, 30_000);

  it("still signals record.pid when cwd matches the operation workspace root", async () => {
    const root = await tempRoot();
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-watchdog-workspace-"));
    roots.push(workspace);
    const id = "WATCHDOG-WORKSPACE";
    await saveOwnedOperation(root, operation(root, id));
    await bindExpiredLiveness(root, id);
    const worker = spawnSleeper(workspace);
    expect(worker.pid).toBeDefined();
    await patchOperation(root, id, { pid: worker.pid!, workspaceRoot: workspace });

    const signals: number[] = [];
    const terminal = await expireOperationAtHardDeadline(root, id, new Date(), undefined, {
      run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 })) as never,
      trace: vi.fn(async () => undefined) as never,
      notifyCompletion: async () => undefined,
      terminateProcessGroup: async (pid: number) => { signals.push(pid); }
    });

    expect(terminal.status).toBe("FAILED");
    expect(signals).toEqual([worker.pid!]);
  }, 30_000);
});
