import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { ChangeSetV1 } from "../src/candidates/assembler.js";
import { createWaveBase, integrateWaveChangeSets, type WaveChangeSetSubmissionV1 } from "../src/candidates/wave.js";
import { computeWorktreeDigest } from "../src/core/git.js";
import { sha256Utf8 } from "../src/core/digest.js";
import { loadOperation } from "../src/operations/state.js";
import type { CandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { runExecutable, runShell } from "../src/utils/process.js";
import { semanticPayload, semanticTestService } from "./semanticAssessmentSupport.js";
import { semanticCapabilityPolicyRevisionV1 } from "../src/semantic/assessment.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

const TASK = "TASK-WAVE-ASSEMBLY-FAIL";

/**
 * G-NEW-4 reproducer: an assembly error in sibling B of a wave whose sibling A
 * is clean must surface as a STRUCTURED per-submission failure (earlier-sibling
 * binds recorded, reconciliation entry for the failed sibling) — never as an
 * unstructured throw that skips wave summaries, `harness.wave.finish`, and the
 * aggregate session.
 */
describe("wave integration assembly failure is a structured per-submission failure", () => {
  it("records the earlier sibling bind and a typed failure when sibling B escapes scope", async () => {
    const root = await createRepo();
    const operationId = "RUN-WAVE-ASSEMBLY-SCOPE";
    const base = await createOperation(root, operationId);
    const changeA = await makeChangeSet(root, base, "wu-a", "src/a.ts", "export const a = 2;\n");
    const changeB = await makeChangeSet(root, base, "wu-b", "src/b.ts", "export const b = 2;\n");
    const wave = createWaveBase({ operationId, taskId: TASK, waveIndex: 0, candidate: base });

    // Sibling B's patch is valid git, but its declared scope does not cover the
    // file it touches, so per-submission assembly rejects it AFTER sibling A
    // has already been durably bound.
    const result = await integrateWaveChangeSets({
      root, stateRoot: root, operationId, taskId: TASK, wave,
      submissions: [
        { workUnitId: changeA.workUnitId, changeSet: changeA, allowedScope: ["src/**"] },
        { workUnitId: changeB.workUnitId, changeSet: changeB, allowedScope: ["src/a.ts"] },
      ]
    });

    // Truthful prefix: the clean sibling stays bound and VISIBLE in the result.
    expect(result.integrated.map((step) => step.workUnitId)).toEqual(["wu-a"]);
    expect(result.integrated[0]?.candidate.revision).toBe(2);
    // The failed sibling is a typed per-submission failure, not a throw.
    expect(result.reconciliationRequired).toHaveLength(1);
    expect(result.reconciliationRequired[0]).toEqual(expect.objectContaining({
      workUnitId: "wu-b",
      observedBaseRevision: base.revision,
      observedBaseDigest: base.identityDigest,
    }));
    expect(result.reconciliationRequired[0]?.reason).toMatch(/^assembly-failed:/);
    // Workspace holds exactly the bound prefix: A applied, B absent.
    expect(await fs.readFile(path.join(root, "src", "a.ts"), "utf8")).toBe("export const a = 2;\n");
    expect(await fs.readFile(path.join(root, "src", "b.ts"), "utf8")).toBe("export const b = 1;\n");
    expect(await computeWorktreeDigest(root)).toBe(result.integrated[0]!.candidate.sourceDigest);
    expect((await loadOperation(root, operationId)).candidateRevision?.revision).toBe(2);
  });

  it("records the earlier sibling bind and a typed failure when sibling B impact assessment rejects after patch application", async () => {
    const root = await createRepo();
    const operationId = "RUN-WAVE-ASSEMBLY-IMPACT";
    const base = await createOperation(root, operationId);
    const changeA = await makeChangeSet(root, base, "wu-a", "src/a.ts", "export const a = 2;\n");
    const changeB = await makeChangeSet(root, base, "wu-b", "src/b.ts", "export const b = 2;\n");
    const wave = createWaveBase({ operationId, taskId: TASK, waveIndex: 0, candidate: base });
    // The assessor misjudges sibling B's changed files, so B's assembly fails
    // AFTER its patch was applied (exercising the unbound-mutation rollback).
    const service = semanticTestService({ payload: (request) => {
      const payload = semanticPayload(request);
      const files = request.evidenceRefs.includes("file:src/b.ts") ? ["src/other.ts"] : ["src/a.ts"];
      return {
        ...payload,
        judgment: {
          type: "CANDIDATE_IMPACT" as const,
          changedFiles: files,
          changeKinds: ["source"],
          reviewDimensions: [],
          requiresIndependentReview: false,
          evidenceRefs: request.evidenceRefs,
          unknowns: []
        }
      };
    } });

    const result = await integrateWaveChangeSets({
      root, stateRoot: root, operationId, taskId: TASK, wave,
      submissions: [submission(changeA), submission(changeB)],
      semanticAssessment: {
        service,
        policyRevision: semanticCapabilityPolicyRevisionV1,
        repositoryBinding: { projectId: base.projectId!, repositoryDigest: "wave-repository-digest", operationId }
      }
    });

    expect(result.integrated.map((step) => step.workUnitId)).toEqual(["wu-a"]);
    expect(result.reconciliationRequired).toHaveLength(1);
    expect(result.reconciliationRequired[0]).toEqual(expect.objectContaining({ workUnitId: "wu-b" }));
    expect(result.reconciliationRequired[0]?.reason).toMatch(/^assembly-failed:/);
    // No unbound mutation may survive the failed sibling: the workspace is the
    // bound prefix, and the operation candidate is the earlier sibling bind.
    expect(await fs.readFile(path.join(root, "src", "a.ts"), "utf8")).toBe("export const a = 2;\n");
    expect(await fs.readFile(path.join(root, "src", "b.ts"), "utf8")).toBe("export const b = 1;\n");
    expect(await computeWorktreeDigest(root)).toBe(result.integrated[0]!.candidate.sourceDigest);
    expect((await loadOperation(root, operationId)).candidateRevision?.revision).toBe(2);
  });
});

function submission(changeSet: ChangeSetV1, resourceClaims?: WaveChangeSetSubmissionV1["resourceClaims"]): WaveChangeSetSubmissionV1 {
  return { workUnitId: changeSet.workUnitId, changeSet, allowedScope: ["src/**"], ...(resourceClaims ? { resourceClaims } : {}) };
}

async function createRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-wave-assembly-fail-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  await fs.writeFile(path.join(root, "src", "b.ts"), "export const b = 1;\n");
  await fs.writeFile(path.join(root, "src", "c.ts"), "export const c = 1;\n");
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
