import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyWaveCorrectionDeclarationV1 } from "../src/agents/waveExecutor.js";

/**
 * RED-first turn-3: both wave paths returned on `reviolations` BEFORE calling
 * the declaration classifier (distributed ~L633 vs ~L651; local ~L855-868 vs
 * ~L885). A correction that declares filesNeededOutsideScope AND still changes
 * out-of-scope files got generic FAIL without scopeBlocker (no BLOCKED
 * routing). Required: declaration check FIRST — when a correction result
 * carries declarations, route to BLOCKED with scopeBlocker REGARDLESS of
 * remaining violations. Vacuous (no genuinely-blocked) stays unblocked.
 */
describe("wave correction declaration ordering (turn-3 RED)", () => {
  const base = {
    operationId: "OP-T3",
    taskId: "TASK-T3",
    workUnitId: "WU-T3",
    participantId: "participant:t3",
    taskScope: ["src/**"] as string[],
    contract: {
      task: { id: "TASK-T3", title: "t3" },
      scope: { allowed: ["src/**"], forbidden: [], frozen: [] },
    } as never,
    config: {
      project: { name: "t3-test" },
      sdd: { contractsDir: ".harness/contracts" },
      validation: { frozenPaths: [] },
    } as never,
  };

  function declareSession(outsidePath = "package-lock.json"): { stdout: string; stderr: string } {
    return {
      stdout: `AEH_RESULT_JSON=${JSON.stringify({
        filesChanged: [],
        behaviorImplemented: ["needs outside file"],
        decisions: [],
        assumptions: [],
        risks: [],
        validationCommands: [],
        followUp: [],
        filesNeededOutsideScope: [{ path: outsidePath, reason: "needs bump for fix" }],
      })}`,
      stderr: "",
    };
  }

  it("declare+still-violates classifies to BLOCKED (fail-closed, never generic FAIL)", () => {
    // Correction declares an outside-scope file AND still changes an
    // out-of-scope file: the classifier must report BLOCKED so the caller can
    // route to BLOCKED with scopeBlocker regardless of remaining violations.
    const out = classifyWaveCorrectionDeclarationV1({
      ...base,
      session: declareSession() as never,
      changedFiles: ["other/outside.txt"],
    });
    expect(out.blocked).toBe(true);
    expect(out.blocker).toBeDefined();
  });

  it("vacuous (in-scope only, no changes) stays unblocked", () => {
    const session = {
      stdout: `AEH_RESULT_JSON=${JSON.stringify({
        filesChanged: [],
        behaviorImplemented: ["x"],
        decisions: [],
        assumptions: [],
        risks: [],
        validationCommands: [],
        followUp: [],
        filesNeededOutsideScope: [{ path: "src/value.ts", reason: "already writable" }],
      })}`,
      stderr: "",
    };
    const out = classifyWaveCorrectionDeclarationV1({
      ...base,
      session: session as never,
      changedFiles: [],
    });
    expect(out.blocked).toBe(false);
  });

  it("both wave paths check declarations BEFORE the reviolations early-return", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, "../src/agents/waveExecutor.ts"), "utf8");
    const lines = src.split("\n");

    // Locate the two correction-classifier calls (distributed uses
    // correctionRemote.session, local uses correctionSession) and the two
    // reviolations early-returns (`if (reviolations.length)` in each path;
    // the distributed timeout/exitCode guard must not swallow violations).
    const classifierLines = lines
      .map((line, idx) => ({ line, idx: idx + 1 }))
      .filter(({ line }) => line.includes("classifyWaveCorrectionDeclarationV1({"))
      .map(({ idx }) => idx)
      // First match is the exported function definition; the two call sites follow.
      .filter((lineNo) => !lines[lineNo - 1].includes("export function"));
    expect(classifierLines).toHaveLength(2);

    const reviolationsReturns = lines
      .map((line, idx) => ({ line, idx }))
      .filter(({ line }) => line.trim().startsWith("if (reviolations.length)"))
      .map(({ idx }) => idx);
    expect(reviolationsReturns).toHaveLength(2);

    const [distributedClassifier, localClassifier] = classifierLines as [number, number];
    const [distributedReviolationsReturn, localReviolationsReturn] =
      reviolationsReturns as [number, number];
    // Convert to 0-based for comparison with findIndex.
    const distClassifierIdx = distributedClassifier - 1;
    const localClassifierIdx = localClassifier - 1;

    expect(
      distClassifierIdx < distributedReviolationsReturn,
      `distributed path: declaration classifier (line ${distributedClassifier}) must run BEFORE reviolations early-return (line ${distributedReviolationsReturn + 1})`,
    ).toBe(true);
    expect(
      localClassifierIdx < localReviolationsReturn,
      `local path: declaration classifier (line ${localClassifier}) must run BEFORE reviolations early-return (line ${localReviolationsReturn + 1})`,
    ).toBe(true);

    // The distributed timeout/exitCode guard must not include reviolations:
    // violations alone fall through to the declaration check first.
    const combinedGuard = lines.findIndex((line) =>
      line.includes("if (correctionTimeout || reviolations.length"),
    );
    expect(
      combinedGuard,
      "distributed timeout guard must not swallow reviolations (split timeout/exitCode from second-escape)",
    ).toBe(-1);
  });
});
