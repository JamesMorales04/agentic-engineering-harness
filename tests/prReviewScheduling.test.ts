import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentExecutionSelection } from "../src/agents/types.js";
import type { ReviewerOutput } from "../src/agents/outputContracts.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";
import type { CandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { runExecutable } from "../src/utils/process.js";
import type { DeliveryFinalizationResult } from "../src/delivery/finalize.js";
import { verifyIndependentPrReviewDigest } from "../src/delivery/prReview.js";
import {
  deriveFinalPrIdentity,
  isMergePendingBlockedDelivery,
  mapPrReviewerVerdict,
  scheduleIndependentPrReviewAndMerge,
  selectIndependentPrReviewer,
  type FinalizeWithReviewRequest,
  type PrReviewScheduleRequest,
  type PrReviewTurnRequest,
  type PrReviewTurnResult,
} from "../src/delivery/prReviewScheduling.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function candidate(): CandidateRevisionV1 {
  return {
    operationId: "RUN-SCHEDULE-1",
    candidateId: "candidate:schedule",
    projectId: "test",
    taskId: "GH-5",
    revision: 2,
    sourceDigest: "a".repeat(64),
    canonicalIdentity: "identity",
    identityDigest: "b".repeat(64),
  } as unknown as CandidateRevisionV1;
}

function blocked(prNumber = 9, commitSha = "a".repeat(40)): DeliveryFinalizationResult {
  return {
    status: "BLOCKED_EXTERNAL",
    humanRequired: false,
    committed: true,
    commitSha,
    pushed: true,
    pullRequest: { number: prNumber, url: "https://github.com/owner/repo/pull/9", draft: true },
    candidate: candidate(),
    message: `Pull request #${prNumber} created; autonomous merge (AUTO_MERGE) requires an independent ACCEPTED PR review.`,
  };
}

function reviewerSelection(overrides: Record<string, unknown> = {}): AgentExecutionSelection {
  return {
    logicalAgent: "reviewer-pr-1",
    role: "Reviewer",
    modelId: "muse-spark",
    runtimeName: "opencode",
    transport: "paseo",
    permissions: { write: "deny" },
    outputContract: "reviewer",
    ...overrides,
  } as unknown as AgentExecutionSelection;
}

function acceptedOutput(): ReviewerOutput {
  return {
    verdict: "PASS",
    findings: [],
    finalizationSafety: "SAFE",
    followUp: [],
  };
}

function repairOutput(): ReviewerOutput {
  return {
    verdict: "FAIL",
    findings: [
      {
        id: "SEC-1",
        severity: "high",
        category: "security",
        location: { file: "src/auth.ts" },
        evidence: "auth bypass on the final diff",
        impact: "unauthorized access",
        recommendedFix: "re-check credentials",
        requiredCompetencies: ["security"],
        reviewDimensions: [],
      },
    ],
    finalizationSafety: "BLOCKED",
    followUp: [],
  };
}

const POLICY_DIGEST = "c".repeat(64);
const EVIDENCE_DIGEST = "d".repeat(64);

function request(overrides: Partial<PrReviewScheduleRequest> = {}): PrReviewScheduleRequest {
  return {
    root: "/tmp/aeh-scheduler-unused",
    config: { version: 1, project: { name: "scheduler-test" } } as HarnessProjectConfig,
    contract: { version: 1, task: { id: "GH-5", title: "Update README" } } as TaskContract,
    candidate: candidate(),
    blocked: blocked(),
    evidenceDigest: EVIDENCE_DIGEST,
    implementerIdentity: "implementer-1",
    reviewerSelections: { "reviewer-pr-1": reviewerSelection() },
    // Explicit low risk: the scheduler defaults to high (fail-closed, mirroring
    // merge.ts), which would require a qualified high-assurance reviewer.
    risk: "low",
    ...overrides,
  };
}

function stubAuthority() {
  return { resolveAuthority: async () => ({ operationId: "RUN-SCHEDULE-1", policyDigest: POLICY_DIGEST }) };
}

