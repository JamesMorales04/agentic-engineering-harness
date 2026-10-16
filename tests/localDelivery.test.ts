import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import { computeCommitTreeDigest, computeWorktreeDigest } from "../src/core/git.js";
import { sha256Canonical, sha256Utf8 } from "../src/core/digest.js";
import { claimControllerEpoch, currentControllerEpoch, bindResolvedOperationPolicy, loadOperation, operationArtifactDir, resolveOperationStateRoot, saveOperation } from "../src/operations/state.js";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import type { CandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { currentObjectiveIdentityV1, evaluateAcceptanceOracleV1, persistAcceptanceOracleArtifactV1, type AcceptanceEvidenceItemV1, type EvidenceBundleV1 } from "../src/architecture/acceptanceOracle.js";
import { finalizeAcceptedChange } from "../src/delivery/finalize.js";
import { localDeliveryBranchForOperation } from "../src/delivery/local.js";
import { runExecutable } from "../src/utils/process.js";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runExecutable("git", args, { cwd, timeoutMs: 120_000 });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

const roots: string[] = [];
const previousEnv = {
  id: process.env.AEH_OPERATION_ID,
  kind: process.env.AEH_OPERATION_KIND,
  control: process.env.AEH_CONTROL_ROOT,
  redirect: process.env.AEH_OPERATION_STATE_REDIRECT,
  epoch: process.env.AEH_CONTROLLER_EPOCH,
};
afterEach(async () => {
  restoreEnv("AEH_OPERATION_ID", previousEnv.id);
  restoreEnv("AEH_OPERATION_KIND", previousEnv.kind);
  restoreEnv("AEH_CONTROL_ROOT", previousEnv.control);
  restoreEnv("AEH_OPERATION_STATE_REDIRECT", previousEnv.redirect);
  restoreEnv("AEH_CONTROLLER_EPOCH", previousEnv.epoch);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

interface LocalFixture {
  repo: string;
  config: HarnessProjectConfig;
  contract: TaskContract;
  candidate: CandidateRevisionV1;
  operationId: string;
  branch: string;
  baseSha: string;
}

/** Plain local CHANGE op: base commit on main, tracked fix applied (dirty), candidate bound over it. */
async function createLocalFixture(options: { fix?: boolean; untracked?: boolean; pinnedBase?: string } = {}): Promise<LocalFixture> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-local-delivery-"));
  roots.push(baseDir);
  const repo = path.join(baseDir, "repo");
  await fs.mkdir(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "AEH Test");
  await git(repo, "config", "user.email", "aeh@example.invalid");
  await fs.writeFile(path.join(repo, "README.md"), "base\n");
  await fs.writeFile(path.join(repo, ".gitignore"), ".harness/\n");
  await git(repo, "add", "README.md", ".gitignore");
  await git(repo, "commit", "-m", "base");
  const baseSha = await git(repo, "rev-parse", "HEAD");
  // Optional pinned base ref that never moves while main advances: lets a
  // test advance HEAD past the recorded base without tripping the
  // base-moved gate for the wrong reason.
  if (options.pinnedBase) await git(repo, "branch", options.pinnedBase);
  if (options.fix !== false) {
    await fs.writeFile(path.join(repo, "README.md"), "accepted local fix\n");
  }
  if (options.untracked === true) {
    await fs.writeFile(path.join(repo, "scratch.txt"), "unreviewed\n");
  }

  const operationId = `CHANGE-LOCAL-${path.basename(baseDir).replace(/[^A-Za-z0-9-]+/g, "").slice(-6)}`;
  const config: HarnessProjectConfig = {
    version: 1,
    project: { name: "local-delivery-test" },
    validation: { baseRef: "main" },
    delivery: { stateDir: ".harness/delivery" },
  };
  const baseRef = options.pinnedBase ?? "main";
  const contract: TaskContract = {
    version: 1,
    task: { id: "CHANGE-LOCAL-1", title: "Apply local fix" },
    git: { baseRef, originatingBranch: baseRef },
    routing: { route: "DIRECT", assurance: "STANDARD" },
  };
  await saveOperation(repo, { version: 1, id: operationId, kind: "change", status: "RUNNING", phase: "delivery", root: repo, payload: { taskId: contract.task.id } });
  const candidate = (await loadOperation(repo, operationId)).candidateRevision!;
  await claimControllerEpoch(repo, operationId, "controller:test");
  process.env.AEH_OPERATION_ID = operationId;
  process.env.AEH_OPERATION_KIND = "change";
  process.env.AEH_CONTROL_ROOT = repo;
  process.env.AEH_OPERATION_STATE_REDIRECT = "1";
  process.env.AEH_CONTROLLER_EPOCH = "1";
  const bound = await loadOperation(repo, operationId);
  const deliveryPolicy = { githubEnabled: false, allowedActions: [], allowedExternalEffects: [] };
  const policy = compileResolvedOperationPolicy({ projectId: candidate.projectId!, operationId, operationExecutionRevision: bound.operationExecutionRevision!, candidateRevision: candidate.revision, candidateDigest: candidate.identityDigest, controllerEpoch: currentControllerEpoch(bound), intent: "local delivery test", route: "DIRECT", minimumAssurance: "STANDARD", policyVersions: {}, policyDigests: { delivery: sha256Canonical(deliveryPolicy) }, validationPolicy: {}, reviewPolicy: { leadAcceptance: true, leadAcceptanceDirect: false, independentReviewRequired: false }, deliveryPolicy, knowledgePolicy: {}, contextPolicy: {}, allowedExternalEffects: [], humanDecisionRequirements: [] });
  await bindResolvedOperationPolicy(repo, operationId, policy);
  await persistFixtureAcceptanceOracle(repo, await loadOperation(repo, operationId));
  return { repo, config, contract, candidate, operationId, branch: localDeliveryBranchForOperation(operationId), baseSha };
}

async function persistFixtureAcceptanceOracle(root: string, operation: Awaited<ReturnType<typeof loadOperation>>): Promise<void> {
  const identity = currentObjectiveIdentityV1(operation);
  const evidenceBase = { assertionId: "ASSERT-DELIVERY", identity, strength: "ELEVATED" as const };
  const evidence: AcceptanceEvidenceItemV1[] = [
    { version: 1, id: "validation:REQ-DELIVERY:ASSERT-DELIVERY", ...evidenceBase, kind: "VALIDATION", status: "PASS", provenance: { sourceId: "REQ-DELIVERY", digest: sha256Canonical("validation") } },
    { version: 1, id: "review:reviewer:test:architecture:ASSERT-DELIVERY", ...evidenceBase, kind: "REVIEW", status: "PASS", dimension: "architecture", reviewerIdentity: "reviewer:test", provider: "test", provenance: { sourceId: "session:reviewer:test", digest: sha256Canonical("review"), executionBindingDigest: sha256Canonical("review-binding") } },
  ];
  const requirement = { version: 1 as const, id: "verification:ASSERT-DELIVERY", assertionId: "ASSERT-DELIVERY", statement: "delivery candidate is ready", minimumAssurance: "STANDARD" as const, validationRequirementIds: ["REQ-DELIVERY"], reviewDimensions: ["architecture"], leadRequired: false };
  const bundleBody = { version: 1 as const, identity, candidate: operation.candidateRevision!, impactDigest: sha256Canonical("impact"), compilationDigest: sha256Canonical("compilation"), requirements: [requirement], evidence };
  const bundle: EvidenceBundleV1 = { ...bundleBody, digest: sha256Canonical(bundleBody) };
  const disposition = evaluateAcceptanceOracleV1(bundle, { minimumAssurance: "ELEVATED", minimumIndependentReviewers: 1, providerDiversity: false, requiredDimensions: ["architecture"] }, undefined, ["README.md"]);
  expect(disposition.disposition).toBe("ACCEPTED");
  await persistAcceptanceOracleArtifactV1(resolveOperationStateRoot(root), bundle, disposition);
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  const result = await runExecutable("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo, timeoutMs: 15_000 });
  return result.exitCode === 0;
}

function frozenRecordFile(repo: string, operationId: string): string {
  return path.join(operationArtifactDir(resolveOperationStateRoot(repo), operationId), "delivery", "local-changeset.json");
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("D25 local delivery for accepted plain CHANGE (GitHub disabled)", () => {
  it("freezes the accepted ChangeSet, BLOCKEDs on the dirty tree, then applies, verifies and fast-forwards after clean", async () => {
    const context = await createLocalFixture();
    // First attempt: the accepted fix is frozen, then delivery BLOCKEDs on
    // the dirty control-root tree instead of touching user-visible changes.
    const blocked = await finalizeAcceptedChange(context.repo, context.config, context.contract, { candidate: context.candidate });
    expect(blocked.status).toBe("BLOCKED_LOCAL");
    expect(blocked.humanRequired).toBe(true);
    expect(blocked.message).toMatch(/not clean/);
    expect(await branchExists(context.repo, context.branch)).toBe(false);
    expect(await git(context.repo, "rev-parse", "HEAD")).toBe(context.baseSha);
    // The frozen ChangeSet survived for the retry.
    const frozen = JSON.parse(await fs.readFile(frozenRecordFile(context.repo, context.operationId), "utf8")) as { patchDigest: string; candidateDigest: string };
    expect(frozen.candidateDigest).toBe(context.candidate.identityDigest);

    // Operator cleans the tree (the fix is preserved in the frozen record).
    await git(context.repo, "checkout", "--", ".");

    const result = await finalizeAcceptedChange(context.repo, context.config, context.contract, { candidate: context.candidate });
    expect(result).toMatchObject({ status: "FINALIZED", committed: true, pushed: false, localBranch: context.branch });
    expect(typeof result.commitSha).toBe("string");
    // The empty delivery branch shell is now populated: applied tree digest
    // equals the accepted candidate tree digest, and main fast-forwarded.
    expect(await computeCommitTreeDigest(context.repo, context.branch)).toBe(context.candidate.sourceDigest);
    expect(await git(context.repo, "rev-parse", "HEAD")).toBe(result.commitSha);
    expect(await git(context.repo, "branch", "--show-current")).toBe("main");
    expect(result.message).toContain(context.branch);
    expect(result.message).toContain(result.commitSha!.slice(0, 12));
  });

  it("BLOCKEDs a staged change without creating the delivery branch", async () => {
    const context = await createLocalFixture();
    await git(context.repo, "add", "-A");
    const result = await finalizeAcceptedChange(context.repo, context.config, context.contract, { candidate: context.candidate });
    expect(result.status).toBe("BLOCKED_LOCAL");
    expect(result.message).toMatch(/not clean/);
    expect(await branchExists(context.repo, context.branch)).toBe(false);
    expect(await git(context.repo, "rev-parse", "HEAD")).toBe(context.baseSha);
  });

  it("BLOCKEDs an untracked non-ignored file", async () => {
    // The untracked file is part of the bound candidate, so the freeze gate
    // (not mere workspace drift) rejects it with the exact reason.
    const context = await createLocalFixture({ untracked: true });
    const result = await finalizeAcceptedChange(context.repo, context.config, context.contract, { candidate: context.candidate });
    expect(result.status).toBe("BLOCKED_LOCAL");
    expect(result.message).toMatch(/untracked/);
    expect(await branchExists(context.repo, context.branch)).toBe(false);
    expect(await git(context.repo, "rev-parse", "HEAD")).toBe(context.baseSha);
  });

  it("BLOCKEDs a diverged base without touching branches", async () => {
    const context = await createLocalFixture();
    const first = await finalizeAcceptedChange(context.repo, context.config, context.contract, { candidate: context.candidate });
    expect(first.status).toBe("BLOCKED_LOCAL");
    await git(context.repo, "checkout", "--", ".");
    await fs.writeFile(path.join(context.repo, "README.md"), "someone else landed this\n");
    await git(context.repo, "add", "README.md");
    await git(context.repo, "commit", "-m", "unrelated advance");
    const divergedHead = await git(context.repo, "rev-parse", "HEAD");
    expect(divergedHead).not.toBe(context.baseSha);

    const result = await finalizeAcceptedChange(context.repo, context.config, context.contract, { candidate: context.candidate });
    expect(result.status).toBe("BLOCKED_LOCAL");
    expect(result.message).toMatch(/delivery base moved/);
    expect(await branchExists(context.repo, context.branch)).toBe(false);
    expect(await git(context.repo, "rev-parse", "HEAD")).toBe(divergedHead);
  });

  it("BLOCKEDs when the checkout advanced while the recorded base is unmoved", async () => {
    const context = await createLocalFixture();
    const first = await finalizeAcceptedChange(context.repo, context.config, context.contract, { candidate: context.candidate });
    expect(first.status).toBe("BLOCKED_LOCAL");
    await git(context.repo, "checkout", "--", ".");
    await git(context.repo, "checkout", "-b", "side-work");
    await fs.writeFile(path.join(context.repo, "README.md"), "side work\n");
    await git(context.repo, "add", "README.md");
    await git(context.repo, "commit", "-m", "side");
    // Base ref 'main' is unmoved; the checked-out HEAD is elsewhere.
    expect(await git(context.repo, "rev-parse", "main")).toBe(context.baseSha);

    const result = await finalizeAcceptedChange(context.repo, context.config, context.contract, { candidate: context.candidate });
    expect(result.status).toBe("BLOCKED_LOCAL");
    expect(result.message).toMatch(/does not equal the recorded delivery base/);
    expect(await branchExists(context.repo, context.branch)).toBe(false);
  });

  it("is an idempotent no-op success on rerun", async () => {
    const context = await createLocalFixture();
    await finalizeAcceptedChange(context.repo, context.config, context.contract, { candidate: context.candidate });
    await git(context.repo, "checkout", "--", ".");
    const first = await finalizeAcceptedChange(context.repo, context.config, context.contract, { candidate: context.candidate });
    expect(first.status).toBe("FINALIZED");
    const count = await git(context.repo, "rev-list", "--count", "HEAD");

    const second = await finalizeAcceptedChange(context.repo, context.config, context.contract, { candidate: context.candidate });
    expect(second).toMatchObject({ status: "FINALIZED", committed: false, commitSha: first.commitSha });
    expect(second.message).toMatch(/already delivered|already applied/);
    expect(await git(context.repo, "rev-list", "--count", "HEAD")).toBe(count);
  });

  it("fails closed when the frozen patch is tampered with", async () => {
    const context = await createLocalFixture();
    await finalizeAcceptedChange(context.repo, context.config, context.contract, { candidate: context.candidate });
    await git(context.repo, "checkout", "--", ".");
    const recordFile = frozenRecordFile(context.repo, context.operationId);
    const record = JSON.parse(await fs.readFile(recordFile, "utf8")) as { patchDigest: string };
    const patchFile = path.join(path.dirname(recordFile), "local-changeset.patch");
    await fs.appendFile(patchFile, "\n# tampered\n");
    expect(sha256Utf8(await fs.readFile(patchFile, "utf8"))).not.toBe(record.patchDigest);

    const result = await finalizeAcceptedChange(context.repo, context.config, context.contract, { candidate: context.candidate });
    expect(result.status).toBe("BLOCKED_LOCAL");
    expect(result.message).toMatch(/digest mismatch/);
    expect(await branchExists(context.repo, context.branch)).toBe(false);
    expect(await git(context.repo, "rev-parse", "HEAD")).toBe(context.baseSha);
  });

  it("reports NO_CHANGES for an accepted candidate identical to the base", async () => {
    const context = await createLocalFixture({ fix: false });
    expect(await computeWorktreeDigest(context.repo)).toBe(await computeCommitTreeDigest(context.repo, "HEAD"));
    const result = await finalizeAcceptedChange(context.repo, context.config, context.contract, { candidate: context.candidate });
    expect(result.status).toBe("NO_CHANGES");
    expect(await branchExists(context.repo, context.branch)).toBe(false);
  });

  it("P1: a concurrent edit racing staging BLOCKEDs with no commit created", async () => {
    const context = await createLocalFixture();
    // Freeze the accepted ChangeSet on the first (dirty) attempt.
    const first = await finalizeAcceptedChange(context.repo, context.config, context.contract, { candidate: context.candidate });
    expect(first.status).toBe("BLOCKED_LOCAL");
    await git(context.repo, "checkout", "--", ".");

    // Simulate a concurrent user edit landing strictly after the
    // clean-tree check: a fake `git` that plants an extra modification
    // whenever `git add` runs, then delegates to the real git. The raced
    // content enters the index via `git add -A`, so the pre-commit
    // staged-tree verification must catch it.
    const fakeBin = path.join(path.dirname(context.repo), "fake-bin");
    await fs.mkdir(fakeBin, { recursive: true });
    const realGit = await runExecutable("which", ["git"], { cwd: context.repo, timeoutMs: 10_000 }).then((result) => result.stdout.trim());
    await fs.writeFile(
      path.join(fakeBin, "git"),
      `#!/bin/sh\nif [ "$1" = "add" ]; then printf 'raced concurrent edit\\n' >> "${context.repo}/README.md"; fi\nexec "${realGit}" "$@"\n`,
      { mode: 0o755 }
    );
    await fs.chmod(path.join(fakeBin, "git"), 0o755);
    // Hermetic migration: ambient PATH no longer reaches managed children,
    // so the fake git is pinned via toolchain state at the fixture parent
    // (kept out of the repo tree so the candidate worktree digest is
    // untouched).
    const { clearToolchainEnvCache } = await import("../src/utils/process.js");
    await fs.mkdir(path.join(path.dirname(context.repo), ".harness"), { recursive: true });
    await fs.writeFile(path.join(path.dirname(context.repo), ".harness", "toolchain.state.json"), JSON.stringify({ version: 1, binPaths: [fakeBin] }));
    clearToolchainEnvCache();
    try {
      const result = await finalizeAcceptedChange(context.repo, context.config, context.contract, { candidate: context.candidate });
      expect(result.status).toBe("BLOCKED_LOCAL");
      expect(result.message).toMatch(/concurrent modification raced delivery staging/);
      expect(result.message).toMatch(/no commit created/);
      // The delivery branch shell exists but holds NO commit: the race was
      // caught before commit creation.
      expect(await git(context.repo, "rev-parse", context.branch)).toBe(context.baseSha);
      const record = JSON.parse(await fs.readFile(frozenRecordFile(context.repo, context.operationId), "utf8")) as { deliveredCommitSha?: string };
      expect(record.deliveredCommitSha).toBeUndefined();
      // The index was reset but the worktree was left untouched.
      expect(await fs.readFile(path.join(context.repo, "README.md"), "utf8")).toContain("raced concurrent edit");
      expect(await git(context.repo, "branch", "--show-current")).toBe("main");
    } finally {
      clearToolchainEnvCache();
      await fs.rm(fakeBin, { recursive: true, force: true });
      await fs.rm(path.join(path.dirname(context.repo), ".harness", "toolchain.state.json"), { force: true });
    }
  });

  it("P2: a stale manually-created branch tip never reports success for the wrong content", async () => {
    // Pinned base stays at B1 while main advances: the stale branch tip can
    // be an ancestor of HEAD without tripping the base-moved gate.
    const context = await createLocalFixture({ pinnedBase: "delivery-base" });
    const first = await finalizeAcceptedChange(context.repo, context.config, context.contract, { candidate: context.candidate });
    expect(first.status).toBe("BLOCKED_LOCAL");
    await git(context.repo, "checkout", "--", ".");

    // Main advances with content that is NOT the accepted candidate.
    await fs.writeFile(path.join(context.repo, "README.md"), "wrong content\n");
    await git(context.repo, "add", "README.md");
    await git(context.repo, "commit", "-m", "unrelated wrong advance");
    const wrongTip = await git(context.repo, "rev-parse", "HEAD");
    expect(wrongTip).not.toBe(context.baseSha);
    // Stale branch shell pointing at the wrong tip: ancestor of HEAD, wrong
    // tree, and no delivery receipt.
    await git(context.repo, "branch", context.branch, "HEAD");

    const result = await finalizeAcceptedChange(context.repo, context.config, context.contract, { candidate: context.candidate });
    // Ancestry alone must not bless foreign content: no false success.
    expect(result.status).toBe("BLOCKED_LOCAL");
    // No new commit was created on the stale branch, HEAD is untouched.
    expect(await git(context.repo, "rev-parse", context.branch)).toBe(wrongTip);
    expect(await git(context.repo, "rev-parse", "HEAD")).toBe(wrongTip);
    const record = JSON.parse(await fs.readFile(frozenRecordFile(context.repo, context.operationId), "utf8")) as { deliveredCommitSha?: string };
    expect(record.deliveredCommitSha).toBeUndefined();
  });
});
