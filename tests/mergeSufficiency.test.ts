import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileResolvedOperationPolicy } from "../src/architecture/executionIdentity.js";
import { sha256Canonical } from "../src/core/digest.js";
import type { HarnessProjectConfig } from "../src/core/types.js";
import { bindIndependentPrReview, evaluateMergeEligibility, verifyIndependentPrReviewDigest } from "../src/delivery/prReview.js";
import { evaluateLiveMergeState } from "../src/delivery/merge.js";
import {
  claimControllerEpoch,
  currentControllerEpoch,
  loadOperation,
  saveOperation,
  bindResolvedOperationPolicy,
} from "../src/operations/state.js";
import type { CandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { executeGatedAction } from "../src/security/gatedAction.js";
import {
  configuredExternalEffects,
  requiredHumanActionAuthorizations,
} from "../src/security/actionPolicy.js";
import {
  controllerActorId,
  type ToolActionKindV1,
  type ToolActionRequestV1,
} from "../src/security/toolActionGate.js";
import type { ActionReconciliationResultV1 } from "../src/security/actionReconciliation.js";

/**
 * MERGE_AUTHORIZATION pins (FAM-MERGE decision (b)):
 * frozen-policy authorization (Owner-delegated `allowedActions` + `mergeMode`
 * + `finalizeOnAcceptance`) COMBINED WITH freshness-bound independent review
 * + live pre-merge revalidation constitutes merge authorization. Per-merge
 * human ACTION_AUTHORIZATION is intentionally not required.
 *
 * PRODUCT FINDING (documented, no behavior change): the literal
 * "RISK_GATED + high-risk proceeds" pin FAILS on current code by design —
 * `evaluateMergeEligibility` blocks `RISK_GATED` + `high` risk
 * ("RISK_GATED mode does not auto-merge high-risk changes", pinned below and
 * in tests/prReview.test.ts). High-risk autonomous merge proceeds only under
 * AUTO_MERGE with a qualified high-assurance review; that is the path pinned
 * in (a).
 */

function candidate(): CandidateRevisionV1 {
  return {
    operationId: "CHANGE-MERGE-SUFF",
    candidateId: "candidate-merge-suff",
    projectId: "test",
    taskId: "T-1",
    revision: 4,
    sourceDigest: "a".repeat(64),
    canonicalIdentity: "identity",
    identityDigest: "b".repeat(64),
  } as unknown as CandidateRevisionV1;
}

function pr() {
  return {
    repository: "owner/repo",
    number: 155,
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    baseRef: "main",
  };
}

function reviewFor(overrides: Record<string, unknown> = {}) {
  return bindIndependentPrReview({
    pr: pr(),
    candidate: candidate(),
    reviewerIdentity: "reviewer-2",
    reviewerProvider: "gpt-6-luna",
    reviewerRole: "Reviewer",
    readOnly: true,
    implementerIdentity: "implementer-1",
    policyDigest: "c".repeat(64),
    evidenceDigest: "d".repeat(64),
    assuranceTier: "HIGH",
    findings: [],
    disposition: "ACCEPTED",
    reviewedAt: "2026-10-09T00:00:00.000Z",
    ...overrides,
  } as never);
}

function mergeProject(): HarnessProjectConfig {
  return {
    version: 1,
    project: { name: "merge-sufficiency" },
    delivery: {
      github: {
        enabled: true,
        allowedActions: ["git.branch.create", "git.commit", "git.push", "github.pull-request.create", "github.pull-request.merge"],
        finalizeOnAcceptance: true,
        pullRequests: true,
        mergeMode: "AUTO_MERGE",
      },
      paseo: { enabled: false },
    },
  };
}

describe("MERGE_AUTHORIZATION sufficiency pins", () => {
  it("(a) AUTO_MERGE + high-risk + green CI + fresh high-assurance review + policy merge proceeds with NO per-merge human authorization", () => {
    const review = reviewFor();
    const result = evaluateMergeEligibility({
      review,
      expectedPr: pr(),
      expectedCandidate: candidate(),
      expectedPolicyDigest: "c".repeat(64),
      implementerIdentity: "implementer-1",
      ciGreen: true,
      baseFresh: true,
      authoritySatisfied: true,
      mergeAllowedByPolicy: true,
      mergeMode: "AUTO_MERGE",
      risk: "high",
      requireHighAssurance: true,
    });
    expect(result.eligible).toBe(true);
    expect(result.blockers).toEqual([]);
    // The documented path: push + PR-create carry human authorizations;
    // merge itself mints none even when the frozen policy allows it.
    const humanAuths = requiredHumanActionAuthorizations(configuredExternalEffects(mergeProject(), "change"));
    expect(configuredExternalEffects(mergeProject(), "change")).toContain("github.pull-request.merge");
    expect(humanAuths).not.toContainEqual({ kind: "ACTION_AUTHORIZATION", action: "github.pull-request.merge" });
    expect(humanAuths).toContainEqual({ kind: "ACTION_AUTHORIZATION", action: "git.push" });
    expect(humanAuths).toContainEqual({ kind: "ACTION_AUTHORIZATION", action: "github.pull-request.create" });
  });

  it("(a-boundary) RISK_GATED + high-risk never auto-merges even with a fresh ACCEPTED review", () => {
    const review = reviewFor();
    const result = evaluateMergeEligibility({
      review,
      expectedPr: pr(),
      expectedCandidate: candidate(),
      expectedPolicyDigest: "c".repeat(64),
      implementerIdentity: "implementer-1",
      ciGreen: true,
      baseFresh: true,
      authoritySatisfied: true,
      mergeAllowedByPolicy: true,
      mergeMode: "RISK_GATED",
      risk: "high",
      requireHighAssurance: true,
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join("\n")).toMatch("RISK_GATED");
  });

  it("(a-boundary) RISK_GATED + low-risk + green CI + fresh review proceeds with NO per-merge human authorization", () => {
    const review = reviewFor();
    const result = evaluateMergeEligibility({
      review,
      expectedPr: pr(),
      expectedCandidate: candidate(),
      expectedPolicyDigest: "c".repeat(64),
      implementerIdentity: "implementer-1",
      ciGreen: true,
      baseFresh: true,
      authoritySatisfied: true,
      mergeAllowedByPolicy: true,
      mergeMode: "RISK_GATED",
      risk: "low",
    });
    expect(result.eligible).toBe(true);
    const humanAuths = requiredHumanActionAuthorizations(configuredExternalEffects(mergeProject(), "change"));
    expect(humanAuths).not.toContainEqual({ kind: "ACTION_AUTHORIZATION", action: "github.pull-request.merge" });
  });

  it("(b) tampered review content (stale digest) fails closed with PR_REVIEW_STALE", () => {
    const review = reviewFor();
    const tampered = {
      ...review,
      findings: [{ id: "late", severity: "note", statement: "added after bind" }],
    } as typeof review;
    expect(() => verifyIndependentPrReviewDigest(tampered)).toThrow("PR_REVIEW_STALE");
    const result = evaluateMergeEligibility({
      review: tampered,
      expectedPr: pr(),
      expectedCandidate: candidate(),
      expectedPolicyDigest: "c".repeat(64),
      implementerIdentity: "implementer-1",
      ciGreen: true,
      baseFresh: true,
      authoritySatisfied: true,
      mergeAllowedByPolicy: true,
      mergeMode: "AUTO_MERGE",
      risk: "low",
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join("\n")).toMatch("PR_REVIEW_STALE");
  });

  it("(c) merge executor run twice under the same idempotency key returns ALREADY_COMPLETED with identical receipt digest", async () => {
    const context = await createMergeContext("RUN-MERGE-SUFF-IDEMPOTENT");
    const actionKey = "delivery:T-1:merge-pr-155";
    const request: ToolActionRequestV1 = {
      root: context.root,
      operationId: context.operationId,
      participantId: controllerActorId(context.operationId),
      candidate: context.candidate,
      actionKey,
      action: "github.pull-request.merge",
      payload: { repository: "owner/repo", number: 155 },
      authority: { kind: "controller-authority", operationId: context.operationId, controllerEpoch: context.epoch },
      now: new Date(NOW),
    };
    let executeCount = 0;
    const run = () =>
      executeGatedAction({
        root: context.root,
        request,
        execute: async () => {
          executeCount += 1;
          return { outcome: "SUCCEEDED" as const, evidence: { number: 155, headSha: "a".repeat(40) } };
        },
        reconcile: async (intent): Promise<ActionReconciliationResultV1> => {
          const evidence = { intentId: intent.intentId, action: intent.action, outcome: "SUCCEEDED", detail: "reconciled" };
          return {
            version: 1,
            intentId: intent.intentId,
            action: intent.action,
            outcome: "SUCCEEDED",
            detail: "reconciled",
            evidenceDigest: sha256Canonical(evidence),
            evidence,
            reconciledAt: NOW,
          };
        },
        now: new Date(NOW),
      });
    const first = await run();
    expect(first.status).toBe("EXECUTED");
    expect(first.receipt?.outcome).toBe("SUCCEEDED");
    const second = await run();
    expect(second.status).toBe("ALREADY_COMPLETED");
    expect(executeCount).toBe(1);
    expect(second.receipt?.receiptId).toBe(first.receipt?.receiptId);
    expect(second.receipt?.receiptDigest).toBe(first.receipt?.receiptDigest);
  });

  it("(d) rebase between review bind and merge blocks (review no longer covers the final head)", () => {
    const review = reviewFor();
    const rebasedHead = "f".repeat(40);
    const eligibility = evaluateMergeEligibility({
      review,
      expectedPr: { ...pr(), headSha: rebasedHead },
      expectedCandidate: candidate(),
      expectedPolicyDigest: "c".repeat(64),
      implementerIdentity: "implementer-1",
      ciGreen: true,
      baseFresh: true,
      authoritySatisfied: true,
      mergeAllowedByPolicy: true,
      mergeMode: "AUTO_MERGE",
      risk: "low",
    });
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.blockers.join("\n")).toMatch("exact final PR head");
    // Live pre-merge revalidation independently blocks the same rebase.
    const liveBlockers = evaluateLiveMergeState(review.pr, {
      state: "open",
      headSha: rebasedHead,
      baseSha: review.pr.baseSha,
      baseRef: review.pr.baseRef,
      mergeable: true,
      mergeableState: "clean",
      combinedStatus: "success",
    });
    expect(liveBlockers.join("\n")).toMatch("head");
  });
});

const NOW = "2026-01-01T00:00:00.000Z";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  delete process.env.AEH_OPERATION_ID;
  delete process.env.AEH_CONTROL_ROOT;
  delete process.env.AEH_OPERATION_STATE_REDIRECT;
  delete process.env.AEH_CONTROLLER_EPOCH;
  delete process.env.AEH_CONTROLLER_TOKEN;
});