describe("prReviewScheduling delivery seam", () => {
  it("review-accepted binds the exact PR identity and attempts the merge", async () => {
    const turns: PrReviewTurnRequest[] = [];
    const finalized: FinalizeWithReviewRequest[] = [];
    const outcome = await scheduleIndependentPrReviewAndMerge(request(), {
      ...stubAuthority(),
      deriveIdentity: async (input) => {
        expect(input.commitSha).toBe("a".repeat(40));
        expect(input.prNumber).toBe(9);
        return { repository: "owner/repo", number: 9, headSha: input.commitSha, baseSha: "b".repeat(40), baseRef: "main" };
      },
      executeReviewTurn: async (turn) => {
        turns.push(turn);
        expect(turn.reviewerSelection.logicalAgent).not.toBe("implementer-1");
        expect(turn.reviewerSelection.permissions.write).toBe("deny");
        return { ok: true, reviewerIdentity: "reviewer-pr-1", reviewerProvider: "muse-spark", output: acceptedOutput() };
      },
      finalizeWithReview: async (input) => {
        finalized.push(input);
        expect(input.round).toBe(1);
        expect(input.implementerIdentity).toBe("implementer-1");
        verifyIndependentPrReviewDigest(input.review);
        expect(input.review.disposition).toBe("ACCEPTED");
        expect(input.review.pr).toMatchObject({ repository: "owner/repo", number: 9, headSha: "a".repeat(40) });
        expect(input.review.reviewerIdentity).toBe("reviewer-pr-1");
        expect(input.review.policyDigest).toBe(POLICY_DIGEST);
        expect(input.review.evidenceDigest).toBe(EVIDENCE_DIGEST);
        expect(input.review.candidate.identityDigest).toBe("b".repeat(64));
        return { status: "FINALIZED", humanRequired: false, committed: true, commitSha: "a".repeat(40), pushed: true, pullRequest: { number: 9, url: "https://github.com/owner/repo/pull/9", draft: true }, candidate: candidate(), message: "merged" };
      },
    });
    expect(turns).toHaveLength(1);
    expect(finalized).toHaveLength(1);
    expect(outcome.delivery.status).toBe("FINALIZED");
    expect(outcome.roundsAttempted).toBe(1);
    expect(outcome.review?.disposition).toBe("ACCEPTED");
  });

  it("reviewer failure propagates as BLOCKED without a merge attempt", async () => {
    const finalized: FinalizeWithReviewRequest[] = [];
    const outcome = await scheduleIndependentPrReviewAndMerge(request(), {
      ...stubAuthority(),
      deriveIdentity: async (input) => ({ repository: "owner/repo", number: 9, headSha: input.commitSha, baseSha: "b".repeat(40), baseRef: "main" }),
      executeReviewTurn: async () => ({ ok: false, kind: "RUNTIME", detail: "provider stopped", exitCode: 1 }),
      finalizeWithReview: async (input) => {
        finalized.push(input);
        throw new Error("must not merge without a genuine review");
      },
    });
    expect(finalized).toHaveLength(0);
    expect(outcome.delivery.status).toBe("BLOCKED_EXTERNAL");
    expect(outcome.delivery.message).toMatch(/review failed/i);
    expect(outcome.delivery.pullRequest?.number).toBe(9);
    expect(outcome.review).toBeUndefined();
    expect(outcome.roundsAttempted).toBe(1);
  });

  it("repair-required retries boundedly then stays BLOCKED", async () => {
    let turns = 0;
    let merges = 0;
    const outcome = await scheduleIndependentPrReviewAndMerge(request(), {
      ...stubAuthority(),
      deriveIdentity: async (input) => ({ repository: "owner/repo", number: 9, headSha: input.commitSha, baseSha: "b".repeat(40), baseRef: "main" }),
      executeReviewTurn: async (): Promise<PrReviewTurnResult> => {
        turns += 1;
        return { ok: true, reviewerIdentity: "reviewer-pr-1", reviewerProvider: "muse-spark", output: repairOutput() };
      },
      finalizeWithReview: async () => {
        merges += 1;
        throw new Error("must not merge REPAIR_REQUIRED");
      },
    });
    expect(turns).toBe(3);
    expect(merges).toBe(0);
    expect(outcome.delivery.status).toBe("BLOCKED_EXTERNAL");
    expect(outcome.delivery.message).toMatch(/repair/i);
    expect(outcome.review?.disposition).toBe("REPAIR_REQUIRED");
    expect(outcome.roundsAttempted).toBe(3);
  });

  it("round exhaustion stays BLOCKED without launching a reviewer", async () => {
    let turns = 0;
    const outcome = await scheduleIndependentPrReviewAndMerge(request({ startRound: 4 }), {
      ...stubAuthority(),
      executeReviewTurn: async () => {
        turns += 1;
        return { ok: true, reviewerIdentity: "reviewer-pr-1", reviewerProvider: "muse-spark", output: acceptedOutput() };
      },
    });
    expect(turns).toBe(0);
    expect(outcome.delivery.status).toBe("BLOCKED_EXTERNAL");
    expect(outcome.delivery.message).toMatch(/ROUNDS_EXHAUSTED/);
    expect(outcome.roundsAttempted).toBe(0);
  });

  it("merge denial converts to BLOCKED while system failures rethrow", async () => {
    const denied = await scheduleIndependentPrReviewAndMerge(request(), {
      ...stubAuthority(),
      deriveIdentity: async (input) => ({ repository: "owner/repo", number: 9, headSha: input.commitSha, baseSha: "b".repeat(40), baseRef: "main" }),
      executeReviewTurn: async () => ({ ok: true, reviewerIdentity: "reviewer-pr-1", reviewerProvider: "muse-spark", output: acceptedOutput() }),
      finalizeWithReview: async () => {
        throw new Error("MERGE_BLOCKED: required GitHub checks are not green (combined state=failure).");
      },
    });
    expect(denied.delivery.status).toBe("BLOCKED_EXTERNAL");
    expect(denied.delivery.message).toMatch(/MERGE_BLOCKED/);
    expect(denied.review?.disposition).toBe("ACCEPTED");

    await expect(
      scheduleIndependentPrReviewAndMerge(request(), {
        ...stubAuthority(),
        deriveIdentity: async (input) => ({ repository: "owner/repo", number: 9, headSha: input.commitSha, baseSha: "b".repeat(40), baseRef: "main" }),
        executeReviewTurn: async () => ({ ok: true, reviewerIdentity: "reviewer-pr-1", reviewerProvider: "muse-spark", output: acceptedOutput() }),
        finalizeWithReview: async () => {
          throw new Error("SYSTEM_FAILURE: git rev-parse HEAD failed");
        },
      }),
    ).rejects.toThrow("SYSTEM_FAILURE");
  });

  it("high risk without a qualified reviewer stays BLOCKED (fail-closed default)", async () => {
    let turns = 0;
    const outcome = await scheduleIndependentPrReviewAndMerge(request({ risk: undefined }), {
      ...stubAuthority(),
      deriveIdentity: async (input) => ({ repository: "owner/repo", number: 9, headSha: input.commitSha, baseSha: "b".repeat(40), baseRef: "main" }),
      executeReviewTurn: async () => {
        turns += 1;
        return { ok: true, reviewerIdentity: "reviewer-pr-1", reviewerProvider: "muse-spark", output: acceptedOutput() };
      },
    });
    expect(turns).toBe(0);
    expect(outcome.delivery.status).toBe("BLOCKED_EXTERNAL");
    expect(outcome.delivery.message).toMatch(/high-assurance/);
    expect(outcome.roundsAttempted).toBe(0);
  });

  it("refuses scheduling without a genuine evidence digest or implementer identity", async () => {
    const noEvidence = await scheduleIndependentPrReviewAndMerge(request({ evidenceDigest: "placeholder" }), {
      ...stubAuthority(),
      executeReviewTurn: async () => {
        throw new Error("must not launch without genuine evidence");
      },
    });
    expect(noEvidence.delivery.status).toBe("BLOCKED_EXTERNAL");
    expect(noEvidence.roundsAttempted).toBe(0);

    const noImplementer = await scheduleIndependentPrReviewAndMerge(request({ implementerIdentity: "  " }), {
      ...stubAuthority(),
      executeReviewTurn: async () => {
        throw new Error("must not launch without implementer identity");
      },
    });
    expect(noImplementer.delivery.status).toBe("BLOCKED_EXTERNAL");
    expect(noImplementer.roundsAttempted).toBe(0);
  });
});

