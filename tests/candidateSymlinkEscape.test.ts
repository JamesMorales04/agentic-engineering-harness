import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assembleCandidateChangeSet } from "../src/candidates/assembler.js";
import { materializeCandidateState } from "../src/candidates/direct.js";
import { computeWorktreeDigest } from "../src/core/git.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { runShell } from "../src/utils/process.js";
import { sha256Utf8 } from "../src/core/digest.js";
import type { AehError } from "../src/core/errors.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import { executeIsolatedCandidateMutation } from "../src/candidates/direct.js";

/**
 * C-NEW-4: candidate assembly checks only path STRINGS. A patch adding a
 * mode-120000 symlink (e.g. `src/link -> ../../outside`) with scope `src/**`
 * passes the string gate and is `git apply`d. Fail-closed expectation: the
 * assembly choke point rejects escaping symlink targets before any apply.
 */
async function initRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-symlink-escape-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  // Ignore harness runtime state so operation-resource registration inside
  // executeIsolatedCandidateMutation cannot perturb the candidate digest.
  await fs.writeFile(path.join(root, ".gitignore"), ".harness/\n");
  await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
  await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.com commit -qm initial", { cwd: root });
  return root;
}

/** Build a real git-generated mode-120000 patch, then restore the baseline. */
async function symlinkPatch(root: string, linkRel: string, target: string): Promise<string> {
  const absolute = path.join(root, linkRel);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.symlink(target, absolute);
  await runShell(`git add ${JSON.stringify(linkRel)}`, { cwd: root });
  const patch = (await runShell(`git diff --cached --binary HEAD -- ${JSON.stringify(linkRel)}`, { cwd: root })).stdout;
  expect(patch).toContain("120000");
  await runShell(`git rm --cached -q ${JSON.stringify(linkRel)}`, { cwd: root });
  await fs.rm(absolute, { force: true });
  expect((await runShell("git status --porcelain", { cwd: root })).stdout).toBe("");
  return patch;
}

