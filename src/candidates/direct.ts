import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";
import type { HarnessProjectConfig, TaskContract, WorkerSession } from "../core/types.js";
import { sha256Utf8 } from "../core/digest.js";
import { AehError } from "../core/errors.js";
import { runExecutable } from "../utils/process.js";
import { existingRepositoryPath, repositoryPath } from "../utils/repositoryPath.js";
import { assertWorkspaceMatchesCandidate } from "./identity.js";
import type { ChangeSetV1 } from "./assembler.js";

export interface IsolatedCandidateExecutionV1 {
  session: WorkerSession;
  changeSet?: ChangeSetV1;
}

/**
 * Materialize the exact source state of a frozen CandidateRevision into a
 * fresh worktree: HEAD plus the candidate's tracked diff plus untracked
 * non-ignored files. The caller owns worktree creation/removal.
 */
export async function materializeCandidateState(sourceRoot: string, targetRoot: string, candidate: CandidateRevisionV1): Promise<void> {
  if (candidate.operationId && !candidate.sourceDigest) throw new AehError("CANDIDATE_STALE", "Candidate has no source digest to materialize.");
  await assertWorkspaceMatchesCandidate(sourceRoot, candidate);
  const baselinePatch = await runExecutable("git", ["diff", "--binary", "HEAD", "--"], { cwd: sourceRoot, timeoutMs: 60_000 });
  if (baselinePatch.exitCode !== 0) throw new AehError("CANDIDATE_STALE", `Unable to snapshot the candidate source: ${baselinePatch.stderr || baselinePatch.stdout}`);
  if (baselinePatch.stdout) {
    const applied = await runExecutable("git", ["apply", "--binary", "-"], { cwd: targetRoot, timeoutMs: 60_000, stdin: baselinePatch.stdout });
    if (applied.exitCode !== 0) throw new AehError("CANDIDATE_STALE", `Unable to materialize the candidate source: ${applied.stderr || applied.stdout}`);
  }
  await copyUntrackedCandidateFiles(sourceRoot, targetRoot);
  await assertWorkspaceMatchesCandidate(targetRoot, candidate);
}

/**
 * Run a single DIRECT participant against an isolated snapshot of the current
 * candidate and return its source diff. The caller owns assembly and binding.
 */
