import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import { computeWorktreeDigest } from "../src/core/git.js";
import { sha256Canonical, sha256Utf8 } from "../src/core/digest.js";
import { bindResolvedOperationPolicy, claimControllerEpoch, currentControllerEpoch, loadOperation, saveOperation } from "../src/operations/state.js";
import { createCandidateRevisionV1, type CandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { currentObjectiveIdentityV1, evaluateAcceptanceOracleV1, persistAcceptanceOracleArtifactV1, type AcceptanceEvidenceItemV1, type EvidenceBundleV1 } from "../src/architecture/acceptanceOracle.js";
import { resolveOperationStateRoot } from "../src/operations/state.js";
import { HumanDecisionLedgerV2 } from "../src/security/humanDecision.js";
import { buildChangePullRequestBody, deliveryFinalizationFailure, finalizeAcceptedChange, finalizeAcceptedIssue } from "../src/delivery/finalize.js";
import { githubRequest, handoffTask, renderPattern, seedDeliveryRecordFromIssue } from "../src/delivery/handoff.js";
import { executeIssueWorkflow } from "../src/issues/workflow.js";
import { executeGatedAction } from "../src/security/gatedAction.js";
import { controllerActorId } from "../src/security/toolActionGate.js";
import type { TaskRunResult } from "../src/core/run.js";
import { runExecutable } from "../src/utils/process.js";

async function git(cwd: string, ...args: string[]): Promise<string> { const result = await runExecutable("git", args, { cwd, timeoutMs: 120_000 }); if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`); return result.stdout.trim(); }
const roots: string[] = [];
const previousEnv = { id: process.env.AEH_OPERATION_ID, kind: process.env.AEH_OPERATION_KIND, control: process.env.AEH_CONTROL_ROOT, redirect: process.env.AEH_OPERATION_STATE_REDIRECT, epoch: process.env.AEH_CONTROLLER_EPOCH };
afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.GH_TOKEN;
  restoreEnv("AEH_OPERATION_ID", previousEnv.id);
  restoreEnv("AEH_OPERATION_KIND", previousEnv.kind);
  restoreEnv("AEH_CONTROL_ROOT", previousEnv.control);
  restoreEnv("AEH_OPERATION_STATE_REDIRECT", previousEnv.redirect);
  restoreEnv("AEH_CONTROLLER_EPOCH", previousEnv.epoch);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("accepted issue delivery finalization", () => {
  it("blocks delivery effects until a current accepted AcceptanceOracle artifact is persisted", async () => {
    const context = await createFinalizeFixture({ acceptanceOracle: false });
    await expect(finalizeAcceptedIssue(context.repo, context.config, context.contract, { candidate: context.candidate }))
      .rejects.toThrow("ACCEPTANCE_ORACLE_REQUIRED");
    expect(context.requests).toHaveLength(0);
    expect(await git(context.repo, "log", "-1", "--pretty=%s")).toBe("base");
  });

  it("blocks delivery effects when strict supply-chain evidence is missing", async () => {
    const context = await createFinalizeFixture();
    const artifactPath = ".harness/aeh-candidate.tgz";
    await fs.writeFile(path.join(context.repo, artifactPath), "packed candidate fixture\n");
    const strictConfig: HarnessProjectConfig = { ...context.config, provenance: { required: true, artifact: artifactPath } };

    await expect(finalizeAcceptedIssue(context.repo, strictConfig, context.contract, { candidate: context.candidate }))
      .rejects.toThrow("SUPPLY_CHAIN_BLOCKED");
    expect(context.requests).toHaveLength(0);
    expect(await git(context.repo, "log", "-1", "--pretty=%s")).toBe("base");
  });

  it("commits accepted work, pushes the exact issue branch and creates a draft PR through the tool action gate", async () => {
    const context = await createFinalizeFixture();
    await expect(finalizeAcceptedIssue(context.repo, context.config, context.contract, { candidate: context.candidate }))
      .rejects.toThrow("TOOL_ACTION_HUMAN_DECISION_REQUIRED");
    const commitSha = await git(context.repo, "rev-parse", "HEAD");
    await recordActionAuthorization(context, "git.push", { remote: "origin", ref: "feature/gh-5-update-readme", expectedCommit: commitSha });
    await recordActionAuthorization(context, "github.pull-request.create", { repository: "owner/repo", head: "feature/gh-5-update-readme", base: "main", apiBase: "https://api.github.com" });
    const result = await finalizeAcceptedIssue(context.repo, context.config, context.contract, { candidate: context.candidate });
    expect(result).toMatchObject({ status: "FINALIZED", committed: false, pushed: true, humanRequired: false, pullRequest: { number: 9, draft: true } });
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

  it("finalizes an accepted candidate with a push-only delivery policy and never requests an unauthorized pull request", async () => {
    const context = await createFinalizeFixture({ pullRequests: false });
    await expect(finalizeAcceptedIssue(context.repo, context.config, context.contract, { candidate: context.candidate }))
      .rejects.toThrow("TOOL_ACTION_HUMAN_DECISION_REQUIRED");
    const commitSha = await git(context.repo, "rev-parse", "HEAD");
    await recordActionAuthorization(context, "git.push", { remote: "origin", ref: "feature/gh-5-update-readme", expectedCommit: commitSha });
    const result = await finalizeAcceptedIssue(context.repo, context.config, context.contract, { candidate: context.candidate });
    expect(result).toMatchObject({ status: "FINALIZED", committed: false, pushed: true, humanRequired: false });
    expect(result.pullRequest).toBeUndefined();
    expect(context.requests.some((request) => request.method === "POST" && request.url.endsWith("/pulls"))).toBe(false);
    expect(await git(context.repo, "status", "--porcelain")).toBe("");
    expect(await git(context.remote, "rev-parse", "refs/heads/feature/gh-5-update-readme")).toBe(await git(context.repo, "rev-parse", "HEAD"));
    const actions = await fs.readdir(actionDirectory(context.repo, context.operationId));
    expect(actions.filter((file) => file.endsWith(".intent.json"))).toHaveLength(2);
    expect(actions.filter((file) => file.endsWith(".receipt.json"))).toHaveLength(2);
  });

  it("reconciles a lost push receipt instead of retrying the side effect", async () => {
    const context = await createFinalizeFixture();
    await expect(finalizeAcceptedIssue(context.repo, context.config, context.contract, { candidate: context.candidate }))
      .rejects.toThrow("TOOL_ACTION_HUMAN_DECISION_REQUIRED");
    const commitSha = await git(context.repo, "rev-parse", "HEAD");
    await recordActionAuthorization(context, "git.push", { remote: "origin", ref: "feature/gh-5-update-readme", expectedCommit: commitSha });
    await recordActionAuthorization(context, "github.pull-request.create", { repository: "owner/repo", head: "feature/gh-5-update-readme", base: "main", apiBase: "https://api.github.com" });
    await finalizeAcceptedIssue(context.repo, context.config, context.contract, { candidate: context.candidate });
    const pushedSha = await git(context.remote, "rev-parse", "refs/heads/feature/gh-5-update-readme");

    // Simulate a crash after the external push but before the receipt persisted.
    const directory = actionDirectory(context.repo, context.operationId);
    const receipts = (await fs.readdir(directory)).filter((file) => file.endsWith(".receipt.json"));
    const pushReceipt = receipts.find((file) => file.includes(sha256Canonical({ operationId: context.operationId, actionKey: "delivery:GH-5:push" })));
    expect(pushReceipt).toBeTruthy();
    await fs.rm(path.join(directory, pushReceipt!));

    const result = await finalizeAcceptedIssue(context.repo, context.config, context.contract, { candidate: context.candidate });
    expect(result.status).toBe("FINALIZED");
    expect(await git(context.remote, "rev-parse", "refs/heads/feature/gh-5-update-readme")).toBe(pushedSha);
    expect(await git(context.repo, "log", "-1", "--pretty=%s")).toBe("GH-5: Update README");
    // The commit was already durable and is not re-executed; push and pull-request
    // receipts are recovered through external reconciliation.
    const recovered = (await fs.readdir(directory)).filter((file) => file.endsWith(".receipt.json"));
    expect(recovered).toHaveLength(3);
    const recoveredReceipts = await Promise.all(recovered.map(async (file) => JSON.parse(await fs.readFile(path.join(directory, file), "utf8")) as { action: string; outcome: string }));
    expect(recoveredReceipts.find((receipt) => receipt.action === "git.push")).toMatchObject({ outcome: "SUCCEEDED" });
  });

  it("fails closed without a managed operation authority", async () => {
    const context = await createFinalizeFixture({ managed: false });
    await expect(finalizeAcceptedIssue(context.repo, context.config, context.contract, { candidate: context.candidate })).rejects.toThrow("DELIVERY_AUTHORITY_REQUIRED");
  });

  it("reports merge-pending BLOCKED instead of silently completing when AUTO_MERGE has no independent review", async () => {
    const context = await createFinalizeFixture({ mergeMode: "AUTO_MERGE" });
    await expect(finalizeAcceptedIssue(context.repo, context.config, context.contract, { candidate: context.candidate }))
      .rejects.toThrow("TOOL_ACTION_HUMAN_DECISION_REQUIRED");
    const commitSha = await git(context.repo, "rev-parse", "HEAD");
    await recordActionAuthorization(context, "git.push", { remote: "origin", ref: "feature/gh-5-update-readme", expectedCommit: commitSha });
    await recordActionAuthorization(context, "github.pull-request.create", { repository: "owner/repo", head: "feature/gh-5-update-readme", base: "main", apiBase: "https://api.github.com" });
    const result = await finalizeAcceptedIssue(context.repo, context.config, context.contract, { candidate: context.candidate });
    // The accepted PR exists, but delivery must not report FINALIZED when the
    // frozen policy requested autonomous merge without a review.
    expect(result.status).toBe("BLOCKED_EXTERNAL");
    expect(result.humanRequired).toBe(false);
    expect(result.pullRequest?.number).toBe(9);
    expect(result.message).toMatch(/independent ACCEPTED PR review/i);
    // The merge was never attempted: no PUT /merge request was issued.
    expect(context.requests.some((request) => request.method === "PUT" && request.url.includes("/merge"))).toBe(false);
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
    // Hermetic migration: ambient PATH no longer reaches managed children, so
    // the fake git is pinned via toolchain state at the fixture parent (kept
    // out of the repo tree so the candidate worktree digest is untouched).
    // Stale/missing state migrates the same way: run `aeh setup`, then retry.
    const { clearToolchainEnvCache } = await import("../src/utils/process.js");
    await fs.mkdir(path.join(path.dirname(context.repo), ".harness"), { recursive: true });
    await fs.writeFile(path.join(path.dirname(context.repo), ".harness", "toolchain.state.json"), JSON.stringify({ version: 1, binPaths: [fakeBin] }));
    clearToolchainEnvCache();
    process.env.AEH_FINALIZE_REPO = context.repo;
    try {
      await expect(finalizeAcceptedIssue(context.repo, context.config, context.contract, { candidate: context.candidate })).rejects.toThrow("git commit failed");
      expect(await git(context.repo, "log", "-1", "--pretty=%s")).toBe("base");
      expect(context.requests).toHaveLength(0);
    } finally {
      delete process.env.AEH_FINALIZE_REPO;
      clearToolchainEnvCache();
      await fs.rm(fakeBin, { recursive: true, force: true });
    }
  });

  it("maps external delivery failures to human-on-exception", () => {
    expect(deliveryFinalizationFailure(new Error("BLOCKED_EXTERNAL: token unavailable"))).toMatchObject({ status: "BLOCKED_EXTERNAL", humanRequired: true });
    expect(deliveryFinalizationFailure(new Error("SYSTEM_FAILURE: branch mismatch"))).toMatchObject({ status: "SYSTEM_FAILURE", humanRequired: false });
  });
});

describe("accepted no-Issue CHANGE delivery", () => {
  it("creates a local branch, commit, push, and pull request only through accepted, scoped ToolActionGates", async () => {
    const context = await createFinalizeFixture({ taskId: "CHANGE-SELFHOST-1", issueDerived: false });
    const branch = renderPattern("feature/{task}-{slug}", context.contract);
    expect(await git(context.repo, "status", "--porcelain")).toContain("README.md");

    await expect(finalizeAcceptedChange(context.repo, context.config, context.contract, { candidate: context.candidate }))
      .rejects.toThrow("TOOL_ACTION_HUMAN_DECISION_REQUIRED");
    expect(await git(context.repo, "branch", "--show-current")).toBe(branch);
    const commitSha = await git(context.repo, "rev-parse", "HEAD");
    const pushPayload = { remote: "origin", ref: branch, expectedCommit: commitSha };
    await recordActionAuthorization(context, "git.push", pushPayload);

    const body = buildChangePullRequestBody(context.contract);
    const prPayload = {
      repository: "owner/repo",
      head: branch,
      base: "main",
      apiBase: "https://api.github.com",
      title: `${context.contract.task.id}: ${context.contract.task.title}`,
      bodyDigest: sha256Canonical(body),
      draft: true
    };
    await expect(finalizeAcceptedChange(context.repo, context.config, context.contract, { candidate: context.candidate }))
      .rejects.toThrow("TOOL_ACTION_HUMAN_DECISION_REQUIRED");
    await recordActionAuthorization(context, "github.pull-request.create", prPayload);

    const result = await finalizeAcceptedChange(context.repo, context.config, context.contract, { candidate: context.candidate });
    expect(result).toMatchObject({ status: "FINALIZED", committed: true, pushed: true, pullRequest: { number: 9, draft: true } });
    expect(await git(context.remote, "rev-parse", `refs/heads/${branch}`)).toBe(commitSha);
    expect(await git(context.repo, "status", "--porcelain")).toBe("");
    expect(context.requests.some((request) => request.url.includes("/issues"))).toBe(false);
    expect(context.requests.filter((request) => request.method === "POST" && request.url.endsWith("/pulls"))).toHaveLength(1);

    const actions = await fs.readdir(actionDirectory(context.repo, context.operationId));
    expect(actions.filter((file) => file.endsWith(".intent.json"))).toHaveLength(4);
    expect(actions.filter((file) => file.endsWith(".receipt.json"))).toHaveLength(4);
    const intents = await Promise.all(actions.filter((file) => file.endsWith(".intent.json")).map(async (file) => JSON.parse(await fs.readFile(path.join(actionDirectory(context.repo, context.operationId), file), "utf8")) as { action: string }));
    expect(intents.map((intent) => intent.action).sort()).toEqual(["git.branch.create", "git.commit", "git.push", "github.pull-request.create"].sort());
  });

  it("keeps no-Issue delivery disabled when project policy is disabled", async () => {
    const context = await createFinalizeFixture({ taskId: "CHANGE-SELFHOST-DISABLED", issueDerived: false });
    const disabled: HarnessProjectConfig = { ...context.config, delivery: { ...context.config.delivery, github: { ...context.config.delivery?.github, enabled: false, allowedActions: [] } } };
    const result = await finalizeAcceptedChange(context.repo, disabled, context.contract, { candidate: context.candidate });
    expect(result.status).toBe("SKIPPED");
    expect(context.requests).toHaveLength(0);
    expect(await git(context.repo, "branch", "--show-current")).toBe("aeh/op-change-selfhost");
  });
});

describe("controller-owned SDD handoff delivery gates", () => {
  it("blocks requested handoff effects before a current accepted AcceptanceOracle disposition", async () => {
    const context = await createFinalizeFixture({ acceptanceOracle: false });
    const config = await prepareHandoff(context);

    await expect(handoffTask(context.repo, config, context.contract.task.id))
      .rejects.toThrow("ACCEPTANCE_ORACLE_REQUIRED");

    expect(context.requests.filter((request) => request.method === "POST")).toHaveLength(0);
    await expect(fs.access(actionDirectory(context.repo, context.operationId))).rejects.toThrow();
    await expect(fs.access(path.join(context.repo, ".harness", "delivery", "GH-5.json"))).rejects.toThrow();
  });

  it("blocks requested handoff effects when policy-required S7 evidence is missing", async () => {
    const context = await createFinalizeFixture();
    const config = await prepareHandoff(context, {
      provenance: { required: true, artifact: ".harness/aeh-candidate.tgz" }
    });

    await expect(handoffTask(context.repo, config, context.contract.task.id))
      .rejects.toThrow("SUPPLY_CHAIN_BLOCKED");

    expect(context.requests).toHaveLength(0);
    await expect(fs.access(actionDirectory(context.repo, context.operationId))).rejects.toThrow();
    await expect(fs.access(path.join(context.repo, ".harness", "delivery", "GH-5.json"))).rejects.toThrow();
  });
});

describe("default managed issue workflow delivery boundary", () => {
  it("uses internal controller workspace before acceptance and receipts public handoff after acceptance", async () => {
    const context = await createFinalizeFixture({ acceptanceOracle: false, candidateBranch: "aeh/op-default-issue" });
    const apiBase = "https://api.github.test";
    const config: HarnessProjectConfig = {
      ...context.config,
      workflow: { issueIntake: { enabled: true, snapshotDir: ".harness/issues", verifyDriftOnRun: true, requireOpen: true } },
      sdd: { contractsDir: ".harness/contracts", runsDir: ".harness/runs" },
      validation: { baseRef: "main", requireSeal: false },
      delivery: { ...context.config.delivery, github: { ...context.config.delivery?.github, enabled: true, repository: "owner/repo", branchPattern: "feature/gh-{issue}-{slug}", apiBaseUrl: apiBase, finalizeOnAcceptance: true } }
    };
    expect(config.workflow?.issueIntake?.autoHandoff).toBeUndefined();
    const contractFile = path.join(context.repo, ".harness", "contracts", "GH-5.yaml");
    await fs.mkdir(path.dirname(contractFile), { recursive: true });
    await fs.writeFile(contractFile, `${JSON.stringify(context.contract, null, 2)}\n`);
    await fs.rm(path.join(context.repo, ".harness", "delivery", "GH-5.json"), { force: true });

    let accepted = false;
    let internalWorkspaceReady = false;
    let branchExists = false;
    let pullRequestExists = false;
    const baseSha = await git(context.repo, "rev-parse", "main");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      context.requests.push({ url: url.toString(), method, body: typeof init?.body === "string" ? init.body : undefined });
      if (method === "POST") expect(accepted).toBe(true);
      if (url.pathname === "/repos/owner/repo/issues/5") {
        return new Response(JSON.stringify({ number: 5, html_url: "https://github.com/owner/repo/issues/5", title: "Update README", body: "Implement the accepted change.", state: "open" }), { status: 200 });
      }
      if (url.pathname.endsWith("/git/ref/heads/main")) return new Response(JSON.stringify({ object: { sha: baseSha } }), { status: 200 });
      if (url.pathname.endsWith("/git/ref/heads/feature/gh-5-update-readme")) {
        return branchExists
          ? new Response(JSON.stringify({ object: { sha: await git(context.remote, "rev-parse", "refs/heads/feature/gh-5-update-readme").catch(() => baseSha) } }), { status: 200 })
          : new Response("not found", { status: 404 });
      }
      if (method === "POST" && url.pathname === "/repos/owner/repo/git/refs") {
        branchExists = true;
        return new Response("{}", { status: 201 });
      }
      if (url.pathname === "/repos/owner/repo/pulls" && method === "GET") return new Response(JSON.stringify(pullRequestExists ? [pullRequest] : []), { status: 200 });
      if (url.pathname === "/repos/owner/repo/pulls" && method === "POST") {
        pullRequestExists = true;
        return new Response(JSON.stringify(pullRequest), { status: 201 });
      }
      return new Response("{}", { status: 200 });
    }));

    const runFile = path.join(context.repo, ".harness", "runs", "GH-5.json");
    const result = await executeIssueWorkflow(context.repo, 5, {}, {
      loadConfig: async () => config,
      importIssue: async (root, issueNumber, _options, dependencies) => {
        // The managed import operation is exercised separately; this fixture asserts the workflow
        // consumes the durable intake result and never performs a public write itself.
        await githubRequest(apiBase, "test-token", `/repos/owner/repo/issues/${issueNumber}`);
        await seedDeliveryRecordFromIssue(root, config, context.contract, { repository: "owner/repo", issueNumber, issueUrl: `https://github.com/owner/repo/issues/${issueNumber}` });
        void dependencies;
        return { operationId: "CHANGE-GH-5-INTAKE", taskId: "GH-5", route: "DIRECT" as const, snapshot: { repository: "owner/repo", number: issueNumber, contentSha256: "a".repeat(64), path: ".harness/issues/GH-5.json" } };
      },
      startOperation: async (root, kind, payload) => {
        expect(kind).toBe("run");
        expect(payload).toMatchObject({ taskId: "GH-5", intentDecision: { intent: "run", effects: { executePreparedTask: true } } });
        expect(context.requests.filter((request) => request.method === "POST")).toHaveLength(0);
        expect(internalWorkspaceReady).toBe(false);
        return loadOperation(root, context.operationId);
      },
      waitForOperation: async (root, operationId) => {
        expect(operationId).toBe(context.operationId);
        const operation = await loadOperation(root, operationId);
        const authority = { kind: "controller-authority" as const, operationId, controllerEpoch: currentControllerEpoch(operation) };
        const workspaceGate = await executeGatedAction({
          root,
          request: { root, operationId, participantId: controllerActorId(operationId), candidate: operation.candidateRevision!, actionKey: "bootstrap:internal-workspace", action: "paseo.workspace.create", payload: { isolation: "worktree", kind: "issue-execution" }, authority },
          execute: async () => { internalWorkspaceReady = true; return { outcome: "SUCCEEDED", evidence: { workspaceId: "paseo-local-fixture", worktreePath: root } }; },
          reconcile: async () => ({ outcome: "UNKNOWN", detail: "fixture reconciliation is not used" })
        });
        expect(workspaceGate.receipt?.outcome).toBe("SUCCEEDED");
        expect(internalWorkspaceReady).toBe(true);
        expect(context.requests.filter((request) => request.method === "POST")).toHaveLength(0);

        await persistFixtureAcceptanceOracle(root, await loadOperation(root, operationId));
        accepted = true;
        await expect(finalizeAcceptedIssue(root, config, context.contract, { candidate: operation.candidateRevision })).rejects.toThrow("TOOL_ACTION_HUMAN_DECISION_REQUIRED");
        const commitSha = await git(root, "rev-parse", "HEAD");
        const branch = "feature/gh-5-update-readme";
        await recordActionAuthorization(context, "git.push", { remote: "origin", ref: branch, expectedCommit: commitSha });
        await recordActionAuthorization(context, "github.pull-request.create", { repository: "owner/repo", head: branch, base: "main", apiBase });
        const delivered = await finalizeAcceptedIssue(root, config, context.contract, { candidate: operation.candidateRevision });
        expect(delivered.status).toBe("FINALIZED");
        expect(await git(root, "branch", "--show-current")).toBe("aeh/op-default-issue");
        expect(await git(context.remote, "rev-parse", `refs/heads/${branch}`)).toBe(await git(root, "rev-parse", "HEAD"));

        const actionFiles = await fs.readdir(actionDirectory(root, operationId));
        const receipts = await Promise.all(actionFiles.filter((file) => file.endsWith(".receipt.json")).map(async (file) => JSON.parse(await fs.readFile(path.join(actionDirectory(root, operationId), file), "utf8")) as { action: string; outcome: string }));
        expect(receipts).toEqual(expect.arrayContaining([
          expect.objectContaining({ action: "paseo.workspace.create", outcome: "SUCCEEDED" }),
          expect.objectContaining({ action: "github.branch.create", outcome: "SUCCEEDED" }),
          expect.objectContaining({ action: "git.commit", outcome: "SUCCEEDED" }),
          expect.objectContaining({ action: "git.push", outcome: "SUCCEEDED" }),
          expect.objectContaining({ action: "github.pull-request.create", outcome: "SUCCEEDED" })
        ]));
        expect(context.requests.filter((request) => request.method === "POST").map((request) => new URL(request.url).pathname)).toEqual(expect.arrayContaining([
          "/repos/owner/repo/git/refs",
          "/repos/owner/repo/pulls"
        ]));

        const runResult = { taskId: "GH-5", status: "PASS", delivery: delivered } as unknown as TaskRunResult;
        await fs.mkdir(path.dirname(runFile), { recursive: true });
        await fs.writeFile(runFile, `${JSON.stringify(runResult)}\n`);
        return { ...operation, status: "SUCCEEDED" };
      }
    });
    expect(result.contract.task.id).toBe("GH-5");
    expect(result.result).toMatchObject({ taskId: "GH-5", status: "PASS", delivery: { status: "FINALIZED" } });
    expect(context.requests.filter((request) => request.method === "POST").every(() => accepted)).toBe(true);
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

