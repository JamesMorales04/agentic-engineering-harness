import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWaveBase, integrateWaveChangeSets } from "../src/candidates/wave.js";
import { computeWorktreeDigest } from "../src/core/git.js";
import { sha256Utf8 } from "../src/core/digest.js";
import { loadOperation } from "../src/operations/state.js";
import type { CandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import type { ChangeSetV1 } from "../src/candidates/assembler.js";
import { runExecutable, runShell } from "../src/utils/process.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

const TASK = "TASK-WAVE-ROLLBACK-RACE";

/**
 * Luna blocker RED: wave rollback races sibling assembly.
 *
 * Two concurrent wave integrations from the same base carry the SAME
 * applicable patch. The winner binds r+1; the loser's locked assembly fails
 * pre-apply STALE without mutating. The loser's catch must NOT `git apply
 * --reverse` the winner's tree: the reverse of the identical patch succeeds
 * and undoes the sibling, leaving the workspace torn (digest no longer
 * matches the durable r+1) while the wave returns a clean reconciliation.
 *
 *Mechanism: DETERMINISTIC (filesystem + durable candidate comparison).
 * Fail-closed: no reverse on uncertainty.
 */
describe("wave rollback must not undo a sibling that committed the same patch", () => {
  it("concurrent identical patches serialize: loser reconciles, winner tree survives", async () => {
    const root = await createRepo();
    const operationId = "RUN-WAVE-ROLLBACK-RACE";
    const base = await createOperation(root, operationId);
    // Same file, same content => byte-identical patch text, reverse-applicable
    // to the sibling's bound tree (the race that disjoint patches mask).
    const changeA = await makeChangeSet(root, base, "wu-a", "src/a.ts", "export const a = 2;\n");
    const changeB = await makeChangeSet(root, base, "wu-b", "src/a.ts", "export const a = 2;\n");
    expect(changeB.patch).toBe(changeA.patch);

    const wave = createWaveBase({ operationId, taskId: TASK, waveIndex: 0, candidate: base });

    const [resultA, resultB] = await Promise.all([
      integrateWaveChangeSets({
        root, stateRoot: root, operationId, taskId: TASK, wave,
        submissions: [{ workUnitId: changeA.workUnitId, changeSet: changeA, allowedScope: ["src/**"] }]
      }),
      integrateWaveChangeSets({
        root, stateRoot: root, operationId, taskId: TASK, wave,
        submissions: [{ workUnitId: changeB.workUnitId, changeSet: changeB, allowedScope: ["src/**"] }]
      })
    ]);

    const integratedCount = resultA.integrated.length + resultB.integrated.length;
    expect(integratedCount).toBe(1);
    const loser = resultA.integrated.length === 1 ? resultB : resultA;
    expect(loser.reconciliationRequired).toHaveLength(1);

    const operation = await loadOperation(root, operationId);
    expect(operation.candidateRevision?.revision).toBe(base.revision + 1);
    // The winner's tree must survive: the loser's rollback must not have
    // reversed the sibling's identical patch.
    expect(await fs.readFile(path.join(root, "src", "a.ts"), "utf8")).toBe("export const a = 2;\n");
    expect(await computeWorktreeDigest(root)).toBe(operation.candidateRevision?.sourceDigest);
  }, 30_000);
});

async function createRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-wave-rollback-race-"));
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
