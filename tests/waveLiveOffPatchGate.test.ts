import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WAVE_OFF_PATCH_DENIED_EVENT_V1,
  checkWaveWorktreeOffPatchV1,
  createWaveOffPatchDenialV1,
  findOffPatchWritesV1,
  snapshotWaveWorktreeV1,
  type WaveWorktreeSnapshotEntryV1,
} from "../src/agents/waveExecutor.js";
import { createWaveBase, integrateWaveChangeSets } from "../src/candidates/wave.js";
import type { ChangeSetV1 } from "../src/candidates/assembler.js";
import { sha256Utf8 } from "../src/core/digest.js";
import { loadOperation } from "../src/operations/state.js";
import { saveOwnedOperation } from "./helpers/ownedOperation.js";
import { runExecutable, runShell } from "../src/utils/process.js";
import * as events from "../src/telemetry/events.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const TASK = "TASK-WAVE-LIVE-GATE";

describe("wave live off-patch gate (FAM-WAVE residual)", () => {
  it("pure matcher flags only touched files outside scope", () => {
    const snap = new Map<string, WaveWorktreeSnapshotEntryV1>([
      ["src/a.ts", { hash: "h1", mtimeMs: 1, size: 10, symlink: false }],
      ["src/b.ts", { hash: "h2", mtimeMs: 1, size: 10, symlink: false }],
    ]);
    const cur = new Map<string, WaveWorktreeSnapshotEntryV1>([
      ["src/a.ts", { hash: "h1x", mtimeMs: 2, size: 12, symlink: false }],
      ["src/b.ts", { hash: "h2", mtimeMs: 1, size: 10, symlink: false }],
      ["outside/evil.ts", { hash: "he", mtimeMs: 2, size: 5, symlink: false }],
    ]);
    // Unit A claims src/a.ts: only the outside file is off-patch.
    expect(findOffPatchWritesV1({ snapshot: snap, current: cur, allowedScope: ["src/a.ts"] })).toEqual([
      "outside/evil.ts",
    ]);
    // Untouched in-scope-adjacent files are never flagged.
    expect(findOffPatchWritesV1({ snapshot: snap, current: snap, allowedScope: ["src/a.ts"] })).toEqual([]);
  });

  it("denial receipt is deterministic and stable", () => {
    const a = createWaveOffPatchDenialV1({
      operationId: "OP",
      taskId: TASK,
      workUnitId: "uB",
      participantId: "p1",
      files: ["outside/evil.ts"],
    });
    const b = createWaveOffPatchDenialV1({
      operationId: "OP",
      taskId: TASK,
      workUnitId: "uB",
      participantId: "p1",
      files: ["outside/evil.ts"],
    });
    expect(a.digest).toBe(b.digest);
    expect(a.fileCount).toBe(1);
  });

  it("two-unit wave: unit B off-scope write is denied live, ChangeSet rejected, root keeps only unit A", async () => {
    const root = await createRepo();
    const operationId = `RUN-WAVE-LIVE-${crypto.randomUUID().slice(0, 8)}`;
    const base = await createOperation(root, operationId);

    // Simulate per-unit worktrees via the real gate helpers.
    const worktreeA = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-live-a-"));
    const worktreeB = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-live-b-"));
    roots.push(worktreeA, worktreeB);
    await fs.cp(root, worktreeA, { recursive: true, filter: (s) => !s.includes(".git") });
    await fs.cp(root, worktreeB, { recursive: true, filter: (s) => !s.includes(".git") });
    // Unit A writes in-scope; unit B writes outside its claimed pathspec.
    const snapA = await snapshotWaveWorktreeV1(worktreeA);
    const snapB = await snapshotWaveWorktreeV1(worktreeB);
    await fs.writeFile(path.join(worktreeA, "src", "a.ts"), "export const a = 2;\n");
    await fs.writeFile(path.join(worktreeB, "outside", "evil.ts"), "export const evil = 1;\n");

    const offA = await checkWaveWorktreeOffPatchV1(worktreeA, snapA, ["src/a.ts"]);
    expect(offA).toEqual([]);
    const offB = await checkWaveWorktreeOffPatchV1(worktreeB, snapB, ["src/b.ts"]);
    expect(offB).toEqual(["outside/evil.ts"]);

    // Live denial receipt + event (same site/verb the executor uses).
    const denial = createWaveOffPatchDenialV1({
      operationId,
      taskId: TASK,
      workUnitId: "uB",
      participantId: "participant:uB",
      files: offB,
    });
    expect(denial.fileCount).toBe(1);
    const seen: Array<{ name: string; attributes: Record<string, unknown> }> = [];
    const spy = vi.spyOn(events, "recordEvent").mockImplementation(async (_r, _c, name, attributes) => {
      seen.push({ name, attributes });
    });
    await events.recordEvent(root, { version: 1, project: { name: "fixture" } } as never, WAVE_OFF_PATCH_DENIED_EVENT_V1, {
      operationId,
      taskId: TASK,
      workUnitId: "uB",
      files: denial.files,
      fileCount: denial.fileCount,
      denialDigest: denial.digest,
      status: "FAIL",
    });
    expect(spy).toHaveBeenCalledOnce();
    expect(seen[0]?.name).toBe("harness.wave.off-patch-denied");

    // ChangeSet layer (defense-in-depth): B's escaping ChangeSet is rejected,
    // A's in-scope ChangeSet integrates; root receives only A's patch.
    const changeA = await makeChangeSet(root, base, "uA", "src/a.ts", "export const a = 2;\n");
    const changeB = await makeChangeSet(root, base, "uB", "outside/evil.ts", "export const evil = 1;\n");
    const wave = createWaveBase({ operationId, taskId: TASK, waveIndex: 0, candidate: base });
    const result = await integrateWaveChangeSets({
      root,
      stateRoot: root,
      operationId,
      taskId: TASK,
      wave,
      submissions: [
        { workUnitId: "uA", changeSet: changeA, allowedScope: ["src/a.ts"] },
        { workUnitId: "uB", changeSet: changeB, allowedScope: ["src/b.ts"] },
      ],
    });
    expect(result.integrated.map((s) => s.workUnitId)).toEqual(["uA"]);
    expect(result.reconciliationRequired.map((r) => r.workUnitId)).toEqual(["uB"]);
    const aContent = await fs.readFile(path.join(root, "src", "a.ts"), "utf8");
    expect(aContent).toContain("export const a = 2;");
    const evilContent = await fs.readFile(path.join(root, "outside", "evil.ts"), "utf8");
    expect(evilContent).toContain("export const evil = 0;");
  });
});

