import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleCandidateChangeSet, type ChangeSetV1 } from "../src/candidates/assembler.js";
import { bindAssembledCandidate } from "../src/candidates/binding.js";
import { bindOperationCandidate, loadOperation } from "../src/operations/state.js";
import { computeWorktreeDigest } from "../src/core/git.js";
import { sha256Canonical, sha256Utf8 } from "../src/core/digest.js";
import type { CandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { runExecutable, runShell } from "../src/utils/process.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

const TASK = "TASK-BIND-RECEIPT";

describe("candidate bind + assembly-receipt atomicity (B-NEW-1)", () => {
  it("binds the candidate and records its assembly receipt in a single durable commit", async () => {
    const root = await createRepo();
    const operationId = "RUN-BIND-RECEIPT-ATOMIC";
    const base = await createOperation(root, operationId);
    const revisionBefore = (await loadOperation(root, operationId)).revision;
    const change = await makeChangeSet(root, base, "wu-atomic", "src/a.ts", "export const a = 2;\n");

    const assembled = await assembleCandidateChangeSet({
      root,
      operationId,
      projectId: base.projectId,
      taskId: TASK,
      currentCandidate: base,
      changeSet: change,
      allowedScope: ["src/**"],
      candidateId: `candidate:${operationId}:r${base.revision + 1}`
    });
    const bound = await bindAssembledCandidate({ root, stateRoot: root, operationId, baseCandidate: base, candidate: assembled.candidate, changeSet: change });

    expect(bound.revision).toBe(base.revision + 1);
    const operation = await loadOperation(root, operationId);
    // Single durable commit: exactly one operation revision covers bind + receipt.
    // Two durable commits (bind, then receipt) leave a crash window with a
    // bound-but-unreceipted revision (orphan) and advance the revision by two.
    expect(operation.revision).toBe(revisionBefore + 1);
    expect(operation.candidateRevision?.identityDigest).toBe(assembled.candidate.identityDigest);
    const assemblyId = `assembly:${operationId}:${assembled.candidate.candidateId}`;
    const receipt = operation.candidateAssemblyReceipts?.[assemblyId];
    expect(receipt).toBeDefined();
    expect(receipt).toMatchObject({
      operationId,
      taskId: TASK,
      workUnitId: "wu-atomic",
      baseCandidateId: base.candidateId,
      baseRevision: base.revision,
      baseIdentityDigest: base.identityDigest,
      candidateId: assembled.candidate.candidateId,
      revision: assembled.candidate.revision,
      identityDigest: assembled.candidate.identityDigest,
      changeSetDigest: sha256Canonical(change),
      patchDigest: change.patchDigest
    });
  });

  it("a crash-retry after a durable bind without receipt self-heals to bound+receipted", async () => {
    const root = await createRepo();
    const operationId = "RUN-BIND-RECEIPT-RETRY";
    const base = await createOperation(root, operationId);
    const change = await makeChangeSet(root, base, "wu-retry", "src/a.ts", "export const a = 2;\n");
    const assembled = await assembleCandidateChangeSet({
      root,
      operationId,
      projectId: base.projectId,
      taskId: TASK,
      currentCandidate: base,
      changeSet: change,
      allowedScope: ["src/**"],
      candidateId: `candidate:${operationId}:r${base.revision + 1}`
    });

    // Simulate the crash window: the bind durably commits but the process
    // dies before the assembly receipt is recorded.
    await bindOperationCandidate(root, operationId, assembled.candidate);
    const orphan = await loadOperation(root, operationId);
    expect(orphan.candidateRevision?.identityDigest).toBe(assembled.candidate.identityDigest);
    const orphanAssemblyId = `assembly:${operationId}:${assembled.candidate.candidateId}`;
    expect(orphan.candidateAssemblyReceipts?.[orphanAssemblyId]).toBeUndefined();

    // Re-running the bind with the same (base, candidate, changeSet) inputs
    // must converge to bound ⟺ receipted instead of deadlocking or
    // double-advancing the revision.
    const healed = await bindAssembledCandidate({ root, stateRoot: root, operationId, baseCandidate: base, candidate: assembled.candidate, changeSet: change });
    expect(healed.identityDigest).toBe(assembled.candidate.identityDigest);
    const operation = await loadOperation(root, operationId);
    expect(operation.candidateRevision?.revision).toBe(base.revision + 1);
    expect(operation.candidateAssemblyReceipts?.[orphanAssemblyId]?.identityDigest).toBe(assembled.candidate.identityDigest);
    expect(await computeWorktreeDigest(root)).toBe(assembled.candidate.sourceDigest);
  });

  it("a rejected bind leaves no receipt, no revision advance, and the base tree", async () => {
    const root = await createRepo();
    const operationId = "RUN-BIND-RECEIPT-ROLLBACK";
    const base = await createOperation(root, operationId);
    const revisionBefore = (await loadOperation(root, operationId)).revision;
    const change = await makeChangeSet(root, base, "wu-rollback", "src/a.ts", "export const a = 2;\n");
    const assembled = await assembleCandidateChangeSet({
      root,
      operationId,
      projectId: base.projectId,
      taskId: TASK,
      currentCandidate: base,
      changeSet: change,
      allowedScope: ["src/**"],
      candidateId: `candidate:${operationId}:r${base.revision + 1}`
    });
    // A candidate that cannot bind (broken parent lineage).
    const unbindable: CandidateRevisionV1 = { ...assembled.candidate, parentCandidateId: "candidate:bogus" };

    await expect(bindAssembledCandidate({ root, stateRoot: root, operationId, baseCandidate: base, candidate: unbindable, changeSet: change }))
      .rejects.toThrow();
    const operation = await loadOperation(root, operationId);
    expect(operation.revision).toBe(revisionBefore);
    expect(operation.candidateRevision?.identityDigest).toBe(base.identityDigest);
    expect(operation.candidateAssemblyReceipts?.[`assembly:${operationId}:${unbindable.candidateId}`]).toBeUndefined();
    expect(await computeWorktreeDigest(root)).toBe(base.sourceDigest);
  });
});

async function createRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-bind-receipt-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  await fs.writeFile(path.join(root, ".gitignore"), ".harness/\n");
  await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.com commit -qm initial", { cwd: root });
  return root;
}

