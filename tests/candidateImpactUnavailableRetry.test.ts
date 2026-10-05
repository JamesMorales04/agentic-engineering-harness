import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assembleCandidateChangeSet } from "../src/candidates/assembler.js";
import { computeWorktreeDigest } from "../src/core/git.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { runShell } from "../src/utils/process.js";
import { sha256Utf8 } from "../src/core/digest.js";
import { AehError } from "../src/core/errors.js";
import {
  semanticCapabilityPolicyRevisionV1,
  type SemanticAssessmentRequestV1,
  type SemanticAssessmentAttemptOptionsV1,
} from "../src/semantic/assessment.js";
import { semanticPayload, semanticTestService } from "./semanticAssessmentSupport.js";

async function tempRepo(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-impact-unavailable-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
  await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.com commit -qm initial", { cwd: root });
  return { root, cleanup: async () => { await fs.rm(root, { recursive: true, force: true }); } };
}

describe("candidate impact non-timeout UNAVAILABLE bounded retry", () => {
  it("retries once with a fresh turn after a launch-level exit=1/no-session UNAVAILABLE then succeeds", async () => {
    const { root, cleanup } = await tempRepo();
    try {
      const current = createCandidateRevisionV1({
        operationId: "OP-IMPACT-UNAVAILABLE-RETRY",
        candidateId: "candidate:OP-IMPACT-UNAVAILABLE-RETRY:r1",
        projectId: "project-impact-unavailable",
        taskId: "TASK-IMPACT-UNAVAILABLE",
        revision: 1,
        sourceDigest: await computeWorktreeDigest(root),
      });
      const patch =
        "diff --git a/src/value.ts b/src/value.ts\nindex 9b7c1d4..e2f9c4a 100644\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n";
      const changeSet = {
        version: 1 as const,
        operationId: current.operationId,
        taskId: "TASK-IMPACT-UNAVAILABLE",
        workUnitId: "WU-1",
        participantId: "participant-1",
        baseCandidateRevision: current.revision,
        baseCandidateDigest: current.identityDigest,
        changedFiles: ["src/value.ts"],
        patch,
        patchDigest: sha256Utf8(patch),
      };

      let runnerAttempts = 0;
      let serviceAttempts = 0;
      const attemptOptions: Array<SemanticAssessmentAttemptOptionsV1 | undefined> = [];
      const requestDigests: string[] = [];
      const { sha256Canonical } = await import("../src/core/digest.js");

      const noCache = { get: async () => undefined, set: async () => undefined };
      const inner = semanticTestService({
        cache: noCache,
        runner: {
          assess: async ({ request }: { request: SemanticAssessmentRequestV1 }) => {
            runnerAttempts += 1;
            if (runnerAttempts === 1) {
              // Launch-level failure: exit=1, empty result id (no session), tiny payload.
              throw new AehError(
                "SEMANTIC_ASSESSMENT_UNAVAILABLE",
                "Paseo Semantic Assessor did not return a completed structured result (exit=1, status=failed).",
                { details: { timeout: false, exitCode: 1, status: "failed", stderrTail: "assessor launch failed: exit 1" } }
              );
            }
            const payload = semanticPayload(request);
            return {
              payload: {
                ...payload,
                judgment: {
                  type: "CANDIDATE_IMPACT",
                  changedFiles: ["src/value.ts"],
                  changeKinds: ["source"],
                  reviewDimensions: [],
                  requiresIndependentReview: false,
                  evidenceRefs: request.evidenceRefs,
                  unknowns: [],
                },
              },
              paseoSession: { provider: "codex", agentId: "paseo-impact-unavailable-retry-2", workspaceId: "workspace-test", transport: "sdk" as const },
            };
          },
        },
      });
      const originalAssess = inner.assess.bind(inner);
      const countingService = Object.create(Object.getPrototypeOf(inner), Object.getOwnPropertyDescriptors(inner)) as typeof inner;
      countingService.assess = (async (request: SemanticAssessmentRequestV1, options?: SemanticAssessmentAttemptOptionsV1) => {
        serviceAttempts += 1;
        attemptOptions.push(options);
        requestDigests.push(sha256Canonical(request));
        return originalAssess(request, options);
      }) as typeof inner.assess;

      const unavailable: unknown[] = [];
      const result = await assembleCandidateChangeSet({
        root,
        operationId: current.operationId,
        taskId: "TASK-IMPACT-UNAVAILABLE",
        currentCandidate: current,
        changeSet,
        allowedScope: ["src/**"],
        candidateId: "candidate:OP-IMPACT-UNAVAILABLE-RETRY:r2",
        semanticAssessment: {
          service: countingService,
          policyRevision: semanticCapabilityPolicyRevisionV1,
          repositoryBinding: { projectId: "project-impact-unavailable", repositoryDigest: "repository-impact-unavailable", operationId: current.operationId },
          // New forensic hook (added by fix); cast so RED run without the field still executes.
          ...({ onAssessorUnavailable: (record: unknown) => { unavailable.push(record); } } as unknown as Record<string, unknown>),
        } as unknown as Parameters<typeof assembleCandidateChangeSet>[0]["semanticAssessment"],
      });

      expect(result.impact.changedFiles).toEqual(["src/value.ts"]);
      expect(result.impact.interpretation).toBe("MODEL");
      // Bounded retry 1x: two fresh provider turns.
      expect(serviceAttempts).toBe(2);
      expect(runnerAttempts).toBe(2);
      // Identical request, fresh turn with cache-bypass transport flag only.
      expect(requestDigests).toHaveLength(2);
      expect(requestDigests[0]).toBe(requestDigests[1]);
      expect(attemptOptions[0]).toMatchObject({ attemptBudget: 1 });
      expect(attemptOptions[0]?.bypassCache).toBeFalsy();
      expect(attemptOptions[1]).toMatchObject({ attemptBudget: 1, bypassCache: true });
      // Observability: UNAVAILABLE path persisted with exit/status/stderr-tail.
      expect(unavailable.length).toBeGreaterThanOrEqual(1);
      expect(unavailable[0]).toMatchObject({
        assessmentType: "CANDIDATE_IMPACT",
        exitCode: 1,
        status: "failed",
        stderrTail: expect.stringContaining("exit 1"),
      });
    } finally {
      await cleanup();
    }
  });

  it("rethrows with diagnostics after two consecutive non-timeout UNAVAILABLE", async () => {
    const { root, cleanup } = await tempRepo();
    try {
      const current = createCandidateRevisionV1({
        operationId: "OP-IMPACT-UNAVAILABLE-FAIL",
        candidateId: "candidate:OP-IMPACT-UNAVAILABLE-FAIL:r1",
        projectId: "project-impact-unavailable-fail",
        taskId: "TASK-IMPACT-UNAVAILABLE-FAIL",
        revision: 1,
        sourceDigest: await computeWorktreeDigest(root),
      });
      const patch =
        "diff --git a/src/value.ts b/src/value.ts\nindex 9b7c1d4..e2f9c4a 100644\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n";
      const changeSet = {
        version: 1 as const,
        operationId: current.operationId,
        taskId: "TASK-IMPACT-UNAVAILABLE-FAIL",
        workUnitId: "WU-1",
        participantId: "participant-1",
        baseCandidateRevision: current.revision,
        baseCandidateDigest: current.identityDigest,
        changedFiles: ["src/value.ts"],
        patch,
        patchDigest: sha256Utf8(patch),
      };

      let runnerAttempts = 0;
      let serviceAttempts = 0;
      const noCache = { get: async () => undefined, set: async () => undefined };
      const inner = semanticTestService({
        cache: noCache,
        runner: {
          assess: async () => {
            runnerAttempts += 1;
            throw new AehError(
              "SEMANTIC_ASSESSMENT_UNAVAILABLE",
              "Paseo Semantic Assessor did not return a completed structured result (exit=1, status=failed).",
              { details: { timeout: false, exitCode: 1, status: "failed", stderrTail: "assessor launch failed: exit 1" } }
            );
          },
        },
      });
      const originalAssess = inner.assess.bind(inner);
      const countingService = Object.create(Object.getPrototypeOf(inner), Object.getOwnPropertyDescriptors(inner)) as typeof inner;
      countingService.assess = (async (request: SemanticAssessmentRequestV1, options?: SemanticAssessmentAttemptOptionsV1) => {
        serviceAttempts += 1;
        return originalAssess(request, options);
      }) as typeof inner.assess;

      const unavailable: unknown[] = [];
      let failure: AehError | undefined;
      try {
        await assembleCandidateChangeSet({
          root,
          operationId: current.operationId,
          taskId: "TASK-IMPACT-UNAVAILABLE-FAIL",
          currentCandidate: current,
          changeSet,
          allowedScope: ["src/**"],
          candidateId: "candidate:OP-IMPACT-UNAVAILABLE-FAIL:r2",
          semanticAssessment: {
            service: countingService,
            policyRevision: semanticCapabilityPolicyRevisionV1,
            repositoryBinding: { projectId: "project-impact-unavailable-fail", repositoryDigest: "repository-impact-unavailable-fail", operationId: current.operationId },
            ...({ onAssessorUnavailable: (record: unknown) => { unavailable.push(record); } } as unknown as Record<string, unknown>),
          } as unknown as Parameters<typeof assembleCandidateChangeSet>[0]["semanticAssessment"],
        });
      } catch (error) {
        failure = error as AehError;
      }

      expect(failure?.code).toBe("SEMANTIC_ASSESSMENT_UNAVAILABLE");
      // Diagnostics preserved on rethrow.
      expect(failure?.details).toMatchObject({ timeout: false, exitCode: 1, status: "failed" });
      expect(String((failure?.details as { stderrTail?: string } | undefined)?.stderrTail ?? "")).toContain("exit 1");
      expect(failure?.message).toContain("exit=1");
      // Bounded: exactly one retry, then fail-closed.
      expect(serviceAttempts).toBe(2);
      expect(runnerAttempts).toBe(2);
      expect(unavailable.length).toBeGreaterThanOrEqual(1);
      // Fail-closed: workspace rolled back.
      expect(await fs.readFile(path.join(root, "src", "value.ts"), "utf8")).toBe("export const value = 1;\n");
    } finally {
      await cleanup();
    }
  });
});
