import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import { computeWorktreeDigest } from "../src/core/git.js";
import { assembleCandidateChangeSet } from "../src/candidates/assembler.js";
import { executeIsolatedCandidateMutation } from "../src/candidates/direct.js";
import { bindAssembledCandidate } from "../src/candidates/binding.js";
import { bindOperationCandidate, loadOperation, patchOperation, saveOperation } from "../src/operations/state.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { runShell } from "../src/utils/process.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

describe("DIRECT candidate lifecycle", () => {
  it("isolates participant writes, assembles the ChangeSet, and binds the exact resulting tree", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-direct-candidate-"));
    roots.push(root);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, ".gitignore"), ".harness/\n");
    await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
    await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.com commit -qm initial", { cwd: root });

    const createdAt = "2026-01-01T00:00:00.000Z";
    await saveOperation(root, { version: 1, id: "RUN-DIRECT-CANDIDATE", kind: "run", status: "RUNNING", phase: "implementation", root, payload: { taskId: "DIRECT-CANDIDATE" }, createdAt, updatedAt: createdAt });
    const currentCandidate = (await loadOperation(root, "RUN-DIRECT-CANDIDATE")).candidateRevision!;

    const config: HarnessProjectConfig = { version: 1, project: { name: "direct-candidate" } };
    const contract: TaskContract = { version: 1, task: { id: "DIRECT-CANDIDATE", title: "Direct candidate test" }, scope: { allowed: ["src/**"], forbidden: [] } };
    const isolated = await executeIsolatedCandidateMutation({
      root,
      operationId: "RUN-DIRECT-CANDIDATE",
      taskId: contract.task.id,
      workUnitId: "direct:DIRECT-CANDIDATE",
      candidate: currentCandidate,
      config,
      contract,
      execute: async (isolatedRoot) => {
        await fs.writeFile(path.join(isolatedRoot, "src", "value.ts"), "export const value = 2;\n");
        return { provider: "test", logicalAgent: "implementer", participantId: "participant:direct", exitCode: 0, stdout: "", stderr: "" };
      }
    });

    expect(await fs.readFile(path.join(root, "src", "value.ts"), "utf8")).toBe("export const value = 1;\n");
    expect(isolated.changeSet?.changedFiles).toEqual(["src/value.ts"]);
    expect(isolated.changeSet?.baseCandidateRevision).toBe(currentCandidate.revision);

    const assembled = await assembleCandidateChangeSet({
      root,
      operationId: "RUN-DIRECT-CANDIDATE",
      projectId: currentCandidate.projectId,
      taskId: contract.task.id,
      currentCandidate,
      changeSet: isolated.changeSet!,
      allowedScope: contract.scope!.allowed,
      forbiddenScope: contract.scope!.forbidden,
      candidateId: "candidate:RUN-DIRECT-CANDIDATE:r2"
    });
    await bindOperationCandidate(root, "RUN-DIRECT-CANDIDATE", assembled.candidate);

    const operation = await loadOperation(root, "RUN-DIRECT-CANDIDATE");
    expect(await fs.readFile(path.join(root, "src", "value.ts"), "utf8")).toBe("export const value = 2;\n");
    expect(assembled.candidate.revision).toBe(currentCandidate.revision + 1);
    expect(assembled.candidate.sourceDigest).toBe(await computeWorktreeDigest(root));
    expect(operation.candidateRevision?.identityDigest).toBe(assembled.candidate.identityDigest);
    expect(operation.candidateRevision?.sourceDigest).toBe(assembled.candidate.sourceDigest);
  });

  it("rejects execution when the workspace no longer matches the bound candidate", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-direct-stale-"));
    roots.push(root);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
    await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.com commit -qm initial", { cwd: root });
    const candidate = createCandidateRevisionV1({ operationId: "RUN-STALE", candidateId: "candidate:RUN-STALE:r1", taskId: "STALE", revision: 1, sourceDigest: await computeWorktreeDigest(root) });
    await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 2;\n");
    const config: HarnessProjectConfig = { version: 1, project: { name: "stale" } };
    const contract: TaskContract = { version: 1, task: { id: "STALE", title: "Stale candidate test" } };

    await expect(executeIsolatedCandidateMutation({ root, operationId: candidate.operationId, taskId: "STALE", workUnitId: "direct:STALE", candidate, config, contract, execute: async () => { throw new Error("must not run"); } })).rejects.toThrow("does not materialize CandidateRevision");
  });

  it("restores the bound tree when an assembled Candidate cannot be bound", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-direct-bind-rollback-"));
    roots.push(root);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, ".gitignore"), ".harness/\n");
    await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
    await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.com commit -qm initial", { cwd: root });
    const operationId = "RUN-DIRECT-BIND-ROLLBACK";
    const now = "2026-01-01T00:00:00.000Z";
    await saveOperation(root, { version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "implementation", root, payload: { taskId: "DIRECT-CANDIDATE" }, createdAt: now, updatedAt: now });
    const baseCandidate = (await loadOperation(root, operationId)).candidateRevision!;
    const config: HarnessProjectConfig = { version: 1, project: { name: "direct-candidate" } };
    const contract: TaskContract = { version: 1, task: { id: "DIRECT-CANDIDATE", title: "Direct candidate test" }, scope: { allowed: ["src/**"], forbidden: [] } };
    const isolated = await executeIsolatedCandidateMutation({ root, operationId, taskId: contract.task.id, workUnitId: "direct:bind-rollback", candidate: baseCandidate, config, contract, execute: async (isolatedRoot) => { await fs.writeFile(path.join(isolatedRoot, "src", "value.ts"), "export const value = 2;\n"); return { provider: "test", logicalAgent: "implementer", exitCode: 0, stdout: "", stderr: "" }; } });
    const assembled = await assembleCandidateChangeSet({ root, operationId, projectId: baseCandidate.projectId, taskId: contract.task.id, currentCandidate: baseCandidate, changeSet: isolated.changeSet!, allowedScope: contract.scope!.allowed, forbiddenScope: [], candidateId: `candidate:${operationId}:r2` });
    await patchOperation(root, operationId, { status: "CANCELLED" });

    await expect(bindAssembledCandidate({ root, stateRoot: root, operationId, baseCandidate, candidate: assembled.candidate, changeSet: isolated.changeSet! })).rejects.toThrow("CandidateRevision");
    expect(await fs.readFile(path.join(root, "src", "value.ts"), "utf8")).toBe("export const value = 1;\n");
    expect(await computeWorktreeDigest(root)).toBe(baseCandidate.sourceDigest);
    expect((await loadOperation(root, operationId)).candidateRevision?.identityDigest).toBe(baseCandidate.identityDigest);
  });
});
