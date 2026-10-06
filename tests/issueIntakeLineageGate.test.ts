import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeProject } from "../src/core/init.js";
import { computeWorktreeDigest } from "../src/core/git.js";
import {
  bindOperationCandidate,
  claimControllerEpoch,
  loadOperation,
  patchOperation,
  recordParticipantReceipt,
  registerOperationAgent,
  saveOperation,
  transitionOperationToTerminal,
  type OperationRecordV2
} from "../src/operations/state.js";
import {
  createCandidateRevisionV1,
  type CandidateRevisionV1,
  type ParticipantReceiptV1
} from "../src/operations/v2Contracts.js";

const environmentKeys = [
  "AEH_CONTROL_ROOT", "AEH_OPERATION_ID", "AEH_OPERATION_KIND", "AEH_OPERATION_STATE_REDIRECT",
  "AEH_OPERATION_WORKSPACE_ID", "AEH_CONTROLLER_EPOCH", "AEH_CONTROLLER_TOKEN"
] as const;

const roots: string[] = [];
let previousEnvironment: Record<string, string | undefined> = {};

beforeEach(() => {
  previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  for (const key of environmentKeys) delete process.env[key];
});
afterEach(async () => {
  for (const key of environmentKeys) {
    const value = previousEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previousEnvironment = {};
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function git(root: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    execFile("git", args, { cwd: root }, (error) => (error ? reject(error) : resolve())));
}

async function fixtureRoot(name: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `aeh-${name}-`));
  roots.push(root);
  await initializeProject(root);
  await fs.writeFile(path.join(root, ".harness", "project.yaml"), `version: 1\nproject:\n  name: ${name}\nvalidation:\n  baseRef: master\n`);
  await git(root, ["init", "-q", "-b", "master"]);
  await git(root, ["config", "user.email", "intake-gate@aeh.invalid"]);
  await git(root, ["config", "user.name", "Intake Gate Test"]);
  return root;
}

