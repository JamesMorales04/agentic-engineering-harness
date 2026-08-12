import { describe, expect, it } from "vitest";
import { triageChange } from "../src/core/triage.js";
import type { HarnessProjectConfig } from "../src/core/types.js";
const config: HarnessProjectConfig = { version: 1, project: { name: "test" }, workflow: { quick: { maxFiles: 3 } } };
describe("triageChange", () => {
  it("accepts a bounded low-risk cosmetic change as quick", () => { const result = triageChange(config, { request: "Change the button padding from 12px to 16px", files: ["src/Button.tsx"], domains: ["frontend"], risk: "low" }); expect(result.mode).toBe("quick"); expect(result.quickEligible).toBe(true); });
  it("escalates security changes to spec", () => { const result = triageChange(config, { request: "Change authorization permissions", files: ["src/auth.ts"], domains: ["security"], risk: "low" }); expect(result.mode).toBe("spec"); expect(result.reasons.join(" ")).toMatch(/security|SDD/i); });
  it("requires bounded scope", () => { expect(triageChange(config, { request: "Fix typo", files: [] }).mode).toBe("spec"); });
});