async function createOperation(root: string, operationId: string): Promise<CandidateRevisionV1> {
  const now = new Date().toISOString();
  await saveOwnedOperation(root, { version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "implementation", root, payload: { taskId: TASK }, createdAt: now, updatedAt: now });
  return (await loadOperation(root, operationId)).candidateRevision!;
}

async function makeChangeSet(root: string, base: CandidateRevisionV1, workUnitId: string, file: string, content: string): Promise<ChangeSetV1> {
  const absolute = path.join(root, file);
  const previous = await fs.readFile(absolute, "utf8");
  const indexFile = path.join(root, ".git", `aeh-test-index-${crypto.randomUUID()}`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    const readTree = await runExecutable("git", ["read-tree", "HEAD"], { cwd: root, timeoutMs: 30_000, env });
    const stageCurrent = readTree.exitCode === 0 ? await runExecutable("git", ["add", "-A"], { cwd: root, timeoutMs: 30_000, env }) : readTree;
    const baseTree = stageCurrent.exitCode === 0 ? await runExecutable("git", ["write-tree"], { cwd: root, timeoutMs: 30_000, env }) : stageCurrent;
    if (baseTree.exitCode !== 0 || !baseTree.stdout.trim()) throw new Error(`test base snapshot failed: ${baseTree.stderr || baseTree.stdout}`);
    await fs.writeFile(absolute, content);
    const stageChange = await runExecutable("git", ["add", "-A", "--", file], { cwd: root, timeoutMs: 30_000, env });
    if (stageChange.exitCode !== 0) throw new Error(`test change staging failed: ${stageChange.stderr || stageChange.stdout}`);
    const diff = await runExecutable("git", ["diff", "--cached", "--binary", baseTree.stdout.trim(), "--", file], { cwd: root, timeoutMs: 30_000, env });
    if (diff.exitCode !== 0 || !diff.stdout.trim()) throw new Error(`test patch generation failed: ${diff.stderr || diff.stdout}`);
    return {
      version: 1,
      operationId: base.operationId,
      taskId: base.taskId!,
      workUnitId,
      participantId: `participant:${workUnitId}`,
      baseCandidateRevision: base.revision,
      baseCandidateDigest: base.identityDigest,
      changedFiles: [file],
      patch: diff.stdout,
      patchDigest: sha256Utf8(diff.stdout)
    };
  } finally {
    await fs.writeFile(absolute, previous);
    await fs.rm(indexFile, { force: true }).catch(() => undefined);
  }
}
