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
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function makeIntent(action: ToolActionKindV1, payload: unknown): ActionIntentV1 {
  return {
    version: 2,
    intentId: `action-intent:${action.replace(/[^a-z]+/g, "-")}-repro`,
    actionKey: `delivery:${action}-repro`,
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

/** Stub: HEAD carries the retried subject, but committed content is stale (digest A, intent expects B). */
function stubSubjectMatch(): typeof runExecutable {
  return (async (_command: string, _args: readonly string[]) => ({
    exitCode: 0,
    stdout: `${SUBJECT}\n`,
    stderr: "",
    durationMs: 1
  })) as unknown as typeof runExecutable;
}

function withDigest(digest: string): ActionReconciliationDependenciesV1 {
  return {
    // `computeCommitTreeDigest` is the HEAD-tree injection port: reconciliation
    // compares contentDigest against the COMMITTED tree, never the worktree.
    ...( { computeCommitTreeDigest: async (_root: string, _ref: string) => digest } as unknown as ActionReconciliationDependenciesV1)
  };
}

describe("K-NEW-3 reproducer: same-subject/different-content commit must not reconcile SUCCEEDED", () => {
  it("message-only payload with matching subject is at most UNKNOWN, never SUCCEEDED", async () => {
    const payload = { taskId: "T-REPRO", message: SUBJECT };
    const result = await reconcileToolAction("/tmp/aeh-repro-root", makeIntent("git.commit", payload), payload, {
      runExecutable: stubSubjectMatch(),
      now: new Date(FIXED_NOW)
    });
    expect(["FAILED", "UNKNOWN"]).toContain(result.outcome);
    expect(result.outcome).not.toBe("SUCCEEDED");
  });

  it("matching subject with non-matching contentDigest is at most UNKNOWN, never SUCCEEDED", async () => {
    const payload = { taskId: "T-REPRO", message: SUBJECT, contentDigest: DIGEST_B };
    const result = await reconcileToolAction("/tmp/aeh-repro-root", makeIntent("git.commit", payload), payload, {
      runExecutable: stubSubjectMatch(),
      ...withDigest(DIGEST_A),
      now: new Date(FIXED_NOW)
    });
    expect(["FAILED", "UNKNOWN"]).toContain(result.outcome);
    expect(result.outcome).not.toBe("SUCCEEDED");
  });

  it("matching subject with matching contentDigest reconciles SUCCEEDED", async () => {
    const payload = { taskId: "T-REPRO", message: SUBJECT, contentDigest: DIGEST_A };
    const result = await reconcileToolAction("/tmp/aeh-repro-root", makeIntent("git.commit", payload), payload, {
      runExecutable: stubSubjectMatch(),
      ...withDigest(DIGEST_A),
      now: new Date(FIXED_NOW)
    });
    expect(result.outcome).toBe("SUCCEEDED");
  });
});
