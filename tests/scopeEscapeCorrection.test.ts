import { describe, expect, it } from "vitest";
import {
  buildScopeEscapeCorrectionPrompt,
  getScopeEscapeDetails,
  isScopeEscapeError,
  withOneScopeEscapeCorrectionTurnV1,
  SCOPE_ESCAPE_CORRECTION_MAX_TURNS_V1,
} from "../src/candidates/scopeEscapeCorrection.js";
import { AehError } from "../src/core/errors.js";

function escapeError(): AehError {
  return new AehError(
    "PARTICIPANT_PLAN_INVALID",
    `ChangeSet escaped its assigned scope: tests/guard.ts (escapedCount=1). escaped=["tests/guard.ts"] escapedCount=1 amendableManifests=[] amendableCount=0 hardProtected=["tests/guard.ts"] hardProtectedCount=1`,
    {
      details: {
        escapedFiles: ["tests/guard.ts"],
        escapedCount: 1,
        amendableManifests: [],
        amendableCount: 0,
        hardProtected: ["tests/guard.ts"],
        hardProtectedCount: 1,
        operationId: "OP-RED",
        taskId: "TASK-RED",
      },
    },
  );
}

describe("scope-escape one-correction turn (RED)", () => {
  it("bound is exactly one", () => {
    expect(SCOPE_ESCAPE_CORRECTION_MAX_TURNS_V1).toBe(1);
  });

  it("detects only scope escapes, not symlink/other PARTICIPANT_PLAN_INVALID", () => {
    expect(isScopeEscapeError(escapeError())).toBe(true);
    const symlink = new AehError(
      "PARTICIPANT_PLAN_INVALID",
      "ChangeSet patch creates a symlink escaping the candidate root: a -> ../../outside.",
    );
    expect(isScopeEscapeError(symlink)).toBe(false);
    const empty = new AehError("PARTICIPANT_PLAN_INVALID", "ChangeSet patch is empty.");
    expect(isScopeEscapeError(empty)).toBe(false);
    expect(isScopeEscapeError(new Error("CANDIDATE_STALE: stale"))).toBe(false);
  });

  it("diagnostic is precise and never echoes full scope lists", () => {
    const details = getScopeEscapeDetails(escapeError());
    expect(details?.escapedFiles).toEqual(["tests/guard.ts"]);
    const prompt = buildScopeEscapeCorrectionPrompt(details!);
    expect(prompt).toContain("tests/guard.ts");
    expect(prompt).toContain("hardProtected");
    expect(prompt).toContain("filesNeededOutsideScope");
    expect(prompt).toContain("second escape is terminal");
    // Guard for (a)=FALSE: builder never receives full scope lists, so it cannot leak them.
    expect(prompt).not.toContain("__ALLOWED_SENTINEL__");
    expect(prompt).not.toContain("__FORBIDDEN_SENTINEL__");
  });

  it("offers exactly one correction; second escape throws ORIGINAL", async () => {
    const first = escapeError();
    const second = new AehError(
      "PARTICIPANT_PLAN_INVALID",
      `ChangeSet escaped its assigned scope: src/evil.ts (escapedCount=1). escaped=["src/evil.ts"] escapedCount=1 amendableManifests=[] amendableCount=0 hardProtected=["src/evil.ts"] hardProtectedCount=1`,
      {
        details: {
          escapedFiles: ["src/evil.ts"],
          escapedCount: 1,
          amendableManifests: [],
          amendableCount: 0,
          hardProtected: ["src/evil.ts"],
          hardProtectedCount: 1,
        },
      },
    );
    let attempts = 0;
    let corrections = 0;
    await expect(
      withOneScopeEscapeCorrectionTurnV1<string>({
        attempt: async () => {
          attempts += 1;
          throw first;
        },
        buildCorrectionPrompt: (details) => buildScopeEscapeCorrectionPrompt(details),
        executeCorrection: async () => {
          corrections += 1;
          throw second;
        },
      }),
    ).rejects.toThrow("tests/guard.ts");
    expect(attempts).toBe(1);
    expect(corrections).toBe(1);
  });

  it("correction timeout throws ORIGINAL (terminal kill preserved)", async () => {
    const first = escapeError();
    let corrections = 0;
    await expect(
      withOneScopeEscapeCorrectionTurnV1<string>({
        attempt: async () => {
          throw first;
        },
        buildCorrectionPrompt: (details) => buildScopeEscapeCorrectionPrompt(details),
        executeCorrection: async () => {
          corrections += 1;
          throw new Error("timed out after 30000ms");
        },
      }),
    ).rejects.toThrow("tests/guard.ts");
    expect(corrections).toBe(1);
  });

  it("non-escape errors never trigger a correction", async () => {
    let corrections = 0;
    await expect(
      withOneScopeEscapeCorrectionTurnV1<string>({
        attempt: async () => {
          throw new AehError("PARTICIPANT_PLAN_INVALID", "ChangeSet patch is empty.");
        },
        buildCorrectionPrompt: (details) => buildScopeEscapeCorrectionPrompt(details),
        executeCorrection: async () => {
          corrections += 1;
          return "corrected";
        },
      }),
    ).rejects.toThrow("ChangeSet patch is empty");
    expect(corrections).toBe(0);
  });

  it("successful correction returns new result with correctionUsed=true", async () => {
    const result = await withOneScopeEscapeCorrectionTurnV1<string>({
      attempt: async () => {
        throw escapeError();
      },
      buildCorrectionPrompt: (details) => buildScopeEscapeCorrectionPrompt(details),
      executeCorrection: async (prompt) => {
        expect(prompt).toContain("tests/guard.ts");
        return "fixed";
      },
    });
    expect(result).toEqual({ result: "fixed", correctionUsed: true });
  });

  it("no escape returns initial result with correctionUsed=false", async () => {
    const result = await withOneScopeEscapeCorrectionTurnV1<string>({
      attempt: async () => "initial",
      buildCorrectionPrompt: (details) => buildScopeEscapeCorrectionPrompt(details),
      executeCorrection: async () => "should-not-run",
    });
    expect(result).toEqual({ result: "initial", correctionUsed: false });
  });
});
