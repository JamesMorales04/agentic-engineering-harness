import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assembleCandidateChangeSet } from "../src/candidates/index.js";
import { computeWorktreeDigest } from "../src/core/git.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { runShell } from "../src/utils/process.js";
import { sha256Utf8 } from "../src/core/digest.js";
import { semanticCapabilityPolicyRevisionV1, type SemanticAssessmentRequestV1 } from "../src/semantic/assessment.js";
import { semanticPayload, semanticTestService } from "./semanticAssessmentSupport.js";

describe("deterministic candidate assembly", () => {
  it("applies a scoped ChangeSet and preserves the blocked impact minimum without a semantic runtime", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-assembler-"));
    try {
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
      await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.com commit -qm initial", { cwd: root });
      const current = createCandidateRevisionV1({ operationId: "OP-1", candidateId: "candidate:OP-1:r1", taskId: "TASK-1", revision: 1, sourceDigest: await computeWorktreeDigest(root) });
      const patch = "diff --git a/src/value.ts b/src/value.ts\nindex 9b7c1d4..e2f9c4a 100644\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n";
      const changeSet = { version: 1 as const, operationId: "OP-1", taskId: "TASK-1", workUnitId: "WU-1", participantId: "participant:WU-1", baseCandidateRevision: 1, baseCandidateDigest: current.identityDigest, changedFiles: ["src/value.ts"], patch, patchDigest: sha256Utf8(patch) };
      const result = await assembleCandidateChangeSet({ root, operationId: "OP-1", taskId: "TASK-1", currentCandidate: current, changeSet, allowedScope: ["src/**"], candidateId: "candidate:OP-1:r2" });
      expect(result.candidate.revision).toBe(2);
      expect(result.candidate.parentCandidateId).toBe(current.candidateId);
      expect(result.candidate.sourceDigest).not.toBe(current.sourceDigest);
      expect(result.impact).toMatchObject({ interpretation: "BLOCKED", changeKinds: [], requiresIndependentReview: true });
      expect(await fs.readFile(path.join(root, "src", "value.ts"), "utf8")).toContain("value = 2");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("assesses the assembled candidate through Semantic Assessor and preserves a deterministic independent-review floor", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-assembler-semantic-impact-"));
    try {
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
      await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.com commit -qm initial", { cwd: root });
      const current = createCandidateRevisionV1({ operationId: "OP-IMPACT", candidateId: "candidate:OP-IMPACT:r1", projectId: "project-impact", taskId: "TASK-IMPACT", revision: 1, sourceDigest: await computeWorktreeDigest(root) });
      const patch = "diff --git a/src/value.ts b/src/value.ts\nindex 9b7c1d4..e2f9c4a 100644\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n";
      const changeSet = { version: 1 as const, operationId: current.operationId, taskId: "TASK-IMPACT", workUnitId: "WU-1", participantId: "participant-1", baseCandidateRevision: current.revision, baseCandidateDigest: current.identityDigest, changedFiles: ["src/value.ts"], patch, patchDigest: sha256Utf8(patch) };
      let captured: SemanticAssessmentRequestV1 | undefined;
      const service = semanticTestService({ payload: (request) => {
        captured = request;
        const payload = semanticPayload(request);
        return { ...payload, judgment: { type: "CANDIDATE_IMPACT", changedFiles: ["src/value.ts"], changeKinds: ["source"], reviewDimensions: ["behavior.correctness"], requiresIndependentReview: false, evidenceRefs: request.evidenceRefs, unknowns: ["possible downstream behavior"] } };
      } });
      const result = await assembleCandidateChangeSet({
        root,
        operationId: current.operationId,
        taskId: "TASK-IMPACT",
        currentCandidate: current,
        changeSet,
        allowedScope: ["src/**"],
        candidateId: "candidate:OP-IMPACT:r2",
        semanticAssessment: { service, policyRevision: semanticCapabilityPolicyRevisionV1, repositoryBinding: { projectId: "project-impact", repositoryDigest: "repository-impact", repositoryRootDigest: "root-impact", operationId: current.operationId } }
      });
      expect(captured?.assessmentType).toBe("CANDIDATE_IMPACT");
      expect(captured?.binding).toMatchObject({ candidateId: result.candidate.candidateId, candidateRevision: 2, candidateDigest: result.candidate.identityDigest });
      expect(captured?.compactEvidence).toEqual(expect.arrayContaining([expect.objectContaining({ ref: "file:src/value.ts", content: "export const value = 2;\n" })]));
      expect(captured?.evidenceReceipts.find((receipt) => receipt.ref === "file:src/value.ts")).toMatchObject({ kind: "CANDIDATE_FILE", path: "src/value.ts" });
      expect(result.impact).toMatchObject({ interpretation: "MODEL", changeKinds: ["source"], reviewDimensions: ["behavior.correctness"], requiresIndependentReview: true, unknowns: ["bounded evidence only", "possible downstream behavior"] });
      expect(result.impact.semanticAssessmentDigest).toMatch(/^[a-f0-9]{64}$/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("rolls back an assembled patch when the typed candidate impact does not match changed paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-assembler-semantic-rollback-"));
    try {
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
      await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.com commit -qm initial", { cwd: root });
      const current = createCandidateRevisionV1({ operationId: "OP-IMPACT-ROLLBACK", candidateId: "candidate:OP-IMPACT-ROLLBACK:r1", projectId: "project-impact", taskId: "TASK-IMPACT-ROLLBACK", revision: 1, sourceDigest: await computeWorktreeDigest(root) });
      const patch = "diff --git a/src/value.ts b/src/value.ts\nindex 9b7c1d4..e2f9c4a 100644\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n";
      const changeSet = { version: 1 as const, operationId: current.operationId, taskId: current.taskId!, workUnitId: "WU-1", participantId: "participant-1", baseCandidateRevision: current.revision, baseCandidateDigest: current.identityDigest, changedFiles: ["src/value.ts"], patch, patchDigest: sha256Utf8(patch) };
      const service = semanticTestService({ payload: (request) => {
        const payload = semanticPayload(request);
        return { ...payload, judgment: { type: "CANDIDATE_IMPACT", changedFiles: ["src/other.ts"], changeKinds: ["source"], reviewDimensions: [], requiresIndependentReview: false, evidenceRefs: request.evidenceRefs, unknowns: [] } };
      } });
      await expect(assembleCandidateChangeSet({
        root, operationId: current.operationId, taskId: current.taskId!, currentCandidate: current, changeSet, allowedScope: ["src/**"], candidateId: "candidate:OP-IMPACT-ROLLBACK:r2",
        semanticAssessment: { service, policyRevision: semanticCapabilityPolicyRevisionV1, repositoryBinding: { projectId: "project-impact", repositoryDigest: "repository-impact", operationId: current.operationId } }
      })).rejects.toMatchObject({ code: "CANDIDATE_IMPACT_INVALID" });
      expect(await fs.readFile(path.join(root, "src", "value.ts"), "utf8")).toBe("export const value = 1;\n");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("rejects an in-scope declared path when the patch actually changes an out-of-scope file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-assembler-path-mismatch-"));
    try {
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.mkdir(path.join(root, "private"), { recursive: true });
      await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
      await fs.writeFile(path.join(root, "private", "guard.txt"), "closed\n");
      await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.com commit -qm initial", { cwd: root });
      const current = createCandidateRevisionV1({ operationId: "OP-PATH-MISMATCH", candidateId: "candidate:OP-PATH-MISMATCH:r1", taskId: "TASK-PATH-MISMATCH", revision: 1, sourceDigest: await computeWorktreeDigest(root) });

      await fs.writeFile(path.join(root, "private", "guard.txt"), "open\n");
      const patch = (await runShell("git diff --binary HEAD -- private/guard.txt", { cwd: root })).stdout;
      await fs.writeFile(path.join(root, "private", "guard.txt"), "closed\n");
      const changeSet = { version: 1 as const, operationId: current.operationId, taskId: "TASK-PATH-MISMATCH", workUnitId: "WU-1", participantId: "participant-1", baseCandidateRevision: current.revision, baseCandidateDigest: current.identityDigest, changedFiles: ["src/value.ts"], patch, patchDigest: sha256Utf8(patch) };

      await expect(assembleCandidateChangeSet({ root, operationId: current.operationId, taskId: "TASK-PATH-MISMATCH", currentCandidate: current, changeSet, allowedScope: ["src/**"], candidateId: "candidate:OP-PATH-MISMATCH:r2" })).rejects.toThrow("do not exactly match the paths touched by its patch");
      expect(await fs.readFile(path.join(root, "private", "guard.txt"), "utf8")).toBe("closed\n");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("rejects a patch path omitted from ChangeSet.changedFiles", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-assembler-path-omitted-"));
    try {
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
      await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.com commit -qm initial", { cwd: root });
      const current = createCandidateRevisionV1({ operationId: "OP-PATH-OMITTED", candidateId: "candidate:OP-PATH-OMITTED:r1", taskId: "TASK-PATH-OMITTED", revision: 1, sourceDigest: await computeWorktreeDigest(root) });

      await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 2;\n");
      const patch = (await runShell("git diff --binary HEAD -- src/value.ts", { cwd: root })).stdout;
      await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
      const changeSet = { version: 1 as const, operationId: current.operationId, taskId: "TASK-PATH-OMITTED", workUnitId: "WU-1", participantId: "participant-1", baseCandidateRevision: current.revision, baseCandidateDigest: current.identityDigest, changedFiles: [], patch, patchDigest: sha256Utf8(patch) };

      await expect(assembleCandidateChangeSet({ root, operationId: current.operationId, taskId: "TASK-PATH-OMITTED", currentCandidate: current, changeSet, allowedScope: ["**"], candidateId: "candidate:OP-PATH-OMITTED:r2" })).rejects.toThrow("do not exactly match the paths touched by its patch");
      expect(await fs.readFile(path.join(root, "src", "value.ts"), "utf8")).toBe("export const value = 1;\n");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("treats both sides of a rename as paths touched by the patch", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-assembler-rename-paths-"));
    try {
      await fs.mkdir(path.join(root, "private"), { recursive: true });
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(path.join(root, "private", "old.txt"), "same content\n");
      await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.com commit -qm initial", { cwd: root });
      const current = createCandidateRevisionV1({ operationId: "OP-RENAME-PATHS", candidateId: "candidate:OP-RENAME-PATHS:r1", taskId: "TASK-RENAME-PATHS", revision: 1, sourceDigest: await computeWorktreeDigest(root) });

      await fs.rename(path.join(root, "private", "old.txt"), path.join(root, "src", "new.txt"));
      const patch = (await runShell("git diff -M --binary HEAD --", { cwd: root })).stdout;
      await fs.rename(path.join(root, "src", "new.txt"), path.join(root, "private", "old.txt"));
      const changeSet = { version: 1 as const, operationId: current.operationId, taskId: "TASK-RENAME-PATHS", workUnitId: "WU-1", participantId: "participant-1", baseCandidateRevision: current.revision, baseCandidateDigest: current.identityDigest, changedFiles: ["src/new.txt"], patch, patchDigest: sha256Utf8(patch) };

      await expect(assembleCandidateChangeSet({ root, operationId: current.operationId, taskId: "TASK-RENAME-PATHS", currentCandidate: current, changeSet, allowedScope: ["src/**"], candidateId: "candidate:OP-RENAME-PATHS:r2" })).rejects.toThrow("do not exactly match the paths touched by its patch");
      expect(await fs.readFile(path.join(root, "private", "old.txt"), "utf8")).toBe("same content\n");
      await expect(fs.access(path.join(root, "src", "new.txt"))).rejects.toThrow();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("rejects a patch whose declared digest does not bind its content", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-assembler-patch-digest-"));
    try {
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
      await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.com commit -qm initial", { cwd: root });
      const current = createCandidateRevisionV1({ operationId: "OP-PATCH-DIGEST", candidateId: "candidate:OP-PATCH-DIGEST:r1", taskId: "TASK-PATCH-DIGEST", revision: 1, sourceDigest: await computeWorktreeDigest(root) });

      await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 2;\n");
      const patch = (await runShell("git diff --binary HEAD -- src/value.ts", { cwd: root })).stdout;
      await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
      const changeSet = { version: 1 as const, operationId: current.operationId, taskId: "TASK-PATCH-DIGEST", workUnitId: "WU-1", participantId: "participant-1", baseCandidateRevision: current.revision, baseCandidateDigest: current.identityDigest, changedFiles: ["src/value.ts"], patch, patchDigest: sha256Utf8("different patch") };

      await expect(assembleCandidateChangeSet({ root, operationId: current.operationId, taskId: "TASK-PATCH-DIGEST", currentCandidate: current, changeSet, allowedScope: ["src/**"], candidateId: "candidate:OP-PATCH-DIGEST:r2" })).rejects.toThrow("patch digest does not match its content");
      expect(await fs.readFile(path.join(root, "src", "value.ts"), "utf8")).toBe("export const value = 1;\n");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