export async function executeIsolatedCandidateMutation(input: {
  root: string;
  operationId: string;
  taskId: string;
  workUnitId: string;
  candidate: CandidateRevisionV1;
  config: HarnessProjectConfig;
  contract: TaskContract;
  execute: (isolatedRoot: string) => Promise<WorkerSession>;
  prepareWorkspace?: (isolatedRoot: string) => Promise<void>;
}): Promise<IsolatedCandidateExecutionV1> {
  if (input.candidate.operationId !== input.operationId) throw new AehError("CANDIDATE_STALE", "DIRECT execution candidate belongs to another operation.");
  if (input.candidate.taskId && input.candidate.taskId !== input.taskId) throw new AehError("CANDIDATE_STALE", "DIRECT execution candidate belongs to another task.");
  await assertWorkspaceMatchesCandidate(input.root, input.candidate);

  const isolatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), `aeh-direct-${safe(input.taskId)}-`));
  try {
    const add = await runExecutable("git", ["worktree", "add", "--detach", isolatedRoot, "HEAD"], { cwd: input.root, timeoutMs: 120_000 });
    if (add.exitCode !== 0) throw new AehError("CANDIDATE_STALE", `Unable to create isolated DIRECT workspace: ${add.stderr || add.stdout}`);

    await materializeCandidateState(input.root, isolatedRoot, input.candidate);
    await copyTaskContext(input.root, isolatedRoot, input.config, input.contract);
    await input.prepareWorkspace?.(isolatedRoot);
    await assertContainedSourceSymlinks(isolatedRoot);

    const addBaseline = await runExecutable("git", ["add", "-A"], { cwd: isolatedRoot, timeoutMs: 30_000 });
    const commitBaseline = addBaseline.exitCode === 0 ? await runExecutable("git", ["-c", "user.name=aeh", "-c", "user.email=aeh@localhost", "commit", "--no-gpg-sign", "-m", "aeh direct baseline", "--allow-empty"], { cwd: isolatedRoot, timeoutMs: 60_000 }) : addBaseline;
    const baseline = commitBaseline.exitCode === 0 ? await runExecutable("git", ["rev-parse", "HEAD"], { cwd: isolatedRoot, timeoutMs: 15_000 }) : commitBaseline;
    if (baseline.exitCode !== 0) throw new AehError("CANDIDATE_STALE", `Unable to seal isolated DIRECT baseline: ${baseline.stderr || baseline.stdout}`);
    const baselineCommit = baseline.stdout.trim();
    if (!baselineCommit) throw new AehError("CANDIDATE_STALE", "Isolated DIRECT baseline commit was not created.");

    const session = await input.execute(isolatedRoot);
    if (session.exitCode !== 0) return { session };

    const intent = await runExecutable("git", ["add", "-N", "--all"], { cwd: isolatedRoot, timeoutMs: 30_000 });
    if (intent.exitCode !== 0) throw new AehError("CANDIDATE_STALE", `Unable to enumerate DIRECT changes: ${intent.stderr || intent.stdout}`);
    const [names, diff] = await Promise.all([
      runExecutable("git", ["diff", "--name-only", "--no-renames", "-z", baselineCommit, "--"], { cwd: isolatedRoot, timeoutMs: 30_000 }),
      runExecutable("git", ["diff", "--binary", "--no-ext-diff", baselineCommit, "--"], { cwd: isolatedRoot, timeoutMs: 60_000 })
    ]);
    if (names.exitCode !== 0 || diff.exitCode !== 0) throw new AehError("CANDIDATE_STALE", `Unable to capture DIRECT ChangeSet: ${names.stderr || diff.stderr || names.stdout || diff.stdout}`);
    const changedFiles = [...new Set(names.stdout.split("\0").map((file) => file.trim()).filter(Boolean))].sort();
    if (!changedFiles.length || !diff.stdout.trim()) return { session };
    const changeSet: ChangeSetV1 = {
      version: 1,
      operationId: input.operationId,
      taskId: input.taskId,
      workUnitId: input.workUnitId,
      participantId: session.participantId ?? `participant:${input.operationId}:direct`,
      baseCandidateRevision: input.candidate.revision,
      baseCandidateDigest: input.candidate.identityDigest,
      changedFiles,
      patch: diff.stdout,
      patchDigest: sha256Utf8(diff.stdout)
    };
    return { session, changeSet };
  } finally {
    await runExecutable("git", ["worktree", "remove", "--force", isolatedRoot], { cwd: input.root, timeoutMs: 120_000 }).catch(() => undefined);
    await fs.rm(isolatedRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Capture the exact inverse of a previously assembled ChangeSet from a fresh
 * snapshot of the now-current candidate. The inverse is still returned as a
 * ChangeSet so callers can advance candidate lineage when rejecting a repair.
 */
export async function captureInverseCandidateChangeSet(input: {
  root: string;
  operationId: string;
  taskId: string;
  workUnitId: string;
  candidate: CandidateRevisionV1;
  config: HarnessProjectConfig;
  contract: TaskContract;
  rejectedChangeSet: ChangeSetV1;
  prepareWorkspace?: (isolatedRoot: string) => Promise<void>;
}): Promise<ChangeSetV1 | undefined> {
  if (input.rejectedChangeSet.operationId !== input.operationId || input.rejectedChangeSet.taskId !== input.taskId) {
    throw new AehError("CANDIDATE_STALE", "Rejected ChangeSet identity does not match the rollback request.");
  }
  if (input.rejectedChangeSet.version !== 1 || input.rejectedChangeSet.baseCandidateRevision + 1 !== input.candidate.revision || sha256Utf8(input.rejectedChangeSet.patch) !== input.rejectedChangeSet.patchDigest) {
    throw new AehError("CANDIDATE_STALE", "Rejected ChangeSet is not bound to the current candidate revision.");
  }
  const result = await executeIsolatedCandidateMutation({
    ...input,
    execute: async (isolatedRoot) => {
      const reverted = await runExecutable("git", ["apply", "--reverse", "--binary", "-"], {
        cwd: isolatedRoot,
        timeoutMs: 60_000,
        stdin: input.rejectedChangeSet.patch
      });
      return {
        provider: "aeh-candidate-controller",
        participantId: `controller:${input.operationId}:candidate-rejection`,
        exitCode: reverted.exitCode,
        stdout: reverted.stdout,
        stderr: reverted.stderr
      };
    }
  });
  return result.changeSet;
}

async function copyUntrackedCandidateFiles(root: string, target: string): Promise<void> {
  const result = await runExecutable("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new AehError("CANDIDATE_STALE", `Unable to snapshot untracked candidate files: ${result.stderr || result.stdout}`);
  for (const relative of result.stdout.split("\0").filter(Boolean)) {
    const source = repositoryPath(root, relative);
    const destination = repositoryPath(target, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(source, destination, { recursive: true, force: true, dereference: false });
  }
}

async function copyTaskContext(root: string, target: string, config: HarnessProjectConfig, contract: TaskContract): Promise<void> {
  const relative = [
    `${config.sdd?.contractsDir ?? ".harness/contracts"}/${contract.task.id}.yaml`,
    `.harness/seals/${contract.task.id}.json`,
    ...Object.values(contract.source ?? {}).filter((value): value is string => Boolean(value)),
    contract.issue?.snapshotPath
  ].filter((value): value is string => Boolean(value));
  for (const item of [...new Set(relative)]) {
    try {
      const source = await existingRepositoryPath(root, item);
      const destination = repositoryPath(target, item);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(source, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function assertContainedSourceSymlinks(root: string): Promise<void> {
  const result = await runExecutable("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new AehError("CANDIDATE_STALE", `Unable to inspect isolated workspace links: ${result.stderr || result.stdout}`);
  const canonicalRoot = await fs.realpath(root);
  for (const relative of [...new Set(result.stdout.split("\0").filter(Boolean))]) {
    const absolute = path.resolve(root, relative);
    const stat = await fs.lstat(absolute).catch(() => undefined);
    if (!stat?.isSymbolicLink()) continue;
    const target = await fs.readlink(absolute);
    const resolved = path.resolve(path.dirname(absolute), target);
    const realTarget = await fs.realpath(resolved).catch(() => resolved);
    const rel = path.relative(canonicalRoot, realTarget);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new AehError("PARTICIPANT_PLAN_INVALID", `Isolated DIRECT workspace contains a source symlink outside its root: ${relative}`);
    }
  }
}

function safe(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, "-"); }