function operationRecord(root: string, id: string): OperationRecordV2 {
  const now = new Date().toISOString();
  return {
    version: 2, id, kind: "change", status: "QUEUED", phase: "queued", root,
    payload: { request: "Import GitHub issue #5", issueIntake: { number: 5 } },
    revision: 1, operationExecutionRevision: 1, createdAt: now, updatedAt: now, lastProgressAt: now,
    intent: { request: "Import GitHub issue #5", classification: "CHANGE", priority: 50 },
    supervision: { required: false, materialized: false, generations: [] },
    stages: { queued: { name: "queued", status: "RUNNING", revision: 1, startedAt: now } },
    participants: {}, progress: { expected: 0, registered: 0, running: 0, completed: 0, failed: 0, blocked: 0 },
    notification: { lastLeadWakeRevision: 0, terminalDelivered: false, attempts: 0 }
  };
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function plannerReceipt(operationId: string, candidate: CandidateRevisionV1, receiptId: string, participantId: string): ParticipantReceiptV1 {
  const now = new Date().toISOString();
  return {
    version: 1, receiptId, operationId, participantId, sessionId: `${participantId}-session`,
    role: "Planner", phase: "planning", outcome: "SUCCEEDED", candidate, settled: true, createdAt: now,
    runtimeTerminal: { kind: "runtime-terminal", eventId: `event-${receiptId}`, observedAt: now, terminal: true, status: "SUCCEEDED", exitCode: 0 },
    contract: { contractId: "task:GH-5", contractDigest: "b".repeat(64), valid: true },
    artifact: { artifactId: `artifact-${receiptId}`, artifactDigest: "c".repeat(64), persisted: true, persistedAt: now },
    provenance: { provenanceId: `provenance-${receiptId}`, provenanceDigest: "d".repeat(64), source: "test", valid: true }
  };
}

function intakeEvidence(contractDigest: string, candidateAdvanced: boolean): Record<string, unknown> {
  return {
    version: 1,
    taskId: "GH-5",
    route: "DELEGATED",
    normalizedBy: "planner+semantic-assessment",
    snapshot: { repository: "owner/repo", number: 5, contentSha256: "a".repeat(64), path: ".harness/issues/GH-5.json" },
    contract: { path: ".harness/contracts/GH-5.yaml", digest: contractDigest },
    planner: { participantId: "planner-1", sessionId: "planner-1-session" },
    candidateAdvanced
  };
}

async function writeIntakeContract(root: string): Promise<string> {
  const content = "version: 1\ntask: GH-5\n";
  await fs.mkdir(path.join(root, ".harness", "contracts"), { recursive: true });
  await fs.writeFile(path.join(root, ".harness", "contracts", "GH-5.yaml"), content);
  return sha256Hex(content);
}

async function advanceCandidate(root: string, operationId: string): Promise<CandidateRevisionV1> {
  // Mirror the controller: authoring writes non-ignored artifacts, then the
  // candidate lineage advances explicitly with a strict parent link.
  await fs.mkdir(path.join(root, "specs", "changes", "GH-5"), { recursive: true });
  await fs.writeFile(path.join(root, "specs", "changes", "GH-5", "proposal.md"), "# GH-5\n");
  const current = (await loadOperation(root, operationId)).candidateRevision!;
  const next = createCandidateRevisionV1({
    operationId,
    candidateId: `candidate:${operationId}:r${current.revision + 1}`,
    projectId: current.projectId,
    taskId: current.taskId,
    revision: current.revision + 1,
    parentCandidateId: current.candidateId,
    sourceDigest: await computeWorktreeDigest(root),
    workspace: current.workspace,
    worktree: current.worktree,
    createdAt: new Date().toISOString()
  });
  await bindOperationCandidate(root, operationId, next);
  return next;
}

describe("issue intake terminal lineage gate (B-NEW-3)", () => {
  it("rejects a forked Planner receipt from a divergent lineage even when revision arithmetic matches", async () => {
    const root = await fixtureRoot("intake-lineage-fork");
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-q", "-m", "baseline"]);
    const operation = operationRecord(root, "CHANGE-INTAKE-FORK");
    await saveOperation(root, operation);
    await claimControllerEpoch(root, operation.id, `controller:test:${operation.id}`);
    const contractDigest = await writeIntakeContract(root);
    await advanceCandidate(root, operation.id);
    const current = (await loadOperation(root, operation.id)).candidateRevision!;
    expect(current.revision).toBe(2);

    // Divergent lineage: same operation, same revision number as the true
    // parent (current.revision - 1) so receipt.revision + 1 === current.revision,
    // but a foreign candidate identity that is NOT the recorded parent.
    const fork = createCandidateRevisionV1({
      operationId: operation.id,
      candidateId: `candidate:${operation.id}:r1-fork`,
      projectId: current.projectId,
      taskId: current.taskId,
      revision: 1,
      sourceDigest: "e".repeat(64),
      worktree: root,
      createdAt: new Date().toISOString()
    });
    expect(fork.revision + 1).toBe(current.revision);
    expect(fork.identityDigest).not.toBe(current.identityDigest);
    expect(fork.candidateId).not.toBe(current.parentCandidateId);
    await patchOperation(root, operation.id, {
      participantReceipts: { "receipt:planner:fork": plannerReceipt(operation.id, fork, "receipt:planner:fork", "planner-fork") }
    });

    await expect(transitionOperationToTerminal(root, operation.id, {
      status: "SUCCEEDED",
      phase: "issue-intake-finished",
      finishedAt: new Date().toISOString(),
      result: { issueIntake: intakeEvidence(contractDigest, true) }
    })).rejects.toThrow(/ISSUE_INTAKE_CANDIDATE_STALE/);
  });

  it("accepts the legitimate parent-bound Planner receipt after controller advancement", async () => {
    const root = await fixtureRoot("intake-lineage-legit");
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-q", "-m", "baseline"]);
    const operation = operationRecord(root, "CHANGE-INTAKE-LEGIT");
    await saveOperation(root, operation);
    await claimControllerEpoch(root, operation.id, `controller:test:${operation.id}`);
    await registerOperationAgent(root, operation.id, { id: "planner-1", role: "Planner" });
    const parent = (await loadOperation(root, operation.id)).candidateRevision!;
    await recordParticipantReceipt(root, operation.id, plannerReceipt(operation.id, parent, "receipt:planner:legit", "planner-1"));
    const contractDigest = await writeIntakeContract(root);
    const current = await advanceCandidate(root, operation.id);
    expect(current.parentCandidateId).toBe(parent.candidateId);

    const result = await transitionOperationToTerminal(root, operation.id, {
      status: "SUCCEEDED",
      phase: "issue-intake-finished",
      finishedAt: new Date().toISOString(),
      result: { issueIntake: intakeEvidence(contractDigest, true) }
    });
    expect(result.record.status).toBe("SUCCEEDED");
    expect(result.record.candidateRevision?.candidateId).toBe(current.candidateId);
  });

  it("accepts a directly bound Planner receipt when the candidate did not advance", async () => {
    const root = await fixtureRoot("intake-lineage-direct");
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-q", "-m", "baseline"]);
    const operation = operationRecord(root, "CHANGE-INTAKE-DIRECT");
    await saveOperation(root, operation);
    await claimControllerEpoch(root, operation.id, `controller:test:${operation.id}`);
    await registerOperationAgent(root, operation.id, { id: "planner-1", role: "Planner" });
    const current = (await loadOperation(root, operation.id)).candidateRevision!;
    await recordParticipantReceipt(root, operation.id, plannerReceipt(operation.id, current, "receipt:planner:direct", "planner-1"));
    const contractDigest = await writeIntakeContract(root);

    const result = await transitionOperationToTerminal(root, operation.id, {
      status: "SUCCEEDED",
      phase: "issue-intake-finished",
      finishedAt: new Date().toISOString(),
      result: { issueIntake: intakeEvidence(contractDigest, false) }
    });
    expect(result.record.status).toBe("SUCCEEDED");
  });
});
