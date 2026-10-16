import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessProjectConfig, TaskContract } from "../core/types.js";
import type { CandidateRevisionV1 } from "../operations/v2Contracts.js";
import { sha256Utf8 } from "../core/digest.js";
import { computeCommitTreeDigest } from "../core/git.js";
import { runExecutable } from "../utils/process.js";
import { assertWorkspaceMatchesCandidate } from "../candidates/identity.js";
import { requireAcceptedCurrentOracleV1 } from "../architecture/acceptanceOracle.js";
import {
  controllerEpochFromEnvironment,
  currentOperationContext,
  loadOperation,
  operationArtifactDir,
  resolveOperationStateRoot,
} from "../operations/state.js";
import type { DeliveryFinalizationResult } from "./finalize.js";

/**
 * D25 local delivery (DETERMINISTIC).
 *
 * Controller-owned local delivery for accepted plain-CHANGE candidates when
 * GitHub delivery is disabled. All effects are local-only git operations
 * (branch create, patch apply, commit, fast-forward) executed by the
 * controller under the frozen operation intent + policy — the same trust
 * class as candidate assembly's `git apply` (direct `runExecutable`, no
 * gated tool actions, no ledger, no new Owner gates). External effects
 * (push / pull-request / merge to a remote) remain exclusively behind the
 * existing `delivery.authorize` HUMAN_REQUIRED path, which is untouched.
 *
 * Trigger conditions (all must hold; any unmet condition returns a
 * BLOCKED_LOCAL terminal with the exact unmet condition — never force,
 * never overwrite, never rebase user work, never touch remotes):
 *  (a) operation kind == CHANGE, no linked issue, route != FORMAL_SDD
 *      (FORMAL_SDD is explicitly out of scope and stays SKIPPED);
 *  (b) AcceptanceOracle ACCEPTED the exact candidate revision
 *      (authority failure throws, as in the GitHub paths);
 *  (c) the frozen ChangeSet patch digest matches (fail closed on tamper);
 *  (d) the control-root worktree is CLEAN (empty `git status --porcelain`;
 *      gitignored harness state never surfaces there);
 *  (e) control-root HEAD equals the recorded delivery base.
 * On success the frozen patch is applied onto the op's delivery branch
 * (`aeh/op-change-<sanitized-opid>`, created from base when missing), the
 * staged index tree is re-verified against the deterministically computed
 * expected tree (frozen base + frozen patch, no worktree reads that could
 * race) BEFORE the commit — any mismatch resets the index (worktree
 * untouched) and BLOCKEDs naming the race with no commit created — then the
 * applied tree digest is verified against the accepted candidate, and the
 * checked-out branch is fast-forwarded to it. Re-running after success is
 * a no-op success only when BOTH the durable delivery receipt and
 * candidate-tree proof agree (never on branch ancestry alone); otherwise
 * delivery proceeds through the normal apply/verify flow (converge or
 * BLOCKED loudly).
 *
 * Residual micro-window (accepted risk, documented): a concurrent `git add`
 * landing strictly between the staged-tree verification and `git commit`
 * completion could still alter the index. That residual is caught by the
 * post-commit applied-tree digest check, which fails closed — but by then a
 * tainted commit exists on the delivery branch. It is left in place with
 * its SHA in the error for inspection; the frozen receipt is NOT updated,
 * so reruns never treat it as delivered and instead converge or BLOCKED
 * loudly.
 *
 * The frozen ChangeSet is a durable artifact (patch bytes + digests) stored
 * under the operation artifact dir. It is frozen from the candidate-bound
 * execution tree (which provably materializes the accepted candidate) on
 * first delivery and verified on every run, so a later dirty control-root
 * tree can never smuggle unreviewed content into delivery.
 */

export interface LocalDeliveryFrozenChangeSetV1 {
  version: 1;
  operationId: string;
  taskId: string;
  branch: string;
  baseSha: string;
  patchDigest: string;
  patchFile: string;
  candidateDigest: string;
  candidateRevision: number;
  createdAt: string;
  deliveredCommitSha?: string;
}

