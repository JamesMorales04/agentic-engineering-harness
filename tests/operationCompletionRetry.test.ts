import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadOperationCompletionTarget,
  notifyOperationCompletion,
  registerOperationCompletionTarget
} from "../src/operations/completion.js";
import { bindOperationLead, loadOperation, saveOperation, transitionOperationToTerminal, type OperationRecordV2 } from "../src/operations/state.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-completion-retry-"));
  roots.push(root);
  return root;
}
function operation(root: string): OperationRecordV2 {
  const now = new Date().toISOString();
  return {
    version: 2,
    id: "AUDIT-RETRY",
    kind: "audit",
    status: "RUNNING",
    phase: "reviewing",
    root,
    payload: { request: "review" },
    revision: 1,
    createdAt: now,
    updatedAt: now,
    lastProgressAt: now,
    supervision: { required: true, materialized: false, generations: [] },
    stages: {},
    participants: {},
    progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 }
  };
}

describe("terminal completion fallback", () => {
  it("retries an explicitly rejected send and stops immediately after Paseo accepts a later turn", async () => {
    const root = await tempRoot();
    await saveOperation(root, operation(root));
    await bindOperationLead(root, "AUDIT-RETRY", "lead-1", "test");
    await registerOperationCompletionTarget(root, "AUDIT-RETRY", "lead-1", "test", vi.fn(async () => undefined));
    const terminal = await transitionOperationToTerminal(root, "AUDIT-RETRY", {
      status: "SUCCEEDED",
      phase: "finished",
      finishedAt: new Date().toISOString(),
      result: { report: ".harness/audits/AUDIT-RETRY.json" }
    });
    const dispatch = vi.fn()
      .mockResolvedValueOnce({ id: "lead-1", exitCode: 1, stdout: "", stderr: "daemon busy", status: "failed", transport: "sdk" })
      .mockResolvedValueOnce({ id: "lead-1", exitCode: 0, stdout: "", stderr: "", status: "working", transport: "sdk" });

    const completion = await notifyOperationCompletion(root, terminal.record, {
      dispatch: dispatch as never,
      trace: vi.fn(async () => undefined) as never,
      retryDelaysMs: [0, 0, 0],
      sleep: vi.fn(async () => undefined)
    });

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(completion).toEqual(expect.objectContaining({ status: "SENT", attempts: 2 }));
    expect((await loadOperation(root, "AUDIT-RETRY")).notification.terminalDelivered).toBe(true);
  });

  it("persists three exhausted attempts without rewriting a successful operation result", async () => {
    const root = await tempRoot();
    await saveOperation(root, operation(root));
    await bindOperationLead(root, "AUDIT-RETRY", "lead-1", "test");
    await registerOperationCompletionTarget(root, "AUDIT-RETRY", "lead-1", "test", vi.fn(async () => undefined));
    const terminal = await transitionOperationToTerminal(root, "AUDIT-RETRY", {
      status: "SUCCEEDED",
      phase: "finished",
      finishedAt: new Date().toISOString(),
      result: { status: "PASS" }
    });
    const dispatch = vi.fn(async () => ({ id: "lead-1", exitCode: 1, stdout: "", stderr: "offline", status: "failed", transport: "sdk" as const }));

    const completion = await notifyOperationCompletion(root, terminal.record, {
      dispatch: dispatch as never,
      trace: vi.fn(async () => undefined) as never,
      retryDelaysMs: [0, 0, 0],
      sleep: vi.fn(async () => undefined)
    });
    const current = await loadOperation(root, "AUDIT-RETRY");

    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(completion).toEqual(expect.objectContaining({ status: "FAILED", attempts: 3, error: "offline" }));
    expect((await loadOperationCompletionTarget(root, "AUDIT-RETRY"))?.attempts).toBe(3);
    expect(current.status).toBe("SUCCEEDED");
    expect(current.result).toEqual({ status: "PASS" });
    expect(current.cleanupWarnings?.some((warning) => warning.startsWith("completion callback:"))).toBe(true);
  });
});
