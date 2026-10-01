import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertWorkspaceMatchesCandidate } from "../src/candidates/identity.js";
import { computeWorktreeDigest } from "../src/core/git.js";
import { createDistributedCandidatePatch } from "../src/distributed/worker.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { runExecutable, runShell } from "../src/utils/process.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

describe("distributed Candidate source materialization", () => {
  it("recreates tracked and untracked Candidate source from the frozen base commit", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-distributed-candidate-"));
    roots.push(parent);
    const source = path.join(parent, "source");
    const worker = path.join(parent, "worker");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "tracked.ts"), "export const value = 1;\n");
    await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.invalid commit -qm base", { cwd: source });
    await fs.writeFile(path.join(source, "tracked.ts"), "export const value = 2;\n");
    await fs.writeFile(path.join(source, "new.ts"), "export const added = true;\n");
    const candidate = createCandidateRevisionV1({ operationId: "RUN-DISTRIBUTED-TRUTH", candidateId: "candidate:r1", projectId: "project-test", taskId: "DISTRIBUTED-TRUTH", revision: 1, sourceDigest: await computeWorktreeDigest(source) });

    const candidatePatch = await createDistributedCandidatePatch(source);
    await runShell(`git clone --quiet --no-checkout -- ${JSON.stringify(source)} ${JSON.stringify(worker)}`, { cwd: parent });
    await runShell("git checkout --quiet --detach HEAD", { cwd: worker });
    const apply = await runExecutable("git", ["apply", "--binary", "-"], { cwd: worker, timeoutMs: 30_000, stdin: candidatePatch });
    expect(apply.exitCode).toBe(0);
    const evidence = await assertWorkspaceMatchesCandidate(worker, candidate);

    expect(evidence.observedSourceDigest).toBe(candidate.sourceDigest);
    expect(await fs.readFile(path.join(worker, "tracked.ts"), "utf8")).toBe("export const value = 2;\n");
    expect(await fs.readFile(path.join(worker, "new.ts"), "utf8")).toBe("export const added = true;\n");
  });
});
