import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  filterForbiddenScopeForAmendment,
  findRepairHardProtectedViolations,
  normalizeRepairScopePath,
  parseRepairScopeBlockerFromSession,
  repairHardProtectedPaths,
  type RepairScopeAmendmentV1,
} from "../src/candidates/repairScope.js";
import { repairProtectedPaths } from "../src/candidates/repair.js";
import { validateDiffScope } from "../src/validators/diffScope.js";
import { outputJsonSchema, validateAgentOutput } from "../src/agents/outputContracts.js";
import { sha256Canonical } from "../src/core/digest.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";

const baseAllowed: TaskContract = {
  version: 1,
  task: { id: "U2", title: "scope-gate" },
  scope: { allowed: ["src/**"], forbidden: [], frozen: [] },
};

function testConfig(): HarnessProjectConfig {
  return {
    version: 1,
    project: { name: "u2" },
    validation: { baseRef: "HEAD", requireSeal: false, commands: [], validators: [], opa: { enabled: false } },
    telemetry: { enabled: false },
  };
}

function testContract(): TaskContract {
  return {
    version: 1,
    task: { id: "U2", title: "scope-gate" },
    scope: { allowed: ["src/**"], forbidden: [], frozen: [] },
    routing: { route: "DIRECT", assurance: "STANDARD" },
  };
}

function makeAmendment(exemptedPaths: string[]): RepairScopeAmendmentV1 {
  const body = {
    version: 1 as const,
    mechanism: "DETERMINISTIC" as const,
    operationId: "op-u2",
    taskId: "U2",
    blockerDigest: "a".repeat(64),
    exemptedPaths,
    decidedBy: "human" as const,
    decisionReason: "u2 test",
    decidedAt: "2026-01-01T00:00:00.000Z",
    decisionId: "decision:123e4567-e89b-12d3-a456-426614174000",
    requestId: "request:u2-1",
    decidedActor: "human:test",
    amendedScope: ["src/**", ...exemptedPaths],
    contractPath: ".harness/contracts/U2.yaml",
    sealPath: ".harness/seals/U2.json",
    amendmentPath: ".harness/seals/U2-scope-amendment-1.json",
  };
  return { ...body, amendmentDigest: sha256Canonical(body) };
}

