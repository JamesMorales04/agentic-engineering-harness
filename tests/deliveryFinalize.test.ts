import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import { computeWorktreeDigest } from "../src/core/git.js";
import { sha256Utf8 } from "../src/core/digest.js";
import { claimControllerEpoch, loadOperation, saveOperation } from "../src/operations/state.js";
import { createCandidateRevisionV1, type CandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { deliveryFinalizationFailure, finalizeAcceptedIssue } from "../src/delivery/finalize.js";
import { runExecutable } from "../src/utils/process.js";

async function git(cwd: string, ...args: string[]): Promise<string> { const result = await runExecutable("git", args, { cwd, timeoutMs: 120_000 }); if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`); return result.stdout.trim(); }
const roots: string[] = [];
const previousEnv = { id: process.env.AEH_OPERATION_ID, control: process.env.AEH_CONTROL_ROOT, redirect: process.env.AEH_OPERATION_STATE_REDIRECT, epoch: process.env.AEH_CONTROLLER_EPOCH };
afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.GH_TOKEN;
  restoreEnv("AEH_OPERATION_ID", previousEnv.id);
  restoreEnv("AEH_CONTROL_ROOT", previousEnv.control);
  restoreEnv("AEH_OPERATION_STATE_REDIRECT", previousEnv.redirect);
  restoreEnv("AEH_CONTROLLER_EPOCH", previousEnv.epoch);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("accepted issue delivery finalization", () => {
  it("commits accepted work, pushes the exact issue branch and creates a draft PR through the tool action gate", async () => {
    const context = await createFinalizeFixture();
    const result = await finalizeAcceptedIssue(context.repo, context.config, context.contract, { candidate: context.candidate });
    expect(result).toMatchObject({ status: "FINALIZED", committed: true, pushed: true, humanRequired: false, pullRequest: { number: 9, draft: true } });
    expect(await git(context.repo, "status", "--porcelain")).toBe("");
    expect(await git(context.repo, "log", "-1", "--pretty=%s")).toBe("GH-5: Update README");
    expect(await git(context.remote, "rev-parse", "refs/heads/feature/gh-5-update-readme")).toBe(await git(context.repo, "rev-parse", "HEAD"));
    const create = context.requests.find((request) => request.method === "POST" && request.url.endsWith("/pulls"));
    expect(create?.body).toContain("Closes #5");
    // Every sensitive action has a durable intent and receipt.
    const actions = await fs.readdir(actionDirectory(context.repo, context.operationId));
    expect(actions.filter((file) => file.endsWith(".intent.json"))).toHaveLength(3);
    expect(actions.filter((file) => file.endsWith(".receipt.json"))).toHaveLength(3);
  });

  it("reconciles a lost push receipt instead of retrying the side effect", async () => {
    const context = await createFinalizeFixture();
    await finalizeAcceptedIssue(context.repo, context.config, context.contract, { candidate: context.candidate });
    const pushedSha = await git(context.remote, "rev-parse", "refs/heads/feature/gh-5-update-readme");

    // Simulate a crash after the external push but before the receipt persisted.
    const directory = actionDirectory(context.repo, context.operationId);
    const receipts = (await fs.readdir(directory)).filter((file) => file.endsWith(".receipt.json"));
    for (const receipt of receipts) await fs.rm(path.join(directory, receipt));

    const result = await finalizeAcceptedIssue(context.repo, context.config, context.contract, { candidate: context.candidate });
    expect(result.status).toBe("FINALIZED");
    expect(await git(context.remote, "rev-parse", "refs/heads/feature/gh-5-update-readme")).toBe(pushedSha);
    expect(await git(context.repo, "log", "-1", "--pretty=%s")).toBe("GH-5: Update README");
    // The commit was already durable and is not re-executed; push and pull-request
    // receipts are recovered through external reconciliation.
    const recovered = (await fs.readdir(directory)).filter((file) => file.endsWith(".receipt.json"));
    expect(recovered).toHaveLength(2);
    const recoveredReceipts = await Promise.all(recovered.map(async (file) => JSON.parse(await fs.readFile(path.join(directory, file), "utf8")) as { action: string; outcome: string }));
    expect(recoveredReceipts.find((receipt) => receipt.action === "git.push")).toMatchObject({ outcome: "SUCCEEDED" });
  });

  it("fails closed without a managed operation authority", async () => {
    const context = await createFinalizeFixture({ managed: false });
    await expect(finalizeAcceptedIssue(context.repo, context.config, context.contract, { candidate: context.candidate })).rejects.toThrow("DELIVERY_AUTHORITY_REQUIRED");
  });

  it("refuses delivery when the Candidate object is correct but the workspace tree has drifted", async () => {
    const context = await createFinalizeFixture();
    await fs.writeFile(path.join(context.repo, "README.md"), "unbound workspace change\n");

    await expect(finalizeAcceptedIssue(context.repo, context.config, context.contract, { candidate: context.candidate }))
      .rejects.toMatchObject({ code: "CANDIDATE_WORKSPACE_MISMATCH" });
    expect(context.requests).toHaveLength(0);
    expect(await git(context.repo, "log", "-1", "--pretty=%s")).toBe("base");
  });

  it("does not commit a workspace changed between candidate verification and staging", async () => {
    const context = await createFinalizeFixture();
    const fakeBin = path.join(path.dirname(context.repo), "fake-bin");
    await fs.mkdir(fakeBin, { recursive: true });
    const realGit = await runExecutable("which", ["git"], { cwd: context.repo, timeoutMs: 10_000 }).then((result) => result.stdout.trim());
    const wrapper = path.join(fakeBin, "git");
    await fs.writeFile(wrapper, `#!/bin/sh\nif [ "${"$1"}" = "add" ]; then printf 'raced mutation\\n' > "${"$AEH_FINALIZE_REPO"}/README.md"; fi\nexec "${realGit}" "${"$@"}"\n`, { mode: 0o755 });
    await fs.chmod(wrapper, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${previousPath ?? ""}`;
    process.env.AEH_FINALIZE_REPO = context.repo;
    try {
      await expect(finalizeAcceptedIssue(context.repo, context.config, context.contract, { candidate: context.candidate })).rejects.toThrow("git commit failed");
      expect(await git(context.repo, "log", "-1", "--pretty=%s")).toBe("base");
      expect(context.requests).toHaveLength(0);
    } finally {
      process.env.PATH = previousPath;
      delete process.env.AEH_FINALIZE_REPO;
      await fs.rm(fakeBin, { recursive: true, force: true });
    }
  });

  it("maps external delivery failures to human-on-exception", () => {
    expect(deliveryFinalizationFailure(new Error("BLOCKED_EXTERNAL: token unavailable"))).toMatchObject({ status: "BLOCKED_EXTERNAL", humanRequired: true });
    expect(deliveryFinalizationFailure(new Error("SYSTEM_FAILURE: branch mismatch"))).toMatchObject({ status: "SYSTEM_FAILURE", humanRequired: false });
  });
});

interface FinalizeFixture {
  repo: string;
  remote: string;
  config: HarnessProjectConfig;
  contract: TaskContract;
  candidate: CandidateRevisionV1;
  operationId: string;
  requests: Array<{ url: string; method: string; body?: string }>;
}

async function createFinalizeFixture(options: { managed?: boolean } = {}): Promise<FinalizeFixture> {
  const managed = options.managed !== false;
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-finalize-"));
  roots.push(baseDir);
  const remote = path.join(baseDir, "origin.git");
  const repo = path.join(baseDir, "repo");
  await fs.mkdir(repo); await git(baseDir, "init", "--bare", remote); await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "AEH Test"); await git(repo, "config", "user.email", "aeh@example.invalid");
  await fs.writeFile(path.join(repo, "README.md"), "base\n"); await git(repo, "add", "README.md"); await git(repo, "commit", "-m", "base"); await git(repo, "remote", "add", "origin", remote); await git(repo, "push", "-u", "origin", "main");
  await git(repo, "checkout", "-b", "feature/gh-5-update-readme");
  await fs.writeFile(path.join(repo, "README.md"), "accepted implementation\n");
  await fs.writeFile(path.join(repo, ".gitignore"), ".harness/\n");
  await fs.mkdir(path.join(repo, ".harness", "delivery"), { recursive: true });
  await fs.writeFile(path.join(repo, ".harness", "delivery", "GH-5.json"), JSON.stringify({ version: 1, taskId: "GH-5", status: "ready", createdAt: "2026-08-11T00:00:00Z", updatedAt: "2026-08-11T00:00:00Z", originatingBranch: "main", github: { repository: "owner/repo", issueNumber: 5, issueUrl: "https://github.com/owner/repo/issues/5", branch: "feature/gh-5-update-readme" } }));

  const config: HarnessProjectConfig = { version: 1, project: { name: "finalize-test" }, validation: { baseRef: "main" }, delivery: { stateDir: ".harness/delivery", github: { enabled: true, tokenEnv: "GH_TOKEN", finalizeOnAcceptance: true, pullRequestDraft: true } } };
  const contract: TaskContract = { version: 1, task: { id: "GH-5", title: "Update README" }, issue: { provider: "github", repository: "owner/repo", number: 5, url: "https://github.com/owner/repo/issues/5", state: "open", fetchedAt: "2026-08-11T00:00:00Z", updatedAt: "2026-08-11T00:00:00Z", contentSha256: "a".repeat(64), snapshotPath: ".harness/issues/GH-5.json" }, git: { baseRef: "main", originatingBranch: "main" } };
  const operationId = "RUN-FINALIZE-GH-5";
  let candidate: CandidateRevisionV1;
  if (managed) {
    await saveOperation(repo, { version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "delivery", root: repo, payload: { taskId: "GH-5" }, createdAt: "2026-08-11T00:00:00Z", updatedAt: "2026-08-11T00:00:00Z" });
    candidate = (await loadOperation(repo, operationId)).candidateRevision!;
    await claimControllerEpoch(repo, operationId, "controller:test");
    process.env.AEH_OPERATION_ID = operationId;
    process.env.AEH_CONTROL_ROOT = repo;
    process.env.AEH_OPERATION_STATE_REDIRECT = "1";
    process.env.AEH_CONTROLLER_EPOCH = "1";
  } else {
    candidate = createCandidateRevisionV1({ operationId, candidateId: `candidate:${operationId}:r1`, projectId: "project-finalize", taskId: "GH-5", revision: 1, sourceDigest: await computeWorktreeDigest(repo), createdAt: "2026-08-11T00:00:00Z" });
    delete process.env.AEH_OPERATION_ID;
    delete process.env.AEH_CONTROL_ROOT;
    delete process.env.AEH_OPERATION_STATE_REDIRECT;
    delete process.env.AEH_CONTROLLER_EPOCH;
  }
  process.env.GH_TOKEN = "test-token";
  const requests: Array<{ url: string; method: string; body?: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? "GET"; requests.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
    if (method === "GET" && url.includes("/pulls?")) return new Response(JSON.stringify(requests.some((request) => request.method === "POST" && request.url.endsWith("/pulls")) ? [pullRequest] : []), { status: 200 });
    if (method === "POST" && url.endsWith("/pulls")) return new Response(JSON.stringify(pullRequest), { status: 201 });
    return new Response("{}", { status: 200 });
  }));
  return { repo, remote, config, contract, candidate, operationId, requests };
}

function actionDirectory(root: string, operationId: string): string {
  return path.resolve(root, ".harness", "security", "tool-actions", sha256Utf8(operationId).slice(0, 32));
}

const pullRequest = { number: 9, html_url: "https://github.com/owner/repo/pull/9", draft: true, head: { ref: "feature/gh-5-update-readme", label: "owner:feature/gh-5-update-readme" }, base: { ref: "main" } };

function restoreEnv(name: string, value: string | undefined): void { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
