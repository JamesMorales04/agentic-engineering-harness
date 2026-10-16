import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assembleCandidateChangeSet, type ChangeSetV1 } from "../src/candidates/assembler.js";
import { computeWorktreeDigest } from "../src/core/git.js";
import { sha256Utf8 } from "../src/core/digest.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { runShell } from "../src/utils/process.js";
import { validateDiffScope } from "../src/validators/diffScope.js";
import type { TaskContract } from "../src/core/types.js";

const DROPPINGS = [".config/mise/mise.lock", "graphify-out/cache/stat-index.json"];

async function initRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-d22-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "tasks.js"), "export const range = (n) => [...Array(n + 1).keys()];\n");
  await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.com commit -qm initial", { cwd: root });
  return root;
}

async function baseCandidate(root: string, operationId: string) {
  return createCandidateRevisionV1({
    operationId,
    candidateId: `candidate:${operationId}:r1`,
    taskId: "TASK-D22",
    revision: 1,
    sourceDigest: await computeWorktreeDigest(root),
  });
}

/**
 * Build a worker-style ChangeSet whose declared files AND patch both carry
 * toolchain/provider droppings alongside one real product fix, then restore
 * the worktree to the clean base (the assembler requires it).
 */
async function workerChangeSet(
  root: string,
  current: Awaited<ReturnType<typeof baseCandidate>>,
  operationId: string,
  files: { path: string; content: string }[],
): Promise<ChangeSetV1> {
  await fs.writeFile(path.join(root, "src", "tasks.js"), "export const range = (n) => [...Array(n).keys()];\n");
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(root, file.path)), { recursive: true });
    await fs.writeFile(path.join(root, file.path), file.content);
  }
  await runShell("git add -N --all", { cwd: root });
  const names = await runShell("git diff --name-only HEAD", { cwd: root });
  const patch = (await runShell("git diff --binary --no-ext-diff HEAD -- .", { cwd: root })).stdout;
  const changedFiles = names.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).sort();
  // Restore the clean base the assembler requires.
  await runShell("git reset -q", { cwd: root });
  await runShell("git checkout -- src/tasks.js", { cwd: root });
  await fs.rm(path.join(root, ".config"), { recursive: true, force: true });
  await fs.rm(path.join(root, "graphify-out"), { recursive: true, force: true });
  await fs.rm(path.join(root, ".harness"), { recursive: true, force: true });
  return {
    version: 1,
    operationId,
    taskId: "TASK-D22",
    workUnitId: "WU-1",
    participantId: "participant:WU-1",
    baseCandidateRevision: current.revision,
    baseCandidateDigest: current.identityDigest,
    changedFiles,
    patch,
    patchDigest: sha256Utf8(patch),
  };
}

