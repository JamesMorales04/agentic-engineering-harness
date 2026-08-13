import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acknowledgeOperationLead,
  activeOperationSupervisor,
  bindOperationLead,
  loadOperation,
  operationEventsFile,
  registerOperationAgent,
  registerSupervisorGeneration,
  saveOperation,
  setOperationStage,
  transitionOperationToTerminal,
  updateOperationParticipant,
  updateSupervisorGeneration,
  type OperationRecordV2
} from "../src/operations/state.js";

const roots: string[] = [];
afterEach(async () => {
  delete process.env.AEH_OPERATION_ID;
  delete process.env.AEH_CONTROL_ROOT;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-supervision-state-"));
  roots.push(value);
  return value;
}

function operation(repositoryRoot: string): OperationRecordV2 {
  const now = new Date().toISOString();
  return {
    version: 2,
    id: "CHANGE-STATE",
    kind: "change",
    status: "QUEUED",
    phase: "queued",
    root: repositoryRoot,
    payload: { request: "implement change" },
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

describe("OperationRecord v2 supervision", () => {
  it("keeps supervisor generations out of participant completion progress", async () => {
    const repositoryRoot = await root();
    await saveOperation(repositoryRoot, operation(repositoryRoot));
    await bindOperationLead(repositoryRoot, "CHANGE-STATE", "lead-1", "test");
    let current = await registerSupervisorGeneration(repositoryRoot, "CHANGE-STATE", {
      agentId: "supervisor-1",
      materialized: true
    });

    expect(activeOperationSupervisor(current)?.agentId).toBe("supervisor-1");
    expect(current.participants).toEqual({});
    expect(current.progress.expected).toBe(0);

    current = await registerOperationAgent(repositoryRoot, "CHANGE-STATE", {
      id: "worker-1",
      logicalAgent: "backend-implementer",
      role: "implementer",
      phase: "implementation",
      parentAgentId: "supervisor-1",
      parentSupervisorGeneration: 1,
      transport: "sdk"
    });
    expect(current.progress.expected).toBe(1);
    expect(current.participants["worker-1"]).toEqual(expect.objectContaining({
      parentAgentId: "supervisor-1",
      parentSupervisorGeneration: 1,
      status: "REGISTERED"
    }));

    current = await updateOperationParticipant(repositoryRoot, "CHANGE-STATE", "worker-1", { status: "RUNNING" });
    expect(current.progress.running).toBe(1);
    current = await updateOperationParticipant(repositoryRoot, "CHANGE-STATE", "worker-1", {
      status: "COMPLETED",
      resultArtifact: ".harness/operations/CHANGE-STATE/agents/worker-1.json"
    });
    expect(current.progress.completed).toBe(1);
    expect(current.progress.running).toBe(0);
  });

  it("supports ACTIVE -> DRAINING -> new ACTIVE generations without reparenting old children", async () => {
    const repositoryRoot = await root();
    await saveOperation(repositoryRoot, operation(repositoryRoot));
    await registerSupervisorGeneration(repositoryRoot, "CHANGE-STATE", {
      agentId: "supervisor-1",
      materialized: true
    });
    await registerOperationAgent(repositoryRoot, "CHANGE-STATE", {
      id: "old-child",
      logicalAgent: "security-reviewer",
      role: "reviewer",
      phase: "review",
      parentAgentId: "supervisor-1",
      parentSupervisorGeneration: 1,
      transport: "sdk"
    });
    await updateSupervisorGeneration(repositoryRoot, "CHANGE-STATE", 1, {
      status: "DRAINING",
      checkpointArtifact: ".harness/operations/CHANGE-STATE/supervisors/generation-1.json"
    });
    const current = await registerSupervisorGeneration(repositoryRoot, "CHANGE-STATE", {
      agentId: "supervisor-2",
      materialized: true
    });

    expect(activeOperationSupervisor(current)?.agentId).toBe("supervisor-2");
    expect(current.supervision.activeGeneration).toBe(2);
    expect(current.supervision.generations.find((item) => item.generation === 1)?.status).toBe("DRAINING");
    expect(current.participants["old-child"].parentSupervisorGeneration).toBe(1);
    expect(current.participants["old-child"].parentAgentId).toBe("supervisor-1");
  });

  it("records stage revisions and requires explicit lead acknowledgement after terminalization", async () => {
    const repositoryRoot = await root();
    await saveOperation(repositoryRoot, operation(repositoryRoot));
    let current = await bindOperationLead(repositoryRoot, "CHANGE-STATE", "lead-1", "test");
    const initialAck = current.lead!.acknowledgedRevision;
    current = await setOperationStage(repositoryRoot, "CHANGE-STATE", "planning", "RUNNING");
    expect(current.revision).toBeGreaterThan(initialAck);
    expect(current.lead!.acknowledgedRevision).toBe(initialAck);

    const terminal = await transitionOperationToTerminal(repositoryRoot, "CHANGE-STATE", {
      status: "SUCCEEDED",
      phase: "finished",
      finishedAt: new Date().toISOString(),
      result: { status: "PASS" }
    });
    expect(terminal.transitioned).toBe(true);
    expect(terminal.record.lead!.acknowledgedRevision).toBeLessThan(terminal.record.revision);

    current = await acknowledgeOperationLead(repositoryRoot, "CHANGE-STATE", terminal.record.revision, "status-read");
    expect(current.lead!.acknowledgedRevision).toBe(current.revision);

    const events = (await fs.readFile(operationEventsFile(repositoryRoot, "CHANGE-STATE"), "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string; revision: number });
    expect(events.some((event) => event.type === "operation.stage")).toBe(true);
    expect(events.some((event) => event.type === "operation.terminal")).toBe(true);
  });

  it("uses AEH_CONTROL_ROOT for one durable state machine from an isolated worktree", async () => {
    const repositoryRoot = await root();
    const worktree = await root();
    await saveOperation(repositoryRoot, operation(repositoryRoot));
    process.env.AEH_OPERATION_ID = "CHANGE-STATE";
    process.env.AEH_CONTROL_ROOT = repositoryRoot;

    await setOperationStage(worktree, "CHANGE-STATE", "implementation", "RUNNING");
    const current = await loadOperation(repositoryRoot, "CHANGE-STATE");
    expect(current.phase).toBe("implementation");
    await expect(fs.access(path.join(worktree, ".harness/operations/CHANGE-STATE.json"))).rejects.toThrow();
  });
});