export interface LocalDeliveryOptions {
  candidate?: CandidateRevisionV1;
  /** Control root that owns delivery (checks + branch + fast-forward). Defaults to root. */
  controlRoot?: string;
}

function frozenFile(stateRoot: string, operationId: string): string {
  return path.join(operationArtifactDir(stateRoot, operationId), "delivery", "local-changeset.json");
}

function frozenPatchFile(stateRoot: string, operationId: string): string {
  return path.join(operationArtifactDir(stateRoot, operationId), "delivery", "local-changeset.patch");
}

/** Deterministic delivery-branch name for one operation. */
export function localDeliveryBranchForOperation(operationId: string): string {
  const slug = operationId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `aeh/op-change-${slug || "op"}`;
}

function blocked(message: string, candidate?: CandidateRevisionV1, localBranch?: string): DeliveryFinalizationResult {
  return {
    status: "BLOCKED_LOCAL",
    humanRequired: true,
    committed: false,
    pushed: false,
    candidate,
    ...(localBranch ? { localBranch } : {}),
    message: `LOCAL_DELIVERY_BLOCKED: ${message}`,
  };
}

async function git(root: string, args: string[], stdin?: string, env?: Record<string, string | undefined>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return runExecutable("git", args, { cwd: root, timeoutMs: 120_000, ...(stdin !== undefined ? { stdin } : {}), ...(env !== undefined ? { env } : {}) });
}

