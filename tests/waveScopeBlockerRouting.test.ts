import { describe, expect, it } from "vitest";
import { classifyWaveCorrectionDeclarationV1 } from "../src/agents/waveExecutor.js";

/**
 * RED-first round 2 (B2): no-change correction + outside-scope declaration must
 * never PASS. Today waveExecutor L707-716 returns PASS with empty changeSet,
 * L309-317 skips assembly, L348-350 barrier can PASS — declared-yet-PASS.
 * Correct: route to BLOCKED (same semantics as DIRECT/repair — FAIL check).
 */
describe("wave correction declaration routing (B2 RED)", () => {
  const base = {
    operationId: "OP-B2",
    taskId: "TASK-B2",
    workUnitId: "WU-B2",
    participantId: "participant:b2",
    taskScope: ["src/**"] as string[],
    contract: {
      task: { id: "TASK-B2", title: "b2" },
      scope: { allowed: ["src/**"], forbidden: [], frozen: [] },
    } as never,
    config: {
      project: { name: "b2-test" },
      sdd: { contractsDir: ".harness/contracts" },
      validation: { frozenPaths: [] },
    } as never,
  };

  function blockerSession(): { stdout: string; stderr: string } {
    return {
      stdout: `AEH_RESULT_JSON=${JSON.stringify({
        filesChanged: [],
        behaviorImplemented: ["touched nothing, needs lockfile"],
        decisions: [],
        assumptions: [],
        risks: [],
        validationCommands: [],
        followUp: [],
        filesNeededOutsideScope: [{ path: "package-lock.json", reason: "needs bump for fix" }],
      })}`,
      stderr: "",
    };
  }

  it("declared-yet-PASS RED: no-change + declaration routes to BLOCKED, never PASS", () => {
    const out = classifyWaveCorrectionDeclarationV1({
      ...base,
      session: blockerSession() as never,
      changedFiles: [],
    });
    expect(out.blocked).toBe(true);
    expect(out.blocker?.filesNeededOutsideScope.map((e) => e.path)).toContain("package-lock.json");
  });

  it("no declaration → not blocked (empty correction stays PASS-eligible)", () => {
    const out = classifyWaveCorrectionDeclarationV1({
      ...base,
      session: { stdout: "did nothing", stderr: "" } as never,
      changedFiles: [],
    });
    expect(out.blocked).toBe(false);
    expect(out.blocker).toBeUndefined();
  });

  it("in-scope declaration is stripped (vacuous, not blocked)", () => {
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

  it("conflicting declaration (changes + needed) is BLOCKED fail-closed, never PASS", () => {
    const session = {
      stdout: `AEH_RESULT_JSON=${JSON.stringify({
        filesChanged: ["src/value.ts"],
        behaviorImplemented: ["x"],
        decisions: [],
        assumptions: [],
        risks: [],
        validationCommands: [],
        followUp: [],
        filesNeededOutsideScope: [{ path: "package-lock.json", reason: "needs bump" }],
      })}`,
      stderr: "",
    };
    const out = classifyWaveCorrectionDeclarationV1({
      ...base,
      session: session as never,
      changedFiles: ["src/value.ts"],
    });
    expect(out.blocked).toBe(true);
  });
});
