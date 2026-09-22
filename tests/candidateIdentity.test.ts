import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeWorktreeDigest } from "../src/core/git.js";
import { verifyTask } from "../src/core/verify.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import { bindOperationCandidate, loadOperation, saveOperation } from "../src/operations/state.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { execFileSync } from "node:child_process";
import { buildRequirementEvidenceGraph } from "../src/evidence/graph.js";

const roots: string[] = [];
const originalEnv = { id: process.env.AEH_OPERATION_ID, redirect: process.env.AEH_OPERATION_STATE_REDIRECT, control: process.env.AEH_CONTROL_ROOT };
afterEach(async () => {
  if (originalEnv.id === undefined) delete process.env.AEH_OPERATION_ID; else process.env.AEH_OPERATION_ID = originalEnv.id;
  if (originalEnv.redirect === undefined) delete process.env.AEH_OPERATION_STATE_REDIRECT; else process.env.AEH_OPERATION_STATE_REDIRECT = originalEnv.redirect;
  if (originalEnv.control === undefined) delete process.env.AEH_CONTROL_ROOT; else process.env.AEH_CONTROL_ROOT = originalEnv.control;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("candidate source identity", () => {
  it("changes when actual worktree content changes and ignores controller state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-candidate-source-")); roots.push(root);
    await fs.mkdir(path.join(root, ".harness"), { recursive: true });
    await fs.writeFile(path.join(root, "source.ts"), "export const value = 1;\n");
    const first = await computeWorktreeDigest(root);
    await fs.writeFile(path.join(root, ".harness", "operation.json"), "controller state\n");
    expect(await computeWorktreeDigest(root)).toBe(first);
    await fs.writeFile(path.join(root, "source.ts"), "export const value = 2;\n");
    expect(await computeWorktreeDigest(root)).not.toBe(first);
  });

  it("binds managed validation reports to the current candidate revision", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-candidate-report-")); roots.push(root);
    execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "AEH Test"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "aeh@example.invalid"], { cwd: root, stdio: "ignore" });
    await fs.writeFile(path.join(root, ".gitignore"), ".harness/\n");
    await fs.writeFile(path.join(root, "source.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", ".gitignore", "source.ts"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    await fs.writeFile(path.join(root, "source.ts"), "export const value = 2;\n");
    const now = "2026-01-01T00:00:00.000Z";
    await saveOperation(root, { version: 1, id: "RUN-CANDIDATE", kind: "run", status: "RUNNING", phase: "implementation", root, payload: { taskId: "CANDIDATE-REPORT" }, createdAt: now, updatedAt: now });
    const digest = await computeWorktreeDigest(root);
    const candidate = (await loadOperation(root, "RUN-CANDIDATE")).candidateRevision!;
    process.env.AEH_OPERATION_ID = "RUN-CANDIDATE";
    process.env.AEH_OPERATION_STATE_REDIRECT = "1";
    process.env.AEH_CONTROL_ROOT = root;
    const config: HarnessProjectConfig = { version: 1, project: { name: "candidate-report" }, validation: { baseRef: "HEAD", requireSeal: false, commands: [], validators: [], opa: { enabled: false } }, telemetry: { enabled: false } };
    const contract: TaskContract = { version: 1, task: { id: "CANDIDATE-REPORT", title: "Candidate report" }, git: { baseRef: "HEAD" }, scope: { allowed: ["**"], forbidden: [], frozen: [] }, requirements: [] };
    const report = await verifyTask(root, config, contract, { stateRoot: root, policyRoot: root });
    expect(report.candidate?.identityDigest).toBe(candidate.identityDigest);
    expect(report.candidate?.sourceDigest).toBe(digest);
    expect(report.candidateWorkspaceIdentity).toMatchObject({ candidateIdentityDigest: candidate.identityDigest, expectedSourceDigest: digest, observedSourceDigest: digest, status: "MATCH" });

    await fs.rm(path.join(root, ".harness", "reports", "CANDIDATE-REPORT.json"), { force: true });
    const mutatingConfig: HarnessProjectConfig = {
      ...config,
      validation: {
        ...config.validation,
        commands: [{ id: "mutates-candidate", command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("require('node:fs').writeFileSync('source.ts', 'mutated by validator\\n')")}` }]
      }
    };
    await expect(verifyTask(root, mutatingConfig, contract, { stateRoot: root, policyRoot: root })).rejects.toMatchObject({ code: "CANDIDATE_WORKSPACE_MISMATCH", details: { expectedSourceDigest: digest } });
    await expect(fs.access(path.join(root, ".harness", "reports", "CANDIDATE-REPORT.json"))).rejects.toThrow();
    await fs.writeFile(path.join(root, "source.ts"), "export const value = 2;\n");

    await fs.rm(path.join(root, ".harness", "reports", "CANDIDATE-REPORT.json"), { force: true });
    await fs.writeFile(path.join(root, "source.ts"), "export const value = 3;\n");
    await expect(verifyTask(root, config, contract, { stateRoot: root, policyRoot: root })).rejects.toMatchObject({ code: "CANDIDATE_WORKSPACE_MISMATCH", details: { expectedSourceDigest: digest } });
    await expect(fs.access(path.join(root, ".harness", "reports", "CANDIDATE-REPORT.json"))).rejects.toThrow();

    await expect(buildRequirementEvidenceGraph({
      root,
      stateRoot: root,
      config,
      contract,
      report
    })).rejects.toMatchObject({ code: "CANDIDATE_WORKSPACE_MISMATCH" });
    await expect(fs.access(path.join(root, ".harness", "evidence", "CANDIDATE-REPORT.json"))).rejects.toThrow();

    await fs.writeFile(path.join(root, "source.ts"), "export const value = 2;\n");
    const sameTreeNextRevision = createCandidateRevisionV1({ operationId: "RUN-CANDIDATE", candidateId: "candidate-2", projectId: candidate.projectId, taskId: "CANDIDATE-REPORT", revision: 2, parentCandidateId: candidate.candidateId, sourceDigest: digest });
    await bindOperationCandidate(root, "RUN-CANDIDATE", sameTreeNextRevision);
    await expect(buildRequirementEvidenceGraph({ root, stateRoot: root, config, contract, report })).rejects.toMatchObject({ code: "CANDIDATE_STALE" });
  });
});