async function createMergeContext(operationId: string): Promise<{ root: string; operationId: string; candidate: CandidateRevisionV1; epoch: number }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-merge-suff-"));
  roots.push(root);
  process.env.AEH_OPERATION_ID = operationId;
  process.env.AEH_CONTROL_ROOT = root;
  process.env.AEH_OPERATION_STATE_REDIRECT = "1";
  await saveOperation(root, { version: 1, id: operationId, kind: "run", status: "RUNNING", phase: "implementation", root, payload: { taskId: "T-1" }, createdAt: NOW, updatedAt: NOW });
  const candidateRecord = (await loadOperation(root, operationId)).candidateRevision!;
  const owned = await claimControllerEpoch(root, operationId, `controller:${operationId}`, { pid: process.pid });
  const policy = compileResolvedOperationPolicy({
    projectId: candidateRecord.projectId!,
    operationId,
    operationExecutionRevision: owned.operationExecutionRevision!,
    candidateRevision: candidateRecord.revision,
    candidateDigest: candidateRecord.identityDigest,
    controllerEpoch: currentControllerEpoch(owned),
    intent: "merge sufficiency pin",
    route: "DIRECT",
    minimumAssurance: "STANDARD",
    policyVersions: {},
    policyDigests: {},
    validationPolicy: {},
    reviewPolicy: {},
    deliveryPolicy: { allowedActions: ["git.branch.create", "git.commit", "github.pull-request.merge"] },
    knowledgePolicy: {},
    contextPolicy: {},
    allowedExternalEffects: ["github.pull-request.merge"] as ToolActionKindV1[],
    humanDecisionRequirements: [],
  });
  await bindResolvedOperationPolicy(root, operationId, policy);
  return { root, operationId, candidate: candidateRecord, epoch: currentControllerEpoch(owned) };
}
