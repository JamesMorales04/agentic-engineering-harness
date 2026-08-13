import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  evaluateOperationWake,
  operationLivenessPolicy,
  operationRevisionAcknowledged,
  runOperationLivenessCheck
} from "../src/operations/liveness.js";
import {
  acknowledgeOperationLead,
  bindOperationLead,
  loadOperation,
  patchOperationMetadata,
  registerSupervisorGeneration,
  saveOperation,
  transitionOperationToTerminal,
  type OperationRecordV2
} from "../src/operations/state.js";

const roots: string[] = [];
const originalEnv = snapshotEnv(["AEH_OPERATION_ID", "AEH_CONTROL_ROOT", "AEH_PARENT_OPERATION_ID"]);
beforeEach(() => clearEnv(Object.keys(originalEnv)));
afterEach(async () => {
  restoreEnv(originalEnv);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-liveness-"));
  roots.push(root);
  return root;
}

function base(root: string): OperationRecordV2 {
  const now = new Date().toISOString();
  return {
    version: 2,
    id: "AUDIT-LIVE",
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

const config = {
  version: 1,
  project: { name: "demo" },
  orchestration: { provider: "paseo" }
} as never;

describe("operation liveness", () => {
  it("does not equate an accepted terminal wake with lead acknowledgement", async () => {
    const root = await tempRoot();
    await saveOperation(root, base(root));
    await bindOperationLead(root, "AUDIT-LIVE", "lead-1", "test");
    const terminal = await transitionOperationToTerminal(root, "AUDIT-LIVE", {
      status: "SUCCEEDED",
      phase: "finished",
      finishedAt: new Date().toISOString(),
      result: { report: ".harness/audits/AUDIT-LIVE.json" }
    });
    const oldWake = new Date(Date.now() - 120_000).toISOString();
    let current = await patchOperationMetadata(root, "AUDIT-LIVE", {
      notification: {
        ...terminal.record.notification,
        terminalDelivered: true,
        lastLeadWakeRevision: terminal.record.revision,
        lastLeadWakeAt: oldWake,
        lastLeadWakeReason: "terminal",
        attempts: 1
      }
    });

    expect(operationRevisionAcknowledged(current)).toBe(false);
    const decision = evaluateOperationWake(current, operationLivenessPolicy(config), Date.now());
    expect(decision).toEqual(expect.objectContaining({ reason: "terminal", target: "lead" }));
    expect(decision.message).toContain("has not acknowledged");

    const dispatch = vi.fn(async () => ({
      id: "lead-1",
      exitCode: 0,
      stdout: "",
      stderr: "",
      status: "working",
      transport: "sdk" as const
    }));
    await runOperationLivenessCheck(root, config, "AUDIT-LIVE", {
      dispatch: dispatch as never,
      inspect: vi.fn(async () => ({ id: "lead-1", status: "idle" })) as never,
      trace: vi.fn(async () => undefined) as never,
      sleep: vi.fn(async () => undefined)
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(String(dispatch.mock.calls[0][2])).toContain("COMPLETED_UNACKNOWLEDGED");

    current = await loadOperation(root, "AUDIT-LIVE");
    expect(operationRevisionAcknowledged(current)).toBe(false);
    current = await acknowledgeOperationLead(root, "AUDIT-LIVE", current.revision, "operation-status");
    expect(operationRevisionAcknowledged(current)).toBe(true);
    expect(evaluateOperationWake(current, operationLivenessPolicy(config), Date.now()).target).toBe("none");
  });

  it("routes a stalled operation to the supervisor first and escalates to the lead if supervisor wake fails", async () => {
    const root = await tempRoot();
    await saveOperation(root, base(root));
    let current = await bindOperationLead(root, "AUDIT-LIVE", "lead-1", "test");
    current = await registerSupervisorGeneration(root, "AUDIT-LIVE", {
      agentId: "supervisor-1",
      materialized: true
    });
    current = await patchOperationMetadata(root, "AUDIT-LIVE", {
      notification: {
        ...current.notification,
        lastLeadWakeRevision: current.revision,
        lastLeadWakeAt: new Date().toISOString()
      }
    });
    const stalledNow = Date.parse(current.lastProgressAt) + 300_000;

    const decision = evaluateOperationWake(current, operationLivenessPolicy(config), stalledNow);
    expect(decision).toEqual(expect.objectContaining({ reason: "stalled", target: "supervisor" }));

    const dispatch = vi.fn(async (_root: string, agentId: string) => {
      if (agentId === "supervisor-1") throw new Error("supervisor unavailable");
      return {
        id: agentId,
        exitCode: 0,
        stdout: "",
        stderr: "",
        status: "working",
        transport: "sdk" as const
      };
    });
    await runOperationLivenessCheck(root, config, "AUDIT-LIVE", {
      dispatch: dispatch as never,
      inspect: vi.fn(async (_root: string, agentId: string) => ({ id: agentId, status: "idle" })) as never,
      trace: vi.fn(async () => undefined) as never,
      sleep: vi.fn(async () => undefined),
      now: () => stalledNow
    });

    const targets = dispatch.mock.calls.map((call) => call[1]);
    expect(targets[0]).toBe("supervisor-1");
    expect(targets.at(-1)).toBe("lead-1");
    expect(targets.slice(0, -1).length).toBeGreaterThan(0);
    expect(targets.slice(0, -1).every((target) => target === "supervisor-1")).toBe(true);
  });

  it("keeps a recent terminal wake quiet while waiting for the lead to acknowledge it", async () => {
    const root = await tempRoot();
    await saveOperation(root, base(root));
    await bindOperationLead(root, "AUDIT-LIVE", "lead-1", "test");
    const terminal = await transitionOperationToTerminal(root, "AUDIT-LIVE", {
      status: "SUCCEEDED",
      phase: "finished",
      finishedAt: new Date().toISOString()
    });
    const current = await patchOperationMetadata(root, "AUDIT-LIVE", {
      notification: {
        ...terminal.record.notification,
        terminalDelivered: true,
        lastLeadWakeRevision: terminal.record.revision,
        lastLeadWakeAt: new Date().toISOString(),
        attempts: 1
      }
    });
    const decision = evaluateOperationWake(current, operationLivenessPolicy(config), Date.now());
    expect(decision.target).toBe("none");
    expect(decision.message).toContain("awaiting lead acknowledgement");
  });
});

function snapshotEnv(names: string[]): Record<string, string | undefined> {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}
function clearEnv(names: string[]): void {
  for (const name of names) delete process.env[name];
}
function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
