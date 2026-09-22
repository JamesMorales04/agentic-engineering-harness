import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelOperation,
  createOperationId,
  extractWorkspaceId,
  startDetachedOperation
} from "../src/operations/controller.js";
import {
  loadOperation,
  acknowledgeOperationLead,
  patchOperation,
  registerOperationAgent,
  saveOperation,
  setOperationStage,
  transitionOperationToTerminal,
  updateOperationParticipant,
  type OperationRecord
} from "../src/operations/state.js";
import { runProcess } from "../src/utils/process.js";
import { resolveBaseRef } from "../src/core/git.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-operation-test-"));
  roots.push(root);
  return root;
}

async function seed(
  root: string,
  overrides: Partial<OperationRecord> = {}
): Promise<OperationRecord> {
  const record: OperationRecord = {
    version: 1,
    id: "AUDIT-1",
    kind: "audit",
    status: "QUEUED",
    phase: "queued",
    root,
    payload: { request: "review" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  };
  await saveOperation(root, record);
  return record;
}

describe("operation controller state", () => {
  it("persists legacy records atomically and normalizes them to v2", async () => {
    const root = await tempRoot();
    const record = await seed(root);
    expect(await loadOperation(root, record.id)).toEqual(
      expect.objectContaining({
        version: 2,
        id: record.id,
        kind: record.kind,
        status: record.status,
        phase: record.phase,
        root,
        payload: record.payload,
        revision: 1,
        supervision: expect.objectContaining({ required: true, materialized: false }),
        participants: {},
        progress: expect.objectContaining({ expected: 0, completed: 0, running: 0 })
      })
    );
  });

  it("serializes concurrent patches without corrupting the operation file", async () => {
    const root = await tempRoot();
    const record = await seed(root, { status: "RUNNING", phase: "executing" });
    await Promise.all([
      patchOperation(root, record.id, { phase: "planning" }),
      patchOperation(root, record.id, { workspaceId: "workspace-op" }),
      patchOperation(root, record.id, { workspaceWarning: "diagnostic" })
    ]);
    const current = await loadOperation(root, record.id);
    expect(current.status).toBe("RUNNING");
    expect(current.workspaceId).toBe("workspace-op");
    expect(current.workspaceWarning).toBe("diagnostic");
    expect(["planning", "executing"]).toContain(current.phase);
  });

  it("serializes concurrent agent registration without losing participants", async () => {
    const root = await tempRoot();
    const record = await seed(root, { status: "RUNNING", phase: "review" });
    await Promise.all([
      registerOperationAgent(root, record.id, {
        id: "reviewer-1",
        role: "security-reviewer",
        transport: "sdk"
      }),
      registerOperationAgent(root, record.id, {
        id: "reviewer-2",
        role: "architecture-reviewer",
        transport: "sdk"
      })
    ]);
    const current = await loadOperation(root, record.id);
    expect(current.agents?.map((agent) => agent.id).sort()).toEqual([
      "reviewer-1",
      "reviewer-2"
    ]);
  });

  it("grants exactly one concurrent caller ownership of the terminal transition", async () => {
    const root = await tempRoot();
    const record = await seed(root, { status: "RUNNING", phase: "reviewing" });
    const [success, cancellation] = await Promise.all([
      transitionOperationToTerminal(root, record.id, {
        status: "SUCCEEDED",
        phase: "finished",
        finishedAt: "2026-08-13T00:00:00.000Z",
        result: { status: "PASS" }
      }),
      transitionOperationToTerminal(root, record.id, {
        status: "CANCELLED",
        phase: "cancelled",
        finishedAt: "2026-08-13T00:00:01.000Z"
      })
    ]);

    expect([success.transitioned, cancellation.transitioned].sort()).toEqual([false, true]);
    const current = await loadOperation(root, record.id);
    expect(["SUCCEEDED", "CANCELLED"]).toContain(current.status);
    expect(success.record.status).toBe(current.status);
    expect(cancellation.record.status).toBe(current.status);
  });

  it("does not let late phase/final patches resurrect a cancelled operation", async () => {
    const root = await tempRoot();
    const record = await seed(root, {
      status: "CANCELLED",
      phase: "cancelled",
      finishedAt: "2026-08-12T21:00:00.000Z"
    });
    await patchOperation(root, record.id, {
      status: "SUCCEEDED",
      phase: "finished",
      result: { status: "PASS" }
    });
    await patchOperation(root, record.id, { phase: "review" });
    const current = await loadOperation(root, record.id);
    expect(current.status).toBe("CANCELLED");
    expect(current.phase).toBe("cancelled");
    expect(current.finishedAt).toBe("2026-08-12T21:00:00.000Z");
  });

  it("rejects an impossible active-state transition without corrupting the record", async () => {
    const root = await tempRoot();
    const record = await seed(root, { status: "QUEUED", phase: "queued" });
    await expect(patchOperation(root, record.id, { status: "SUCCEEDED", phase: "finished" })).rejects.toThrow("Invalid operation status transition QUEUED -> SUCCEEDED");
    expect(await loadOperation(root, record.id)).toMatchObject({ status: "QUEUED", phase: "queued", revision: 1 });
  });

  it("does not let custom lifecycle mutations change a terminal operation", async () => {
    const root = await tempRoot();
    const record = await seed(root, { status: "CANCELLED", phase: "cancelled", finishedAt: "2026-08-12T21:00:00.000Z" });
    const before = await loadOperation(root, record.id);
    await setOperationStage(root, record.id, "late-worker", "RUNNING");
    await registerOperationAgent(root, record.id, { id: "late-worker", role: "implementer" });
    await updateOperationParticipant(root, record.id, "late-worker", { status: "COMPLETED", resultArtifact: "late.json" });
    const current = await loadOperation(root, record.id);
    expect(current).toEqual(before);
  });

  it("rejects an acknowledgement for a stale revision inside the durable mutation boundary", async () => {
    const root = await tempRoot();
    const record = await seed(root, { status: "RUNNING", phase: "planning" });
    await saveOperation(root, record);
    const bound = await (await import("../src/operations/state.js")).bindOperationLead(root, record.id, "lead-1", "test");
    const staleRevision = bound.revision;
    const current = await setOperationStage(root, record.id, "review", "RUNNING");
    await expect(acknowledgeOperationLead(root, record.id, staleRevision, "stale-read")).rejects.toThrow("AEH_OPERATION_ACK_REVISION_MISMATCH");
    expect((await loadOperation(root, record.id)).lead?.acknowledgedRevision).toBeLessThan(current.revision);
  });

  it("cancels registered agents without requiring a Paseo list discovery", async () => {
    const root = await tempRoot();
    const record = await seed(root, {
      status: "RUNNING",
      phase: "review",
      agents: [
        {
          id: "reviewer-1",
          role: "security-reviewer",
          transport: "sdk",
          registeredAt: new Date().toISOString()
        },
        {
          id: "reviewer-2",
          role: "architecture-reviewer",
          transport: "sdk",
          registeredAt: new Date().toISOString()
        }
      ]
    });
    const run = vi.fn(async (command: string) => {
      if (command === "paseo stop 'reviewer-1'" || command === "paseo stop 'reviewer-2'") {
        return { exitCode: 0, stdout: "stopped", stderr: "", durationMs: 1 };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const trace = vi.fn(async () => undefined);

    const cancelled = await cancelOperation(root, record.id, {
      run: run as never,
      trace: trace as never
    });
    expect(cancelled.status).toBe("CANCELLED");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.some(([command]) => String(command).includes("paseo ls"))).toBe(false);
    expect(trace).toHaveBeenCalledWith(
      root,
      "cleanup.discovery",
      expect.objectContaining({ source: "operation-state", agentCount: 2 })
    );
  });

  it("starts a detached controller process and records its pid", async () => {
    const root = await tempRoot();
    const unref = vi.fn();
    const spawnProcess = vi.fn(() => ({ pid: 4242, unref }));
    const record = await startDetachedOperation(
      root,
      "audit",
      { request: "review" },
      {
        nodeExecutable: "/usr/bin/node",
        entryFile: "/pkg/dist/main.js",
        spawnProcess: spawnProcess as never
      }
    );
    expect(record).toEqual(
      expect.objectContaining({
        version: 2,
        kind: "audit",
        status: "QUEUED",
        phase: "dispatched",
        pid: 4242
      })
    );
    expect(spawnProcess).toHaveBeenCalledWith(
      "/usr/bin/node",
      ["/pkg/dist/main.js", "operation", "execute", record.id, root],
      expect.objectContaining({ detached: true, stdio: "ignore" })
    );
    expect(unref).toHaveBeenCalledTimes(1);
    expect((await loadOperation(root, record.id)).pid).toBe(4242);
  });

  it("terminalizes an asynchronously failed detached controller spawn", async () => {
    const root = await tempRoot();
    let onError: ((error: Error) => void) | undefined;
    const child = {
      pid: 4243,
      unref: vi.fn(),
      once: vi.fn((event: string, handler: (error: Error) => void) => {
        if (event === "error") onError = handler;
        return child;
      })
    };
    const record = await startDetachedOperation(root, "audit", { request: "review" }, {
      nodeExecutable: "/usr/bin/node",
      entryFile: "/pkg/dist/main.js",
      spawnProcess: vi.fn(() => child) as never
    });

    onError?.(new Error("spawn EACCES"));
    await vi.waitFor(async () => expect((await loadOperation(root, record.id)).status).toBe("FAILED"));
    expect((await loadOperation(root, record.id)).phase).toBe("spawn-failed");
  });

  it("cancels a detached direct-process handle registered by runProcess", async () => {
    if (process.platform === "win32") return;
    const root = await tempRoot();
    const record = await seed(root, {
      status: "RUNNING",
      phase: "executing",
      agents: [{ id: "reviewer-1", role: "reviewer", registeredAt: new Date().toISOString() }]
    });
    const previous = {
      id: process.env.AEH_OPERATION_ID,
      kind: process.env.AEH_OPERATION_KIND,
      root: process.env.AEH_CONTROL_ROOT,
      redirect: process.env.AEH_OPERATION_STATE_REDIRECT
    };
    process.env.AEH_OPERATION_ID = record.id;
    process.env.AEH_OPERATION_KIND = "audit";
    process.env.AEH_CONTROL_ROOT = root;
    process.env.AEH_OPERATION_STATE_REDIRECT = "1";
    const running = runProcess(`${shellQuote(process.execPath)} -e ${shellQuote("setTimeout(()=>{},60000)")}`, { cwd: root, timeoutMs: 60_000 });
    const handles = path.join(root, ".harness", "operations", `${record.id}.processes`);
    try {
      await vi.waitFor(async () => expect((await fs.readdir(handles)).length).toBeGreaterThan(0));
      const cancelled = await cancelOperation(root, record.id, {
        run: vi.fn(async () => ({ exitCode: 0, stdout: "stopped", stderr: "", durationMs: 1 })) as never,
        trace: vi.fn(async () => undefined) as never
      });
      const result = await running;
      expect(cancelled.status).toBe("CANCELLED");
      expect(result.exitCode).not.toBe(0);
    } finally {
      restoreEnv("AEH_OPERATION_ID", previous.id);
      restoreEnv("AEH_OPERATION_KIND", previous.kind);
      restoreEnv("AEH_CONTROL_ROOT", previous.root);
      restoreEnv("AEH_OPERATION_STATE_REDIRECT", previous.redirect);
    }
  }, 10_000);

  it("cancels detached descendants that are outside the controller process group", async () => {
    if (process.platform !== "linux") return;
    const root = await tempRoot();
    const descendantFile = path.join(root, "descendant.pid");
    const script = [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      "const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });",
      "fs.writeFileSync(process.argv[1], String(descendant.pid));",
      "setInterval(() => {}, 60000);"
    ].join(" ");
    const controller = spawn(process.execPath, ["-e", script, descendantFile], {
      cwd: root,
      detached: true,
      stdio: "ignore"
    });
    const record = await seed(root, {
      status: "RUNNING",
      phase: "executing",
      pid: controller.pid
    });
    let descendantPid: number | undefined;
    try {
      await vi.waitFor(async () => {
        descendantPid = Number(await fs.readFile(descendantFile, "utf8"));
        expect(descendantPid).toBeGreaterThan(0);
      });
      const cancelled = await cancelOperation(root, record.id, {
        run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 })) as never,
        trace: vi.fn(async () => undefined) as never
      });
      expect(cancelled.status).toBe("CANCELLED");
      await vi.waitFor(async () => {
        expect(await isLiveLinuxProcess(descendantPid!)).toBe(false);
      }, { timeout: 3_000, interval: 50 });
    } finally {
      if (controller.pid) {
        try { process.kill(-controller.pid, "SIGKILL"); } catch { /* already stopped */ }
      }
      if (descendantPid) {
        try { process.kill(-descendantPid, "SIGKILL"); } catch { /* already stopped */ }
      }
    }
  }, 10_000);

  it("extracts workspace ids from nested Paseo JSON", () => {
    expect(
      extractWorkspaceId(
        JSON.stringify({
          requestId: "x",
          workspace: { id: "workspace-abc", cwd: "/repo" }
        })
      )
    ).toBe("workspace-abc");
  });

  it("creates stable-shaped operation ids", () => {
    expect(createOperationId("audit", "same-seed")).toMatch(
      /^AUDIT-\d{8}T\d{6}Z-[a-f0-9]{8}$/
    );
  });

  it("falls back from an unavailable configured base ref to the current branch", async () => {
    const root = await tempRoot();
    await runProcess("git init -q && git config user.email aeh@example.invalid && git config user.name aeh && git commit --allow-empty -qm baseline && git branch -M fixture-base", { cwd: root, timeoutMs: 30_000 });
    const resolved = await resolveBaseRef(root, "main");
    expect(resolved.ref).toBe("fixture-base");
    expect(resolved.fallbackFrom).toBe("main");
  });
});

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function isLiveLinuxProcess(pid: number): Promise<boolean> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const closingParen = stat.lastIndexOf(")");
    return closingParen >= 0 && stat.slice(closingParen + 2).trim().split(/\s+/)[0] !== "Z";
  } catch {
    return false;
  }
}
