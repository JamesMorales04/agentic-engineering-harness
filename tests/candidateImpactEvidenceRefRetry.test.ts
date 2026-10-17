import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assembleCandidateChangeSet } from "../src/candidates/assembler.js";
import { computeWorktreeDigest } from "../src/core/git.js";
import { createCandidateRevisionV1 } from "../src/operations/v2Contracts.js";
import { runShell } from "../src/utils/process.js";
import { sha256Canonical, sha256Utf8 } from "../src/core/digest.js";
import { AehError } from "../src/core/errors.js";
import {
  semanticCapabilityPolicyRevisionV1,
  type SemanticAssessmentAttemptOptionsV1,
  type SemanticAssessmentRequestV1,
} from "../src/semantic/assessment.js";
import { semanticPayload, semanticTestService } from "./semanticAssessmentSupport.js";

// Live D29 slip, verbatim: the judgment cited `file:tests.unit.spec.js`
// instead of the receipted `file:tests/tasks.unit.spec.js` while changedFiles
// was correct — terminal at 6-8/12 progress with no retry.
const FILE = "tests/tasks.unit.spec.js";
const CORRECT_REF = `file:${FILE}`;
const MANGLED_REF = "file:tests.unit.spec.js";

const PATCH =
  "diff --git a/tests/tasks.unit.spec.js b/tests/tasks.unit.spec.js\nindex 9b7c1d4..e2f9c4a 100644\n--- a/tests/tasks.unit.spec.js\n+++ b/tests/tasks.unit.spec.js\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n";

type Turn = "mangled" | "missing" | "clean";

async function setupRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-impact-ref-"));
  await fs.mkdir(path.join(root, "tests"), { recursive: true });
  await fs.writeFile(path.join(root, FILE), "export const value = 1;\n");
  await runShell("git init -q && git add -A && git -c user.name=test -c user.email=test@example.com commit -qm initial", { cwd: root });
  const current = createCandidateRevisionV1({
    operationId: "OP-IMPACT-REF",
    candidateId: "candidate:OP-IMPACT-REF:r1",
    projectId: "project-impact-ref",
    taskId: "TASK-IMPACT-REF",
    revision: 1,
    sourceDigest: await computeWorktreeDigest(root),
  });
  const changeSet = {
    version: 1 as const,
    operationId: current.operationId,
    taskId: "TASK-IMPACT-REF",
    workUnitId: "WU-1",
    participantId: "participant-1",
    baseCandidateRevision: current.revision,
    baseCandidateDigest: current.identityDigest,
    changedFiles: [FILE],
    patch: PATCH,
    patchDigest: sha256Utf8(PATCH),
  };
  return { root, current, changeSet, cleanup: async () => { await fs.rm(root, { recursive: true, force: true }); } };
}

function scriptedService(turns: Turn[], counters: {
  runnerAttempts: { count: number };
  serviceAttempts: { count: number };
  attemptOptions: Array<SemanticAssessmentAttemptOptionsV1 | undefined>;
  requestDigests: string[];
  runnerRepairs: unknown[];
}) {
  const noCache = { get: async () => undefined, set: async () => undefined };
  const inner = semanticTestService({
    cache: noCache,
    runner: {
      assess: async ({ request, repair }: { request: SemanticAssessmentRequestV1; repair?: { attempt: number; reason: string } }) => {
        counters.runnerAttempts.count += 1;
        counters.runnerRepairs.push(repair);
        const mode = turns[Math.min(counters.runnerAttempts.count - 1, turns.length - 1)];
        const payload = semanticPayload(request);
        const judgmentRefs =
          mode === "mangled" ? ["candidate:patch", MANGLED_REF]
          : mode === "missing" ? ["candidate:patch"]
          : [...request.evidenceRefs];
        return {
          payload: {
            ...payload,
            judgment: { type: "CANDIDATE_IMPACT", changedFiles: [FILE], changeKinds: ["test"], reviewDimensions: [], requiresIndependentReview: false, evidenceRefs: judgmentRefs, unknowns: [] },
          },
          paseoSession: { provider: "codex", agentId: `paseo-impact-ref-${counters.runnerAttempts.count}`, workspaceId: "workspace-test", transport: "sdk" as const },
        };
      },
    },
  });
  const originalAssess = inner.assess.bind(inner);
  const countingService = Object.create(Object.getPrototypeOf(inner), Object.getOwnPropertyDescriptors(inner)) as typeof inner;
  countingService.assess = (async (request: SemanticAssessmentRequestV1, options?: SemanticAssessmentAttemptOptionsV1) => {
    counters.serviceAttempts.count += 1;
    counters.attemptOptions.push(options);
    counters.requestDigests.push(sha256Canonical(request));
    return originalAssess(request, options);
  }) as typeof inner.assess;
  return countingService;
}

