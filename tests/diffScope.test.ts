import { describe, expect, it } from "vitest";
import { generatedIgnoreYieldedToExplicitRule, validateDiffScope } from "../src/validators/diffScope.js";
import type { TaskContract } from "../src/core/types.js";

const base: TaskContract = {
  version: 1,
  task: { id: "T-1", title: "test" },
  scope: {
    allowed: ["src/**", "tests/**"],
    forbidden: ["src/auth/**"],
    frozen: ["tests/acceptance/frozen/**"]
  }
};

describe("validateDiffScope", () => {
  it("passes valid changes", () => {
    const checks = validateDiffScope(["src/domain/a.ts", "tests/a.test.ts"], base);
    expect(checks.every((x) => x.status === "PASS")).toBe(true);
  });

  it("fails scope expansion and frozen changes", () => {
    const checks = validateDiffScope(["docs/random.md", "tests/acceptance/frozen/x.feature"], base);
    expect(checks.some((x) => x.status === "FAIL")).toBe(true);
  });
});

describe("generatedIgnoreYieldedToExplicitRule (D8 Luna round 3: same matches() semantics as validateDiffScope)", () => {
  const manifest = ".harness/managed-assets.json";
  it("stays ignored without explicit rules", () => {
    expect(generatedIgnoreYieldedToExplicitRule(manifest, [])).toBe(false);
    expect(generatedIgnoreYieldedToExplicitRule(manifest, ["src/**"])).toBe(false);
  });
  it("re-exposes on exact, glob, redundant-separator, parent-glob, and ** rules", () => {
    expect(generatedIgnoreYieldedToExplicitRule(manifest, [".harness/managed-assets.json"])).toBe(true);
    expect(generatedIgnoreYieldedToExplicitRule(manifest, [".harness/*.json"])).toBe(true);
    expect(generatedIgnoreYieldedToExplicitRule(manifest, [".harness//managed-assets.json"])).toBe(true);
    expect(generatedIgnoreYieldedToExplicitRule(manifest, [".harness/**"])).toBe(true);
    expect(generatedIgnoreYieldedToExplicitRule(manifest, ["**"])).toBe(true);
  });
  it("never re-exposes on unsafe rules", () => {
    expect(generatedIgnoreYieldedToExplicitRule(manifest, ["../outside"])).toBe(false);
    expect(generatedIgnoreYieldedToExplicitRule(manifest, ["src/../**"])).toBe(false);
  });
});
