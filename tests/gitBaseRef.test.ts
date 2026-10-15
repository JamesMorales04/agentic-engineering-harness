import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCommit, resolveWorkspaceBase } from "../src/core/git.js";
import {
  buildHandoffWorkspaceEvidence,
  buildHandoffWorkspacePayload,
  createBranchOffWorkspace,
  createHandoffBranchOffWorkspace,
  resolveHandoffWorkspaceBase,
} from "../src/delivery/handoff.js";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import {
  bindResolvedOperationPolicy,
  claimControllerEpoch,
  loadOperation,
  saveOperation,
} from "../src/operations/state.js";
import { buildBranchOffWorkspaceCommand } from "../src/operations/controller.js";

vi.mock("../src/utils/process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/process.js")>();
  return {
    ...actual,
    runExecutable: vi.fn(async (command: string, args: readonly string[], options?: unknown) => {
      if (command !== "paseo") return actual.runExecutable(command, args as string[], options as never);
      const log = process.env.AEH_TEST_PASEO_ARGV_LOG;
      if (log) await fs.appendFile(log, `${JSON.stringify(args)}\n`);
      if (args[0] === "workspace" && args[1] === "create") {
        return { exitCode: 0, stdout: JSON.stringify({ workspaceId: "wks_test", worktreePath: "/tmp/fake-ws" }), stderr: "", durationMs: 1 };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected command", durationMs: 1 };
    }),
  };
});
import { buildBranchOffWorkspaceCommand } from "../src/operations/controller.js";
import type { HarnessProjectConfig } from "../src/core/types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function gitRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-base-ref-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "aeh@example.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "AEH Test"], { cwd: root });
  // Mirror real checkouts: harness state never enters the candidate digest,
  // so operation bookkeeping (including lock files) cannot perturb it.
  await fs.writeFile(path.join(root, ".gitignore"), ".harness/\n");
  await fs.writeFile(path.join(root, "file.txt"), "v1\n");
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "one"], { cwd: root });
  return root;
}