describe("verdict mapping and reviewer selection", () => {
  it("accepts only explicit SAFE passes without blocking findings", () => {
    expect(mapPrReviewerVerdict(acceptedOutput()).disposition).toBe("ACCEPTED");
    expect(mapPrReviewerVerdict({ ...acceptedOutput(), verdict: "PASS_WITH_WARNINGS" }).disposition).toBe("ACCEPTED");
    expect(mapPrReviewerVerdict({ ...acceptedOutput(), finalizationSafety: "RISK_KNOWN" }).disposition).toBe("REPAIR_REQUIRED");
    expect(mapPrReviewerVerdict(repairOutput()).disposition).toBe("REPAIR_REQUIRED");
    const blockingDespitePass = { ...acceptedOutput(), findings: repairOutput().findings };
    expect(mapPrReviewerVerdict(blockingDespitePass).disposition).toBe("REPAIR_REQUIRED");
  });

  it("selects an independent read-only Reviewer deterministically", () => {
    const selections = {
      "reviewer-b": reviewerSelection({ logicalAgent: "reviewer-b" }),
      "reviewer-a": reviewerSelection({ logicalAgent: "reviewer-a" }),
      implementer: reviewerSelection({ logicalAgent: "implementer-1", role: "Reviewer" }),
      writer: reviewerSelection({ logicalAgent: "writer-1", permissions: { write: "allow" } }),
    };
    expect(selectIndependentPrReviewer(selections, "implementer-1", { requireHighAssurance: false })?.logicalAgent).toBe("reviewer-a");
    expect(selectIndependentPrReviewer({ implementer: selections.implementer }, "implementer-1", { requireHighAssurance: false })).toBeUndefined();
    expect(selectIndependentPrReviewer({ writer: selections.writer }, "implementer-1", { requireHighAssurance: false })).toBeUndefined();
  });

  it("requires a qualified high-assurance provider for high-risk changes", () => {
    const selections = {
      standard: reviewerSelection({ logicalAgent: "reviewer-std", modelId: "muse-spark" }),
      luna: reviewerSelection({ logicalAgent: "reviewer-luna", modelId: "gpt-6-luna" }),
    };
    expect(selectIndependentPrReviewer(selections, "implementer-1", { requireHighAssurance: true })?.logicalAgent).toBe("reviewer-luna");
    expect(selectIndependentPrReviewer({ standard: selections.standard }, "implementer-1", { requireHighAssurance: true })).toBeUndefined();
  });

  it("recognizes only merge-pending BLOCKED results", () => {
    expect(isMergePendingBlockedDelivery(blocked())).toBe(true);
    expect(isMergePendingBlockedDelivery({ ...blocked(), status: "FINALIZED" })).toBe(false);
    expect(isMergePendingBlockedDelivery({ ...blocked(), humanRequired: true })).toBe(false);
    expect(isMergePendingBlockedDelivery({ ...blocked(), pullRequest: undefined })).toBe(false);
    expect(isMergePendingBlockedDelivery({ ...blocked(), commitSha: undefined })).toBe(false);
  });
});

