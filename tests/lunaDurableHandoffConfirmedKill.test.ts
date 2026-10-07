import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import { cancelOperation } from "../src/operations/controller.js";
import { loadOperation, type OperationRecordV2 } from "../src/operations/state.js";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { HumanDecisionLedgerV2 } from "../src/security/humanDecision.js";
import { bindResolvedOperationPolicy, currentControllerEpoch } from "../src/operations/state.js";
import { createManagedRuntime, runtimeProjectId } from "../src/runtime/index.js";
import { reconcileOperationResources } from "../src/runtime/operationResources.js";
import { clearManagedProcessHandles, runShell } from "../src/utils/process.js";
import { runDirectWorkerProcess } from "../src/workers/directProcess.js";

const roots: string[] = [];
const children: ChildProcess[] = [];
const savedEnv: Record<string, string | undefined> = {};
const realKill: typeof process.kill = process.kill;

afterEach(async () => {
  for (const child of children.splice(0)) {
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
  }
  (process as { kill: typeof process.kill }).kill = realKill;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of Object.keys(savedEnv)) delete savedEnv[key];
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function runningRecord(root: string, id: string): OperationRecordV2 {
  const now = new Date().toISOString();
  return {
    version: 2,
    id,
    kind: "audit",
    status: "RUNNING",
    phase: "reviewing",
    root,
    payload: { request: "luna durable handoff red" },
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
    intent: "luna red test", route: "DIRECT", minimumAssurance: "STANDARD",
    policyVersions: { resolvedOperationPolicy: "2" }, policyDigests: {}, validationPolicy: {}, reviewPolicy: {}, deliveryPolicy: {}, knowledgePolicy: {}, contextPolicy: {},
    allowedExternalEffects: [], humanDecisionRequirements: []
  });
  const bound = await bindResolvedOperationPolicy(root, operationId, policy);
  const ledger = new HumanDecisionLedgerV2(path.join(root, ".harness", "security", "human-decisions.json"));
  await ledger.record({
    operationId, candidate, operationExecutionRevision: bound.operationExecutionRevision!, policyDigest: policy.digest,
    controllerEpoch: currentControllerEpoch(bound), purpose: { kind: "OPERATION_CONTROL", command: "CANCEL" }, kind: "CANCEL",
    actorId, reason: "luna durable-handoff red", createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000)
  });
}