describe("candidate symlink escape gate (C-NEW-4)", () => {
  it("RED: rejects a mode-120000 patch entry whose target escapes the root under scope src/**", async () => {
    const root = await initRepo();
    try {
      const current = createCandidateRevisionV1({ operationId: "OP-SYMLINK", candidateId: "candidate:OP-SYMLINK:r1", taskId: "TASK-SYMLINK", revision: 1, sourceDigest: await computeWorktreeDigest(root) });
      const patch = await symlinkPatch(root, "src/link", "../../outside");
      const changeSet = { version: 1 as const, operationId: current.operationId, taskId: "TASK-SYMLINK", workUnitId: "WU-1", participantId: "participant-1", baseCandidateRevision: current.revision, baseCandidateDigest: current.identityDigest, changedFiles: ["src/link"], patch, patchDigest: sha256Utf8(patch) };
      let failure: AehError | undefined;
      try {
        await assembleCandidateChangeSet({ root, operationId: current.operationId, taskId: "TASK-SYMLINK", currentCandidate: current, changeSet, allowedScope: ["src/**"], candidateId: "candidate:OP-SYMLINK:r2" });
      } catch (error) { failure = error as AehError; }
      expect(failure?.code).toBe("PARTICIPANT_PLAN_INVALID");
      expect(failure?.message).toMatch(/symlink/i);
      // Fail-closed: no unbound mutation survives; the link was never applied.
      await expect(fs.lstat(path.join(root, "src", "link"))).rejects.toThrow();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("RED: rejects an absolute symlink target in an in-scope patch", async () => {
    const root = await initRepo();
    try {
      const current = createCandidateRevisionV1({ operationId: "OP-SYMLINK-ABS", candidateId: "candidate:OP-SYMLINK-ABS:r1", taskId: "TASK-SYMLINK-ABS", revision: 1, sourceDigest: await computeWorktreeDigest(root) });
      const patch = await symlinkPatch(root, "src/link", "/etc/passwd");
      const changeSet = { version: 1 as const, operationId: current.operationId, taskId: "TASK-SYMLINK-ABS", workUnitId: "WU-1", participantId: "participant-1", baseCandidateRevision: current.revision, baseCandidateDigest: current.identityDigest, changedFiles: ["src/link"], patch, patchDigest: sha256Utf8(patch) };
      await expect(assembleCandidateChangeSet({ root, operationId: current.operationId, taskId: "TASK-SYMLINK-ABS", currentCandidate: current, changeSet, allowedScope: ["src/**"], candidateId: "candidate:OP-SYMLINK-ABS:r2" })).rejects.toMatchObject({ code: "PARTICIPANT_PLAN_INVALID" });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("RED: materializing an untracked escaping symlink is rejected (direct.ts sibling)", async () => {
    const root = await initRepo();
    // materializeCandidateState requires the target to share the source HEAD,
    // mirroring the `git worktree add` setup in executeIsolatedCandidateMutation.
    const target = path.join(os.tmpdir(), `aeh-symlink-mat-${process.pid}-${Date.now()}`);
    try {
      // Absolute-target links survive Node's fs.cp target rewrite byte-identical,
      // so pre-fix this materializes with no gate at all (wave path has no
      // assertContainedSourceSymlinks; only the DIRECT pre-worker check does).
      await fs.symlink("/definitely-outside-the-candidate-root", path.join(root, "src", "evil"));
      const current = createCandidateRevisionV1({ operationId: "OP-SYMLINK-MAT", candidateId: "candidate:OP-SYMLINK-MAT:r1", taskId: "TASK-SYMLINK-MAT", revision: 1, sourceDigest: await computeWorktreeDigest(root) });
      await runShell(`git worktree add --detach ${JSON.stringify(target)} HEAD`, { cwd: root });
      try {
        await expect(materializeCandidateState(root, target, current)).rejects.toMatchObject({ code: "PARTICIPANT_PLAN_INVALID" });
      } finally {
        await runShell(`git worktree remove --force ${JSON.stringify(target)}`, { cwd: root });
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(target, { recursive: true, force: true }); }
  });

  it("assembles an in-scope symlink with a contained target (no false positive)", async () => {
    const root = await initRepo();
    try {
      const current = createCandidateRevisionV1({ operationId: "OP-SYMLINK-OK", candidateId: "candidate:OP-SYMLINK-OK:r1", taskId: "TASK-SYMLINK-OK", revision: 1, sourceDigest: await computeWorktreeDigest(root) });
      const patch = await symlinkPatch(root, "src/link", "value.ts");
      const changeSet = { version: 1 as const, operationId: current.operationId, taskId: "TASK-SYMLINK-OK", workUnitId: "WU-1", participantId: "participant-1", baseCandidateRevision: current.revision, baseCandidateDigest: current.identityDigest, changedFiles: ["src/link"], patch, patchDigest: sha256Utf8(patch) };
      const result = await assembleCandidateChangeSet({ root, operationId: current.operationId, taskId: "TASK-SYMLINK-OK", currentCandidate: current, changeSet, allowedScope: ["src/**"], candidateId: "candidate:OP-SYMLINK-OK:r2" });
      expect(result.candidate.revision).toBe(2);
      expect((await fs.lstat(path.join(root, "src", "link"))).isSymbolicLink()).toBe(true);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("rejects a retarget of a committed in-scope link to outside the root", async () => {
    const root = await initRepo();
    try {
      await fs.symlink("value.ts", path.join(root, "src", "link"));
      await runShell("git add -A && git -c user.name=test -c user.email=test@example.com commit -qm link", { cwd: root });
      const current = createCandidateRevisionV1({ operationId: "OP-SYMLINK-RETARGET", candidateId: "candidate:OP-SYMLINK-RETARGET:r1", taskId: "TASK-SYMLINK-RETARGET", revision: 1, sourceDigest: await computeWorktreeDigest(root) });
      await fs.rm(path.join(root, "src", "link"));
      await fs.symlink("../../../../outside", path.join(root, "src", "link"));
      const patch = (await runShell("git diff --binary HEAD -- src/link", { cwd: root })).stdout;
      expect(patch).toMatch(/120000/);
      await fs.rm(path.join(root, "src", "link"));
      await fs.symlink("value.ts", path.join(root, "src", "link"));
      const changeSet = { version: 1 as const, operationId: current.operationId, taskId: "TASK-SYMLINK-RETARGET", workUnitId: "WU-1", participantId: "participant-1", baseCandidateRevision: current.revision, baseCandidateDigest: current.identityDigest, changedFiles: ["src/link"], patch, patchDigest: sha256Utf8(patch) };
      await expect(assembleCandidateChangeSet({ root, operationId: current.operationId, taskId: "TASK-SYMLINK-RETARGET", currentCandidate: current, changeSet, allowedScope: ["src/**"], candidateId: "candidate:OP-SYMLINK-RETARGET:r2" })).rejects.toMatchObject({ code: "PARTICIPANT_PLAN_INVALID" });
      expect(await fs.readlink(path.join(root, "src", "link"))).toBe("value.ts");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("rejects a drive-letter symlink target in an in-scope patch", async () => {
    const root = await initRepo();
    try {
      const current = createCandidateRevisionV1({ operationId: "OP-SYMLINK-DRIVE", candidateId: "candidate:OP-SYMLINK-DRIVE:r1", taskId: "TASK-SYMLINK-DRIVE", revision: 1, sourceDigest: await computeWorktreeDigest(root) });
      const patch = await symlinkPatch(root, "src/link", "C:/evil-outside");
      const changeSet = { version: 1 as const, operationId: current.operationId, taskId: "TASK-SYMLINK-DRIVE", workUnitId: "WU-1", participantId: "participant-1", baseCandidateRevision: current.revision, baseCandidateDigest: current.identityDigest, changedFiles: ["src/link"], patch, patchDigest: sha256Utf8(patch) };
      await expect(assembleCandidateChangeSet({ root, operationId: current.operationId, taskId: "TASK-SYMLINK-DRIVE", currentCandidate: current, changeSet, allowedScope: ["src/**"], candidateId: "candidate:OP-SYMLINK-DRIVE:r2" })).rejects.toMatchObject({ code: "PARTICIPANT_PLAN_INVALID" });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("assembles a pure symlink deletion (no false positive on removal)", async () => {
    const root = await initRepo();
    try {
      await fs.symlink("value.ts", path.join(root, "src", "link"));
      await runShell("git add -A && git -c user.name=test -c user.email=test@example.com commit -qm link", { cwd: root });
      const current = createCandidateRevisionV1({ operationId: "OP-SYMLINK-RM", candidateId: "candidate:OP-SYMLINK-RM:r1", taskId: "TASK-SYMLINK-RM", revision: 1, sourceDigest: await computeWorktreeDigest(root) });
      await runShell("git rm -q src/link", { cwd: root });
      const patch = (await runShell("git diff --cached --binary HEAD -- src/link", { cwd: root })).stdout;
      expect(patch).toContain("deleted file mode 120000");
      await runShell("git reset -q --hard HEAD", { cwd: root });
      const changeSet = { version: 1 as const, operationId: current.operationId, taskId: "TASK-SYMLINK-RM", workUnitId: "WU-1", participantId: "participant-1", baseCandidateRevision: current.revision, baseCandidateDigest: current.identityDigest, changedFiles: ["src/link"], patch, patchDigest: sha256Utf8(patch) };
      const result = await assembleCandidateChangeSet({ root, operationId: current.operationId, taskId: "TASK-SYMLINK-RM", currentCandidate: current, changeSet, allowedScope: ["src/**"], candidateId: "candidate:OP-SYMLINK-RM:r2" });
      expect(result.candidate.revision).toBe(2);
      await expect(fs.lstat(path.join(root, "src", "link"))).rejects.toThrow();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("reference: direct.ts pre-worker gate rejects a source tree containing an escaping symlink", async () => {
    const root = await initRepo();
    try {
      await fs.symlink("../../outside", path.join(root, "src", "evil"));
      await runShell("git add -A && git -c user.name=test -c user.email=test@example.com commit -qm evil", { cwd: root });
      const candidate = createCandidateRevisionV1({ operationId: "RUN-SYMLINK-REF", candidateId: "candidate:RUN-SYMLINK-REF:r1", taskId: "REF", revision: 1, sourceDigest: await computeWorktreeDigest(root) });
      const config: HarnessProjectConfig = { version: 1, project: { name: "ref" } };
      const contract: TaskContract = { version: 1, task: { id: "REF", title: "ref" } };
      await expect(executeIsolatedCandidateMutation({ root, operationId: candidate.operationId, taskId: "REF", workUnitId: "direct:REF", candidate, config, contract, execute: async () => { throw new Error("must not run"); } })).rejects.toMatchObject({ code: "PARTICIPANT_PLAN_INVALID" });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