describe("deriveFinalPrIdentity", () => {
  it("derives the exact final PR identity from local git only (no network)", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-pr-identity-"));
    roots.push(base);
    const repo = path.join(base, "repo");
    await fs.mkdir(repo);
    const git = async (...args: string[]) => {
      const result = await runExecutable("git", args, { cwd: repo, timeoutMs: 60_000 });
      if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
      return result.stdout.trim();
    };
    await git("init", "-b", "main");
    await git("config", "user.name", "AEH Test");
    await git("config", "user.email", "aeh@example.invalid");
    await fs.writeFile(path.join(repo, "README.md"), "base\n");
    await git("add", "README.md");
    await git("commit", "-m", "base");
    await git("checkout", "-b", "feature/gh-5-update-readme");
    await fs.writeFile(path.join(repo, "README.md"), "accepted implementation\n");
    await git("add", "README.md");
    await git("commit", "-m", "GH-5: Update README");
    const headSha = await git("rev-parse", "HEAD");
    const baseSha = await git("rev-parse", "main^{commit}");

    const config = { version: 1, project: { name: "identity-test" }, validation: { baseRef: "main" } } as HarnessProjectConfig;
    const contract = {
      version: 1,
      task: { id: "GH-5", title: "Update README" },
      issue: { provider: "github", repository: "owner/repo", number: 5 },
      git: { baseRef: "main", originatingBranch: "main" },
    } as unknown as TaskContract;
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network must not be used for PR identity derivation");
    }));
    try {
      const identity = await deriveFinalPrIdentity({ root: repo, config, contract, commitSha: headSha, prNumber: 9 });
      expect(identity).toEqual({ repository: "owner/repo", number: 9, headSha, baseSha, baseRef: "main" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