describe("Unit 2 scope-gate coherence", () => {
  describe("C4: single normalizeRepairScopePath identity (posix-normalize + collapse)", () => {
    it("collapses drifted equivalents to one identity", () => {
      expect(normalizeRepairScopePath("./src//a.ts")).toBe("src/a.ts");
      expect(normalizeRepairScopePath("src/./a.ts")).toBe("src/a.ts");
      expect(normalizeRepairScopePath("src/a/../b.ts")).toBe("src/b.ts");
      expect(normalizeRepairScopePath("src//a.ts")).toBe("src/a.ts");
      expect(normalizeRepairScopePath("./src/a.ts")).toBe("src/a.ts");
      expect(normalizeRepairScopePath("src/a.ts")).toBe("src/a.ts");
    });

    it("preserves globs, strips dirs, maps empty", () => {
      expect(normalizeRepairScopePath("src/**")).toBe("src/**");
      expect(normalizeRepairScopePath("**")).toBe("**");
      expect(normalizeRepairScopePath("src/")).toBe("src");
      expect(normalizeRepairScopePath("")).toBe("");
      expect(normalizeRepairScopePath("src\\a.ts")).toBe("src/a.ts");
      expect(normalizeRepairScopePath(".harness/seals/U2.json")).toBe(".harness/seals/U2.json");
    });

    it("diffScope normalizes at every gate", () => {
      for (const drifted of ["./src/a.ts", "src//a.ts", "src/./a.ts", "src/b/../a.ts"]) {
        const checks = validateDiffScope([drifted], baseAllowed);
        expect(checks.find((c) => c.id === "diff.allowed-scope")?.status).toBe("PASS");
      }
      // Forbidden/frozen gates also normalize.
      const forbidden: TaskContract = {
        version: 1,
        task: { id: "U2", title: "x" },
        scope: { allowed: ["**"], forbidden: ["src/secret/**"], frozen: ["tests/**"] },
      };
      expect(
        validateDiffScope(["./src/secret/a.ts"], forbidden).find((c) => c.id === "diff.forbidden-paths")?.status,
      ).toBe("FAIL");
      expect(
        validateDiffScope(["src//secret/a.ts"], forbidden).find((c) => c.id === "diff.forbidden-paths")?.status,
      ).toBe("FAIL");
      expect(
        validateDiffScope(["./tests/a.ts"], forbidden).find((c) => c.id === "diff.frozen-paths")?.status,
      ).toBe("FAIL");
    });

    it("hard-protected search normalizes drifted inputs", () => {
      const config = testConfig();
      const contract = testContract();
      const seal = `.harness/seals/${contract.task.id}.json`;
      expect(findRepairHardProtectedViolations([seal], config, contract)).toEqual([seal]);
      expect(findRepairHardProtectedViolations([`./${seal}`], config, contract)).toEqual([seal]);
      expect(findRepairHardProtectedViolations([seal.replace("/", "//")], config, contract)).toEqual([seal]);
    });

    it("amendment exemption matches on normalized identity (exact+/**)", () => {
      const amendment = makeAmendment(["src/a.ts"]);
      // Exact + /** variants are both exempted.
      expect(filterForbiddenScopeForAmendment(["src/a.ts", "src/a.ts/**", "src/b.ts"], amendment)).toEqual([
        "src/b.ts",
      ]);
      // Drifted forbidden entries normalize to the same identity and exempt.
      expect(
        filterForbiddenScopeForAmendment(["./src/a.ts", "src//a.ts/**", "src/b.ts"], amendment),
      ).toEqual(["src/b.ts"]);
    });
  });

  describe("C2: diffScope fail-closed empty allowlist", () => {
    it("empty allowlist denies changes", () => {
      const empty: TaskContract = {
        version: 1,
        task: { id: "U2", title: "empty" },
        scope: { allowed: [], forbidden: [], frozen: [] },
      };
      const checks = validateDiffScope(["src/a.ts"], empty);
      expect(checks.find((c) => c.id === "diff.allowed-scope")?.status).toBe("FAIL");
    });

    it("missing allowlist denies changes (fail-closed default)", () => {
      const missing: TaskContract = { version: 1, task: { id: "U2", title: "missing" } };
      const checks = validateDiffScope(["src/a.ts"], missing);
      expect(checks.find((c) => c.id === "diff.allowed-scope")?.status).toBe("FAIL");
    });

    it("empty allowlist with no changes passes", () => {
      const empty: TaskContract = {
        version: 1,
        task: { id: "U2", title: "empty" },
        scope: { allowed: [], forbidden: [], frozen: [] },
      };
      const checks = validateDiffScope([], empty);
      expect(checks.find((c) => c.id === "diff.allowed-scope")?.status).toBe("PASS");
    });

    it('explicit ["**"] remains the only open allowlist', () => {
      const open: TaskContract = {
        version: 1,
        task: { id: "U2", title: "open" },
        scope: { allowed: ["**"], forbidden: [], frozen: [] },
      };
      const checks = validateDiffScope(["src/a.ts", ".harness/seals/U2.json"], open);
      expect(checks.find((c) => c.id === "diff.allowed-scope")?.status).toBe("PASS");
    });
  });

  describe("C3: no-mutation conflict diagnostic", () => {
    it("conflict throws REPAIR_SCOPE_BLOCKER_CONFLICT instead of undefined", () => {
      const session = {
        stdout: `AEH_RESULT_JSON=${JSON.stringify({
          filesChanged: ["src/a.ts"],
          behaviorRepaired: [],
          validationCommands: [],
          filesNeededOutsideScope: [{ path: "package-lock.json", reason: "needs bump" }],
        })}`,
        stderr: "",
      };
      expect(() => parseRepairScopeBlockerFromSession(session)).toThrow(/REPAIR_SCOPE_BLOCKER_CONFLICT/);
    });

    it("valid blocker still returns files; absent/invalid still returns undefined", () => {
      const valid = {
        stdout: `AEH_RESULT_JSON=${JSON.stringify({
          filesChanged: [],
          behaviorRepaired: [],
          validationCommands: [],
          filesNeededOutsideScope: [{ path: "package-lock.json", reason: "needs bump" }],
        })}`,
        stderr: "",
      };
      expect(parseRepairScopeBlockerFromSession(valid)).toMatchObject([{ path: "package-lock.json" }]);
      expect(parseRepairScopeBlockerFromSession({ stdout: "", stderr: "" })).toBeUndefined();
      expect(
        parseRepairScopeBlockerFromSession({
          stdout: `AEH_RESULT_JSON=${JSON.stringify({ filesChanged: ["src/a.ts"] })}`,
          stderr: "",
        }),
      ).toBeUndefined();
    });

    it("zod rejects conflict; wire schema encodes anyOf no-mutation guard", () => {
      const conflict = {
        filesChanged: ["src/a.ts"],
        filesNeededOutsideScope: [{ path: "package-lock.json", reason: "needs bump" }],
      };
      const zod = validateAgentOutput("repair-result", conflict);
      expect(zod.ok).toBe(false);
      expect(zod.issues.join("\n")).toMatch(/REPAIR_SCOPE_BLOCKER_CONFLICT/);
      const schema = outputJsonSchema("repair-result") as unknown as Record<string, unknown>;
      expect(schema).toHaveProperty("anyOf");
      const anyOf = schema["anyOf"] as unknown[];
      expect(anyOf.length).toBe(2);
    });
  });

  describe("C1: normal assembly denies frozen/seal/validator/policy paths", () => {
    it("run.ts assembly threads the canonical repairProtectedPaths deny source", async () => {
      const runTs = await fs.readFile(new URL("../src/core/run.ts", import.meta.url), "utf8");
      expect(runTs).toContain("repairProtectedPaths");
      expect(runTs).toContain("normalizeRepairScopePath");
    });

    it("canonical deny source covers seal + frozen + amendable manifests", () => {
      const config = testConfig();
      const contract = testContract();
      const seal = `.harness/seals/${contract.task.id}.json`;
      expect(repairProtectedPaths(config, contract)).toContain(seal);
      expect(repairHardProtectedPaths(config, contract)).toContain(seal);
      // Amendable manifests are denied by default (exemptible only via ledger).
      expect(repairProtectedPaths(config, contract)).toContain("package-lock.json");
      expect(repairHardProtectedPaths(config, contract)).not.toContain("package-lock.json");
      // Frozen inputs are contained in the canonical set.
      const frozenContract: TaskContract = {
        ...contract,
        scope: { allowed: ["src/**"], forbidden: [], frozen: ["tests/frozen/**"] },
      };
      expect(repairProtectedPaths(config, frozenContract)).toContain("tests/frozen/**");
    });
  });
});
