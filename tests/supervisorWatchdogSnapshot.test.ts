import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runOperationLivenessCheck } from "../src/operations/liveness.js";
import { bindOperationLead, registerOperationAgent, registerSupervisorGeneration, saveOperation, updateOperationParticipant, type OperationRecordV2 } from "../src/operations/state.js";

const roots: string[] = [];
const originalOperationId = process.env.AEH_OPERATION_ID;
const originalControlRoot = process.env.AEH_CONTROL_ROOT;

beforeEach(() => {
  delete process.env.AEH_OPERATION_ID;
  delete process.env.AEH_CONTROL_ROOT;
});

afterEach(async () => {
  if (originalOperationId === undefined) delete process.env.AEH_OPERATION_ID;
  else process.env.AEH_OPERATION_ID = originalOperationId;
  if (originalControlRoot === undefined) delete process.env.AEH_CONTROL_ROOT;
  else process.env.AEH_CONTROL_ROOT = originalControlRoot;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const config = { version: 1, project: { name: "watchdog-test" }, orchestration: { provider: "paseo" } } as never;

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-watchdog-"));
  roots.push(root);
  const timestamp = new Date().toISOString();
  const record: OperationRecordV2 = { version: 2, id: "AUDIT-WATCH", kind: "audit", status: "RUNNING", phase: "reviewing", root, payload: { request: "review" }, revision: 1, createdAt: timestamp, updatedAt: timestamp, lastProgressAt: timestamp, supervision: { required: true, materialized: false, generations: [] }, stages: {}, participants: {}, progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 }, notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 } };
  await saveOperation(root, record);
  await bindOperationLead(root, record.id, "lead-1", "test");
  await registerSupervisorGeneration(root, record.id, { agentId: "supervisor-1", materialized: true });
  await registerOperationAgent(root, record.id, { id: "reviewer-1", role: "reviewer", logicalAgent: "test-reviewer", phase: "reviewing" });
  await updateOperationParticipant(root, record.id, "reviewer-1", { status: "RUNNING" });
  const skill = path.join(root, ".harness/controller/AUDIT-WATCH/files/skills/recovery-classifier/SKILL.md");
  await fs.mkdir(path.dirname(skill), { recursive: true });
  await fs.writeFile(skill, "# Recovery Classifier\nRECOVERY_SKILL_SENTINEL\n");
  return { root, now: Date.now() + 300_000 };
}

it("keeps an active child stall controller-only", async () => {
  const { root, now } = await fixture();
  const dispatch = vi.fn();
  const decision = await runOperationLivenessCheck(root, config, "AUDIT-WATCH", { dispatch: dispatch as never, inspect: vi.fn(async (_root: string, id: string) => ({ id, status: id === "reviewer-1" ? "running" : "idle" })) as never, trace: vi.fn(async () => undefined) as never, now: () => now });
  expect(decision.target).toBe("none");
  expect(decision.message).toContain("still active");
  expect(dispatch).not.toHaveBeenCalled();
});

it("loads recovery-classifier only when an idle supervisor actually receives a watchdog wake", async () => {
  const { root, now } = await fixture();
  const dispatch = vi.fn(async (_root: string, id: string) => ({ id, exitCode: 0, stdout: "", stderr: "", status: "working", transport: "sdk" as const }));
  await runOperationLivenessCheck(root, config, "AUDIT-WATCH", { dispatch: dispatch as never, inspect: vi.fn(async (_root: string, id: string) => ({ id, status: "idle" })) as never, trace: vi.fn(async () => undefined) as never, sleep: vi.fn(async () => undefined), now: () => now });
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(dispatch.mock.calls[0]?.[1]).toBe("supervisor-1");
  const prompt = String(dispatch.mock.calls[0]?.[2]);
  expect(prompt).toContain("Deterministic watchdog snapshot");
  expect(prompt).toContain('"logicalAgent":"test-reviewer"');
  expect(prompt).toContain("Do not run shell commands");
  expect(prompt).toContain("RECOVERY_SKILL_SENTINEL");
});
