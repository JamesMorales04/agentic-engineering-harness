import { describe, expect, it } from "vitest";
import { validateDiffScope } from "../src/validators/diffScope.js";
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
