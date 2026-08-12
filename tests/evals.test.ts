import { describe, expect, it } from "vitest";
import { scoreEvalResult } from "../src/evals/scoring.js";
import type { EvalCase } from "../src/evals/types.js";

const evalCase: EvalCase = { version: 1, id: "E-1", taskId: "T-1", baseRef: "abc", expectations: { maxRepairs: 2, maxHumanInterventions: 0, maxCostUsd: 1 } };

describe("eval scoring", () => {
  it("rewards deterministic first-pass success", () => {
    const scored = scoreEvalResult(evalCase, {
      version: 1, caseId: "E-1", variant: "default", taskId: "T-1", baseRef: "abc", status: "PASS", commandExitCode: 0,
      metrics: { firstPassSuccess: true, repairCount: 0, humanInterventions: 0, durationMs: 100, usage: { costUsd: 0.1 } },
      startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z"
    });
    expect(scored.score).toBeGreaterThan(90);
  });
});
