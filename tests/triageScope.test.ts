import { describe, expect, it } from "vitest";
import { triageChange } from "../src/core/triage.js";
import type { HarnessProjectConfig } from "../src/core/types.js";

const config: HarnessProjectConfig = { version: 1, project: { name: "triage-scope" } };

describe("canonical scope bounding", () => {
  it("accepts concrete low-risk files", () => {
    expect(triageChange(config, { request: "Adjust button padding", files: ["src/Button.tsx"], domains: ["frontend"], risk: "low" }).route).toBe("DIRECT");
  });

  it("rejects repository-wide and wildcard scopes even when they count as one pattern", () => {
    for (const scope of ["**", "src/**", "src/*.ts", "src/{a,b}.ts"]) {
      const decision = triageChange(config, { request: "Small cleanup", files: [scope], domains: ["frontend"], risk: "low" });
      expect(["DELEGATED", "FORMAL_SDD"]).toContain(decision.route);
      expect(decision.reasons.join(" ")).toMatch(/concrete file paths/i);
    }
  });
});