async function revParse(root: string, ref: string): Promise<string> {
  const result = await git(root, ["rev-parse", "--verify", "--end-of-options", ref]);
  if (result.exitCode !== 0) throw new Error(`SYSTEM_FAILURE: git rev-parse ${ref} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function refExists(root: string, branch: string): Promise<boolean> {
  const result = await git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  return result.exitCode === 0;
}

async function isAncestor(root: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await git(root, ["merge-base", "--is-ancestor", ancestor, descendant]);
  return result.exitCode === 0;
}

function quoteRef(value: string): string {
  if (
    !/^[A-Za-z0-9._/-]+$/.test(value) ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("@{")
  ) {
    throw new Error(`Unsafe git ref: ${value}`);
  }
  return value;
}

/**
 * Write the current index to a tree object (DETERMINISTIC, no worktree
 * reads that could race): `git write-tree` snapshots the staged index
 * only, so the returned SHA is exactly what a commit right now would
 * record — including any content a concurrent edit smuggled into the
 * index after the clean-tree check.
 */
async function writeStagedTree(controlRoot: string): Promise<string> {
  const result = await git(controlRoot, ["write-tree"]);
  if (result.exitCode !== 0) throw new Error(`SYSTEM_FAILURE: cannot write staged tree during delivery verification: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

/**
 * Compute the exact expected delivery tree (DETERMINISTIC): the frozen
 * base commit plus the frozen patch hunks, built in an isolated throwaway
 * index (`GIT_INDEX_FILE`) so no worktree state — raced or otherwise — can
 * influence it. The throwaway index directory is always removed.
 */
async function computeExpectedDeliveryTree(controlRoot: string, baseSha: string, patch: string, taskId: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-local-delivery-"));
  const indexFile = path.join(dir, "index");
  try {
    const env = { GIT_INDEX_FILE: indexFile };
    const read = await git(controlRoot, ["read-tree", baseSha], undefined, env);
    if (read.exitCode !== 0) throw new Error(`SYSTEM_FAILURE: cannot read delivery base ${baseSha.slice(0, 12)} into the expected-tree index: ${read.stderr || read.stdout}`);
    const apply = await git(controlRoot, ["apply", "--cached", "--binary", "--whitespace=nowarn", "-"], patch, env);
    if (apply.exitCode !== 0) throw new Error(`SYSTEM_FAILURE: frozen patch for ${taskId} does not apply to its own recorded base ${baseSha.slice(0, 12)}: ${apply.stderr || apply.stdout}`);
    const written = await git(controlRoot, ["write-tree"], undefined, env);
    if (written.exitCode !== 0) throw new Error(`SYSTEM_FAILURE: cannot write expected delivery tree for ${taskId}: ${written.stderr || written.stdout}`);
    return written.stdout.trim();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Freeze the accepted candidate's ChangeSet from the candidate-bound
 * execution tree (DETERMINISTIC). Requires the tree to materialize the
 * candidate and to contain no untracked non-ignored files (a `git diff`
 * patch cannot represent them, so they fail closed here with the exact
 * reason instead of being silently dropped). Reuses an existing frozen
 * record when it already binds the current candidate; fails closed when
 * the stored patch or candidate binding diverges (tamper/staleness).
 */
export async function freezeLocalChangePatch(input: {
  root: string;
  stateRoot: string;
  operationId: string;
  taskId: string;
  branch: string;
  baseSha: string;
  candidate: CandidateRevisionV1;
}): Promise<LocalDeliveryFrozenChangeSetV1> {
  const { root, stateRoot, operationId, taskId, branch, baseSha, candidate } = input;
  const file = frozenFile(stateRoot, operationId);
  const patchPath = frozenPatchFile(stateRoot, operationId);
  try {
    const stored = JSON.parse(await fs.readFile(file, "utf8")) as LocalDeliveryFrozenChangeSetV1;
    if (
      stored.version === 1 &&
      stored.operationId === operationId &&
      stored.taskId === taskId &&
      stored.branch === branch &&
      typeof stored.patchDigest === "string" &&
      typeof stored.patchFile === "string" &&
      stored.candidateDigest === candidate.identityDigest &&
      stored.candidateRevision === candidate.revision
    ) {
      if (stored.baseSha !== baseSha && !stored.deliveredCommitSha) {
        throw new Error(
          `delivery base moved for ${taskId}: the frozen ChangeSet pins base ${String(stored.baseSha).slice(0, 12)}, but the base now resolves to ${baseSha.slice(0, 12)}; refusing to deliver a stale-base patch onto a moved base.`
        );
      }
      // A completed delivery receipt stays usable for the idempotency probe
      // even after delivery advanced the base past the recorded pin; the
      // patch digest is still verified below, so tamper fails closed here.
      const patch = await fs.readFile(path.resolve(path.dirname(file), stored.patchFile), "utf8");
      if (sha256Utf8(patch) !== stored.patchDigest) {
        throw new Error(
          `frozen ChangeSet patch digest mismatch for ${taskId}: stored patch does not match its recorded digest (possible tamper; refusing delivery).`
        );
      }
      return stored;
    }
    throw new Error(
      `frozen ChangeSet is stale for ${taskId}: it binds candidate r${stored.candidateRevision} (${stored.candidateDigest?.slice(0, 12) ?? "unknown"}), current is r${candidate.revision} (${candidate.identityDigest.slice(0, 12)}). Re-freeze from the current accepted candidate.`
    );
  } catch (error) {
    if (error instanceof Error && /frozen ChangeSet (patch digest mismatch|is stale)|delivery base moved/.test(error.message)) throw error;
    // Missing/unreadable record (or a record for another shape): freeze fresh below.
  }

  await assertWorkspaceMatchesCandidate(root, candidate);
  const untracked = await git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--"]);
  if (untracked.exitCode !== 0) throw new Error(`SYSTEM_FAILURE: cannot enumerate untracked files: ${untracked.stderr || untracked.stdout}`);
  const untrackedFiles = untracked.stdout.split("\0").filter(Boolean).sort();
  if (untrackedFiles.length > 0) {
    throw new Error(
      `cannot freeze ChangeSet for ${taskId}: candidate tree has ${untrackedFiles.length} untracked non-ignored file(s) (${untrackedFiles.slice(0, 8).join(", ")}) that a git patch cannot represent; failing closed.`
    );
  }
  const diff = await git(root, ["diff", "--binary", "--no-color", baseSha, "--"]);
  if (diff.exitCode !== 0) throw new Error(`SYSTEM_FAILURE: cannot diff candidate tree against delivery base: ${diff.stderr || diff.stdout}`);
  if (!diff.stdout.trim()) {
    throw new Error(`EMPTY_PATCH: candidate tree for ${taskId} is identical to delivery base ${baseSha.slice(0, 12)} (nothing to deliver).`);
  }
  const record: LocalDeliveryFrozenChangeSetV1 = {
    version: 1,
    operationId,
    taskId,
    branch,
    baseSha,
    patchDigest: sha256Utf8(diff.stdout),
    patchFile: "local-changeset.patch",
    candidateDigest: candidate.identityDigest,
    candidateRevision: candidate.revision,
    createdAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(patchPath, diff.stdout);
  await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
  const reread = await fs.readFile(patchPath, "utf8");
  if (sha256Utf8(reread) !== record.patchDigest) {
    throw new Error(`SYSTEM_FAILURE: frozen ChangeSet patch failed its own digest verification after write.`);
  }
  return record;
}

/**
 * Controller-owned local delivery for an accepted plain-CHANGE candidate.
 * See the module docblock for the trigger conditions and authority model.
 */
export async function finalizeLocalChangeDelivery(
  root: string,
  config: HarnessProjectConfig,
  contract: TaskContract,
  options: LocalDeliveryOptions = {}
): Promise<DeliveryFinalizationResult> {
  const controlRoot = path.resolve(options.controlRoot ?? root);
  const context = currentOperationContext();
  const operationId = context.id;
  if (context.kind !== "change" || !operationId) {
    return {
      status: "SKIPPED",
      humanRequired: false,
      committed: false,
      pushed: false,
      message: "Local CHANGE delivery requires a managed CHANGE operation.",
    };
  }
  if (contract.issue) {
    return {
      status: "SKIPPED",
      humanRequired: false,
      committed: false,
      pushed: false,
      message: "Local CHANGE delivery does not handle issue-linked tasks; the issue delivery path owns them.",
    };
  }
  if (contract.routing?.route === "FORMAL_SDD") {
    return {
      status: "SKIPPED",
      humanRequired: false,
      committed: false,
      pushed: false,
      message: "Local CHANGE delivery does not handle FORMAL_SDD (follow-up: SDD local delivery).",
    };
  }

  const stateRoot = resolveOperationStateRoot(controlRoot);
  const operation = await loadOperation(stateRoot, operationId);
  if (operation.kind !== "change") {
    throw new Error("DELIVERY_AUTHORITY_REQUIRED: local CHANGE delivery requires a CHANGE operation record.");
  }
  const boundCandidate = options.candidate ?? operation.candidateRevision;
  if (!boundCandidate || !operation.candidateRevision || boundCandidate.identityDigest !== operation.candidateRevision.identityDigest) {
    throw new Error("DELIVERY_AUTHORITY_REQUIRED: local CHANGE delivery requires the operation's current CandidateRevision.");
  }
  // Authority: only an ACCEPTED current AcceptanceOracle disposition unlocks
  // delivery effects (same gate as the GitHub paths; throws on failure).
  await requireAcceptedCurrentOracleV1(stateRoot, operation, boundCandidate);
  void controllerEpochFromEnvironment();

  const base = contract.git?.originatingBranch ?? contract.git?.baseRef ?? config.validation?.baseRef ?? "main";
  let baseSha: string;
  try {
    baseSha = await revParse(controlRoot, `${base}^{commit}`);
  } catch {
    throw new Error(`SYSTEM_FAILURE: cannot resolve delivery base '${base}' in the control root.`);
  }
  const branch = localDeliveryBranchForOperation(operationId);

  // Freeze (or re-verify) the ChangeSet from the candidate-bound tree. This
  // runs before the cleanliness gate on purpose: the freeze is what preserves
  // the accepted content across the operator's cleanup, so a dirty first
  // attempt freezes then BLOCKEDs, and the clean retry delivers. A completed
  // delivery receipt stays re-verifiable even after delivery advanced the
  // base past the recorded pin (the post-success probe below turns that
  // rerun into a no-op success).
  let frozen: LocalDeliveryFrozenChangeSetV1;
  try {
    frozen = await freezeLocalChangePatch({ root, stateRoot, operationId, taskId: contract.task.id, branch, baseSha, candidate: boundCandidate });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/^EMPTY_PATCH:/.test(message)) {
      return { status: "NO_CHANGES", humanRequired: false, committed: false, pushed: false, candidate: boundCandidate, localBranch: branch, message: `Accepted CHANGE candidate for ${contract.task.id} has no changes against delivery base ${baseSha.slice(0, 12)}; no local branch was published.` };
    }
    if (/^SYSTEM_FAILURE:/.test(message) || /^CANDIDATE_/.test(message) || (error as { code?: string })?.code === "CANDIDATE_WORKSPACE_MISMATCH") {
      throw error;
    }
    return blocked(message, boundCandidate, branch);
  }

  // (d) Control-root worktree must be CLEAN: gitignored harness state never
  // surfaces in porcelain, so any entry is user-visible content at risk.
  const status = await git(controlRoot, ["status", "--porcelain"]);
  if (status.exitCode !== 0) throw new Error(`SYSTEM_FAILURE: cannot inspect control-root Git status: ${status.stderr || status.stdout}`);
  if (status.stdout.trim()) {
    const entries = status.stdout.trim().split("\n").slice(0, 8).join(", ");
    return blocked(
      `control-root worktree is not clean (${status.stdout.trim().split("\n").length} entr${status.stdout.trim().split("\n").length === 1 ? "y" : "ies"}: ${entries}); refusing to deliver over user-visible changes.`,
      boundCandidate,
      branch
    );
  }

  const headSha = await revParse(controlRoot, "HEAD");
  const candidateTreeDigest = boundCandidate.sourceDigest;

  // Post-success rerun probe: the stored delivery receipt for this exact
  // candidate (patch digest already re-verified by the freeze above) whose
  // commit HEAD already contains is a no-op success.
  const branchExists = await refExists(controlRoot, quoteRef(branch));
  if (frozen.deliveredCommitSha && branchExists) {
    const tip = await revParse(controlRoot, quoteRef(branch));
    if (tip === frozen.deliveredCommitSha && (await isAncestor(controlRoot, tip, headSha))) {
      return {
        status: "FINALIZED",
        humanRequired: false,
        committed: false,
        pushed: false,
        commitSha: tip,
        candidate: boundCandidate,
        localBranch: branch,
        message: `Accepted CHANGE already delivered locally on ${branch} (${tip.slice(0, 12)}); HEAD already contains the delivery commit (no-op).`,
      };
    }
  }
  // P2: branch ancestry alone never reports success. A no-op success
  // requires BOTH the durable delivery receipt for this exact candidate
  // (re-verified above) AND tree proof that the tip materializes the
  // accepted candidate. Otherwise fall through to the normal apply/verify
  // flow below, which converges or BLOCKEDs loudly instead of blessing
  // foreign content.
  if (branchExists) {
    const tip = await revParse(controlRoot, quoteRef(branch));
    const receiptDelivered = frozen.deliveredCommitSha === tip;
    const treeProven = (await computeCommitTreeDigest(controlRoot, quoteRef(branch))) === candidateTreeDigest;
    if (receiptDelivered && treeProven && (await isAncestor(controlRoot, tip, headSha))) {
      return {
        status: "FINALIZED",
        humanRequired: false,
        committed: false,
        pushed: false,
        commitSha: tip,
        candidate: boundCandidate,
        localBranch: branch,
        message: `Accepted CHANGE already delivered locally on ${branch} (${tip.slice(0, 12)}); HEAD already contains the delivery commit (no-op).`,
      };
    }
  }

  // (e) Control-root HEAD must equal the recorded delivery base.
  if (headSha !== baseSha) {
    return blocked(
      `control-root HEAD ${headSha.slice(0, 12)} does not equal the recorded delivery base ${baseSha.slice(0, 12)} (base '${base}'); the base moved or the checkout advanced — refusing to fast-forward.`,
      boundCandidate,
      branch
    );
  }

  const currentBranchResult = await git(controlRoot, ["branch", "--show-current"]);
  if (currentBranchResult.exitCode !== 0) throw new Error(`SYSTEM_FAILURE: cannot determine the checked-out branch: ${currentBranchResult.stderr || currentBranchResult.stdout}`);
  const currentBranch = currentBranchResult.stdout.trim();
  if (!currentBranch) {
    return blocked("control-root checkout is detached (no checked-out branch to fast-forward); refusing delivery.", boundCandidate, branch);
  }

  // Delivery branch already materializes the accepted candidate tree (a
  // previous run applied and committed but never fast-forwarded): skip the
  // apply and fast-forward now.
  if (branchExists) {
    const tip = await revParse(controlRoot, quoteRef(branch));
    if (!(await isAncestor(controlRoot, baseSha, tip))) {
      return blocked(
        `delivery branch ${branch} at ${tip.slice(0, 12)} does not contain the recorded delivery base ${baseSha.slice(0, 12)}; refusing to overwrite foreign history.`,
        boundCandidate,
        branch
      );
    }
    const branchTree = await computeCommitTreeDigest(controlRoot, quoteRef(branch));
    if (branchTree === candidateTreeDigest) {
      const fastForwarded = await fastForwardCheckedOutBranch(controlRoot, currentBranch, branch);
      return {
        status: "FINALIZED",
        humanRequired: false,
        committed: false,
        pushed: false,
        commitSha: tip,
        candidate: boundCandidate,
        localBranch: branch,
        message: `Accepted CHANGE patch already applied on ${branch} (${tip.slice(0, 12)}); ${fastForwarded}.`,
      };
    }
    const baseTree = await computeCommitTreeDigest(controlRoot, baseSha);
    if (branchTree !== baseTree) {
      return blocked(
        `delivery branch ${branch} already diverges from the delivery base with unrecognized content; refusing to overwrite.`,
        boundCandidate,
        branch
      );
    }
  }

  // Apply the frozen patch onto the delivery branch (created from base when
  // missing), commit, verify the applied tree digest, fast-forward.
  const patch = await fs.readFile(frozenPatchFile(stateRoot, operationId), "utf8");
  if (sha256Utf8(patch) !== frozen.patchDigest) {
    return blocked("frozen ChangeSet patch digest mismatch on delivery read (possible tamper); refusing delivery.", boundCandidate, branch);
  }

  let delivered = false;
  try {
    if (!branchExists) {
      const created = await git(controlRoot, ["checkout", "-b", quoteRef(branch), baseSha]);
      if (created.exitCode !== 0) throw new Error(`SYSTEM_FAILURE: cannot create delivery branch ${branch} from ${baseSha.slice(0, 12)}: ${created.stderr || created.stdout}`);
    } else {
      const switched = await git(controlRoot, ["checkout", quoteRef(branch)]);
      if (switched.exitCode !== 0) throw new Error(`SYSTEM_FAILURE: cannot check out delivery branch ${branch}: ${switched.stderr || switched.stdout}`);
    }
    const applied = await git(controlRoot, ["apply", "--binary", "--whitespace=nowarn", "-"], patch);
    if (applied.exitCode !== 0) throw new Error(`SYSTEM_FAILURE: frozen patch does not apply to delivery base ${baseSha.slice(0, 12)}: ${applied.stderr || applied.stdout}`);
    const added = await git(controlRoot, ["add", "-A"]);
    if (added.exitCode !== 0) throw new Error(`SYSTEM_FAILURE: cannot stage delivered changes: ${added.stderr || added.stdout}`);
    // P1: re-verify the staged index tree against the deterministically
    // computed expected tree (frozen base + frozen patch hunks, built in an
    // isolated temp index — no worktree reads that could race) BEFORE any
    // commit exists. On ANY mismatch a concurrent edit entered the index
    // after the clean-tree check: reset the index (worktree untouched) and
    // BLOCKED_LOCAL naming the race. No commit is created on this path.
    // (Residual micro-window documented in the module docblock: a `git add`
    // landing strictly between this verification and commit completion is
    // caught instead by the post-commit applied-tree check, which fails
    // closed but leaves the tainted commit for inspection.)
    const stagedTree = await writeStagedTree(controlRoot);
    const expectedTree = await computeExpectedDeliveryTree(controlRoot, baseSha, patch, contract.task.id);
    if (stagedTree !== expectedTree) {
      const reset = await git(controlRoot, ["reset"]);
      if (reset.exitCode !== 0) throw new Error(`SYSTEM_FAILURE: concurrent edit raced delivery staging and the delivery index cannot be reset: ${reset.stderr || reset.stdout}`);
      return blocked(
        `concurrent modification raced delivery staging for ${contract.task.id}: staged tree ${stagedTree.slice(0, 12)} does not match the frozen expected tree ${expectedTree.slice(0, 12)}; index reset (worktree untouched), no commit created.`,
        boundCandidate,
        branch
      );
    }
    const commitMessage = `${contract.task.id}: ${contract.task.title}`;
    const committed = await commitWithHarnessIdentity(controlRoot, commitMessage);
    if (committed.exitCode !== 0) throw new Error(`SYSTEM_FAILURE: git commit failed during local delivery: ${committed.stderr || committed.stdout}`);
    const commitSha = await revParse(controlRoot, "HEAD");
    const appliedTree = await computeCommitTreeDigest(controlRoot, "HEAD");
    if (appliedTree !== candidateTreeDigest) {
      throw new Error(
        `SYSTEM_FAILURE: applied tree digest ${appliedTree.slice(0, 12)} does not match the accepted candidate tree ${candidateTreeDigest.slice(0, 12)}; leaving ${branch} at ${commitSha.slice(0, 12)} for inspection.`
      );
    }
    delivered = true;
    const record: LocalDeliveryFrozenChangeSetV1 = { ...frozen, deliveredCommitSha: commitSha };
    await fs.writeFile(frozenFile(stateRoot, operationId), `${JSON.stringify(record, null, 2)}\n`);
    const fastForwarded = branch === currentBranch
      ? `checked-out branch ${currentBranch} is the delivery branch`
      : await fastForwardCheckedOutBranch(controlRoot, currentBranch, branch);
    return {
      status: "FINALIZED",
      humanRequired: false,
      committed: true,
      pushed: false,
      commitSha,
      candidate: boundCandidate,
      localBranch: branch,
      message: `Accepted CHANGE delivered locally on ${branch} (${commitSha.slice(0, 12)}); ${fastForwarded}.`,
    };
  } finally {
    if (!delivered || currentBranch !== branch) {
      // Best-effort restore of the original checkout; never masks the delivery result.
      const back = await git(controlRoot, ["checkout", quoteRef(currentBranch)]);
      if (back.exitCode !== 0 && delivered) {
        throw new Error(`SYSTEM_FAILURE: delivered ${branch} but cannot restore checkout of ${currentBranch}: ${back.stderr || back.stdout}`);
      }
    }
  }
}

async function fastForwardCheckedOutBranch(controlRoot: string, currentBranch: string, branch: string): Promise<string> {
  if (currentBranch === branch) return `checked-out branch ${currentBranch} is the delivery branch`;
  const back = await git(controlRoot, ["checkout", quoteRef(currentBranch)]);
  if (back.exitCode !== 0) throw new Error(`SYSTEM_FAILURE: cannot check out ${currentBranch} after delivery: ${back.stderr || back.stdout}`);
  const merged = await git(controlRoot, ["merge", "--ff-only", quoteRef(branch)]);
  if (merged.exitCode !== 0) throw new Error(`SYSTEM_FAILURE: cannot fast-forward ${currentBranch} to ${branch}: ${merged.stderr || merged.stdout}`);
  return `fast-forwarded ${currentBranch} to ${branch}`;
}

async function commitWithHarnessIdentity(root: string, message: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const name = await git(root, ["config", "user.name"]);
  const email = await git(root, ["config", "user.email"]);
  const args =
    name.exitCode === 0 && name.stdout.trim() && email.exitCode === 0 && email.stdout.trim()
      ? ["commit", "-m", message]
      : ["-c", "user.name=Agentic Engineering Harness", "-c", "user.email=aeh@users.noreply.github.com", "commit", "-m", message];
  return git(root, args);
}
