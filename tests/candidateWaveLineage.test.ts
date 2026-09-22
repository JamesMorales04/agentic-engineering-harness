import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { changeSetDigest, type ChangeSetV1 } from "../src/candidates/assembler.js";
import { createWaveBase, integrateWaveChangeSets, type WaveChangeSetSubmissionV1 } from "../src/candidates/wave.js";
import { computeWorktreeDigest } from "../src/core/git.js";
import { sha256Utf8 } from "../src/core/digest.js";
import { bindOperationCandidate, loadOperation, saveOperation } from "../src/operations/state.js";
import { createCandidateRevisionV1, type CandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { runExecutable, runShell } from "../src/utils/process.js";
import { semanticPayload, semanticTestAssessor, semanticTestService } from "./semanticAssessmentSupport.js";
import { semanticCapabilityPolicyRevisionV1, type SemanticAssessmentRequestV1 } from "../src/semantic/assessment.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

const TASK = "TASK-WAVE";

describe("truthful parallel wave candidate lineage", () => {
  it("integrates independent sibling patches and records the observed wave base", async () => {
    const root = await createRepo();
    const operationId = "RUN-WAVE-INDEPENDENT";
    const base = await createOperation(root, operationId);
    const changeA = await makeChangeSet(root, base, "wu-a", "src/a.ts", "export const a = 2;\n");
    const changeB = await makeChangeSet(root, base, "wu-b", "src/b.ts", "export const b = 2;\n");
    const wave = createWaveBase({ operationId, taskId: TASK, waveIndex: 0, candidate: base });

    const result = await integrateWaveChangeSets({ root, stateRoot: root, operationId, taskId: TASK, wave, submissions: [submission(changeA), submission(changeB)] });

    expect(result.reconciliationRequired).toEqual([]);
    expect(result.integrated.map((step) => step.workUnitId)).toEqual(["wu-a", "wu-b"]);
    expect(result.integrated[0]?.derived).toBe(false);
    expect(result.integrated[1]?.derived).toBe(true);
    expect(result.integrated.map((step) => step.candidate.revision)).toEqual([2, 3]);
    expect(await fs.readFile(path.join(root, "src", "a.ts"), "utf8")).toBe("export const a = 2;\n");
    expect(await fs.readFile(path.join(root, "src", "b.ts"), "utf8")).toBe("export const b = 2;\n");
    const operation = await loadOperation(root, operationId);
    expect(operation.candidateRevision?.revision).toBe(3);
  });

  it("assesses each assembled wave candidate through the bound Semantic Assessor runtime", async () => {
    const root = await createRepo();
    const operationId = "RUN-WAVE-SEMANTIC-IMPACT";
    const base = await createOperation(root, operationId);
    const change = await makeChangeSet(root, base, "wu-a", "src/a.ts", "export const a = 2;\n");
    const wave = createWaveBase({ operationId, taskId: TASK, waveIndex: 0, candidate: base });
    let captured: SemanticAssessmentRequestV1 | undefined;
    const service = semanticTestService({ payload: (request) => {
      captured = request;
      const payload = semanticPayload(request);
      return {
        ...payload,
        judgment: {
          type: "CANDIDATE_IMPACT" as const,
          changedFiles: ["src/a.ts"],
          changeKinds: ["source"],
          reviewDimensions: ["behavior.correctness"],
          requiresIndependentReview: true,
          evidenceRefs: request.evidenceRefs,
          unknowns: ["impact outside this candidate evidence is unknown"]
        }
      };
    } });

    const result = await integrateWaveChangeSets({
      root,
      stateRoot: root,
      operationId,
      taskId: TASK,
      wave,
      submissions: [submission(change)],
      semanticAssessment: {
        service,
        policyRevision: semanticCapabilityPolicyRevisionV1,
        repositoryBinding: { projectId: base.projectId!, repositoryDigest: "wave-repository-digest", operationId }
      }
    });

    expect(captured?.assessmentType).toBe("CANDIDATE_IMPACT");
    expect(captured?.binding).toMatchObject({ candidateId: result.integrated[0]?.candidate.candidateId, candidateRevision: 2, candidateDigest: result.integrated[0]?.candidate.identityDigest });
    expect(captured?.evidenceReceipts.find((receipt) => receipt.ref === "file:src/a.ts")).toMatchObject({ kind: "CANDIDATE_FILE", path: "src/a.ts" });
    expect(result.integrated[0]?.impact).toMatchObject({ interpretation: "MODEL", requiresIndependentReview: true, unknowns: ["bounded evidence only", "impact outside this candidate evidence is unknown"] });
  });

  it("never rewrites the original sibling base and records an explicit derived rebase", async () => {
    const root = await createRepo();
    const operationId = "RUN-WAVE-PROVENANCE";
    const base = await createOperation(root, operationId);
    const changeA = await makeChangeSet(root, base, "wu-a", "src/a.ts", "export const a = 2;\n");
    const changeB = await makeChangeSet(root, base, "wu-b", "src/b.ts", "export const b = 2;\n");
    const originalDigest = changeSetDigest(changeB);
    const wave = createWaveBase({ operationId, taskId: TASK, waveIndex: 0, candidate: base });

    const result = await integrateWaveChangeSets({ root, stateRoot: root, operationId, taskId: TASK, wave, submissions: [submission(changeA), submission(changeB)] });

    // The caller-provided sibling ChangeSets are never mutated.
    expect(changeA.baseCandidateRevision).toBe(base.revision);
    expect(changeB.baseCandidateRevision).toBe(base.revision);
    expect(changeB.baseCandidateDigest).toBe(base.identityDigest);
    expect(changeB.derivation).toBeUndefined();
    const derived = result.integrated[1]!.changeSet;
    expect(derived.baseCandidateRevision).toBe(2);
    expect(derived.derivation).toEqual(expect.objectContaining({
      kind: "WAVE_REBASE",
      originalChangeSetDigest: originalDigest,
      originalBaseCandidateRevision: base.revision,
      originalBaseCandidateDigest: base.identityDigest
    }));
    expect(derived.patchDigest).toBe(changeB.patchDigest);
    expect(changeSetDigest(derived)).not.toBe(originalDigest);
  });

  it("rebases a same-file sibling when the patches do not textually overlap", async () => {
    const root = await createRepo();
    const operationId = "RUN-WAVE-REBASE-CLEAN";
    const base = await createOperation(root, operationId);
    const first = await makeChangeSet(root, base, "wu-a", "src/long.ts", longFile(2));
    const second = await makeChangeSet(root, base, "wu-b", "src/long.ts", longFile(2, 18));
    const wave = createWaveBase({ operationId, taskId: TASK, waveIndex: 0, candidate: base });

    const result = await integrateWaveChangeSets({ root, stateRoot: root, operationId, taskId: TASK, wave, submissions: [submission(first), submission(second)] });

    expect(result.reconciliationRequired).toEqual([]);
    expect(result.integrated).toHaveLength(2);
    expect(result.integrated[1]?.derived).toBe(true);
    const content = await fs.readFile(path.join(root, "src", "long.ts"), "utf8");
    expect(content).toContain("line1 = 2");
    expect(content).toContain("line18 = 2");
  });

  it("fails closed with a typed reconciliation requirement when a sibling cannot be rebased", async () => {
    const root = await createRepo();
    const operationId = "RUN-WAVE-CONFLICT";
    const base = await createOperation(root, operationId);
    const first = await makeChangeSet(root, base, "wu-a", "src/a.ts", "export const a = 2;\n");
    const second = await makeChangeSet(root, base, "wu-b", "src/a.ts", "export const a = 3;\n");
    const wave = createWaveBase({ operationId, taskId: TASK, waveIndex: 0, candidate: base });

    const result = await integrateWaveChangeSets({ root, stateRoot: root, operationId, taskId: TASK, wave, submissions: [submission(first), submission(second)] });

    expect(result.integrated.map((step) => step.workUnitId)).toEqual(["wu-a"]);
    expect(result.reconciliationRequired).toHaveLength(1);
    expect(result.reconciliationRequired[0]).toEqual(expect.objectContaining({ workUnitId: "wu-b", observedBaseRevision: base.revision }));
    expect(result.reconciliationRequired[0]?.reason).toMatch(/^rebase-required:/);
    expect(await fs.readFile(path.join(root, "src", "a.ts"), "utf8")).toBe("export const a = 2;\n");
    // Truthful prefix: the integrated sibling is bound, the conflicting one is not.
    expect((await loadOperation(root, operationId)).candidateRevision?.revision).toBe(2);
  });

  it("rejects a submission whose declared base is stale instead of relabelling it", async () => {
    const root = await createRepo();
    const operationId = "RUN-WAVE-STALE";
    const base = await createOperation(root, operationId);
    const change = await makeChangeSet(root, base, "wu-a", "src/a.ts", "export const a = 2;\n");
    const stale = { ...change, baseCandidateRevision: base.revision - 1 };
    const wave = createWaveBase({ operationId, taskId: TASK, waveIndex: 0, candidate: base });

    const result = await integrateWaveChangeSets({ root, stateRoot: root, operationId, taskId: TASK, wave, submissions: [submission(stale)] });

    expect(result.integrated).toEqual([]);
    expect(result.reconciliationRequired[0]).toEqual(expect.objectContaining({ workUnitId: "wu-a", reason: `stale-base:r${base.revision - 1}` }));
    expect(await fs.readFile(path.join(root, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
  });

  it("rejects a submission whose digest does not match the frozen wave base", async () => {
    const root = await createRepo();
    const operationId = "RUN-WAVE-STALE-DIGEST";
    const base = await createOperation(root, operationId);
    const change = await makeChangeSet(root, base, "wu-a", "src/a.ts", "export const a = 2;\n");
    const stale = { ...change, baseCandidateDigest: "f".repeat(64) };
    const wave = createWaveBase({ operationId, taskId: TASK, waveIndex: 0, candidate: base });

    const result = await integrateWaveChangeSets({ root, stateRoot: root, operationId, taskId: TASK, wave, submissions: [submission(stale)] });

    expect(result.integrated).toEqual([]);
    expect(result.reconciliationRequired[0]?.reason).toBe(`stale-base:r${base.revision}`);
  });

  it("refuses to integrate when the frozen wave base is no longer current", async () => {
    const root = await createRepo();
    const operationId = "RUN-WAVE-SUPERSEDED";
    const base = await createOperation(root, operationId);
    const change = await makeChangeSet(root, base, "wu-a", "src/a.ts", "export const a = 2;\n");
    await fs.writeFile(path.join(root, "src", "c.ts"), "export const c = 9;\n");
    await bindOperationCandidate(root, operationId, createCandidateRevisionV1({ operationId, candidateId: `candidate:${operationId}:r2`, projectId: base.projectId, taskId: TASK, revision: 2, parentCandidateId: base.candidateId, worktree: base.worktree, sourceDigest: await computeWorktreeDigest(root) }));
    const wave = createWaveBase({ operationId, taskId: TASK, waveIndex: 0, candidate: base });

    await expect(integrateWaveChangeSets({ root, stateRoot: root, operationId, taskId: TASK, wave, submissions: [submission(change)] }))
      .rejects.toThrow("Wave base is no longer the current candidate revision");
  });

  it("integrates deterministically by work unit id regardless of submission order", async () => {
    const root = await createRepo();
    const operationId = "RUN-WAVE-ORDER";
    const base = await createOperation(root, operationId);
    const changeB = await makeChangeSet(root, base, "wu-b", "src/b.ts", "export const b = 2;\n");
    const changeA = await makeChangeSet(root, base, "wu-a", "src/a.ts", "export const a = 2;\n");
    const wave = createWaveBase({ operationId, taskId: TASK, waveIndex: 0, candidate: base });

    const result = await integrateWaveChangeSets({ root, stateRoot: root, operationId, taskId: TASK, wave, submissions: [submission(changeB), submission(changeA)] });

    expect(result.integrated.map((step) => step.workUnitId)).toEqual(["wu-a", "wu-b"]);
    expect(result.integrated.map((step) => step.candidate.revision)).toEqual([2, 3]);
  });

  it("supports explicit rebase and retry against the advanced candidate", async () => {
    const root = await createRepo();
    const operationId = "RUN-WAVE-RETRY";
    const base = await createOperation(root, operationId);
    const first = await makeChangeSet(root, base, "wu-a", "src/a.ts", "export const a = 2;\n");
    const conflicting = await makeChangeSet(root, base, "wu-b", "src/a.ts", "export const a = 3;\n");
    const firstWave = createWaveBase({ operationId, taskId: TASK, waveIndex: 0, candidate: base });
    const initial = await integrateWaveChangeSets({ root, stateRoot: root, operationId, taskId: TASK, wave: firstWave, submissions: [submission(first), submission(conflicting)] });
    expect(initial.reconciliationRequired).toHaveLength(1);

    // Re-execution observes the new candidate and produces a new ChangeSet with a new base.
    const advanced = (await loadOperation(root, operationId)).candidateRevision!;
    const retry = await makeChangeSet(root, advanced, "wu-b", "src/a.ts", "export const a = 3;\n");
    expect(retry.baseCandidateRevision).toBe(advanced.revision);
    expect(retry.baseCandidateDigest).toBe(advanced.identityDigest);
    const secondWave = createWaveBase({ operationId, taskId: TASK, waveIndex: 1, candidate: advanced });
    const retried = await integrateWaveChangeSets({ root, stateRoot: root, operationId, taskId: TASK, wave: secondWave, submissions: [submission(retry)] });

    expect(retried.reconciliationRequired).toEqual([]);
    expect(retried.integrated[0]?.derived).toBe(false);
    expect(retried.integrated[0]?.candidate.revision).toBe(3);
    expect(await fs.readFile(path.join(root, "src", "a.ts"), "utf8")).toBe("export const a = 3;\n");
  });

  it("restores the bound candidate when assembly fails after applying a patch", async () => {
    const root = await createRepo();
    const operationId = "RUN-WAVE-ROLLBACK";
    const base = await createOperation(root, operationId);
    const change = await makeChangeSet(root, base, "wu-a", "src/a.ts", "export const a = 2;\n");
    const wave = createWaveBase({ operationId, taskId: TASK, waveIndex: 0, candidate: base });
    const service = semanticTestService({ payload: (request) => {
      const payload = semanticPayload(request);
      return {
        ...payload,
        judgment: {
          type: "CANDIDATE_IMPACT" as const,
          changedFiles: ["src/other.ts"],
          changeKinds: ["source"],
          reviewDimensions: [],
          requiresIndependentReview: false,
          evidenceRefs: request.evidenceRefs,
          unknowns: []
        }
      };
    } });

    await expect(integrateWaveChangeSets({ root, stateRoot: root, operationId, taskId: TASK, wave, submissions: [submission(change)], semanticAssessment: {
      service,
      policyRevision: semanticCapabilityPolicyRevisionV1,
      repositoryBinding: { projectId: base.projectId!, repositoryDigest: "wave-repository-digest", operationId }
    } }))
      .rejects.toThrow("CANDIDATE_IMPACT_INVALID");

    // No unbound mutation may survive a failed integration.
    expect(await computeWorktreeDigest(root)).toBe(base.sourceDigest);
    expect((await loadOperation(root, operationId)).candidateRevision?.revision).toBe(1);
  });

  it("requires reconciliation instead of co-integrating conflicting exclusive resource claims", async () => {
    const root = await createRepo();
    const operationId = "RUN-WAVE-RESOURCE";
    const base = await createOperation(root, operationId);
    const changeA = await makeChangeSet(root, base, "wu-a", "src/a.ts", "export const a = 2;\n");
    const changeB = await makeChangeSet(root, base, "wu-b", "src/b.ts", "export const b = 2;\n");
    const exclusive = [{ version: 1 as const, resource: "database-schema", mode: "EXCLUSIVE_WRITE" as const }];
    const wave = createWaveBase({ operationId, taskId: TASK, waveIndex: 0, candidate: base });

    const result = await integrateWaveChangeSets({
      root, stateRoot: root, operationId, taskId: TASK, wave,
      submissions: [submission(changeA, exclusive), submission(changeB, exclusive)]
    });

    expect(result.integrated.map((step) => step.workUnitId)).toEqual(["wu-a"]);
    expect(result.reconciliationRequired[0]).toEqual(expect.objectContaining({ workUnitId: "wu-b" }));
    expect(result.reconciliationRequired[0]?.reason).toContain("resource-claim:resource:database-schema:exclusive-exclusive");
  });
});

function submission(changeSet: ChangeSetV1, resourceClaims?: WaveChangeSetSubmissionV1["resourceClaims"]): WaveChangeSetSubmissionV1 {
  return { workUnitId: changeSet.workUnitId, changeSet, allowedScope: ["src/**"], ...(resourceClaims ? { resourceClaims } : {}) };
}

async function createRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-wave-lineage-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  await fs.writeFile(path.join(root, "src", "b.ts"), "export const b = 1;\n");
  await fs.writeFile(path.join(root, "src", "c.ts"), "export const c = 1;\n");
  await fs.writeFile(path.join(root, "src", "long.ts"), longFile(1));
  await fs.writeFile(path.join(root, ".gitignore"), ".harness/\n");
  await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.com commit -qm initial", { cwd: root });
  return root;
}

async function createOperation(root: string, operationId: string): Promise<CandidateRevisionV1> {
  const now = new Date().toISOString();
  await saveOperation(root, { version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "implementation", root, payload: { taskId: TASK }, createdAt: now, updatedAt: now });
  return (await loadOperation(root, operationId)).candidateRevision!;
}

async function makeChangeSet(root: string, base: CandidateRevisionV1, workUnitId: string, file: string, content: string): Promise<ChangeSetV1> {
  const absolute = path.join(root, file);
  const previous = await fs.readFile(absolute, "utf8");
  const indexFile = path.join(root, ".git", `aeh-test-index-${crypto.randomUUID()}`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    // Snapshot the exact current worktree state (the candidate the worker observed)
    // into a private index so the patch is generated against that base, not HEAD.
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

function longFile(value: number, targetLine = 1): string {
  const lines = Array.from({ length: 24 }, (_, index) => `export const line${index + 1} = ${index + 1 === targetLine ? value : 1};`);
  return `${lines.join("\n")}\n`;
}
