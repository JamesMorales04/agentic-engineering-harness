import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import { deliveryFinalizationFailure, finalizeAcceptedIssue } from "../src/delivery/finalize.js";

function git(cwd: string, ...args: string[]): string { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
afterEach(() => { vi.unstubAllGlobals(); delete process.env.GH_TOKEN; });

describe("accepted issue delivery finalization", () => {
  it("commits accepted work, pushes the exact issue branch and creates a draft PR", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-finalize-"));
    const remote = path.join(baseDir, "origin.git");
    const repo = path.join(baseDir, "repo");
    await fs.mkdir(repo); git(baseDir, "init", "--bare", remote); git(repo, "init", "-b", "main");
    git(repo, "config", "user.name", "AEH Test"); git(repo, "config", "user.email", "aeh@example.invalid");
    await fs.writeFile(path.join(repo, "README.md"), "base\n"); git(repo, "add", "README.md"); git(repo, "commit", "-m", "base"); git(repo, "remote", "add", "origin", remote); git(repo, "push", "-u", "origin", "main");
    git(repo, "checkout", "-b", "feature/gh-5-update-readme");
    await fs.writeFile(path.join(repo, "README.md"), "accepted implementation\n");
    await fs.mkdir(path.join(repo, ".harness", "delivery"), { recursive: true });
    await fs.writeFile(path.join(repo, ".harness", "delivery", "GH-5.json"), JSON.stringify({ version: 1, taskId: "GH-5", status: "ready", createdAt: "2026-08-11T00:00:00Z", updatedAt: "2026-08-11T00:00:00Z", originatingBranch: "main", github: { repository: "owner/repo", issueNumber: 5, issueUrl: "https://github.com/owner/repo/issues/5", branch: "feature/gh-5-update-readme" } }));

    const config: HarnessProjectConfig = { version: 1, project: { name: "finalize-test" }, validation: { baseRef: "main" }, delivery: { stateDir: ".harness/delivery", github: { enabled: true, tokenEnv: "GH_TOKEN", finalizeOnAcceptance: true, pullRequestDraft: true } } };
    const contract: TaskContract = { version: 1, mode: "spec", task: { id: "GH-5", title: "Update README" }, issue: { provider: "github", repository: "owner/repo", number: 5, url: "https://github.com/owner/repo/issues/5", state: "open", fetchedAt: "2026-08-11T00:00:00Z", updatedAt: "2026-08-11T00:00:00Z", contentSha256: "a".repeat(64), snapshotPath: ".harness/issues/GH-5.json" }, git: { baseRef: "main", originatingBranch: "main" } };
    process.env.GH_TOKEN = "test-token";
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET"; requests.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
      if (method === "GET" && url.includes("/pulls?")) return new Response("[]", { status: 200 });
      if (method === "POST" && url.endsWith("/pulls")) return new Response(JSON.stringify({ number: 9, html_url: "https://github.com/owner/repo/pull/9", draft: true }), { status: 201 });
      return new Response("{}", { status: 200 });
    }));

    const result = await finalizeAcceptedIssue(repo, config, contract);
    expect(result).toMatchObject({ status: "FINALIZED", committed: true, pushed: true, humanRequired: false, pullRequest: { number: 9, draft: true } });
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "log", "-1", "--pretty=%s")).toBe("GH-5: Update README");
    expect(git(remote, "rev-parse", "refs/heads/feature/gh-5-update-readme")).toBe(git(repo, "rev-parse", "HEAD"));
    const create = requests.find((request) => request.method === "POST" && request.url.endsWith("/pulls"));
    expect(create?.body).toContain("Closes #5");
  });

  it("maps external delivery failures to human-on-exception", () => {
    expect(deliveryFinalizationFailure(new Error("BLOCKED_EXTERNAL: token unavailable"))).toMatchObject({ status: "BLOCKED_EXTERNAL", humanRequired: true });
    expect(deliveryFinalizationFailure(new Error("SYSTEM_FAILURE: branch mismatch"))).toMatchObject({ status: "SYSTEM_FAILURE", humanRequired: false });
  });
});
