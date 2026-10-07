import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWaveBase, integrateWaveChangeSets, type WaveChangeSetSubmissionV1 } from "../src/candidates/wave.js";
import { computeWorktreeDigest } from "../src/core/git.js";
import { sha256Utf8 } from "../src/core/digest.js";
import { loadOperation } from "../src/operations/state.js";
import type { CandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import type { ChangeSetV1 } from "../src/candidates/assembler.js";
import { runExecutable as actualRunExecutable, runShell } from "../src/utils/process.js";

/**
 * Deterministic apply barrier (B-NEW-2 RED/GREEN harness). The first mutating
 * `git apply` waits until the second concurrent assembly also reaches its
 * apply (or a bounded timeout fires), forcing the interleave that torn
 * workspaces need. Without per-operation serialization both assemblies apply
 * disjoint patches to the shared tree (mixed tree / torn state); with
 * serialization the loser never reaches `git apply` because it goes STALE
 * inside the coordination lock first, so the barrier always times out alone.
 */
let applyArrivals = 0;
let applyWaiters: Array<() => void> = [];
const APPLY_BARRIER_TIMEOUT_MS = 2_000;

function releaseApplyBarrier(): void {
  applyArrivals = 0;
  const waiters = applyWaiters.splice(0);
  waiters.forEach((resolve) => resolve());
}

async function applyBarrier(): Promise<void> {
  applyArrivals += 1;
  if (applyArrivals >= 2) {
    releaseApplyBarrier();
    return;
  }
  await new Promise<void>((resolve) => {
    applyWaiters.push(resolve);
    setTimeout(() => {
      const index = applyWaiters.indexOf(resolve);
      if (index >= 0) applyWaiters.splice(index, 1);
      resolve();
    }, APPLY_BARRIER_TIMEOUT_MS);
  });
}

vi.mock("../src/utils/process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/process.js")>();
  return {
    ...actual,
    runExecutable: async (command: string, args: readonly string[], options?: never) => {
      if (command === "git" && args[0] === "apply" && args.includes("--binary") && !args.includes("--check") && !args.includes("--reverse")) {
        await applyBarrier();
      }
      return (actual.runExecutable as typeof actualRunExecutable)(command, args, options);
    }
  };
});

const roots: string[] = [];
afterEach(async () => {
  releaseApplyBarrier();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
beforeEach(() => {
  applyArrivals = 0;
  applyWaiters = [];
});

const TASK = "TASK-ASSEMBLY-LOCK";

describe("shared-workspace assembly serialization (B-NEW-2)", () => {
  it("two concurrent wave integrations from the same base serialize without torn state", async () => {
    const root = await createRepo();
    const operationId = "RUN-ASSEMBLY-LOCK";
    const base = await createOperation(root, operationId);
    const changeA = await makeChangeSet(root, base, "wu-a", "src/a.ts", "export const a = 2;\n");
    const changeB = await makeChangeSet(root, base, "wu-b", "src/b.ts", "export const b = 2;\n");
    const wave = createWaveBase({ operationId, taskId: TASK, waveIndex: 0, candidate: base });

    const [resultA, resultB] = await Promise.all([
      integrateWaveChangeSets({ root, stateRoot: root, operationId, taskId: TASK, wave, submissions: [submission(changeA)] }),
      integrateWaveChangeSets({ root, stateRoot: root, operationId, taskId: TASK, wave, submissions: [submission(changeB)] })
    ]);

    // Exactly one integration wins at r+1; the loser gets a clean,
    // retryable stale signal — never a torn workspace or mixed-tree bind.
    const integratedCount = resultA.integrated.length + resultB.integrated.length;
    expect(integratedCount).toBe(1);
    const loser = resultA.integrated.length === 1 ? resultB : resultA;
    expect(loser.reconciliationRequired).toHaveLength(1);
    expect(loser.reconciliationRequired[0]?.reason).toMatch(/stale|assembly-failed/i);

    const operation = await loadOperation(root, operationId);
    expect(operation.candidateRevision?.revision).toBe(base.revision + 1);
    // The bound tree is exactly the winner's patch: no mixed bind, no tear.
    expect(await computeWorktreeDigest(root)).toBe(operation.candidateRevision?.sourceDigest);
    const aContent = await fs.readFile(path.join(root, "src", "a.ts"), "utf8");
    const bContent = await fs.readFile(path.join(root, "src", "b.ts"), "utf8");
    const winnerIsA = resultA.integrated.length === 1;
    expect(aContent).toBe(winnerIsA ? "export const a = 2;\n" : "export const a = 1;\n");
    expect(bContent).toBe(winnerIsA ? "export const b = 1;\n" : "export const b = 2;\n");
  }, 30_000);
});

function submission(changeSet: ChangeSetV1): WaveChangeSetSubmissionV1 {
  return { workUnitId: changeSet.workUnitId, changeSet, allowedScope: ["src/**"] };
}

async function createRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-assembly-lock-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  await fs.writeFile(path.join(root, "src", "b.ts"), "export const b = 1;\n");
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
    const readTree = await actualRunExecutable("git", ["read-tree", "HEAD"], { cwd: root, timeoutMs: 30_000, env });
    const stageCurrent = readTree.exitCode === 0 ? await actualRunExecutable("git", ["add", "-A"], { cwd: root, timeoutMs: 30_000, env }) : readTree;
    const baseTree = stageCurrent.exitCode === 0 ? await actualRunExecutable("git", ["write-tree"], { cwd: root, timeoutMs: 30_000, env }) : stageCurrent;
    if (baseTree.exitCode !== 0 || !baseTree.stdout.trim()) throw new Error(`test base snapshot failed: ${baseTree.stderr || baseTree.stdout}`);
    await fs.writeFile(absolute, content);
    const stageChange = await actualRunExecutable("git", ["add", "-A", "--", file], { cwd: root, timeoutMs: 30_000, env });
    if (stageChange.exitCode !== 0) throw new Error(`test change staging failed: ${stageChange.stderr || stageChange.stdout}`);
    const diff = await actualRunExecutable("git", ["diff", "--cached", "--binary", baseTree.stdout.trim(), "--", file], { cwd: root, timeoutMs: 30_000, env });
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
