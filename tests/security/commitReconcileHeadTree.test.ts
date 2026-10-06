import { describe, expect, it } from "vitest";
import { sha256Canonical } from "../../src/core/digest.js";
import { createCandidateRevisionV1 } from "../../src/operations/v2Contracts.js";
import { classifyToolActionImpact, type ActionIntentV1, type ToolActionKindV1 } from "../../src/security/toolActionGate.js";
import {
  reconcileToolAction,
  type ActionReconciliationDependenciesV1
} from "../../src/security/actionReconciliation.js";
import type { runExecutable } from "../../src/utils/process.js";

const FIXED_NOW = "2026-03-04T05:06:07.000Z";
const SUBJECT = "T-REPRO: Same Subject";
const STALE_SUBJECT = "T-OLD: unrelated";
const DIGEST_NEW = "b".repeat(64);
const DIGEST_OLD = "a".repeat(64);

function makeIntent(action: ToolActionKindV1, payload: unknown): ActionIntentV1 {
  return {
    version: 2,
    intentId: `action-intent:${action.replace(/[^a-z]+/g, "-")}-headtree`,
    actionKey: `delivery:${action}-headtree`,
    operationId: "RUN-REPRO-1",
    participantId: "participant:lead",
    role: "Lead/Director",
    candidate: createCandidateRevisionV1({ operationId: "RUN-REPRO-1", candidateId: "candidate:repro", projectId: "project-test", taskId: "T-REPRO", revision: 1, sourceDigest: "a".repeat(64), createdAt: FIXED_NOW }),
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

/** HEAD subject matches; history irrelevant for this case. */
function stubHeadSubjectMatch(): typeof runExecutable {
  return (async (_command: string, args: readonly string[]) => {
    const argv = args.join(" ");
    if (argv.includes("log") && argv.includes("--pretty=%s")) {
      return { exitCode: 0, stdout: `${SUBJECT}\n`, stderr: "", durationMs: 1 };
    }
    // Bounded history scan (post-fix): only HEAD exists with the subject.
    if (argv.includes("log")) {
      return { exitCode: 0, stdout: `abc123${"0".repeat(34)}\x1f${SUBJECT}\n`, stderr: "", durationMs: 1 };
    }
    return { exitCode: 1, stdout: "", stderr: "unexpected", durationMs: 1 };
  }) as unknown as typeof runExecutable;
}

describe("LUNA BLOCKER: worktree digest must not stand in for the committed tree", () => {
  it("HEAD subject matches + worktree matches but HEAD TREE differs -> must NOT be SUCCEEDED", async () => {
    const payload = { taskId: "T-REPRO", message: SUBJECT, contentDigest: DIGEST_NEW };
    const result = await reconcileToolAction("/tmp/aeh-repro-root", makeIntent("git.commit", payload), payload, {
      runExecutable: stubHeadSubjectMatch(),
      // The committed HEAD tree still holds stale content (differs from the
      // intent). Reconciliation compares against the COMMITTED tree, so this
      // must not succeed even if the live worktree holds the new content.
      ...({
        computeCommitTreeDigest: async (_root: string, _ref: string) => DIGEST_OLD
      } as unknown as ActionReconciliationDependenciesV1),
      now: new Date(FIXED_NOW)
    });
    expect(result.outcome).toBe("UNKNOWN");
    expect(result.detail).toBe("commit-content-mismatch");
  });

  it("stale HEAD subject with matching commit later in bounded history -> SUCCEEDED", async () => {
    const headSha = "1".repeat(40);
    const priorSha = "2".repeat(40);
    const stubHistory: typeof runExecutable = (async (_command: string, args: readonly string[]) => {
      const argv = args.join(" ");
      if (args.includes("-1")) {
        return { exitCode: 0, stdout: `${STALE_SUBJECT}\n`, stderr: "", durationMs: 1 };
      }
      if (argv.includes("log")) {
        return { exitCode: 0, stdout: `${headSha}\x1f${STALE_SUBJECT}\n${priorSha}\x1f${SUBJECT}\n`, stderr: "", durationMs: 1 };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected", durationMs: 1 };
    }) as unknown as typeof runExecutable;
    const payload = { taskId: "T-REPRO", message: SUBJECT, contentDigest: DIGEST_NEW };
    const result = await reconcileToolAction("/tmp/aeh-repro-root", makeIntent("git.commit", payload), payload, {
      runExecutable: stubHistory,
      ...({
        computeCommitTreeDigest: async (_root: string, ref: string) => (ref === priorSha ? DIGEST_NEW : DIGEST_OLD)
      } as unknown as ActionReconciliationDependenciesV1),
      now: new Date(FIXED_NOW)
    });
    expect(result.outcome).toBe("SUCCEEDED");
    expect(result.detail).toBe("commit-content-compared-history");
  });

  it("HEAD subject mismatch with no matching subject in history -> FAILED", async () => {
    const headSha = "1".repeat(40);
    const otherSha = "3".repeat(40);
    const stubAbsent: typeof runExecutable = (async (_command: string, args: readonly string[]) => {
      const argv = args.join(" ");
      if (args.includes("-1")) {
        return { exitCode: 0, stdout: `${STALE_SUBJECT}\n`, stderr: "", durationMs: 1 };
      }
      if (argv.includes("log")) {
        return { exitCode: 0, stdout: `${headSha}\x1f${STALE_SUBJECT}\n${otherSha}\x1fT-OTHER: different\n`, stderr: "", durationMs: 1 };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected", durationMs: 1 };
    }) as unknown as typeof runExecutable;
    const payload = { taskId: "T-REPRO", message: SUBJECT, contentDigest: DIGEST_NEW };
    const result = await reconcileToolAction("/tmp/aeh-repro-root", makeIntent("git.commit", payload), payload, {
      runExecutable: stubAbsent,
      ...({
        computeCommitTreeDigest: async (_root: string, _ref: string) => DIGEST_NEW
      } as unknown as ActionReconciliationDependenciesV1),
      now: new Date(FIXED_NOW)
    });
    expect(result.outcome).toBe("FAILED");
    expect(result.detail).toBe("commit-subject-mismatch");
  });

  it("HEAD subject mismatch with subject present but tree differs -> UNKNOWN", async () => {
    const headSha = "1".repeat(40);
    const priorSha = "2".repeat(40);
    const stubPresentMismatch: typeof runExecutable = (async (_command: string, args: readonly string[]) => {
      const argv = args.join(" ");
      if (args.includes("-1")) {
        return { exitCode: 0, stdout: `${STALE_SUBJECT}\n`, stderr: "", durationMs: 1 };
      }
      if (argv.includes("log")) {
        return { exitCode: 0, stdout: `${headSha}\x1f${STALE_SUBJECT}\n${priorSha}\x1f${SUBJECT}\n`, stderr: "", durationMs: 1 };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected", durationMs: 1 };
    }) as unknown as typeof runExecutable;
    const payload = { taskId: "T-REPRO", message: SUBJECT, contentDigest: DIGEST_NEW };
    const result = await reconcileToolAction("/tmp/aeh-repro-root", makeIntent("git.commit", payload), payload, {
      runExecutable: stubPresentMismatch,
      ...({
        computeCommitTreeDigest: async (_root: string, _ref: string) => DIGEST_OLD
      } as unknown as ActionReconciliationDependenciesV1),
      now: new Date(FIXED_NOW)
    });
    expect(result.outcome).toBe("UNKNOWN");
    expect(result.detail).toBe("commit-content-mismatch");
  });
});