describe("workspace base commit resolution (DETERMINISTIC)", () => {
  it("pins branch names to exact SHAs and reports unresolvable refs", async () => {
    const root = await gitRepo();
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    expect(await resolveCommit(root, "main")).toBe(head);
    expect(await resolveCommit(root, "HEAD")).toBe(head);
    expect(await resolveCommit(root, head)).toBe(head.toLowerCase());
    expect(await resolveCommit(root, "no-such-ref")).toBeUndefined();
  });

  it("does not follow a moved branch: SHAs stay exact after the branch advances", async () => {
    const root = await gitRepo();
    const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    await fs.writeFile(path.join(root, "file.txt"), "v2\n");
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "two"], { cwd: root });
    const after = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    expect(after).not.toBe(before);
    // A previously resolved SHA still names the exact original commit.
    expect(await resolveCommit(root, before)).toBe(before.toLowerCase());
    expect(await resolveCommit(root, "main")).toBe(after);
  });

  it("builds workspace create commands with a SHA-pinned base", async () => {    const root = await gitRepo();
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const config = { version: 1, project: { name: "base-ref-test" }, validation: { baseRef: "main" } } as HarnessProjectConfig;
    const record = { id: "OP-BASE-REF", kind: "change" } as never;
    const built = await buildBranchOffWorkspaceCommand(root, record, config, { title: "t", branch: "aeh/op-test", slug: "slug" });
    expect(built.pinned).toBe(true);
    expect(built.base).toBe(head);
    expect(built.command).toContain(`--base '${head}'`);
    // Unresolvable bases fall back to the configured name (traced).
    const traced: string[] = [];
    const fallback = await buildBranchOffWorkspaceCommand(
      root, record, { version: 1, project: { name: "x" }, validation: { baseRef: "no-such-ref" } } as HarnessProjectConfig,
      { title: "t", branch: "aeh/op-test", slug: "slug" },
      async (event) => { traced.push(event); },
    );
    expect(fallback.pinned).toBe(false);
    expect(fallback.base).toBe("no-such-ref");
    expect(traced).toContain("workspace.base.unresolved");
  });

  it("shares one pinning helper across controller and handoff callers", async () => {
    const root = await gitRepo();
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    expect(await resolveWorkspaceBase(root, "main")).toEqual({ base: head, pinned: true });
    expect(await resolveWorkspaceBase(root, "no-such-ref")).toEqual({ base: "no-such-ref", pinned: false });
  });

  it("binds handoff authorization payloads to the same resolved base", async () => {
    const root = await gitRepo();
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    // Remote-branch handoffs check out the branch; no base pinning applies.
    expect(await resolveHandoffWorkspaceBase(root, "feature/remote", "main")).toEqual({
      mode: "checkout-branch", branch: "feature/remote",
    });
    // Branch-off handoffs carry the pinned SHA so the gated request and the
    // executor cannot diverge behind the authorization.
    expect(await resolveHandoffWorkspaceBase(root, undefined, "main")).toEqual({
      mode: "branch-off", branch: "", base: head, basePinned: true,
    });
    expect(await resolveHandoffWorkspaceBase(root, undefined, "no-such-ref")).toEqual({
      mode: "branch-off", branch: "", base: "no-such-ref", basePinned: false,
    });
  });

  it("builds the exact authorized handoff payload, receipt-bound to the resolved base", async () => {
    const payload = buildHandoffWorkspacePayload({
      root: "/repo", slug: "slug", taskId: "T-1", mode: "branch-off",
      branch: "feature/T-1", base: "a".repeat(40), basePinned: true,
    });
    expect(payload).toEqual({
      path: "/repo", isolation: "worktree", mode: "branch-off", branch: "feature/T-1",
      base: "a".repeat(40), basePinned: true, slug: "slug", title: "T-1",
    });
    // The receipt evidence carries the same base so the authorization,
    // executor call, and receipt cannot disagree about the base.
    expect(buildHandoffWorkspaceEvidence({ workspaceId: "wks_1", worktreePath: "/w" }, payload)).toEqual({
      workspaceId: "wks_1", worktreePath: "/w", branch: "feature/T-1",
      base: "a".repeat(40), basePinned: true,
    });
  });

  it("passes the authorized resolved base to the executor", async () => {
    const root = await gitRepo();
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const argvLog = path.join(root, "paseo-argv.log");
    process.env.AEH_TEST_PASEO_ARGV_LOG = argvLog;
    try {
      const resolved = await resolveHandoffWorkspaceBase(root, undefined, "main");
      expect(resolved).toEqual({ mode: "branch-off", branch: "", base: head, basePinned: true });
      const payload = buildHandoffWorkspacePayload({
        root, slug: "slug", taskId: "T-1", mode: "branch-off", branch: "feature/T-1",
        base: resolved.base, basePinned: resolved.basePinned,
      });
      const created = await createBranchOffWorkspace(root, resolved.base!, "feature/T-1", "slug", "T-1", "OP-TEST-1");
      expect(created).toMatchObject({ workspaceId: "wks_test" });
      const lines = (await fs.readFile(argvLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
      const create = lines.find((args) => args[0] === "workspace" && args[1] === "create");
      expect(create).toBeDefined();
      // The executor's --base is exactly the authorized payload's base.
      expect(create![create!.indexOf("--base") + 1]).toBe(payload.base);
      expect(payload.base).toBe(head);
    } finally {
      delete process.env.AEH_TEST_PASEO_ARGV_LOG;
    }
  });

  it("binds payload, executor, and receipt through the production handoff call site", async () => {
    const root = await gitRepo();
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const now = new Date().toISOString();
    const operationId = "OP-HANDOFF-BASE";
    await saveOperation(root, { version: 1, id: operationId, kind: "change", status: "RUNNING", phase: "preparing", root, payload: { request: "fixture" }, createdAt: now, updatedAt: now });
    const owned = await claimControllerEpoch(root, operationId, "controller:test", { pid: process.pid });
    // The migrated record already carries its initial candidate; use it as
    // the authority binding directly.
    const candidate = (await loadOperation(root, operationId)).candidateRevision!;
    const policy = compileResolvedOperationPolicy({
      projectId: candidate.projectId!, operationId, operationExecutionRevision: 1,
      candidateRevision: candidate.revision, candidateDigest: candidate.identityDigest, controllerEpoch: owned.controller!.epoch,
      intent: "handoff base fixture", route: "DIRECT", minimumAssurance: "NONE", policyVersions: {},
      policyDigests: {}, validationPolicy: {}, reviewPolicy: {}, deliveryPolicy: {}, knowledgePolicy: {},
      contextPolicy: {}, allowedExternalEffects: [], humanDecisionRequirements: [],
    });
    await bindResolvedOperationPolicy(root, operationId, policy);
    const previousOperationId = process.env.AEH_OPERATION_ID;
    process.env.AEH_OPERATION_ID = operationId;
    // Paseo argv log lives outside the fixture repo so the boundary log
    // itself can never perturb the candidate digest under test.
    const argvLog = path.join(os.tmpdir(), `aeh-paseo-argv-${Date.now()}-${process.pid}.log`);
    process.env.AEH_TEST_PASEO_ARGV_LOG = argvLog;
    try {
      const { workspace, payload } = await createHandoffBranchOffWorkspace({
        root, taskId: "T-HO", originatingBranch: "main", localIssueBranch: "feature/T-HO",
        slug: "slug", handoffAuthority: {
          operationId, controllerEpoch: owned.controller!.epoch, candidate,
          evidence: { kind: "controller-authority", operationId, controllerEpoch: owned.controller!.epoch },
        },
      });
      expect(payload.base).toBe(head);
      expect(payload.basePinned).toBe(true);
      expect(workspace).toMatchObject({ workspaceId: "wks_test" });
      const lines = (await fs.readFile(argvLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
      const create = lines.find((args) => args[0] === "workspace" && args[1] === "create");
      expect(create![create!.indexOf("--base") + 1]).toBe(payload.base);
    } finally {
      delete process.env.AEH_TEST_PASEO_ARGV_LOG;
      await fs.rm(argvLog, { force: true });
      if (previousOperationId === undefined) delete process.env.AEH_OPERATION_ID;
      else process.env.AEH_OPERATION_ID = previousOperationId;
    }
  });
});
