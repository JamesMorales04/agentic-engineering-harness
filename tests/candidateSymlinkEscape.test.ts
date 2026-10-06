import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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

  it("RED-CHAIN: rejects a patch link whose target traverses an existing outward in-repo symlink", async () => {
    const root = await initRepo();
    try {
      // Pre-existing in-repo symlink escaping the root (committed baseline).
      await fs.symlink("../../outside", path.join(root, "src", "portal"));
      await runShell("git add -A && git -c user.name=test -c user.email=test@example.com commit -qm portal", { cwd: root });
      const current = createCandidateRevisionV1({ operationId: "OP-SYMLINK-CHAIN", candidateId: "candidate:OP-SYMLINK-CHAIN:r1", taskId: "TASK-SYMLINK-CHAIN", revision: 1, sourceDigest: await computeWorktreeDigest(root) });
      // Lexically contained (`src/portal/file`) but resolves outside via portal.
      const patch = await symlinkPatch(root, "src/link", "portal/file");
      const changeSet = { version: 1 as const, operationId: current.operationId, taskId: "TASK-SYMLINK-CHAIN", workUnitId: "WU-1", participantId: "participant-1", baseCandidateRevision: current.revision, baseCandidateDigest: current.identityDigest, changedFiles: ["src/link"], patch, patchDigest: sha256Utf8(patch) };
      let failure: AehError | undefined;
      try {
        await assembleCandidateChangeSet({ root, operationId: current.operationId, taskId: "TASK-SYMLINK-CHAIN", currentCandidate: current, changeSet, allowedScope: ["src/**"], candidateId: "candidate:OP-SYMLINK-CHAIN:r2" });
      } catch (error) { failure = error as AehError; }
      expect(failure?.code).toBe("PARTICIPANT_PLAN_INVALID");
      expect(failure?.message).toMatch(/symlink/i);
      await expect(fs.lstat(path.join(root, "src", "link"))).rejects.toThrow();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("RED-CHAIN: materializing an untracked link through an outward in-repo symlink is rejected", async () => {
    const root = await initRepo();
    const target = path.join(os.tmpdir(), `aeh-symlink-chain-${process.pid}-${Date.now()}`);
    try {
      await fs.symlink("../../outside", path.join(root, "src", "portal"));
      await runShell("git add -A && git -c user.name=test -c user.email=test@example.com commit -qm portal", { cwd: root });
      // Untracked chained link: lexically `src/portal/file`, effectively outside.
      await fs.symlink("portal/file", path.join(root, "src", "link"));
      const current = createCandidateRevisionV1({ operationId: "OP-SYMLINK-CHAIN-MAT", candidateId: "candidate:OP-SYMLINK-CHAIN-MAT:r1", taskId: "TASK-SYMLINK-CHAIN-MAT", revision: 1, sourceDigest: await computeWorktreeDigest(root) });
      await runShell(`git worktree add --detach ${JSON.stringify(target)} HEAD`, { cwd: root });
      try {
        await expect(materializeCandidateState(root, target, current)).rejects.toMatchObject({ code: "PARTICIPANT_PLAN_INVALID" });
      } finally {
        await runShell(`git worktree remove --force ${JSON.stringify(target)}`, { cwd: root });
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(target, { recursive: true, force: true }); }
  });

  it("assembles a link through a contained in-repo symlink (no false positive on chains)", async () => {
    const root = await initRepo();
    try {
      await fs.mkdir(path.join(root, "src", "realdir"), { recursive: true });
      await fs.writeFile(path.join(root, "src", "realdir", "value.ts"), "export const v = 1;\n");
      await fs.symlink("realdir", path.join(root, "src", "portal"));
      await runShell("git add -A && git -c user.name=test -c user.email=test@example.com commit -qm portal", { cwd: root });
      const current = createCandidateRevisionV1({ operationId: "OP-SYMLINK-CHAIN-OK", candidateId: "candidate:OP-SYMLINK-CHAIN-OK:r1", taskId: "TASK-SYMLINK-CHAIN-OK", revision: 1, sourceDigest: await computeWorktreeDigest(root) });
      const patch = await symlinkPatch(root, "src/link", "portal/value.ts");
      const changeSet = { version: 1 as const, operationId: current.operationId, taskId: "TASK-SYMLINK-CHAIN-OK", workUnitId: "WU-1", participantId: "participant-1", baseCandidateRevision: current.revision, baseCandidateDigest: current.identityDigest, changedFiles: ["src/link"], patch, patchDigest: sha256Utf8(patch) };
      const result = await assembleCandidateChangeSet({ root, operationId: current.operationId, taskId: "TASK-SYMLINK-CHAIN-OK", currentCandidate: current, changeSet, allowedScope: ["src/**"], candidateId: "candidate:OP-SYMLINK-CHAIN-OK:r2" });
      expect(result.candidate.revision).toBe(2);
      expect((await fs.lstat(path.join(root, "src", "link"))).isSymbolicLink()).toBe(true);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("RED-MULTILINE: rejects a symlink patch whose target block spans multiple added lines (fail-closed malformed)", async () => {
    const root = await initRepo();
    try {
      // Committed outward symlink whose name contains a newline: the joint
      // multi-line target `portal\nfile` resolves through it outside the root,
      // while a piecemeal gate only ever sees dangling `portal` / `file`.
      await fs.symlink("../../outside", path.join(root, "src", "portal\nfile"));
      await runShell("git add -A && git -c user.name=test -c user.email=test@example.com commit -qm evil", { cwd: root });
      const current = createCandidateRevisionV1({ operationId: "OP-SYMLINK-MULTILINE", candidateId: "candidate:OP-SYMLINK-MULTILINE:r1", taskId: "TASK-SYMLINK-MULTILINE", revision: 1, sourceDigest: await computeWorktreeDigest(root) });
      // Hand-crafted mode-120000 block with a two-line link body. git apply
      // accepts it and materializes a link whose target is `portal\nfile`.
      const patch = [
        "diff --git a/src/link b/src/link",
        "new file mode 120000",
        "index 0000000..0000000",
        "--- /dev/null",
        "+++ b/src/link",
        "@@ -0,0 +1,2 @@",
        "+portal",
        "+file",
        "\\ No newline at end of file",
        ""
      ].join("\n");
      const changeSet = { version: 1 as const, operationId: current.operationId, taskId: "TASK-SYMLINK-MULTILINE", workUnitId: "WU-1", participantId: "participant-1", baseCandidateRevision: current.revision, baseCandidateDigest: current.identityDigest, changedFiles: ["src/link"], patch, patchDigest: sha256Utf8(patch) };
      let failure: AehError | undefined;
      try {
        await assembleCandidateChangeSet({ root, operationId: current.operationId, taskId: "TASK-SYMLINK-MULTILINE", currentCandidate: current, changeSet, allowedScope: ["src/**"], candidateId: "candidate:OP-SYMLINK-MULTILINE:r2" });
      } catch (error) { failure = error as AehError; }
      expect(failure?.code).toBe("PARTICIPANT_PLAN_INVALID");
      expect(failure?.message).toMatch(/symlink|malformed/i);
      // Fail-closed: the multi-line link was never applied.
      await expect(fs.lstat(path.join(root, "src", "link"))).rejects.toThrow();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("RED-REALPATH: realpath(root) failure rejects fail-closed instead of skipping containment", async () => {
    const root = await initRepo();
    try {
      await fs.symlink("../../outside", path.join(root, "src", "portal"));
      await runShell("git add -A && git -c user.name=test -c user.email=test@example.com commit -qm portal", { cwd: root });
      const current = createCandidateRevisionV1({ operationId: "OP-SYMLINK-REALPATH", candidateId: "candidate:OP-SYMLINK-REALPATH:r1", taskId: "TASK-SYMLINK-REALPATH", revision: 1, sourceDigest: await computeWorktreeDigest(root) });
      // Lexically contained (`src/portal/file`) but resolves outside via
      // portal, so the verdict depends entirely on the chain check that
      // needs realpath(root). Force exactly that lookup to fail.
      const patch = await symlinkPatch(root, "src/link", "portal/file");
      const changeSet = { version: 1 as const, operationId: current.operationId, taskId: "TASK-SYMLINK-REALPATH", workUnitId: "WU-1", participantId: "participant-1", baseCandidateRevision: current.revision, baseCandidateDigest: current.identityDigest, changedFiles: ["src/link"], patch, patchDigest: sha256Utf8(patch) };
      const originalRealpath = fs.realpath;
      const spy = vi.spyOn(fs, "realpath").mockImplementation((async (...args: unknown[]) => {
        if (String(args[0]) === path.resolve(root)) throw Object.assign(new Error("mocked realpath(root) failure"), { code: "EACCES" });
        return (originalRealpath as (...inner: unknown[]) => Promise<string>)(...args);
      }) as typeof fs.realpath);
      try {
        let failure: AehError | undefined;
        try {
          await assembleCandidateChangeSet({ root, operationId: current.operationId, taskId: "TASK-SYMLINK-REALPATH", currentCandidate: current, changeSet, allowedScope: ["src/**"], candidateId: "candidate:OP-SYMLINK-REALPATH:r2" });
        } catch (error) { failure = error as AehError; }
        expect(failure?.code).toBe("PARTICIPANT_PLAN_INVALID");
        expect(failure?.message).toMatch(/symlink|contain|verify/i);
        // Fail-closed: the unverifiable link was never applied.
        await expect(fs.lstat(path.join(root, "src", "link"))).rejects.toThrow();
      } finally { spy.mockRestore(); }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