async function createFinalizeFixture(options: { managed?: boolean; acceptanceOracle?: boolean; candidateBranch?: string; pullRequests?: boolean; taskId?: string; issueDerived?: boolean; mergeMode?: "AUTO_MERGE" | "RISK_GATED" } = {}): Promise<FinalizeFixture> {
  const managed = options.managed !== false;
  const taskId = options.taskId ?? "GH-5";
  const issueDerived = options.issueDerived !== false;
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-finalize-"));
  roots.push(baseDir);
  const remote = path.join(baseDir, "origin.git");
  const repo = path.join(baseDir, "repo");
  await fs.mkdir(repo); await git(baseDir, "init", "--bare", remote); await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "AEH Test"); await git(repo, "config", "user.email", "aeh@example.invalid");
  await fs.writeFile(path.join(repo, "README.md"), "base\n"); await git(repo, "add", "README.md"); await git(repo, "commit", "-m", "base"); await git(repo, "remote", "add", "origin", remote); await git(repo, "push", "-u", "origin", "main");
  await git(repo, "checkout", "-b", options.candidateBranch ?? (issueDerived ? "feature/gh-5-update-readme" : "aeh/op-change-selfhost"));
  await fs.writeFile(path.join(repo, "README.md"), "accepted implementation\n");
  await fs.writeFile(path.join(repo, ".gitignore"), ".harness/\n");
  await fs.mkdir(path.join(repo, ".harness", "delivery"), { recursive: true });
  if (issueDerived) await fs.writeFile(path.join(repo, ".harness", "delivery", `${taskId}.json`), JSON.stringify({ version: 1, taskId, status: "ready", createdAt: "2026-08-11T00:00:00Z", updatedAt: "2026-08-11T00:00:00Z", originatingBranch: "main", github: { repository: "owner/repo", issueNumber: 5, issueUrl: "https://github.com/owner/repo/issues/5", branch: "feature/gh-5-update-readme" } }));

  const allowedActions: Array<"git.branch.create" | "git.commit" | "git.push" | "github.issue.create" | "github.branch.create" | "github.pull-request.create" | "github.pull-request.merge"> = ["git.branch.create", "git.commit", "git.push", ...(issueDerived ? ["github.issue.create", "github.branch.create"] as const : []), ...(options.pullRequests === false ? [] : ["github.pull-request.create" as const]), ...(options.mergeMode ? ["github.pull-request.merge" as const] : [])];
  const config: HarnessProjectConfig = { version: 1, project: { name: "finalize-test" }, validation: { baseRef: "main" }, delivery: { stateDir: ".harness/delivery", github: { enabled: true, allowedActions, repository: "owner/repo", tokenEnv: "GH_TOKEN", finalizeOnAcceptance: true, pullRequestDraft: true, ...(options.pullRequests === false ? { pullRequests: false } : {}), ...(options.mergeMode ? { mergeMode: options.mergeMode } : {}) } } };
  const contract: TaskContract = { version: 1, task: { id: taskId, title: issueDerived ? "Update README" : "Redesign Home" }, ...(issueDerived ? { issue: { provider: "github" as const, repository: "owner/repo", number: 5, url: "https://github.com/owner/repo/issues/5", state: "open", fetchedAt: "2026-08-11T00:00:00Z", updatedAt: "2026-08-11T00:00:00Z", contentSha256: "a".repeat(64), snapshotPath: ".harness/issues/GH-5.json" } } : {}), git: { baseRef: "main", originatingBranch: "main" }, routing: { route: "DIRECT", assurance: "STANDARD" } };
  const operationId = `RUN-FINALIZE-${taskId}`;
  let candidate: CandidateRevisionV1;
  if (managed) {
    await saveOperation(repo, { version: 1, id: operationId, kind: issueDerived ? "run" : "change", status: "RUNNING", phase: "delivery", root: repo, payload: { taskId }, createdAt: "2026-08-11T00:00:00Z", updatedAt: "2026-08-11T00:00:00Z" });
    candidate = (await loadOperation(repo, operationId)).candidateRevision!;
    await claimControllerEpoch(repo, operationId, "controller:test");
    process.env.AEH_OPERATION_ID = operationId;
    process.env.AEH_OPERATION_KIND = issueDerived ? "run" : "change";
    process.env.AEH_CONTROL_ROOT = repo;
    process.env.AEH_OPERATION_STATE_REDIRECT = "1";
    process.env.AEH_CONTROLLER_EPOCH = "1";
    const operation = await loadOperation(repo, operationId);
    const allowedExternalEffects: Array<"github.issue.create" | "github.branch.create" | "git.push" | "github.pull-request.create" | "github.pull-request.merge"> = [
      ...(issueDerived ? ["github.issue.create", "github.branch.create"] as const : []),
      "git.push",
      ...(options.pullRequests === false ? [] : ["github.pull-request.create" as const]),
      ...(options.mergeMode ? ["github.pull-request.merge" as const] : [])
    ];
    const humanDecisionRequirements = allowedExternalEffects.filter((action) => action !== "github.branch.create").map((action) => ({ kind: "ACTION_AUTHORIZATION" as const, action }));
    const deliveryPolicy = { githubEnabled: true, allowedActions, allowedExternalEffects, ...(options.mergeMode ? { mergeMode: options.mergeMode } : {}) };
    const policy = compileResolvedOperationPolicy({ projectId: candidate.projectId!, operationId, operationExecutionRevision: operation.operationExecutionRevision!, candidateRevision: candidate.revision, candidateDigest: candidate.identityDigest, controllerEpoch: currentControllerEpoch(operation), intent: "delivery finalization test", route: "DIRECT", minimumAssurance: "STANDARD", policyVersions: {}, policyDigests: { delivery: sha256Canonical({ ...deliveryPolicy, humanDecisionRequirements }) }, validationPolicy: {}, reviewPolicy: { leadAcceptance: true, leadAcceptanceDirect: false, independentReviewRequired: false }, deliveryPolicy, knowledgePolicy: {}, contextPolicy: {}, allowedExternalEffects, humanDecisionRequirements });
    await bindResolvedOperationPolicy(repo, operationId, policy);
    if (options.acceptanceOracle !== false) await persistFixtureAcceptanceOracle(repo, await loadOperation(repo, operationId));
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

async function persistFixtureAcceptanceOracle(root: string, operation: Awaited<ReturnType<typeof loadOperation>>): Promise<void> {
  const identity = currentObjectiveIdentityV1(operation);
  const evidenceBase = { assertionId: "ASSERT-DELIVERY", identity, strength: "ELEVATED" as const };
  const evidence: AcceptanceEvidenceItemV1[] = [
    { version: 1, id: "validation:REQ-DELIVERY:ASSERT-DELIVERY", ...evidenceBase, kind: "VALIDATION", status: "PASS", provenance: { sourceId: "REQ-DELIVERY", digest: sha256Canonical("validation") } },
    { version: 1, id: "review:reviewer:test:architecture:ASSERT-DELIVERY", ...evidenceBase, kind: "REVIEW", status: "PASS", dimension: "architecture", reviewerIdentity: "reviewer:test", provider: "test", provenance: { sourceId: "session:reviewer:test", digest: sha256Canonical("review"), executionBindingDigest: sha256Canonical("review-binding") } }
  ];
  const requirement = { version: 1 as const, id: "verification:ASSERT-DELIVERY", assertionId: "ASSERT-DELIVERY", statement: "delivery candidate is ready", minimumAssurance: "STANDARD" as const, validationRequirementIds: ["REQ-DELIVERY"], reviewDimensions: ["architecture"], leadRequired: false };
  const bundleBody = { version: 1 as const, identity, candidate: operation.candidateRevision!, impactDigest: sha256Canonical("impact"), compilationDigest: sha256Canonical("compilation"), requirements: [requirement], evidence };
  const bundle: EvidenceBundleV1 = { ...bundleBody, digest: sha256Canonical(bundleBody) };
  const disposition = evaluateAcceptanceOracleV1(bundle, { minimumAssurance: "ELEVATED", minimumIndependentReviewers: 1, providerDiversity: false, requiredDimensions: ["architecture"] });
  expect(disposition.disposition).toBe("ACCEPTED");
  await persistAcceptanceOracleArtifactV1(resolveOperationStateRoot(root), bundle, disposition);
}

async function prepareHandoff(context: FinalizeFixture, overrides: Partial<HarnessProjectConfig> = {}): Promise<HarnessProjectConfig> {
  await fs.rm(path.join(context.repo, ".harness", "delivery", "GH-5.json"), { force: true });
  const contracts = path.join(context.repo, ".harness", "contracts");
  await fs.mkdir(contracts, { recursive: true });
  await fs.writeFile(path.join(contracts, "GH-5.yaml"), `${JSON.stringify(context.contract, null, 2)}\n`);
  return {
    ...context.config,
    ...overrides,
    sdd: { contractsDir: ".harness/contracts" },
    validation: { ...context.config.validation, requireSeal: false },
    delivery: {
      ...context.config.delivery,
      github: { ...context.config.delivery?.github, enabled: true, repository: "owner/repo" }
    }
  };
}

async function recordActionAuthorization(context: FinalizeFixture, action: "git.push" | "github.issue.create" | "github.pull-request.create", payload: unknown): Promise<void> {
  const operation = await loadOperation(context.repo, context.operationId);
  const ledger = new HumanDecisionLedgerV2(path.resolve(context.repo, ".harness", "security", "human-decisions.json"));
  await ledger.record({
    operationId: operation.id,
    candidate: operation.candidateRevision!,
    operationExecutionRevision: operation.operationExecutionRevision!,
    policyDigest: operation.resolvedOperationPolicy!.digest,
    controllerEpoch: currentControllerEpoch(operation),
    purpose: { kind: "ACTION_AUTHORIZATION", action, effectDigest: sha256Canonical(payload) },
    kind: "APPROVE",
    actorId: "human:test:delivery-approval",
    reason: `approved exact ${action} effect`,
    createdAt: new Date()
  });
}

function actionDirectory(root: string, operationId: string): string {
  return path.resolve(root, ".harness", "security", "tool-actions", sha256Utf8(operationId).slice(0, 32));
}

const pullRequest = { number: 9, html_url: "https://github.com/owner/repo/pull/9", draft: true, head: { ref: "feature/gh-5-update-readme", label: "owner:feature/gh-5-update-readme" }, base: { ref: "main" } };

function restoreEnv(name: string, value: string | undefined): void { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
