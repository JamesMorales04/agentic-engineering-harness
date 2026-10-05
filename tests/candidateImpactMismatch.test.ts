import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assembleCandidateChangeSet } from "../src/candidates/assembler.js";
import { computeWorktreeDigest } from "../src/core/git.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { runShell } from "../src/utils/process.js";
import { sha256Utf8 } from "../src/core/digest.js";
import { semanticCapabilityPolicyRevisionV1, type SemanticAssessmentRequestV1 } from "../src/semantic/assessment.js";
import { semanticPayload, semanticTestService } from "./semanticAssessmentSupport.js";
import type { AehError } from "../src/core/errors.js";

const FIVE = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"];
const FOUR = FIVE.slice(0, 4);

describe("candidate impact mismatch diagnostics + bounded retry", () => {
  it("RED: 4/5 mismatch carries declared/observed diff, persists receipt, retries once then rethrows", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-impact-mismatch-"));
    try {
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      for (const file of FIVE) await fs.writeFile(path.join(root, file), `export const v = 1;\n`);
      await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.com commit -qm initial", { cwd: root });
      const current = createCandidateRevisionV1({ operationId: "OP-MISMATCH", candidateId: "candidate:OP-MISMATCH:r1", projectId: "project-mismatch", taskId: "TASK-MISMATCH", revision: 1, sourceDigest: await computeWorktreeDigest(root) });

      for (const file of FIVE) await fs.writeFile(path.join(root, file), `export const v = 2;\n`);
      const patch = (await runShell("git diff --binary HEAD --", { cwd: root })).stdout;
      expect(patch.trim()).not.toBe("");
      for (const file of FIVE) await fs.writeFile(path.join(root, file), `export const v = 1;\n`);

      const changeSet = { version: 1 as const, operationId: current.operationId, taskId: "TASK-MISMATCH", workUnitId: "WU-1", participantId: "participant-1", baseCandidateRevision: current.revision, baseCandidateDigest: current.identityDigest, changedFiles: [...FIVE], patch, patchDigest: sha256Utf8(patch) };

      let runnerAttempts = 0;
      let serviceAttempts = 0;
      // No-cache stub so the bounded retry is a fresh provider turn, not a cache HIT.
      const noCache = { get: async () => undefined, set: async () => undefined };
      const inner = semanticTestService({
        cache: noCache,
        runner: {
          assess: async ({ request }: { request: SemanticAssessmentRequestV1 }) => {
            runnerAttempts += 1;
            const payload = semanticPayload(request);
            return {
              payload: {
                ...payload,
                judgment: { type: "CANDIDATE_IMPACT", changedFiles: [...FOUR], changeKinds: ["source"], reviewDimensions: [], requiresIndependentReview: false, evidenceRefs: request.evidenceRefs, unknowns: [] }
              },
              paseoSession: { provider: "codex", agentId: "paseo-impact-mismatch-1", workspaceId: "workspace-test", transport: "sdk" as const }
            };
          }
        }
      });
      const originalAssess = inner.assess.bind(inner);
      const countingService = Object.create(Object.getPrototypeOf(inner), Object.getOwnPropertyDescriptors(inner)) as typeof inner;
      countingService.assess = (async (request: SemanticAssessmentRequestV1, options?: { attemptBudget?: number }) => {
        serviceAttempts += 1;
        return originalAssess(request, options);
      }) as typeof inner.assess;

      const rejected: unknown[] = [];
      let failure: AehError | undefined;
      try {
        await assembleCandidateChangeSet({
          root, operationId: current.operationId, taskId: "TASK-MISMATCH", currentCandidate: current, changeSet,
          allowedScope: ["src/**"], candidateId: "candidate:OP-MISMATCH:r2",
          semanticAssessment: {
            service: countingService, policyRevision: semanticCapabilityPolicyRevisionV1,
            repositoryBinding: { projectId: "project-mismatch", repositoryDigest: "repository-mismatch", operationId: current.operationId },
            onRejectedJudgment: (record) => { rejected.push(record); }
          }
        });
      } catch (error) {
        failure = error as AehError;
      }

      expect(failure?.code).toBe("CANDIDATE_IMPACT_INVALID");
      // Prefix stable (PR88 convention: append, don't rewrite).
      expect(failure?.message).toContain("candidate impact judgment changedFiles do not exactly match the assembled ChangeSet.");
      // Declared-vs-observed diff is recoverable from details.
      expect(failure?.details).toMatchObject({ declaredCount: 5, observedCount: 4, missingCount: 1, extraCount: 0 });
      expect(failure?.details?.declared).toEqual(expect.arrayContaining(FIVE));
      expect(failure?.details?.observed).toEqual(expect.arrayContaining(FOUR));
      expect(failure?.details?.missing).toEqual(["src/e.ts"]);
      expect(failure?.details?.assessmentDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(failure?.message).toContain("src/e.ts");
      // Receipt persisted for forensics.
      expect(rejected.length).toBeGreaterThanOrEqual(1);
      expect(rejected[0]).toMatchObject({ assessmentType: "CANDIDATE_IMPACT", declaredCount: 5, observedCount: 4, missing: ["src/e.ts"] });
      // Bounded retry-once with identical inputs: second mismatch rethrows.
      expect(serviceAttempts).toBe(2);
      expect(runnerAttempts).toBe(2);
      // Fail-closed: workspace rolled back, no unbound mutation survives.
      for (const file of FIVE) expect(await fs.readFile(path.join(root, file), "utf8")).toBe("export const v = 1;\n");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