function counters() {
  return {
    runnerAttempts: { count: 0 },
    serviceAttempts: { count: 0 },
    attemptOptions: [] as Array<SemanticAssessmentAttemptOptionsV1 | undefined>,
    requestDigests: [] as string[],
    runnerRepairs: [] as unknown[],
  };
}

describe("candidate impact evidence-ref slip bounded retry (D29)", () => {
  it("(a) outside-ref slip on first turn retries once with identical inputs then succeeds", async () => {
    const { root, current, changeSet, cleanup } = await setupRepo();
    try {
      const seen = counters();
      const service = scriptedService(["mangled", "clean"], seen);
      const rejected: unknown[] = [];
      const result = await assembleCandidateChangeSet({
        root, operationId: current.operationId, taskId: "TASK-IMPACT-REF", currentCandidate: current, changeSet,
        allowedScope: ["tests/**"], candidateId: "candidate:OP-IMPACT-REF:r2",
        semanticAssessment: {
          service, policyRevision: semanticCapabilityPolicyRevisionV1,
          repositoryBinding: { projectId: "project-impact-ref", repositoryDigest: "repository-impact-ref", operationId: current.operationId },
          onRejectedJudgment: (record) => { rejected.push(record); },
        },
      });

      expect(result.impact.changedFiles).toEqual([FILE]);
      // Bounded retry-once: two real provider turns, not a single-shot terminal.
      expect(seen.serviceAttempts.count).toBe(2);
      expect(seen.runnerAttempts.count).toBe(2);
      // Identical semantic inputs, no repair hints; only the cache-bypass transport flag differs.
      expect(seen.requestDigests).toHaveLength(2);
      expect(seen.requestDigests[0]).toBe(seen.requestDigests[1]);
      expect(seen.runnerRepairs).toEqual([undefined, undefined]);
      expect(seen.attemptOptions[0]).toMatchObject({ attemptBudget: 1 });
      expect(seen.attemptOptions[0]?.bypassCache).toBeFalsy();
      expect(seen.attemptOptions[1]).toMatchObject({ attemptBudget: 1, bypassCache: true });
      // Service-observed slip forensics persist via the service's own
      // reply.rejected channel; the assembler emits nothing without an
      // assessmentDigest to cite (no fabricated fields).
      expect(rejected).toHaveLength(0);
    } finally { await cleanup(); }
  });

  it("(b) two consecutive outside-ref slips terminal with the original error details preserved", async () => {
    const { root, current, changeSet, cleanup } = await setupRepo();
    try {
      const seen = counters();
      const service = scriptedService(["mangled", "mangled"], seen);
      let failure: AehError | undefined;
      try {
        await assembleCandidateChangeSet({
          root, operationId: current.operationId, taskId: "TASK-IMPACT-REF", currentCandidate: current, changeSet,
          allowedScope: ["tests/**"], candidateId: "candidate:OP-IMPACT-REF:r2",
          semanticAssessment: {
            service, policyRevision: semanticCapabilityPolicyRevisionV1,
            repositoryBinding: { projectId: "project-impact-ref", repositoryDigest: "repository-impact-ref", operationId: current.operationId },
          },
        });
      } catch (error) { failure = error as AehError; }

      // Original service error rethrown, details preserved (not rewritten).
      expect(failure?.code).toBe("SEMANTIC_ASSESSMENT_INVALID");
      expect(failure?.message).toContain("typed judgment or assessment payload referenced evidence outside the request evidence.");
      expect(failure?.details).toMatchObject({ offendingEvidenceRefs: [MANGLED_REF], offendingEvidenceRefCount: 1 });
      // Bounded: exactly one retry, then fail-closed.
      expect(seen.serviceAttempts.count).toBe(2);
      expect(seen.runnerAttempts.count).toBe(2);
      // Fail-closed: workspace rolled back, no unbound mutation survives.
      expect(await fs.readFile(path.join(root, FILE), "utf8")).toBe("export const value = 1;\n");
    } finally { await cleanup(); }
  });

  it("(c) clean first turn takes a single attempt with no retry", async () => {
    const { root, current, changeSet, cleanup } = await setupRepo();
    try {
      const seen = counters();
      const service = scriptedService(["clean"], seen);
      const rejected: unknown[] = [];
      const result = await assembleCandidateChangeSet({
        root, operationId: current.operationId, taskId: "TASK-IMPACT-REF", currentCandidate: current, changeSet,
        allowedScope: ["tests/**"], candidateId: "candidate:OP-IMPACT-REF:r2",
        semanticAssessment: {
          service, policyRevision: semanticCapabilityPolicyRevisionV1,
          repositoryBinding: { projectId: "project-impact-ref", repositoryDigest: "repository-impact-ref", operationId: current.operationId },
          onRejectedJudgment: (record) => { rejected.push(record); },
        },
      });

      expect(result.impact.changedFiles).toEqual([FILE]);
      expect(seen.serviceAttempts.count).toBe(1);
      expect(seen.runnerAttempts.count).toBe(1);
      expect(seen.attemptOptions[0]).toMatchObject({ attemptBudget: 1 });
      expect(seen.attemptOptions[0]?.bypassCache).toBeFalsy();
      expect(rejected).toHaveLength(0);
    } finally { await cleanup(); }
  });

  it("(d) missing file-ref slip (assembler gate) retries once then succeeds with ref telemetry", async () => {
    const { root, current, changeSet, cleanup } = await setupRepo();
    try {
      const seen = counters();
      const service = scriptedService(["missing", "clean"], seen);
      const rejected: unknown[] = [];
      const result = await assembleCandidateChangeSet({
        root, operationId: current.operationId, taskId: "TASK-IMPACT-REF", currentCandidate: current, changeSet,
        allowedScope: ["tests/**"], candidateId: "candidate:OP-IMPACT-REF:r2",
        semanticAssessment: {
          service, policyRevision: semanticCapabilityPolicyRevisionV1,
          repositoryBinding: { projectId: "project-impact-ref", repositoryDigest: "repository-impact-ref", operationId: current.operationId },
          onRejectedJudgment: (record) => { rejected.push(record); },
        },
      });

      expect(result.impact.changedFiles).toEqual([FILE]);
      expect(seen.serviceAttempts.count).toBe(2);
      expect(seen.runnerAttempts.count).toBe(2);
      expect(seen.requestDigests[0]).toBe(seen.requestDigests[1]);
      expect(seen.runnerRepairs).toEqual([undefined, undefined]);
      expect(seen.attemptOptions[1]).toMatchObject({ attemptBudget: 1, bypassCache: true });
      // Assembler-observed slip persists the rejected-judgment receipt with the ref diff.
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({
        assessmentType: "CANDIDATE_IMPACT",
        missing: [CORRECT_REF],
        extra: [],
        assessmentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    } finally { await cleanup(); }
  });
});
