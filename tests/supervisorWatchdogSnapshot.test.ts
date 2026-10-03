import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { evaluateOperationWake, operationLivenessPolicy, runOperationLivenessCheck } from "../src/operations/liveness.js";
import { loadOperationWakeBudget } from "../src/operations/wakeBudget.js";
import { bindOperationLead, loadOperation, registerOperationAgent, registerSupervisorGeneration, saveOperation, updateOperationMetadata, updateOperationParticipant, type OperationRecordV2 } from "../src/operations/state.js";

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
  await saveOwnedOperation(root, record);
  await bindOperationLead(root, record.id, "lead-1", "test");
  await registerSupervisorGeneration(root, record.id, { agentId: "supervisor-1", materialized: true });
  await registerOperationAgent(root, record.id, { id: "reviewer-1", role: "reviewer", logicalAgent: "test-reviewer", phase: "reviewing" });
  await updateOperationParticipant(root, record.id, "reviewer-1", { status: "RUNNING" });
  const staleAt = new Date(Date.now() - 20 * 60_000).toISOString();
  await updateOperationMetadata(root, record.id, (current) => ({
    lastProgressAt: staleAt,
    participants: { ...current.participants, "reviewer-1": { ...current.participants["reviewer-1"]!, startedAt: staleAt, registeredAt: staleAt } }
  }));
  const skill = path.join(root, ".harness/controller/AUDIT-WATCH/files/skills/recovery-classifier/SKILL.md");
  await fs.mkdir(path.dirname(skill), { recursive: true });
  await fs.writeFile(skill, "# Recovery Classifier\nRECOVERY_SKILL_SENTINEL\n");
  return { root, now: Date.now() + 300_000 };
}

it("wakes the Supervisor when a runtime-active participant has no meaningful progress", async () => {
  const { root, now } = await fixture();
  const dispatch = vi.fn(async (_root: string, id: string) => ({ id, exitCode: 0, stdout: "", stderr: "", status: "working", transport: "sdk" as const }));
  const decision = await runOperationLivenessCheck(root, config, "AUDIT-WATCH", { dispatch: dispatch as never, inspect: vi.fn(async (_root: string, id: string) => ({ id, status: id === "reviewer-1" ? "running" : "idle" })) as never, trace: vi.fn(async () => undefined) as never, now: () => now });
  expect(decision.target).toBe("supervisor");
  expect(decision.reason).toBe("stalled");
  expect(dispatch).toHaveBeenCalledTimes(1);
});

it("loads recovery-classifier only when an idle supervisor actually receives a watchdog wake", async () => {
  const { root, now } = await fixture();
  const dispatch = vi.fn(async (_root: string, id: string) => ({ id, exitCode: 0, stdout: "", stderr: "", status: "working", transport: "sdk" as const }));
  const analyst = {
    version: 1, kind: "OPERATIONS_ANALYST_ADVISORY", authority: "ADVISORY_ONLY", mechanism: "MODEL", operationId: "AUDIT-WATCH",
    assessmentDigest: "a".repeat(64), evidenceDigest: "b".repeat(64), classification: "POSSIBLE_STALL", probableCause: "PROVIDER_STALL",
    suggestedSupervisorAction: "RESUME_SAME_SESSION", rationale: "No high or medium activity has arrived inside the frozen lease window.",
    evidenceRefs: ["operation://AUDIT-WATCH/watchdog/1"], unknowns: ["Provider progress is not observable beyond its last heartbeat."]
  } as const;
  const analyzeOperations = vi.fn(async () => analyst);
  await runOperationLivenessCheck(root, config, "AUDIT-WATCH", { dispatch: dispatch as never, inspect: vi.fn(async (_root: string, id: string) => ({ id, status: "idle" })) as never, trace: vi.fn(async () => undefined) as never, sleep: vi.fn(async () => undefined), analyzeOperations: analyzeOperations as never, now: () => now });
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(dispatch.mock.calls[0]?.[1]).toBe("supervisor-1");
  const prompt = String(dispatch.mock.calls[0]?.[2]);
  expect(prompt).toContain("Deterministic watchdog snapshot");
  expect(prompt).toContain('"logicalAgent":"test-reviewer"');
  expect(prompt).toContain("Do not run shell commands");
  expect(prompt).toContain("RECOVERY_SKILL_SENTINEL");
  expect(prompt).toContain("ADVISORY_ONLY");
  expect(prompt).toContain("Treat this as a hypothesis");
  expect(analyzeOperations).toHaveBeenCalledTimes(1);
});

