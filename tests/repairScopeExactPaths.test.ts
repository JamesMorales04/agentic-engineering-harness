import { describe, expect, it } from "vitest";
import { sha256Canonical } from "../src/core/digest.js";
import {
  assertRepairScopeAmendment,
  createRepairScopeBlockerReceipt,
  filterForbiddenScopeForAmendment,
  isExactRepairScopeFilePath,
  parseRepairScopeBlockerFromSession,
} from "../src/candidates/repairScope.js";

function amendmentWith(exemptedPaths: string[]) {
  const body = {
    version: 1 as const,
    mechanism: "DETERMINISTIC" as const,
    operationId: "op-1",
    taskId: "T1",
    blockerDigest: "a".repeat(64),
    exemptedPaths,
    decidedBy: "human" as const,
    decisionReason: "test",
    decidedAt: "2026-01-01T00:00:00.000Z",
    decisionId: "decision:12345678-1234-1234-1234-123456789012",
    requestId: "request:abc",
    decidedActor: "human:lead",
    amendedScope: ["**", ...exemptedPaths],
    contractPath: ".harness/contracts/T1.yaml",
    sealPath: ".harness/seals/T1.json",
    amendmentPath: ".harness/seals/T1-scope-amendment-1.json",
  };
  return { ...body, amendmentDigest: sha256Canonical(body) };
}

function blockerSession(pathValue: string) {
  return {
    stdout: `AEH_RESULT_JSON=${JSON.stringify({
      filesChanged: [],
      behaviorRepaired: [],
      validationCommands: [],
      filesNeededOutsideScope: [{ path: pathValue, reason: "needs it" }],
    })}`,
    stderr: "",
  };
}

const GLOBS = ["src/**", "**", "src/*.ts", "src/a?.ts", "src/[ab].ts", "src/{a,b}.ts", "src/!(a).ts", "src/+(a).ts", "src/@(a).ts"];

describe("repair scope amendment exact-paths gate (C-NEW-2)", () => {
  it("isExactRepairScopeFilePath rejects glob metacharacters and trailing /**", () => {
    for (const glob of GLOBS) expect(isExactRepairScopeFilePath(glob)).toBe(false);
    for (const exact of ["package-lock.json", "src/a.ts", "a/b/c.lock"]) {
      expect(isExactRepairScopeFilePath(exact)).toBe(true);
    }
  });

  it("assertRepairScopeAmendment throws on glob exemptedPaths; exact still passes", () => {
    for (const glob of ["src/**", "**"]) {
      expect(() => assertRepairScopeAmendment(amendmentWith([glob]))).toThrow(/exact file path|exact paths only/);
    }
    expect(() => assertRepairScopeAmendment(amendmentWith(["package-lock.json"]))).not.toThrow();
  });

  it("parseRepairScopeBlockerFromSession throws on glob paths; exact still parses", () => {
    for (const glob of ["src/**", "**"]) {
      expect(() => parseRepairScopeBlockerFromSession(blockerSession(glob))).toThrow(/REPAIR_SCOPE_BLOCKER_INVALID/);
    }
    expect(parseRepairScopeBlockerFromSession(blockerSession("package-lock.json"))).toEqual([
      { path: "package-lock.json", reason: "needs it" },
    ]);
  });

  it("createRepairScopeBlockerReceipt throws on glob paths; exact still succeeds", () => {
    expect(() =>
      createRepairScopeBlockerReceipt({
        operationId: "op-1",
        taskId: "T1",
        workUnitId: "W1",
        filesNeededOutsideScope: [{ path: "src/**", reason: "needs it" }],
      }),
    ).toThrow(/exact file path|exact paths only/);
    const receipt = createRepairScopeBlockerReceipt({
      operationId: "op-1",
      taskId: "T1",
      workUnitId: "W1",
      filesNeededOutsideScope: [{ path: "package-lock.json", reason: "needs it" }],
    });
    expect(receipt.filesNeededOutsideScope).toEqual([{ path: "package-lock.json", reason: "needs it" }]);
  });

  it("existing blocker cap (8) and ledger checks intact alongside the glob gate", () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({ path: `pkg${i}.json`, reason: "needs it" }));
    expect(() =>
      createRepairScopeBlockerReceipt({ operationId: "op-1", taskId: "T1", workUnitId: "W1", filesNeededOutsideScope: nine }),
    ).toThrow(/1-8/);
    // Glob gate fires before the size gate for a glob entry.
    expect(() =>
      createRepairScopeBlockerReceipt({
        operationId: "op-1",
        taskId: "T1",
        workUnitId: "W1",
        filesNeededOutsideScope: [{ path: "**", reason: "needs it" }],
      }),
    ).toThrow(/exact file path|exact paths only/);
  });

  it("filterForbiddenScopeForAmendment cannot be reached with a glob amendment", () => {
    expect(() =>
      filterForbiddenScopeForAmendment(["src/**", "package-lock.json"], amendmentWith(["src/**"])),
    ).toThrow(/exact file path|exact paths only/);
  });
});
