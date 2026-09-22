import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Canonical } from "../../src/core/digest.js";
import { createCandidateRevisionV1 } from "../../src/operations/v2Contracts.js";
import { classifyToolActionImpact, type ActionIntentV1, type ToolActionKindV1 } from "../../src/security/toolActionGate.js";
import {
  reconcileToolAction,
  reconciliationReceiptOutcome,
  type ActionReconciliationDependenciesV1,
  type ActionReconciliationHttpInitV1,
  type ActionReconciliationResultV1
} from "../../src/security/actionReconciliation.js";
import { runExecutable, type ProcessResult } from "../../src/utils/process.js";

type FetchJson = NonNullable<ActionReconciliationDependenciesV1["fetchJson"]>;

interface CapturedRequest {
  url: string;
  init?: ActionReconciliationHttpInitV1;
}

interface GitFixture {
  root: string;
  remote: string;
  head: string;
}

const FIXED_NOW = "2026-03-04T05:06:07.000Z";
const TOKEN_ENV_NAMES = ["GH_TOKEN", "GITHUB_TOKEN", "GITHUB_PAT"] as const;
const roots: string[] = [];
const savedTokenEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of TOKEN_ENV_NAMES) {
    savedTokenEnv.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(async () => {
  for (const name of TOKEN_ENV_NAMES) {
    const value = savedTokenEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedTokenEnv.clear();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("git.commit reconciliation", () => {
  it("reports SUCCEEDED when HEAD matches the expected head", async () => {
    const fixture = await createGitFixture();
    const payload = { expectedHead: fixture.head };
    const result = await reconcileToolAction(fixture.root, makeIntent("git.commit", payload), payload, { now: new Date(FIXED_NOW) });

    expect(result.outcome).toBe("SUCCEEDED");
    expect(result.intentId).toBe(makeIntent("git.commit", payload).intentId);
    expect(result.evidence).toEqual({ expectedHead: fixture.head, observedHead: fixture.head });
    expect(result.reconciledAt).toBe(FIXED_NOW);
  }, 30_000);

  it("reports FAILED when HEAD differs from the expected head", async () => {
    const fixture = await createGitFixture();
    const payload = { expectedHead: "0".repeat(40) };
    const result = await reconcileToolAction(fixture.root, makeIntent("git.commit", payload), payload);

    expect(result.outcome).toBe("FAILED");
    expect(result.evidence).toEqual({ expectedHead: "0".repeat(40), observedHead: fixture.head });
  }, 30_000);

  it("reports UNKNOWN when expectedHead evidence is absent", async () => {
    const root = await tempRoot();
    const payload = {};
    const result = await reconcileToolAction(root, makeIntent("git.commit", payload), payload);

    expect(result.outcome).toBe("UNKNOWN");
    expect(result.detail).toBe("expected-head-absent");
  });

  it("rejects an abbreviated expected head instead of guessing", async () => {
    const root = await tempRoot();
    const payload = { expectedHead: "abc1234" };
    const result = await reconcileToolAction(root, makeIntent("git.commit", payload), payload);

    expect(result.outcome).toBe("UNKNOWN");
    expect(result.detail).toBe("payload-missing-evidence");
    expect(result.evidence.invalidFields).toEqual(["expectedHead"]);
  });

  it("reports UNKNOWN when HEAD cannot be read", async () => {
    const root = await tempRoot();
    const payload = { expectedHead: "a".repeat(40) };
    const result = await reconcileToolAction(root, makeIntent("git.commit", payload), payload);

    expect(result.outcome).toBe("UNKNOWN");
    expect(result.detail).toBe("head-unreadable");
  });
});

describe("git.branch.create reconciliation", () => {
  it("recognizes only the exact locally created branch and commit", async () => {
    const root = await tempRoot();
    const sha = "a".repeat(40);
    const payload = { branch: "feature/change-1", expectedCommit: sha };
    const runExecutableSpy: typeof runExecutable = async (_command, args) => ({ exitCode: 0, stdout: `${sha}\n`, stderr: "", durationMs: 1 });
    const result = await reconcileToolAction(root, makeIntent("git.branch.create", payload), payload, { runExecutable: runExecutableSpy });
    expect(result.outcome).toBe("SUCCEEDED");
    expect(result.evidence).toEqual({ branch: payload.branch, expectedCommit: sha, observedCommit: sha });
  });

  it("reports FAILED when the exact local branch is absent", async () => {
    const root = await tempRoot();
    const payload = { branch: "feature/change-1", expectedCommit: "a".repeat(40) };
    const runExecutableSpy: typeof runExecutable = async () => ({ exitCode: 1, stdout: "", stderr: "", durationMs: 1 });
    const result = await reconcileToolAction(root, makeIntent("git.branch.create", payload), payload, { runExecutable: runExecutableSpy });
    expect(result.outcome).toBe("FAILED");
    expect(result.detail).toBe("local-branch-absent");
  });
});

describe("git.push reconciliation", () => {
  it("reports SUCCEEDED when the remote ref matches the expected commit", async () => {
    const fixture = await createGitFixture();
    const payload = { remote: fixture.remote, ref: "refs/heads/main", expectedCommit: fixture.head };
    const result = await reconcileToolAction(fixture.root, makeIntent("git.push", payload), payload, { now: new Date(FIXED_NOW) });

    expect(result.outcome).toBe("SUCCEEDED");
    expect(result.evidence).toMatchObject({ remote: fixture.remote, ref: "refs/heads/main", expectedCommit: fixture.head, observedSha: fixture.head });
  }, 30_000);

  it("resolves a branch shorthand ref against the remote", async () => {
    const fixture = await createGitFixture();
    const payload = { remote: fixture.remote, ref: "main", expectedCommit: fixture.head };
    const result = await reconcileToolAction(fixture.root, makeIntent("git.push", payload), payload);

    expect(result.outcome).toBe("SUCCEEDED");
    expect(result.evidence.observedSha).toBe(fixture.head);
  }, 30_000);

  it("reports FAILED when the remote ref points at a different commit", async () => {
    const fixture = await createGitFixture();
    const newer = await commit(fixture.root, "newer local commit");
    const payload = { remote: fixture.remote, ref: "refs/heads/main", expectedCommit: newer };
    const result = await reconcileToolAction(fixture.root, makeIntent("git.push", payload), payload);

    expect(result.outcome).toBe("FAILED");
    expect(result.evidence.expectedCommit).toBe(newer);
    expect(result.evidence.observedSha).toBe(fixture.head);
  }, 30_000);

  it("reports FAILED when the remote ref is absent", async () => {
    const fixture = await createGitFixture();
    const payload = { remote: fixture.remote, ref: "refs/heads/feature-missing", expectedCommit: fixture.head };
    const result = await reconcileToolAction(fixture.root, makeIntent("git.push", payload), payload);

    expect(result.outcome).toBe("FAILED");
    expect(result.detail).toBe("remote-ref-absent");
    expect(result.evidence.observedShas).toEqual([]);
  }, 30_000);

  it("reports UNKNOWN when the remote cannot be inspected", async () => {
    const fixture = await createGitFixture();
    const missingRemote = path.join(path.dirname(fixture.remote), "missing-remote.git");
    const payload = { remote: missingRemote, ref: "refs/heads/main", expectedCommit: fixture.head };
    const result = await reconcileToolAction(fixture.root, makeIntent("git.push", payload), payload);

    expect(result.outcome).toBe("UNKNOWN");
    expect(result.detail).toBe("remote-inspection-failed");
  }, 30_000);

  it("reports UNKNOWN when payload evidence is missing", async () => {
    const fixture = await createGitFixture();
    const payload = { remote: fixture.remote };
    const result = await reconcileToolAction(fixture.root, makeIntent("git.push", payload), payload);

    expect(result.outcome).toBe("UNKNOWN");
    expect(result.detail).toBe("payload-missing-evidence");
    expect(result.evidence.invalidFields).toEqual(["ref", "expectedCommit"]);
  }, 30_000);

  it("rejects an abbreviated expected commit instead of guessing", async () => {
    const fixture = await createGitFixture();
    const payload = { remote: fixture.remote, ref: "refs/heads/main", expectedCommit: fixture.head.slice(0, 8) };
    const result = await reconcileToolAction(fixture.root, makeIntent("git.push", payload), payload);

    expect(result.outcome).toBe("UNKNOWN");
    expect(result.detail).toBe("payload-missing-evidence");
    expect(result.evidence.invalidFields).toEqual(["expectedCommit"]);
  }, 30_000);

  it("rejects remote-helper and option-looking remotes without invoking git", async () => {
    const fixture = await createGitFixture();
    const runExecutableSpy: typeof runExecutable = async () => { throw new Error("git must not run for invalid remotes"); };
    for (const remote of ["ext::sh -c whoami", "--upload-pack=touch /tmp/pwned", "ssh://git@example.com/repo.git extra"]) {
      const payload = { remote, ref: "refs/heads/main", expectedCommit: fixture.head };
      const result = await reconcileToolAction(fixture.root, makeIntent("git.push", payload), payload, { runExecutable: runExecutableSpy });
      expect(result.outcome).toBe("UNKNOWN");
      expect(result.detail).toBe("payload-missing-evidence");
    }
  }, 30_000);
});

describe("github.branch.create reconciliation", () => {
  const payload = { repository: "octo/repo", branch: "feature/x", sha: "a".repeat(40) };

  it("reports SUCCEEDED when the branch ref matches the expected sha", async () => {
    const root = await tempRoot();
    const { fetchJson, calls } = stubFetch(200, { object: { sha: "a".repeat(40), type: "commit" } });
    const result = await reconcileToolAction(root, makeIntent("github.branch.create", payload), payload, { fetchJson, token: "test-token", now: new Date(FIXED_NOW) });

    expect(result.outcome).toBe("SUCCEEDED");
    expect(result.evidence).toMatchObject({ repository: "octo/repo", branch: "feature/x", expectedSha: "a".repeat(40), observedSha: "a".repeat(40), status: 200 });
    expect(result.evidenceDigest).toBe(sha256Canonical(result.evidence));

    expect(calls).toHaveLength(1);
    const request = new URL(calls[0].url);
    expect(request.origin).toBe("https://api.github.com");
    expect(request.pathname).toBe("/repos/octo/repo/git/ref/heads/feature/x");
    expect(calls[0].init?.method).toBe("GET");
    expect(calls[0].init?.headers?.Authorization).toBe("Bearer test-token");
    expect(JSON.stringify(result.evidence)).not.toContain("test-token");
  });

  it("honors an explicit apiBase", async () => {
    const root = await tempRoot();
    const enterprisePayload = { ...payload, apiBase: "https://github.example.com/api/v3/" };
    const { fetchJson, calls } = stubFetch(200, { object: { sha: "a".repeat(40) } });
    const result = await reconcileToolAction(root, makeIntent("github.branch.create", enterprisePayload), enterprisePayload, { fetchJson, token: "test-token" });

    expect(result.outcome).toBe("SUCCEEDED");
    expect(calls[0].url.startsWith("https://github.example.com/api/v3/repos/octo/repo/git/ref/heads/feature/x")).toBe(true);
  });

  it("reports FAILED when the branch ref differs from the expected sha", async () => {
    const root = await tempRoot();
    const { fetchJson } = stubFetch(200, { object: { sha: "b".repeat(40) } });
    const result = await reconcileToolAction(root, makeIntent("github.branch.create", payload), payload, { fetchJson, token: "test-token" });

    expect(result.outcome).toBe("FAILED");
    expect(result.evidence).toMatchObject({ expectedSha: "a".repeat(40), observedSha: "b".repeat(40) });
  });

  it("reports FAILED when the branch does not exist", async () => {
    const root = await tempRoot();
    const { fetchJson } = stubFetch(404, { message: "Not Found" });
    const result = await reconcileToolAction(root, makeIntent("github.branch.create", payload), payload, { fetchJson, token: "test-token" });

    expect(result.outcome).toBe("FAILED");
    expect(result.detail).toBe("github-branch-absent");
  });

  it("reports UNKNOWN when the API responds with an unexpected status", async () => {
    const root = await tempRoot();
    const { fetchJson } = stubFetch(500, { message: "boom" });
    const result = await reconcileToolAction(root, makeIntent("github.branch.create", payload), payload, { fetchJson, token: "test-token" });

    expect(result.outcome).toBe("UNKNOWN");
    expect(result.detail).toBe("github-api-unexpected-status");
    expect(result.evidence.status).toBe(500);
  });

  it("reports UNKNOWN when the API call throws", async () => {
    const root = await tempRoot();
    const fetchJson: FetchJson = async () => { throw new Error("network unreachable"); };
    const result = await reconcileToolAction(root, makeIntent("github.branch.create", payload), payload, { fetchJson, token: "test-token" });

    expect(result.outcome).toBe("UNKNOWN");
    expect(result.detail).toBe("github-api-unavailable");
    expect(result.evidence.error).toBe("network unreachable");
  });

  it("reports HUMAN_REQUIRED and performs no API call without a token", async () => {
    const root = await tempRoot();
    const { fetchJson, calls } = stubFetch(200, { object: { sha: "a".repeat(40) } });
    const result = await reconcileToolAction(root, makeIntent("github.branch.create", payload), payload, { fetchJson });

    expect(result.outcome).toBe("HUMAN_REQUIRED");
    expect(result.detail).toBe("github-token-unavailable");
    expect(calls).toHaveLength(0);
  });
});

describe("github.pull-request.create reconciliation", () => {
  const payload = { repository: "octo/repo", head: "feature", base: "main" };

  it("reports SUCCEEDED when an open pull request matches head and base", async () => {
    const root = await tempRoot();
    const { fetchJson, calls } = stubFetch(200, [
      { number: 42, html_url: "https://github.com/octo/repo/pull/42", head: { ref: "feature" }, base: { ref: "main" } }
    ]);
    const result = await reconcileToolAction(root, makeIntent("github.pull-request.create", payload), payload, { fetchJson, token: "test-token" });

    expect(result.outcome).toBe("SUCCEEDED");
    expect(result.evidence).toMatchObject({ pullRequestNumber: 42, pullRequestUrl: "https://github.com/octo/repo/pull/42", matchCount: 1 });

    const request = new URL(calls[0].url);
    expect(request.pathname).toBe("/repos/octo/repo/pulls");
    expect(request.searchParams.get("state")).toBe("open");
    expect(request.searchParams.get("head")).toBe("octo:feature");
    expect(request.searchParams.get("base")).toBe("main");
  });

  it("reports FAILED when no open pull request is observed", async () => {
    const root = await tempRoot();
    const { fetchJson } = stubFetch(200, []);
    const result = await reconcileToolAction(root, makeIntent("github.pull-request.create", payload), payload, { fetchJson, token: "test-token" });

    expect(result.outcome).toBe("FAILED");
    expect(result.detail).toBe("open-pull-request-not-observed");
  });

  it("reports UNKNOWN when the API call throws", async () => {
    const root = await tempRoot();
    const fetchJson: FetchJson = async () => { throw new Error("connection reset"); };
    const result = await reconcileToolAction(root, makeIntent("github.pull-request.create", payload), payload, { fetchJson, token: "test-token" });

    expect(result.outcome).toBe("UNKNOWN");
    expect(result.detail).toBe("github-api-unavailable");
  });

  it("reports UNKNOWN when the API responds with an unexpected status", async () => {
    const root = await tempRoot();
    const { fetchJson } = stubFetch(403, { message: "rate limited" });
    const result = await reconcileToolAction(root, makeIntent("github.pull-request.create", payload), payload, { fetchJson, token: "test-token" });

    expect(result.outcome).toBe("UNKNOWN");
    expect(result.detail).toBe("github-api-unexpected-status");
  });

  it("reports HUMAN_REQUIRED without a token", async () => {
    const root = await tempRoot();
    const { fetchJson, calls } = stubFetch(200, []);
    const result = await reconcileToolAction(root, makeIntent("github.pull-request.create", payload), payload, { fetchJson });

    expect(result.outcome).toBe("HUMAN_REQUIRED");
    expect(calls).toHaveLength(0);
  });
});

describe("github.issue.create reconciliation", () => {
  const marker = "aeh-issue-marker:abc123";

  it("reports HUMAN_REQUIRED without a marker because issues have no deterministic external identity", async () => {
    const root = await tempRoot();
    const payload = { repository: "octo/repo" };
    const result = await reconcileToolAction(root, makeIntent("github.issue.create", payload), payload, { token: "test-token" });

    expect(result.outcome).toBe("HUMAN_REQUIRED");
    expect(result.detail).toBe("issue-identity-marker-required");
  });

  it("reports SUCCEEDED when an issue body contains the exact marker", async () => {
    const root = await tempRoot();
    const payload = { repository: "octo/repo", marker };
    const { fetchJson, calls } = stubFetch(200, [
      { number: 7, html_url: "https://github.com/octo/repo/issues/7", body: "unrelated body" },
      { number: 8, html_url: "https://github.com/octo/repo/issues/8", body: `Created by AEH\n${marker}\n` }
    ]);
    const result = await reconcileToolAction(root, makeIntent("github.issue.create", payload), payload, { fetchJson, token: "test-token" });

    expect(result.outcome).toBe("SUCCEEDED");
    expect(result.evidence).toMatchObject({ issueNumber: 8, issueUrl: "https://github.com/octo/repo/issues/8", scanned: 2 });

    const request = new URL(calls[0].url);
    expect(request.pathname).toBe("/repos/octo/repo/issues");
    expect(request.searchParams.get("state")).toBe("all");
    expect(request.searchParams.get("per_page")).toBe("100");
  });

  it("reports UNKNOWN when the marker is not observed because absence cannot be proven under pagination", async () => {
    const root = await tempRoot();
    const payload = { repository: "octo/repo", marker };
    const { fetchJson } = stubFetch(200, [{ number: 7, html_url: "https://github.com/octo/repo/issues/7", body: "unrelated body" }]);
    const result = await reconcileToolAction(root, makeIntent("github.issue.create", payload), payload, { fetchJson, token: "test-token" });

    expect(result.outcome).toBe("UNKNOWN");
    expect(result.detail).toBe("issue-marker-not-observed");
  });

  it("reports HUMAN_REQUIRED without a token", async () => {
    const root = await tempRoot();
    const payload = { repository: "octo/repo", marker };
    const { fetchJson, calls } = stubFetch(200, []);
    const result = await reconcileToolAction(root, makeIntent("github.issue.create", payload), payload, { fetchJson });

    expect(result.outcome).toBe("HUMAN_REQUIRED");
    expect(result.detail).toBe("github-token-unavailable");
    expect(calls).toHaveLength(0);
  });
});

describe("paseo.workspace.create reconciliation", () => {
  it("reports HUMAN_REQUIRED without a durable provider identity", async () => {
    const root = await tempRoot();
    const payload = {};
    const result = await reconcileToolAction(root, makeIntent("paseo.workspace.create", payload), payload);

    expect(result.outcome).toBe("HUMAN_REQUIRED");
    expect(result.detail).toBe("provider-identity-missing");
  });

  it("does not invent a provider inspection contract when only a workspaceId is known", async () => {
    const root = await tempRoot();
    const payload = { workspaceId: "workspace-42" };
    const runExecutableSpy: typeof runExecutable = async () => { throw new Error("unconfirmed provider CLI must not run"); };
    const result = await reconcileToolAction(root, makeIntent("paseo.workspace.create", payload), payload, { runExecutable: runExecutableSpy });

    expect(result.outcome).toBe("HUMAN_REQUIRED");
    expect(result.detail).toBe("provider-identity-inspection-unavailable");
    expect(result.evidence).toEqual({ workspaceId: "workspace-42" });
  });
});

describe("reconciliation evidence and receipt mapping", () => {
  it("never reports SUCCEEDED for a missing payload", async () => {
    const root = await tempRoot();
    const actions: ToolActionKindV1[] = ["git.branch.create", "git.commit", "git.push", "github.issue.create", "github.branch.create", "github.pull-request.create", "paseo.workspace.create"];
    for (const action of actions) {
      const result = await reconcileToolAction(root, makeIntent(action, null), null);
      expect(["UNKNOWN", "HUMAN_REQUIRED"]).toContain(result.outcome);
    }
  });

  it("binds evidenceDigest to the canonical evidence and changes when evidence changes", async () => {
    const root = await tempRoot();
    const first = await reconcileBranch(root, "a".repeat(40), "a".repeat(40));
    const second = await reconcileBranch(root, "b".repeat(40), "b".repeat(40));

    expect(first.outcome).toBe("SUCCEEDED");
    expect(second.outcome).toBe("SUCCEEDED");
    for (const result of [first, second]) {
      expect(result.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(result.evidenceDigest).toBe(sha256Canonical(result.evidence));
    }
    expect(first.evidenceDigest).not.toBe(second.evidenceDigest);
  });

  it("maps only conclusive outcomes to a persistable receipt status", () => {
    const base: ActionReconciliationResultV1 = {
      version: 1,
      intentId: "action-intent:test",
      action: "git.commit",
      outcome: "SUCCEEDED",
      detail: "head-observed",
      evidenceDigest: "0".repeat(64),
      evidence: {},
      reconciledAt: FIXED_NOW
    };

    expect(reconciliationReceiptOutcome(base)).toBe("SUCCEEDED");
    expect(reconciliationReceiptOutcome({ ...base, outcome: "FAILED" })).toBe("FAILED");
    expect(reconciliationReceiptOutcome({ ...base, outcome: "UNKNOWN" })).toBeUndefined();
    expect(reconciliationReceiptOutcome({ ...base, outcome: "HUMAN_REQUIRED" })).toBeUndefined();
  });
});

async function reconcileBranch(root: string, expectedSha: string, observedSha: string): Promise<ActionReconciliationResultV1> {
  const payload = { repository: "octo/repo", branch: "feature/x", sha: expectedSha };
  const { fetchJson } = stubFetch(200, { object: { sha: observedSha } });
  return reconcileToolAction(root, makeIntent("github.branch.create", payload), payload, { fetchJson, token: "test-token", now: new Date(FIXED_NOW) });
}

function makeIntent(action: ToolActionKindV1, payload: unknown, overrides: Partial<ActionIntentV1> = {}): ActionIntentV1 {
  return {
    version: 1,
    intentId: `action-intent:${action.replace(/[^a-z]+/g, "-")}`,
    actionKey: `delivery:${action}`,
    operationId: "RUN-RECONCILE-1",
    participantId: "participant:lead",
    role: "Lead/Director",
    candidate: createCandidateRevisionV1({ operationId: "RUN-RECONCILE-1", candidateId: "candidate:reconcile", projectId: "project-test", taskId: "T-1", revision: 1, sourceDigest: "a".repeat(64), createdAt: FIXED_NOW }),
    action,
    impact: classifyToolActionImpact(action),
    payloadDigest: sha256Canonical(payload),
    authorityBindingDigest: "b".repeat(64),
    requestDigest: "c".repeat(64),
    createdAt: FIXED_NOW,
    ...overrides
  };
}

function stubFetch(status: number, body: unknown): { fetchJson: FetchJson; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchJson: FetchJson = async (url, init) => { calls.push({ url, init }); return { status, body }; };
  return { fetchJson, calls };
}

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-action-reconciliation-"));
  roots.push(root);
  return root;
}

async function createGitFixture(): Promise<GitFixture> {
  const base = await tempRoot();
  const remote = path.join(base, "remote.git");
  await git(base, ["init", "--bare", "--initial-branch=main", remote]);

  const root = path.join(base, "work");
  await fs.mkdir(root);
  await git(root, ["init", "--initial-branch=main"]);
  await fs.writeFile(path.join(root, "README.md"), "# reconciliation fixture\n");
  await git(root, ["add", "README.md"]);
  await commit(root, "initial");
  await git(root, ["remote", "add", "origin", remote]);
  await git(root, ["push", "origin", "main"]);
  return { root, remote, head: (await git(root, ["rev-parse", "HEAD"])).stdout.trim() };
}

async function commit(root: string, message: string): Promise<string> {
  await git(root, ["-c", "user.email=fixture@example.com", "-c", "user.name=Fixture", "commit", "--allow-empty", "-m", message]);
  return (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
}

async function git(cwd: string, args: string[]): Promise<ProcessResult> {
  const result = await runExecutable("git", args, { cwd, timeoutMs: 60_000 });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed (${result.exitCode}): ${result.stderr || result.stdout}`);
  return result;
}