it("does not mistake an unobservable provider heartbeat gap for a hung turn and enforces the Owner hard deadline", async () => {
  const { root } = await fixture();
  const operation = await loadOperation(root, "AUDIT-WATCH");
  const startedAt = Date.parse(operation.createdAt);
  const policy = operationLivenessPolicy({ ...config, orchestration: { operations: { liveness: { hardDeadlineMs: 8 * 60 * 60_000, progressLeaseMs: 15 * 60_000, stallWindowMs: 15 * 60_000, providerTurnDeadlineMs: 30 * 60_000 } } } } as never, operation);
  const waiting = {
    ...operation,
    lastProgressAt: new Date(startedAt).toISOString(),
    participants: {
      ...operation.participants,
      "reviewer-1": {
        ...operation.participants["reviewer-1"],
        executionLiveness: { version: 1, state: "WAITING_PROVIDER", startedAt: new Date(startedAt).toISOString(), lastActivityAt: new Date(startedAt).toISOString(), waitingKind: "PROVIDER", waitingSinceAt: new Date(startedAt).toISOString(), waitingDeadlineAt: new Date(startedAt + 30 * 60_000).toISOString(), progressLease: { expiresAt: new Date(startedAt + 15 * 60_000).toISOString() }, toolCallsBeforeFirstMutation: 0, turnsBeforeFirstMutation: null, providerTurns: 1, currentProviderTurnBudget: 8, toolCallCount: 0, repositoryMutationCount: 0, artifactCount: 0, validationCount: 0, noProgressRenewals: 0, participantRestarts: 0 }
      }
    }
  } as OperationRecordV2;
  expect(evaluateOperationWake(waiting, policy, startedAt + 6 * 60_000, 0, 0, 0).reason).toBeUndefined();
  expect(evaluateOperationWake(waiting, policy, startedAt + 16 * 60_000, 0, 0, 0)).toMatchObject({ reason: "stalled", target: "supervisor" });
  expect(evaluateOperationWake(waiting, policy, startedAt + 31 * 60_000, 0, 0, 0)).toMatchObject({ reason: "stalled", target: "supervisor" });
  expect(evaluateOperationWake(operation, { ...policy, hardDeadlineMs: 1_000 }, startedAt + 1_001, 0, 0, 0)).toMatchObject({ reason: "hard-deadline", target: "controller" });
});

it("escalates to the Lead after bounded Supervisor-busy recovery opportunities", async () => {
  const { root, now } = await fixture();
  const dispatch = vi.fn(async (_root: string, id: string) => ({ id, exitCode: 0, stdout: "", stderr: "", status: "working", transport: "sdk" as const }));
  const inspect = vi.fn(async (_root: string, id: string) => ({ id, status: id === "supervisor-1" || id === "reviewer-1" ? "running" : "idle" }));
  const deps = { dispatch: dispatch as never, inspect: inspect as never, trace: vi.fn(async () => undefined) as never, now: () => now };
  await runOperationLivenessCheck(root, config, "AUDIT-WATCH", deps);
  await runOperationLivenessCheck(root, config, "AUDIT-WATCH", deps);
  const latest = await loadOperation(root, "AUDIT-WATCH");
  expect((await loadOperationWakeBudget(root, "AUDIT-WATCH", latest.revision)).supervisorAccepted).toBe(2);
  await runOperationLivenessCheck(root, config, "AUDIT-WATCH", deps);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(dispatch.mock.calls[0]?.[1]).toBe("lead-1");
});
