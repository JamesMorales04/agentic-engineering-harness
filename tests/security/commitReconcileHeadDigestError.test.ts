import { describe, expect, it } from "vitest";
import { sha256Canonical } from "../../src/core/digest.js";
import { createCandidateRevisionV1 } from "../../src/operations/v2Contracts.js";
import { classifyToolActionImpact, type ActionIntentV1, type ToolActionKindV1 } from "../../src/security/toolActionGate.js";
import { reconcileToolAction } from "../../src/security/actionReconciliation.js";
import type { runExecutable } from "../../src/utils/process.js";

const FIXED_NOW = "2026-03-04T05:06:07.000Z";
const SUBJECT = "T-HEAD-ERR: Same Subject";
const STALE_SUBJECT = "T-OLD: unrelated";
const DIGEST_NEW = "b".repeat(64);
const DIGEST_OLD = "a".repeat(64);

function makeIntent(action: ToolActionKindV1, payload: unknown): ActionIntentV1 {
  return {
    version: 2,
    intentId: `action-intent:${action.replace(/[^a-z]+/g, "-")}-headerr`,
    actionKey: `delivery:${action}-headerr`,
    operationId: "RUN-HEADERR-1",
    participantId: "participant:lead",
    role: "Lead/Director",
    candidate: createCandidateRevisionV1({ operationId: "RUN-HEADERR-1", candidateId: "candidate:headerr", projectId: "project-test", taskId: "T-HEAD-ERR", revision: 1, sourceDigest: "a".repeat(64), createdAt: FIXED_NOW }),
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

function stubHistory(headSha: string, priorSha: string): typeof runExecutable {
  return (async (_command: string, args: readonly string[]) => {
    const argv = args.join(" ");
    if (args.includes("-1")) {
      return { exitCode: 0, stdout: `${STALE_SUBJECT}\n`, stderr: "", durationMs: 1 };
    }
    if (argv.includes("log")) {
      return { exitCode: 0, stdout: `${headSha}\x1f${STALE_SUBJECT}\n${priorSha}\x1f${SUBJECT}\n`, stderr: "", durationMs: 1 };
    }
    return { exitCode: 1, stdout: "", stderr: "unexpected", durationMs: 1 };
  }) as unknown as typeof runExecutable;
}

describe("LUNA BLOCKER (7th review): unverifiable HEAD must never be bypassed by history", () => {
  it("HEAD digest ERROR + history match -> UNKNOWN (never SUCCEEDED via stale history)", async () => {
    const headSha = "1".repeat(40);
    const priorSha = "2".repeat(40);
    const payload = { taskId: "T-HEAD-ERR", message: SUBJECT, contentDigest: DIGEST_NEW };
    const result = await reconcileToolAction("/tmp/aeh-headerr-root", makeIntent("git.commit", payload), payload, {
      runExecutable: stubHistory(headSha, priorSha),
      computeCommitTreeDigest: async (_root: string, ref: string) => {
        if (ref === "HEAD") throw new Error("COMMIT_BLOB_TOO_LARGE: committed blob 'big.bin' at HEAD is 100 bytes (cap 1 bytes).");
        if (ref === priorSha) return DIGEST_NEW;
        return DIGEST_OLD;
      },
      now: new Date(FIXED_NOW)
    });
    expect(result.outcome).toBe("UNKNOWN");
    expect(result.detail).toBe("commit-content-unreadable");
    expect(result.evidence["scannedCommits"]).toBe(2);
  });

  it("HEAD digest MISMATCH (computed, differs) + history match -> still SUCCEEDED", async () => {
    const headSha = "1".repeat(40);
    const priorSha = "2".repeat(40);
    const payload = { taskId: "T-HEAD-ERR", message: SUBJECT, contentDigest: DIGEST_NEW };
    const result = await reconcileToolAction("/tmp/aeh-headerr-root", makeIntent("git.commit", payload), payload, {
      runExecutable: stubHistory(headSha, priorSha),
      computeCommitTreeDigest: async (_root: string, ref: string) => (ref === priorSha ? DIGEST_NEW : DIGEST_OLD),
      now: new Date(FIXED_NOW)
    });
    expect(result.outcome).toBe("SUCCEEDED");
    expect(result.detail).toBe("commit-content-compared-history");
  });
});
