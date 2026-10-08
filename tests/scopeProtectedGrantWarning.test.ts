import { describe, expect, it } from "vitest";
import {
  findScopeProtectedGrantWarnings,
  formatScopeProtectedGrantWarning,
  repairHardProtectedPaths,
  scopePatternOverlapsHardPattern,
} from "../src/candidates/repairScope.js";
import type { HarnessProjectConfig, TaskContract } from "../src/core/types.js";

function minimalHard(): string[] {
  const config = {} as HarnessProjectConfig;
  const contract = { version: 1, task: { id: "T", title: "T" } } as TaskContract;
  return repairHardProtectedPaths(config, contract);
}

describe("scope protected-grant warning (fail-closed, warn-only)", () => {
  it("warns for an exact hard-file grant (validator source)", () => {
    const hard = ["src/validators", "src/validators/**"];
    const warnings = findScopeProtectedGrantWarnings(["src/validators/diffScope.ts"], hard);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.normalized).toBe("src/validators/diffScope.ts");
    expect(warnings[0]?.matchedHardPaths).toContain("src/validators/**");
    expect(formatScopeProtectedGrantWarning(warnings[0]!)).toContain("SCOPE_PROTECTED_GRANT_WARNING");
  });

  it("warns for bare-directory and parent/child grants", () => {
    const hard = ["tests", "tests/**", "src/validators", "src/validators/**"];
    // Exact bare dir.
    expect(findScopeProtectedGrantWarnings(["tests"], hard)).toHaveLength(1);
    // Parent grant contains hard content.
    expect(findScopeProtectedGrantWarnings(["src"], hard)).toHaveLength(1);
    // Child grant lies under a hard directory.
    expect(findScopeProtectedGrantWarnings(["src/validators/foo.ts"], hard)).toHaveLength(1);
  });

  it("warns for glob overlap in either direction", () => {
    const hard = ["src/validators", "src/validators/**", ".harness/seals/T.json"];
    // Granted glob matches hard content.
    expect(findScopeProtectedGrantWarnings(["src/**"], hard)).toHaveLength(1);
    // Open grant matches everything, including hard content.
    expect(findScopeProtectedGrantWarnings(["**"], hard)).toHaveLength(1);
    // Extension glob overlaps a hard file with the same extension.
    expect(findScopeProtectedGrantWarnings(["**/*.json"], hard)).toHaveLength(1);
    // Unit-level overlap predicate agrees in both directions.
    expect(scopePatternOverlapsHardPattern("src/**", "src/validators/**")).toBe(true);
    expect(scopePatternOverlapsHardPattern("src/validators/**", "src/**")).toBe(true);
  });

  it("does NOT warn for unrelated scope or non-overlapping root globs", () => {
    const hard = ["src/validators", "src/validators/**", ".harness/seals/T.json", ".harness/seals/T.json/**"];
    expect(findScopeProtectedGrantWarnings(["src/providers/foo.ts"], hard)).toHaveLength(0);
    // `*.json` at the root cannot match a nested seal path.
    expect(findScopeProtectedGrantWarnings(["*.json"], hard)).toHaveLength(0);
    expect(scopePatternOverlapsHardPattern("*.json", ".harness/seals/T.json")).toBe(false);
  });

  it("does NOT warn for unsafe/out-of-root inputs (fail-closed elsewhere)", () => {
    const hard = ["src/validators", "src/validators/**"];
    expect(findScopeProtectedGrantWarnings(["../outside"], hard)).toHaveLength(0);
    expect(findScopeProtectedGrantWarnings(["/etc/passwd"], hard)).toHaveLength(0);
    expect(findScopeProtectedGrantWarnings(["src/../outside"], hard)).toHaveLength(0);
  });

  it("warns end-to-end against the real hard-protected list", () => {
    const hard = minimalHard();
    expect(hard).toContain("src/validators/**");
    expect(hard).toContain("tests/**");
    const warnings = findScopeProtectedGrantWarnings(["src/validators/diffScope.ts"], hard);
    expect(warnings).toHaveLength(1);
    const message = formatScopeProtectedGrantWarning(warnings[0]!);
    expect(message).toContain("can NEVER take effect");
    expect(message).toContain("Owner exemption");
    expect(message).toContain("fail-closed preserved");
  });

  it("is warn-only: inputs unmutated and hard violations still reported", async () => {
    const hard = ["src/validators", "src/validators/**"];
    const granted = ["src/validators/diffScope.ts"];
    const snapshot = [...granted];
    const warnings = findScopeProtectedGrantWarnings(granted, hard);
    expect(warnings).toHaveLength(1);
    // No broadening/narrowing: caller inputs are untouched.
    expect(granted).toEqual(snapshot);
    // The grant is still hard-protected downstream (fail-closed preserved):
    // the same overlap the warning cites remains a violation at the gate.
    expect(warnings[0]?.matchedHardPaths.length).toBeGreaterThan(0);
  });
});