async function writeManagedHandle(root: string, operationId: string, pid: number): Promise<void> {
  const safeId = operationId.replace(/[^A-Za-z0-9._-]/g, "_");
  const dir = path.join(root, ".harness", "operations", `${safeId}.processes`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${pid}.json`), JSON.stringify({ pid, processGroupId: pid, startedAt: new Date().toISOString() }));
}

async function handlesRemain(root: string, operationId: string): Promise<boolean> {
  const safeId = operationId.replace(/[^A-Za-z0-9._-]/g, "_");
  const dir = path.join(root, ".harness", "operations", `${safeId}.processes`);
  try {
    const entries = await fs.readdir(dir);
    return entries.filter((e) => e.endsWith(".json")).length > 0;
  } catch {
    return false;
  }
}

/** Stub process.kill: delivery always fails, liveness always reports alive (unkillable stub). */
function stubUnkillable(): void {
  (process as { kill: typeof process.kill }).kill = ((pid: number, signal?: number | NodeJS.Signals) => {
    if (signal === undefined || signal === 0) return true;
    throw Object.assign(new Error(`EPERM: operation not permitted (stubbed unkillable ${pid})`), { code: "EPERM" });
  }) as typeof process.kill;
}

function saveEnv(keys: string[]): void {
  for (const key of keys) savedEnv[key] = process.env[key];
}

describe("Luna durable-handoff + confirmed-kill REDs", () => {
  it("(a-i) uncertain-effects cancel clears managed-process handles and sets the durable cleanup flag", async () => {
    const root = await tempRoot("aeh-luna-a1-");
    const id = "AUDIT-LUNA-A1";
    await saveOwnedOperation(root, runningRecord(root, id));
    await bindCancellationDecision(root, id, "human:luna-red");
    // Sibling-stale-handle reuse shape: the live pid is named by OUR handle
    // (authorizing the kill loop via the managed set) but is ALSO named by a
    // sibling's stale handle, so the fenced kill loop must skip it. Without
    // the terminal hook, the later unfenced reconciliation re-signals it.
    const reused = spawn("sleep", ["60"], { cwd: root, detached: true, stdio: "ignore" });
    reused.unref();
    children.push(reused);
    expect(reused.pid).toBeDefined();
    await writeManagedHandle(root, id, reused.pid!);
    await saveOwnedOperation(root, runningRecord(root, "SIBLING-STALE"));
    await writeManagedHandle(root, "SIBLING-STALE", reused.pid!);
    const current = await loadOperation(root, id);
    const runtime = await createManagedRuntime({
      root, projectId: runtimeProjectId(root), ownerId: `provider-controller:${id}:${current.controller!.epoch}`
    });
    await runtime.acquireProviderLease({
      provider: "opencode", workspaceId: "operation-ws", mode: "write",
      lifecycle: {
        operationId: current.id,
        candidateDigest: current.candidateRevision!.identityDigest,
        operationExecutionRevision: current.operationExecutionRevision!,
        policyDigest: current.resolvedOperationPolicy!.digest,
        controllerTokenDigest: current.controller!.tokenDigest!,
        controllerEpoch: current.controller!.epoch,
        participantId: "participant-luna-red",
        sessionId: "sess-luna-uncertain",
        providerStatus: "UNCERTAIN"
      }
    });
    const run = vi.fn(async () => ({ exitCode: 0, stdout: "stopped", stderr: "", durationMs: 1 }));
    const terminal = await cancelOperation(root, id, {
      run: run as never,
      trace: (async () => undefined) as never,
      notifyCompletion: (async () => undefined) as never,
      humanActorId: "human:luna-red",
      inspectProviderSession: async () => ({ status: "uncertain" })
    });
    expect(terminal.phase).toBe("UNCERTAIN_EXTERNAL_EFFECTS");
    // The hook must have removed our handles before the unfenced terminal
    // reconciliation: the sibling-owned live pid must survive (no re-signal).
    expect(await handlesRemain(root, id)).toBe(false);
    let siblingAlive = false;
    try { process.kill(reused.pid!, 0); siblingAlive = true; } catch { siblingAlive = false; }
    expect(siblingAlive).toBe(true);
    expect((terminal as unknown as Record<string, unknown>).processHandlesCleanupCompletedAt).toBeTruthy();
  }, 30_000);

  it("(a-ii) failed handle clear propagates instead of being swallowed", async () => {
    const root = await tempRoot("aeh-luna-a2-");
    const id = "AUDIT-LUNA-A2";
    await writeManagedHandle(root, id, 48896);
    const failure = Object.assign(new Error("EACCES: permission denied (stubbed clear failure)"), { code: "EACCES" });
    const spy = vi.spyOn(fs, "rm").mockRejectedValueOnce(failure);
    try {
      await expect(clearManagedProcessHandles(root, id)).rejects.toThrow(/EACCES/);
    } finally {
      spy.mockRestore();
    }
  });

  it("(a-iii) recovery on a terminal op with leftover handles and no flag fence-cleans without blind-signaling", async () => {
    const root = await tempRoot("aeh-luna-a3-");
    const id = "AUDIT-LUNA-A3";
    const now = new Date().toISOString();
    await fs.mkdir(path.join(root, ".harness", "operations"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".harness", "operations", `${id}.json`),
      `${JSON.stringify({ ...runningRecord(root, id), status: "CANCELLED", phase: "cancelled", finishedAt: now }, null, 2)}\n`,
      "utf8"
    );
    await writeManagedHandle(root, id, 48897);
    const terminateProcess = vi.fn(async (_pid: number) => undefined);
    const receipt = await reconcileOperationResources(root, id, {
      terminateProcess: terminateProcess as never,
      archiveWorkspace: (async () => undefined) as never,
      archiveAgent: (async () => undefined) as never,
      inspectAgent: (async () => undefined) as never,
      listOwnedAgents: (async () => []) as never,
      trace: (async () => undefined) as never
    });
    expect(terminateProcess).not.toHaveBeenCalled();
    expect(await handlesRemain(root, id)).toBe(false);
    expect(receipt.terminalOrphansRemaining).toBe(0);
  });

  it("(b-1) runChild registration rejection with an unkillable child throws ORPHAN_UNKILLABLE with pid", async () => {
    const root = await tempRoot("aeh-luna-b1-");
    saveEnv(["AEH_OPERATION_ID", "AEH_CONTROL_ROOT", "AEH_OPERATION_STATE_REDIRECT"]);
    process.env.AEH_OPERATION_ID = "OP-LUNA-B1";
    process.env.AEH_CONTROL_ROOT = root;
    process.env.AEH_OPERATION_STATE_REDIRECT = "1";
    const safeId = "OP-LUNA-B1";
    await fs.mkdir(path.join(root, ".harness", "operations"), { recursive: true });
    await fs.writeFile(path.join(root, ".harness", "operations", `${safeId}.processes`), "blocker-file");
    stubUnkillable();
    const error = await runShell("sleep 60", { cwd: root, timeoutMs: 10_000 }).then(
      () => { throw new Error("RUNCHILD_RESOLVED_SILENTLY"); },
      (failure: unknown) => failure as { message: string; code?: string; pid?: number }
    );
    expect(String((error as { message: string }).message)).toMatch(/ORPHAN_UNKILLABLE/);
    expect((error as { code?: string }).code).toBe("AEH_ORPHAN_UNKILLABLE");
    expect((error as { pid?: number }).pid).toBeGreaterThan(0);
  }, 30_000);

  it("(b-2) runChild force-settle with a surviving child throws instead of silent success", async () => {
    const root = await tempRoot("aeh-luna-b2-");
    stubUnkillable();
    const error = await runShell("sleep 60", { cwd: root, timeoutMs: 50 }).then(
      () => { throw new Error("RUNCHILD_RESOLVED_SILENTLY"); },
      (failure: unknown) => failure as Error
    );
    expect(String(error)).toMatch(/ORPHAN_UNKILLABLE/);
  }, 30_000);

  it("(b-3) stopProcess on a surviving process reports failure instead of silent success", async () => {
    stubUnkillable();
    const mod = await import("../src/workers/runtimeSessions.js") as unknown as Record<string, unknown>;
    expect(typeof mod.stopProcess).toBe("function");
    const stopProcess = mod.stopProcess as (child: unknown) => Promise<unknown>;
    const fakeChild = { exitCode: null as number | null, signalCode: null as string | null, pid: 48898, kill: () => false as boolean, once: (_event: string, _listener: () => void) => undefined };
    await expect(stopProcess(fakeChild)).rejects.toThrow(/ORPHAN_UNKILLABLE/);
    try {
      await stopProcess(fakeChild);
      throw new Error("STOPPROCESS_RESOLVED_SILENTLY");
    } catch (failure) {
      expect(String(failure)).toContain("48898");
    }
  }, 30_000);

  it("(b-4) directProcess registration rejection with an unkillable child throws ORPHAN_UNKILLABLE", async () => {
    const root = await tempRoot("aeh-luna-b4-");
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-luna-b4-home-"));
    roots.push(home);
    saveEnv(["AEH_OPERATION_ID", "AEH_CONTROL_ROOT", "AEH_OPERATION_STATE_REDIRECT"]);
    process.env.AEH_OPERATION_ID = "OP-LUNA-B4";
    process.env.AEH_CONTROL_ROOT = root;
    process.env.AEH_OPERATION_STATE_REDIRECT = "1";
    await fs.mkdir(path.join(root, ".harness", "operations"), { recursive: true });
    await fs.writeFile(path.join(root, ".harness", "operations", "OP-LUNA-B4.processes"), "blocker-file");
    stubUnkillable();
    const error = await runDirectWorkerProcess(
      process.execPath, ["-e", "setTimeout(()=>{},60000)"],
      { version: 1, project: { name: "luna-red" } },
      { cwd: root, timeoutMs: 10_000, homeDirectory: home }
    ).then(
      () => { throw new Error("DIRECT_RESOLVED_SILENTLY"); },
      (failure: unknown) => failure as { message: string; code?: string }
    );
    expect(String((error as { message: string }).message)).toMatch(/ORPHAN_UNKILLABLE/);
    expect((error as { code?: string }).code).toBe("AEH_ORPHAN_UNKILLABLE");
  }, 30_000);
});
