import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assembleCandidateChangeSet,
  assemblerScopeEscapeDiffV1,
  MAX_ASSEMBLER_SCOPE_ESCAPE_FILES_V1,
  type CandidateScopeEscapeV1,
} from "../src/candidates/assembler.js";
import { computeWorktreeDigest } from "../src/core/git.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { runShell } from "../src/utils/process.js";
import { sha256Utf8 } from "../src/core/digest.js";
import type { AehError } from "../src/core/errors.js";

/**
 * Observability-only scope-escape diagnostics (fail-closed preserved):
 * PARTICIPANT_PLAN_INVALID at assembler.ts carries bounded
 * {escapedFiles, amendableManifests, hardProtected} (hard/amendable split
 * reused from repairScope.ts; dedupe/sort/cap like PR88) in error details +
 * a best-effort trace hook. Still throws terminal; no blocker routing.
 */
describe("candidate scope-escape diagnostics (observability only)", () => {
  it("splits amendable manifests from hard-protected paths (dedupe/sort/cap like PR88)", () => {
    const diff = assemblerScopeEscapeDiffV1([
      "tests/browser/fixture/controlCenterJourney.ts",
      "package.json",
      "package.json",
      "tests/a.ts",
    ]);
    expect(diff.escapedCount).toBe(3);
    expect(diff.escapedFiles).toEqual([...diff.escapedFiles].sort());
    expect(diff.amendableManifests).toEqual(["package.json"]);
    expect(diff.amendableCount).toBe(1);
    expect(diff.hardProtected).toEqual([
      "tests/a.ts",
      "tests/browser/fixture/controlCenterJourney.ts",
    ]);
    expect(diff.hardProtectedCount).toBe(2);
    expect(MAX_ASSEMBLER_SCOPE_ESCAPE_FILES_V1).toBe(10);
  });

  it("caps bounded lists at 10 with total counts preserved", () => {
    const files = Array.from({ length: 12 }, (_, i) => `tests/file-${String(i).padStart(2, "0")}.ts`);
    const diff = assemblerScopeEscapeDiffV1(files);
    expect(diff.escapedCount).toBe(12);
    expect(diff.escapedFiles).toHaveLength(10);
    expect(diff.hardProtectedCount).toBe(12);
    expect(diff.hardProtected).toHaveLength(10);
    expect(diff.amendableCount).toBe(0);
  });

  it("escape message uses capped list + total count with >10 escaped files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-scope-escape-cap-"));
    try {
      const files = Array.from({ length: 12 }, (_, i) => `evil-${String(i).padStart(2, "0")}.txt`);
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
      for (const file of files) await fs.writeFile(path.join(root, file), "closed\n");
      await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.com commit -qm initial", { cwd: root });
      const current = createCandidateRevisionV1({
        operationId: "OP-ESCAPE-CAP",
        candidateId: "candidate:OP-ESCAPE-CAP:r1",
        projectId: "project-escape",
        taskId: "TASK-ESCAPE-CAP",
        revision: 1,
        sourceDigest: await computeWorktreeDigest(root),
      });
      for (const file of files) await fs.writeFile(path.join(root, file), "open\n");
      const patch = (await runShell("git diff --binary HEAD --", { cwd: root })).stdout;
      expect(patch.trim()).not.toBe("");
      for (const file of files) await fs.writeFile(path.join(root, file), "closed\n");
      const changeSet = {
        version: 1 as const,
        operationId: current.operationId,
        taskId: "TASK-ESCAPE-CAP",
        workUnitId: "WU-1",
        participantId: "participant-1",
        baseCandidateRevision: current.revision,
        baseCandidateDigest: current.identityDigest,
        changedFiles: files,
        patch,
        patchDigest: sha256Utf8(patch),
      };
      let failure: AehError | undefined;
      try {
        await assembleCandidateChangeSet({
          root,
          operationId: current.operationId,
          taskId: "TASK-ESCAPE-CAP",
          currentCandidate: current,
          changeSet,
          allowedScope: ["src/**"],
          candidateId: "candidate:OP-ESCAPE-CAP:r2",
        });
      } catch (error) {
        failure = error as AehError;
      }
      expect(failure?.code).toBe("PARTICIPANT_PLAN_INVALID");
      expect(failure?.message).toContain("ChangeSet escaped its assigned scope:");
      // Capped list + total count retained (same convention as details).
      expect(failure?.message).toContain("escapedCount=12");
      expect(failure?.message).toContain("evil-00.txt");
      expect(failure?.message).not.toContain("evil-11.txt");
      expect(failure?.details).toMatchObject({ escapedCount: 12 });
      expect(failure?.details?.escapedFiles).toHaveLength(10);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("RED: escape throw carries bounded split in details + emits best-effort trace, still throws terminal", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-scope-escape-"));
    try {
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.mkdir(path.join(root, "tests"), { recursive: true });
      await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
      await fs.writeFile(path.join(root, "package.json"), '{"name":"x"}\n');
      await fs.writeFile(path.join(root, "tests", "guard.ts"), "closed\n");
      await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.com commit -qm initial", { cwd: root });
      const current = createCandidateRevisionV1({
        operationId: "OP-ESCAPE",
        candidateId: "candidate:OP-ESCAPE:r1",
        projectId: "project-escape",
        taskId: "TASK-ESCAPE",
        revision: 1,
        sourceDigest: await computeWorktreeDigest(root),
      });

      await fs.writeFile(path.join(root, "package.json"), '{"name":"y"}\n');
      await fs.writeFile(path.join(root, "tests", "guard.ts"), "open\n");
      const patch = (await runShell("git diff --binary HEAD --", { cwd: root })).stdout;
      expect(patch.trim()).not.toBe("");
      await fs.writeFile(path.join(root, "package.json"), '{"name":"x"}\n');
      await fs.writeFile(path.join(root, "tests", "guard.ts"), "closed\n");

      const changeSet = {
        version: 1 as const,
        operationId: current.operationId,
        taskId: "TASK-ESCAPE",
        workUnitId: "WU-1",
        participantId: "participant-1",
        baseCandidateRevision: current.revision,
        baseCandidateDigest: current.identityDigest,
        changedFiles: ["package.json", "tests/guard.ts"],
        patch,
        patchDigest: sha256Utf8(patch),
      };

      const traces: CandidateScopeEscapeV1[] = [];
      let failure: AehError | undefined;
      try {
        await assembleCandidateChangeSet({
          root,
          operationId: current.operationId,
          taskId: "TASK-ESCAPE",
          currentCandidate: current,
          changeSet,
          allowedScope: ["src/**"],
          candidateId: "candidate:OP-ESCAPE:r2",
          onScopeEscape: (record) => {
            traces.push(record);
          },
        });
      } catch (error) {
        failure = error as AehError;
      }

      // Still throws terminal fail-closed with stable prefix.
      expect(failure?.code).toBe("PARTICIPANT_PLAN_INVALID");
      expect(failure?.message).toContain("ChangeSet escaped its assigned scope:");
      expect(failure?.message).toContain("package.json");
      expect(failure?.message).toContain("tests/guard.ts");
      // Bounded split in details (no blocker routing, no weakening).
      expect(failure?.details).toMatchObject({
        escapedCount: 2,
        amendableCount: 1,
        hardProtectedCount: 1,
        operationId: "OP-ESCAPE",
        taskId: "TASK-ESCAPE",
      });
      expect(failure?.details?.escapedFiles).toEqual(["package.json", "tests/guard.ts"]);
      expect(failure?.details?.amendableManifests).toEqual(["package.json"]);
      expect(failure?.details?.hardProtected).toEqual(["tests/guard.ts"]);
      // Best-effort trace emitted with the same bounded split.
      expect(traces).toHaveLength(1);
      expect(traces[0]).toMatchObject({
        operationId: "OP-ESCAPE",
        taskId: "TASK-ESCAPE",
        escapedCount: 2,
        amendableManifests: ["package.json"],
        hardProtected: ["tests/guard.ts"],
      });
      // Fail-closed: workspace rolled back, no unbound mutation survives.
      expect(await fs.readFile(path.join(root, "package.json"), "utf8")).toBe('{"name":"x"}\n');
      expect(await fs.readFile(path.join(root, "tests", "guard.ts"), "utf8")).toBe("closed\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("a throwing trace hook never masks the fail-closed rejection", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-scope-escape-hook-"));
    try {
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
      await fs.writeFile(path.join(root, "tests-guard.txt"), "closed\n");
      await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.com commit -qm initial", { cwd: root });
      const current = createCandidateRevisionV1({
        operationId: "OP-ESCAPE-HOOK",
        candidateId: "candidate:OP-ESCAPE-HOOK:r1",
        projectId: "project-escape",
        taskId: "TASK-ESCAPE-HOOK",
        revision: 1,
        sourceDigest: await computeWorktreeDigest(root),
      });
      await fs.writeFile(path.join(root, "tests-guard.txt"), "open\n");
      const patch = (await runShell("git diff --binary HEAD --", { cwd: root })).stdout;
      await fs.writeFile(path.join(root, "tests-guard.txt"), "closed\n");
      const changeSet = {
        version: 1 as const,
        operationId: current.operationId,
        taskId: "TASK-ESCAPE-HOOK",
        workUnitId: "WU-1",
        participantId: "participant-1",
        baseCandidateRevision: current.revision,
        baseCandidateDigest: current.identityDigest,
        changedFiles: ["tests-guard.txt"],
        patch,
        patchDigest: sha256Utf8(patch),
      };
      await expect(
        assembleCandidateChangeSet({
          root,
          operationId: current.operationId,
          taskId: "TASK-ESCAPE-HOOK",
          currentCandidate: current,
          changeSet,
          allowedScope: ["src/**"],
          candidateId: "candidate:OP-ESCAPE-HOOK:r2",
          onScopeEscape: () => {
            throw new Error("trace sink failed");
          },
        }),
      ).rejects.toMatchObject({ code: "PARTICIPANT_PLAN_INVALID" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
