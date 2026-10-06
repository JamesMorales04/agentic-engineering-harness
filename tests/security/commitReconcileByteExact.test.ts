import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Canonical } from "../../src/core/digest.js";
import { computeCommitTreeDigest, computeWorktreeDigest } from "../../src/core/git.js";
import { createCandidateRevisionV1 } from "../../src/operations/v2Contracts.js";
import { reconcileToolAction } from "../../src/security/actionReconciliation.js";
import { classifyToolActionImpact, type ActionIntentV1, type ToolActionKindV1 } from "../../src/security/toolActionGate.js";
import type { runExecutable } from "../../src/utils/process.js";

const FIXED_NOW = "2026-03-04T05:06:07.000Z";
const SUBJECT = "T-BIN: binary content commit";
const STALE_SUBJECT = "T-OLD: unrelated";
// Committed blob bytes that are NOT valid UTF-8. Lossy UTF-8 decode/re-encode
// maps 0xFF -> U+FFFD (EF BF BD), so the lossy path hashes different bytes
// than the raw blob and collides with a digest over the replacement sequence.
const RAW_BLOB = Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0xff]);
const FILE_NAME = "bin.dat";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function git(root: string, args: readonly string[]): void {
  execFileSync("git", [...args], { cwd: root, stdio: "ignore" });
}

async function initBinaryRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-bin-digest-"));
  roots.push(root);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "AEH Test"]);
  git(root, ["config", "user.email", "aeh@example.invalid"]);
  await fs.writeFile(path.join(root, FILE_NAME), RAW_BLOB);
  git(root, ["add", FILE_NAME]);
  git(root, ["commit", "-m", SUBJECT]);
  return root;
}

/** Canonical single-entry combiner over caller-supplied bytes (mirrors git.ts). */
function combinerDigest(fileBytes: Buffer): string {
  const hash = crypto.createHash("sha256");
  hash.update(`path\0${FILE_NAME}\0`);
  hash.update(fileBytes);
  return hash.digest("hex");
}

function makeIntent(action: ToolActionKindV1, payload: unknown): ActionIntentV1 {
  return {
    version: 2,
    intentId: `action-intent:${action.replace(/[^a-z]+/g, "-")}-binexact`,
    actionKey: `delivery:${action}-binexact`,
    operationId: "RUN-BIN-1",
    participantId: "participant:lead",
    role: "Lead/Director",
    candidate: createCandidateRevisionV1({ operationId: "RUN-BIN-1", candidateId: "candidate:bin", projectId: "project-test", taskId: "T-BIN", revision: 1, sourceDigest: "a".repeat(64), createdAt: FIXED_NOW }),
    operationExecutionRevision: 1,
    policyDigest: "d".repeat(64),
    action,
    impact: classifyToolActionImpact(action),
    controllerEpoch: 1,
    payloadDigest: sha256Canonical(payload),
    authorityBindingDigest: "b".repeat(64),
    requestDigest: "c".repeat(64),
    createdAt: FIXED_NOW
  };
}

describe("LUNA BLOCKER (a): commit-tree digest must hash raw blob bytes", () => {
  it("same non-UTF8 blob hashes identically via worktree-read and git-show-read, and differs from the lossy-decoded hash", async () => {
    const root = await initBinaryRepo();
    const worktreeDigest = await computeWorktreeDigest(root);
    const commitDigest = await computeCommitTreeDigest(root, "HEAD");
    // Byte-exactness: the committed blob is the same bytes as the worktree file.
    expect(commitDigest).toBe(worktreeDigest);
    // The lossy UTF-8 decode/re-encode round-trip must NOT be what is hashed.
    const lossyDigest = combinerDigest(Buffer.from(RAW_BLOB.toString("utf8"), "utf8"));
    expect(lossyDigest).not.toBe(worktreeDigest);
    expect(commitDigest).not.toBe(lossyDigest);
  });

  it("a contentDigest crafted over the lossy-normalized bytes must never reconcile SUCCEEDED", async () => {
    const root = await initBinaryRepo();
    // Attacker-observable collision: bytes that Unicode-normalize identically
    // through the lossy path (0xFF -> U+FFFD). Pre-fix this digest equals the
    // commit-tree digest and falsely reconciles SUCCEEDED.
    const lossyDigest = combinerDigest(Buffer.from(RAW_BLOB.toString("utf8"), "utf8"));
    const payload = { taskId: "T-BIN", message: SUBJECT, contentDigest: lossyDigest };
    const result = await reconcileToolAction(root, makeIntent("git.commit", payload), payload, {
      now: new Date(FIXED_NOW)
    });
    expect(result.outcome).not.toBe("SUCCEEDED");
    expect(result.outcome).toBe("UNKNOWN");
    expect(result.detail).toBe("commit-content-mismatch");
  });
});

