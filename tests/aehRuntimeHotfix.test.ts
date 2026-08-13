import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  evaluateOperationWake,
  operationLivenessPolicy,
  runOperationLivenessCheck
} from "../src/operations/liveness.js";
import { acknowledgeOperationRevision, readOperationStatus } from "../src/operations/mcp.js";
import {
  bindOperationLead,
  loadOperation,
  patchOperationMetadata,
  registerSupervisorGeneration,
  saveOperation,
  setOperationStage,
  transitionOperationToTerminal,
  type OperationRecordV2
} from "../src/operations/state.js";
import {
  loadOperationWakeBudget,
  recordOperationWakeAccepted
} from "../src/operations/wakeBudget.js";

const roots: string[] = [];
const originalEnv = snapshotEnv(["AEH_OPERATION_ID", "AEH_CONTROL_ROOT", "AEH_PARENT_OPERATION_ID"]);
beforeEach(() => clearEnv(Object.keys(originalEnv)));
afterEach(async () => {
  restoreEnv(originalEnv);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-runtime-hotfix-"));
  roots.push(root);
  return root;
}

function operation(root: string): OperationRecordV2 {
  const now = new Date().toISOString();
  return {
    version: 2,
    id: "AUDIT-HOTFIX",
    kind: "audit",
    status: "RUNNING",
    phase: "supervision",
    root,
    payload: { request: "audit runtime" },
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

describe("AEH runtime hotfix", () => {
  it("keeps status reads read-only and acknowledges only through the explicit exact-revision lead primitive", async () => {
    const root = await tempRoot();
    await saveOperation(root, operation(root));
    let current = await bindOperationLead(root, "AUDIT-HOTFIX", "lead-1", "test");
    const boundRevision = current.revision;
    current = await setOperationStage(root, "AUDIT-HOTFIX", "reviewing", "RUNNING");
    expect(current.revision).toBeGreaterThan(boundRevision);
    expect(current.lead?.acknowledgedRevision).toBe(boundRevision);

    const compactRead = await readOperationStatus(root, "AUDIT-HOTFIX");
    expect(compactRead).toEqual(expect.objectContaining({ operationId: "AUDIT-HOTFIX", revision: current.revision }));
    expect((await loadOperation(root, "AUDIT-HOTFIX")).lead?.acknowledgedRevision).toBe(boundRevision);

    await expect(acknowledgeOperationRevision(root, "AUDIT-HOTFIX", current.revision, {
      PASEO_AGENT_ID: "worker-1",
      AEH_MANAGED_AGENT: "1",
      AEH_INTERACTIVE_LEAD: "0"
    })).rejects.toThrow("bound interactive lead");

    const acknowledged = await acknowledgeOperationRevision(root, "AUDIT-HOTFIX", current.revision, {
      PASEO_AGENT_ID: "lead-1",
      AEH_MANAGED_AGENT: "1",
      AEH_INTERACTIVE_LEAD: "1",
      AEH_ORCHESTRATION_ALLOWED: "1"
    });
    expect(acknowledged.acknowledgedRevision).toBe(current.revision);
    expect((await loadOperation(root, "AUDIT-HOTFIX")).lead?.acknowledgedRevision).toBe(current.revision);
  });

  it("persists a bounded stalled-revision wake budget across monitor reloads", async () => {
    const root = await tempRoot();
    await saveOperation(root, operation(root));
    let current = await bindOperationLead(root, "AUDIT-HOTFIX", "lead-1", "test");
    current = await registerSupervisorGeneration(root, "AUDIT-HOTFIX", {
      agentId: "supervisor-1",
      materialized: true
    });
    current = await patchOperationMetadata(root, "AUDIT-HOTFIX", {
      notification: {
        ...current.notification,
        lastLeadWakeRevision: current.revision,
        lastLeadWakeAt: new Date().toISOString()
      }
    });
    const policy = operationLivenessPolicy(config);
    const now = Date.parse(current.lastProgressAt) + 300_000;

    let budget = await loadOperationWakeBudget(root, "AUDIT-HOTFIX", current.revision);
    expect(evaluateOperationWake(current, policy, now, budget.supervisorAccepted, budget.leadAccepted, budget.terminalLeadAccepted).target).toBe("supervisor");

    await recordOperationWakeAccepted(root, "AUDIT-HOTFIX", current.revision, "supervisor", "stalled");
    await recordOperationWakeAccepted(root, "AUDIT-HOTFIX", current.revision, "supervisor", "stalled");
    budget = await loadOperationWakeBudget(root, "AUDIT-HOTFIX", current.revision);
    expect(budget.supervisorAccepted).toBe(2);
    expect(evaluateOperationWake(current, policy, now, budget.supervisorAccepted, budget.leadAccepted, budget.terminalLeadAccepted).target).toBe("lead");

    await recordOperationWakeAccepted(root, "AUDIT-HOTFIX", current.revision, "lead", "stalled");
    const reloadedAfterRestart = await loadOperationWakeBudget(root, "AUDIT-HOTFIX", current.revision);
    const exhausted = evaluateOperationWake(
      current,
      policy,
      now,
      reloadedAfterRestart.supervisorAccepted,
      reloadedAfterRestart.leadAccepted,
      reloadedAfterRestart.terminalLeadAccepted
    );
    expect(exhausted.target).toBe("none");
    expect(exhausted.message).toContain("wake budget exhausted");

    const nextRevisionBudget = await loadOperationWakeBudget(root, "AUDIT-HOTFIX", current.revision + 1);
    expect(nextRevisionBudget).toEqual(expect.objectContaining({ supervisorAccepted: 0, leadAccepted: 0, terminalLeadAccepted: 0 }));
  });

  it("suppresses further terminal LLM wakes after the durable retry budget is exhausted", async () => {
    const root = await tempRoot();
    await saveOperation(root, operation(root));
    await bindOperationLead(root, "AUDIT-HOTFIX", "lead-1", "test");
    const terminal = await transitionOperationToTerminal(root, "AUDIT-HOTFIX", {
      status: "CANCELLED",
      phase: "cancelled",
      finishedAt: new Date().toISOString()
    });
    const oldWake = new Date(Date.now() - 300_000).toISOString();
    const current = await patchOperationMetadata(root, "AUDIT-HOTFIX", {
      notification: {
        ...terminal.record.notification,
        terminalDelivered: true,
        lastLeadWakeRevision: terminal.record.revision,
        lastLeadWakeAt: oldWake,
        lastLeadWakeReason: "terminal",
        attempts: 1
      }
    });
    await recordOperationWakeAccepted(root, "AUDIT-HOTFIX", current.revision, "lead", "terminal");
    await recordOperationWakeAccepted(root, "AUDIT-HOTFIX", current.revision, "lead", "terminal");

    const dispatch = vi.fn(async () => ({
      id: "lead-1",
      exitCode: 0,
      stdout: "",
      stderr: "",
      status: "working",
      transport: "sdk" as const
    }));
    const decision = await runOperationLivenessCheck(root, config, "AUDIT-HOTFIX", {
      dispatch: dispatch as never,
      inspect: vi.fn(async () => ({ id: "lead-1", status: "idle" })) as never,
      trace: vi.fn(async () => undefined) as never,
      now: () => Date.now(),
      sleep: vi.fn(async () => undefined)
    });
    expect(decision.target).toBe("none");
    expect(decision.message).toContain("terminal lead wake budget exhausted");
    expect(dispatch).not.toHaveBeenCalled();
    expect((await loadOperation(root, "AUDIT-HOTFIX")).lead?.acknowledgedRevision).toBeLessThan(current.revision);
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