describe("assembler managed-provisioned hygiene (D22)", () => {
  it("strips droppings from scope accounting AND the delivered patch (digest recomputed)", async () => {
    const root = await initRepo();
    try {
      const current = await baseCandidate(root, "OP-D22-MIXED");
      const changeSet = await workerChangeSet(root, current, "OP-D22-MIXED", [
        { path: ".config/mise/mise.lock", content: "lock\n" },
        { path: "graphify-out/cache/stat-index.json", content: '{"s":1}\n' },
      ]);
      // Precondition: the worker-declared set really does sweep droppings.
      expect(changeSet.changedFiles).toEqual([...DROPPINGS, "src/tasks.js"].sort());

      const result = await assembleCandidateChangeSet({
        root,
        operationId: "OP-D22-MIXED",
        taskId: "TASK-D22",
        currentCandidate: current,
        changeSet,
        allowedScope: ["src/**"],
        candidateId: "candidate:OP-D22-MIXED:r2",
      });

      // Only the real file remains: scope passed, patch rewritten, digest recomputed.
      expect(result.changeSet.changedFiles).toEqual(["src/tasks.js"]);
      expect(result.changeSet.patch).not.toContain(".config/mise");
      expect(result.changeSet.patch).not.toContain("graphify-out");
      expect(result.changeSet.patchDigest).toBe(sha256Utf8(result.changeSet.patch));
      expect(result.impact.changedFiles).toEqual(["src/tasks.js"]);
      // Delivery applied the fix but never committed droppings.
      expect(await fs.readFile(path.join(root, "src", "tasks.js"), "utf8")).toContain("Array(n)");
      await expect(fs.access(path.join(root, ".config", "mise", "mise.lock"))).rejects.toThrow();
      await expect(fs.access(path.join(root, "graphify-out", "cache", "stat-index.json"))).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("droppings-only ChangeSet yields the pre-existing empty-patch terminal (no new states)", async () => {
    const root = await initRepo();
    try {
      const current = await baseCandidate(root, "OP-D22-EMPTY");
      await fs.mkdir(path.join(root, ".config", "mise"), { recursive: true });
      await fs.writeFile(path.join(root, ".config", "mise", "mise.lock"), "lock\n");
      await runShell("git add -N --all", { cwd: root });
      const patch = (await runShell("git diff --binary --no-ext-diff HEAD -- .", { cwd: root })).stdout;
      await runShell("git reset -q", { cwd: root });
      await fs.rm(path.join(root, ".config"), { recursive: true, force: true });
      const changeSet: ChangeSetV1 = {
        version: 1,
        operationId: "OP-D22-EMPTY",
        taskId: "TASK-D22",
        workUnitId: "WU-1",
        participantId: "participant:WU-1",
        baseCandidateRevision: current.revision,
        baseCandidateDigest: current.identityDigest,
        changedFiles: [".config/mise/mise.lock"],
        patch,
        patchDigest: sha256Utf8(patch),
      };
      await expect(
        assembleCandidateChangeSet({
          root,
          operationId: "OP-D22-EMPTY",
          taskId: "TASK-D22",
          currentCandidate: current,
          changeSet,
          allowedScope: ["src/**"],
          candidateId: "candidate:OP-D22-EMPTY:r2",
        }),
      ).rejects.toMatchObject({ code: "PARTICIPANT_PLAN_INVALID", message: expect.stringContaining("patch is empty") });
      // Nothing was applied.
      expect(await fs.readFile(path.join(root, "src", "tasks.js"), "utf8")).toContain("Array(n + 1)");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("a D8 protected manifest still FAILs even beside droppings (classes stay distinct)", async () => {
    const root = await initRepo();
    try {
      const current = await baseCandidate(root, "OP-D22-HARD");
      await fs.mkdir(path.join(root, ".harness"), { recursive: true });
      await fs.writeFile(path.join(root, ".harness", "managed-assets.json"), '{"v":1}\n');
      const changeSet = await workerChangeSet(root, current, "OP-D22-HARD", [
        { path: ".harness/managed-assets.json", content: '{"v":2}\n' },
        { path: ".config/mise/mise.lock", content: "lock\n" },
      ]);
      expect(changeSet.changedFiles).toEqual(
        [".config/mise/mise.lock", ".harness/managed-assets.json", "src/tasks.js"].sort(),
      );
      await expect(
        assembleCandidateChangeSet({
          root,
          operationId: "OP-D22-HARD",
          taskId: "TASK-D22",
          currentCandidate: current,
          changeSet,
          allowedScope: ["**"],
          forbiddenScope: [".harness/managed-assets.json", ".harness/managed-assets.json/**"],
          candidateId: "candidate:OP-D22-HARD:r2",
        }),
      ).rejects.toMatchObject({ code: "PARTICIPANT_PLAN_INVALID" });
      // Nothing was applied (fail-closed before any git apply).
      expect(await fs.readFile(path.join(root, "src", "tasks.js"), "utf8")).toContain("Array(n + 1)");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("an explicit exact exemption is honored, never silently discarded by the managed filter", async () => {
    const root = await initRepo();
    try {
      const current = await baseCandidate(root, "OP-D22-EXEMPT");
      await fs.mkdir(path.join(root, ".config", "mise"), { recursive: true });
      await fs.writeFile(path.join(root, ".config", "mise", "mise.lock"), "lock\n");
      await runShell("git add -N --all", { cwd: root });
      const patch = (await runShell("git diff --binary --no-ext-diff HEAD -- .", { cwd: root })).stdout;
      await runShell("git reset -q", { cwd: root });
      await fs.rm(path.join(root, ".config"), { recursive: true, force: true });
      const changeSet: ChangeSetV1 = {
        version: 1,
        operationId: "OP-D22-EXEMPT",
        taskId: "TASK-D22",
        workUnitId: "WU-1",
        participantId: "participant:WU-1",
        baseCandidateRevision: current.revision,
        baseCandidateDigest: current.identityDigest,
        changedFiles: [".config/mise/mise.lock"],
        patch,
        patchDigest: sha256Utf8(patch),
      };
      // Explicit Owner/lead authority names the exact file: it survives the
      // managed filter and flows through today's exemption semantics (lifts
      // the forbidden deny; allowed-scope membership still required).
      const result = await assembleCandidateChangeSet({
        root,
        operationId: "OP-D22-EXEMPT",
        taskId: "TASK-D22",
        currentCandidate: current,
        changeSet,
        allowedScope: ["**"],
        forbiddenScope: [".config/**"],
        exactScopeExemptions: [".config/mise/mise.lock"],
        candidateId: "candidate:OP-D22-EXEMPT:r2",
      });
      expect(result.changeSet.changedFiles).toEqual([".config/mise/mise.lock"]);
      expect(await fs.readFile(path.join(root, ".config", "mise", "mise.lock"), "utf8")).toBe("lock\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("validateDiffScope managed-provisioned hygiene (D22)", () => {
  const contract = (scope: TaskContract["scope"]): TaskContract => ({
    version: 1,
    task: { id: "T-D22", title: "d22" },
    scope,
  });

  it("droppings neither fail allowed-scope nor trigger forbidden", () => {
    const checks = validateDiffScope(
      ["src/tasks.js", ".config/mise/mise.lock", "graphify-out/cache/stat-index.json", ".serena/x"],
      contract({ allowed: ["src/**"], forbidden: [".config/**"], frozen: [] }),
    );
    expect(checks.every((check) => check.status === "PASS")).toBe(true);
  });

  it("droppings-only input passes (nothing attributable)", () => {
    const checks = validateDiffScope(
      [".config/mise/mise.lock", "graphify-out/cache/stat-index.json"],
      contract({ allowed: ["src/**"], forbidden: [], frozen: [] }),
    );
    expect(checks.every((check) => check.status === "PASS")).toBe(true);
  });

  it("the D8 protected-manifest class is NOT filtered (still fails narrow scope)", () => {
    const checks = validateDiffScope([".harness/managed-assets.json"], contract({ allowed: ["src/**"] }));
    expect(checks.find((check) => check.id === "diff.allowed-scope")?.status).toBe("FAIL");
  });

  it("genuine scope violations are still caught beside droppings", () => {
    const checks = validateDiffScope(
      ["src/tasks.js", "docs/other.md", ".config/mise/mise.lock"],
      contract({ allowed: ["src/**"], forbidden: [], frozen: [] }),
    );
    const allowed = checks.find((check) => check.id === "diff.allowed-scope");
    expect(allowed?.status).toBe("FAIL");
    expect(allowed?.details).toMatchObject({ outsideAllowed: ["docs/other.md"] });
  });
});