describe("LUNA BLOCKER (c): commit-tree digest must hash blob bytes with no trailing-newline strip", () => {
  const LINK_NAME = "link";
  // A trailing-LF symlink target is legal bytes on Linux. `git show
  // <ref>:<path>` returns these blob bytes RAW with no framing newline, so
  // the digest path must hash them exactly as returned.
  const TARGET_NL = "target\n";
  const TARGET_BARE = "target";
  const NL_SUBJECT = "T-NL: symlink target with trailing newline";

  async function initNewlineSymlinkRepo(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-nl-digest-"));
    roots.push(root);
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.name", "AEH Test"]);
    git(root, ["config", "user.email", "aeh@example.invalid"]);
    await fs.symlink(TARGET_NL, path.join(root, LINK_NAME));
    git(root, ["add", LINK_NAME]);
    git(root, ["commit", "-m", NL_SUBJECT]);
    return root;
  }

  /** Canonical single-entry symlink combiner over caller-supplied target bytes (mirrors git.ts). */
  function symlinkCombinerDigest(target: string): string {
    const hash = crypto.createHash("sha256");
    hash.update(`path\0${LINK_NAME}\0`);
    hash.update(`symlink\0${target}\0`);
    return hash.digest("hex");
  }

  it("committed `target\\n` symlink target digests differently from bare `target` (no normalization)", async () => {
    const root = await initNewlineSymlinkRepo();
    const commitDigest = await computeCommitTreeDigest(root, "HEAD");
    // Byte-exactness: the committed blob is the raw `target\n` bytes.
    expect(commitDigest).toBe(symlinkCombinerDigest(TARGET_NL));
    // No normalization: must NOT equal the digest over stripped `target`.
    expect(commitDigest).not.toBe(symlinkCombinerDigest(TARGET_BARE));
    // Both paths hash identical inputs identically.
    expect(await computeWorktreeDigest(root)).toBe(commitDigest);
  });

  it("a contentDigest over stripped `target` must never reconcile SUCCEEDED against committed `target\\n`", async () => {
    const root = await initNewlineSymlinkRepo();
    const payload = { taskId: "T-NL", message: NL_SUBJECT, contentDigest: symlinkCombinerDigest(TARGET_BARE) };
    const result = await reconcileToolAction(root, makeIntent("git.commit", payload), payload, {
      now: new Date(FIXED_NOW)
    });
    expect(result.outcome).not.toBe("SUCCEEDED");
    expect(result.outcome).toBe("UNKNOWN");
    expect(result.detail).toBe("commit-content-mismatch");
  });
});