async function createRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-wave-live-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "outside"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  await fs.writeFile(path.join(root, "src", "b.ts"), "export const b = 1;\n");
  await fs.writeFile(path.join(root, "outside", "evil.ts"), "export const evil = 0;\n");
  await fs.writeFile(path.join(root, ".gitignore"), ".harness/\n");
  await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.com commit -qm initial", { cwd: root });
  return root;
}

async function createOperation(root: string, operationId: string) {
  const now = new Date().toISOString();
  await saveOwnedOperation(root, { version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "implementation", root, payload: { taskId: TASK }, createdAt: now, updatedAt: now });
  return (await loadOperation(root, operationId)).candidateRevision!;
}

async function makeChangeSet(
  root: string,
  base: NonNullable<Awaited<ReturnType<typeof loadOperation>>["candidateRevision"]>,
  workUnitId: string,
  file: string,
  content: string
): Promise<ChangeSetV1> {
  const absolute = path.join(root, file);
  const previous = await fs.readFile(absolute, "utf8").catch(() => "");
  const indexFile = path.join(root, ".git", `aeh-test-index-${crypto.randomUUID()}`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    const readTree = await runExecutable("git", ["read-tree", "HEAD"], { cwd: root, timeoutMs: 30_000, env });
    const stageCurrent = readTree.exitCode === 0 ? await runExecutable("git", ["add", "-A"], { cwd: root, timeoutMs: 30_000, env }) : readTree;
    const baseTree = stageCurrent.exitCode === 0 ? await runExecutable("git", ["write-tree"], { cwd: root, timeoutMs: 30_000, env }) : stageCurrent;
    if (baseTree.exitCode !== 0 || !baseTree.stdout.trim()) throw new Error(`test base snapshot failed: ${baseTree.stderr || baseTree.stdout}`);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
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
      patchDigest: sha256Utf8(diff.stdout),
    };
  } finally {
    await fs.writeFile(absolute, previous);
    await fs.rm(indexFile, { force: true }).catch(() => undefined);
  }
}