describe("LUNA BLOCKER (d): symlink targets hash by raw bytes, not UTF-8 strings", () => {
  const LINK_NAME = "link";
  // Two DISTINCT invalid-UTF-8 byte sequences that decode to the SAME
  // replacement string via toString("utf8"): both become U+FFFD. Pre-fix both
  // digest paths decoded to strings before hashing, so these collided to the
  // same digest (false match / false SUCCEEDED).
  const TARGET_FF = Buffer.from([0xff]);
  const TARGET_FE = Buffer.from([0xfe]);
  const SYM_SUBJECT = "T-SYM: invalid-UTF8 symlink target";
  const VALID_TARGET = "valid-target";

  async function initSymlinkRepo(target: Buffer, subject = SYM_SUBJECT): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-sym-digest-"));
    roots.push(root);
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.name", "AEH Test"]);
    git(root, ["config", "user.email", "aeh@example.invalid"]);
    await fs.symlink(target, path.join(root, LINK_NAME));
    git(root, ["add", LINK_NAME]);
    git(root, ["commit", "-m", subject]);
    return root;
  }

  /** Canonical single-entry symlink combiner over raw target BYTES (mirrors git.ts). */
  function symlinkCombinerDigestBytes(target: Buffer): string {
    const hash = crypto.createHash("sha256");
    hash.update(`path\0${LINK_NAME}\0`);
    hash.update("symlink\0");
    hash.update(target);
    hash.update("\0");
    return hash.digest("hex");
  }

  it("decodes to the same replacement string (precondition: string path collides)", async () => {
    expect(TARGET_FF.toString("utf8")).toBe(TARGET_FE.toString("utf8"));
    expect(TARGET_FF.toString("utf8")).toBe("\uFFFD");
  });

  it("same invalid bytes agree worktree==commit (byte-exact positive)", async () => {
    const root = await initSymlinkRepo(TARGET_FF);
    const commitDigest = await computeCommitTreeDigest(root, "HEAD");
    expect(commitDigest).toBe(symlinkCombinerDigestBytes(TARGET_FF));
    expect(await computeWorktreeDigest(root)).toBe(commitDigest);
  });

  it("distinct invalid bytes decoding to the same string digest distinctly (no false match)", async () => {
    const root = await initSymlinkRepo(TARGET_FF);
    const commitDigestFF = await computeCommitTreeDigest(root, "HEAD");
    // Swap the worktree link to the colliding 0xFE target without committing.
    await fs.rm(path.join(root, LINK_NAME));
    await fs.symlink(TARGET_FE, path.join(root, LINK_NAME));
    const worktreeDigestFE = await computeWorktreeDigest(root);
    expect(worktreeDigestFE).toBe(symlinkCombinerDigestBytes(TARGET_FE));
    // Post-fix the digests MUST differ; pre-fix both were the FFFD-string digest.
    expect(worktreeDigestFE).not.toBe(commitDigestFF);
  });

  it("a contentDigest over the colliding 0xFE target must never reconcile SUCCEEDED against committed 0xFF", async () => {
    const root = await initSymlinkRepo(TARGET_FF);
    const payload = { taskId: "T-SYM", message: SYM_SUBJECT, contentDigest: symlinkCombinerDigestBytes(TARGET_FE) };
    const result = await reconcileToolAction(root, makeIntent("git.commit", payload), payload, {
      now: new Date(FIXED_NOW)
    });
    expect(result.outcome).not.toBe("SUCCEEDED");
    expect(result.outcome).toBe("UNKNOWN");
    expect(result.detail).toBe("commit-content-mismatch");
  });

  it("valid-UTF8 targets still agree worktree==commit (positive control)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-sym-valid-"));
    roots.push(root);
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.name", "AEH Test"]);
    git(root, ["config", "user.email", "aeh@example.invalid"]);
    await fs.symlink(VALID_TARGET, path.join(root, LINK_NAME));
    git(root, ["add", LINK_NAME]);
    git(root, ["commit", "-m", SYM_SUBJECT]);
    const commitDigest = await computeCommitTreeDigest(root, "HEAD");
    expect(commitDigest).toBe(symlinkCombinerDigestBytes(Buffer.from(VALID_TARGET, "utf8")));
    expect(await computeWorktreeDigest(root)).toBe(commitDigest);
  });
});

describe("LUNA BLOCKER (b): unreadable-candidate outcomes carry scan observability", () => {
  function stubHistory(): typeof runExecutable {
    return (async (_command: string, args: readonly string[]) => {
      const argv = args.join(" ");
      if (args.includes("-1")) {
        return { exitCode: 0, stdout: `${STALE_SUBJECT}\n`, stderr: "", durationMs: 1 };
      }
      if (argv.includes("log")) {
        return {
          exitCode: 0,
          stdout: `${"1".repeat(40)}\x1f${STALE_SUBJECT}\n${"2".repeat(40)}\x1f${SUBJECT}\n`,
          stderr: "",
          durationMs: 1
        };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected", durationMs: 1 };
    }) as unknown as typeof runExecutable;
  }

  it("commit-content-unreadable (throw) carries scannedCommits and scanLimit", async () => {
    const payload = { taskId: "T-BIN", message: SUBJECT, contentDigest: "b".repeat(64) };
    const result = await reconcileToolAction("/tmp/aeh-repro-root", makeIntent("git.commit", payload), payload, {
      runExecutable: stubHistory(),
      computeCommitTreeDigest: async () => { throw new Error("blob unavailable"); },
      now: new Date(FIXED_NOW)
    });
    expect(result.outcome).toBe("UNKNOWN");
    expect(result.detail).toBe("commit-content-unreadable");
    expect(result.evidence["scannedCommits"]).toBe(2);
    expect(result.evidence["scanLimit"]).toBe(20);
  });

  it("commit-content-unreadable (non-hex digest) carries scannedCommits and scanLimit", async () => {
    const payload = { taskId: "T-BIN", message: SUBJECT, contentDigest: "b".repeat(64) };
    const result = await reconcileToolAction("/tmp/aeh-repro-root", makeIntent("git.commit", payload), payload, {
      runExecutable: stubHistory(),
      computeCommitTreeDigest: async () => "not-a-hex-digest",
      now: new Date(FIXED_NOW)
    });
    expect(result.outcome).toBe("UNKNOWN");
    expect(result.detail).toBe("commit-content-unreadable");
    expect(result.evidence["scannedCommits"]).toBe(2);
    expect(result.evidence["scanLimit"]).toBe(20);
  });
});
