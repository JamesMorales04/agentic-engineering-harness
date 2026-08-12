import { describe, expect, it } from "vitest";
import type { HarnessProjectConfig, ValidationCheck } from "../src/core/types.js";
import { classifyEngineeringIntent } from "../src/audit/intent.js";
import { classifyAuditFailure } from "../src/audit/run.js";

const config: HarnessProjectConfig = { version: 1, project: { name: "demo" }, orchestration: { provider: "none" } };

describe("engineering intent classification", () => {
  it("classifies pure explanations as informational", () => {
    const result = classifyEngineeringIntent(config, { request: "What does src/core/run.ts do?" });
    expect(result.intent).toBe("informational");
    expect(result.changeTriage).toBeUndefined();
  });

  it("classifies repository reviews as AUDIT rather than direct or QUICK", () => {
    const result = classifyEngineeringIntent(config, { request: "review the repo and validate the code for improvements" });
    expect(result.intent).toBe("audit");
    expect(result.changeTriage).toBeUndefined();
  });

  it("classifies bug hunts and security reviews as audit", () => {
    expect(classifyEngineeringIntent(config, { request: "find bugs and regression risks in this repository" }).intent).toBe("audit");
    expect(classifyEngineeringIntent(config, { request: "audit the authentication security model" }).intent).toBe("audit");
  });

  it("classifies mutation requests as CHANGE and then QUICK/SPEC", () => {
    const quick = classifyEngineeringIntent(config, { request: "fix the typo", files: ["README.md"], domains: ["docs"], risk: "low" });
    expect(quick.intent).toBe("change");
    expect(quick.changeTriage?.mode).toBe("quick");

    const spec = classifyEngineeringIntent(config, { request: "fix authentication authorization boundaries", files: ["src/auth.ts"], domains: ["auth"], risk: "high" });
    expect(spec.intent).toBe("change");
    expect(spec.changeTriage?.mode).toBe("spec");
  });

  it("prefers CHANGE when a request asks to review and fix", () => {
    const result = classifyEngineeringIntent(config, { request: "review this module and fix every bug you find", files: ["src/x.ts"] });
    expect(result.intent).toBe("change");
  });
});

describe("audit validator failure classification", () => {
  function failed(stderr: string): ValidationCheck {
    return { id: "command.test", category: "command", status: "FAIL", message: "test failed with exit code 1.", details: { stderr } };
  }

  it("distinguishes sandbox denial from assertion failures", () => {
    expect(classifyAuditFailure(failed("spawnSync git EPERM: operation not permitted"))).toBe("SANDBOX_DENIAL");
    expect(classifyAuditFailure(failed("AssertionError: expected 2 to equal 3"))).toBe("ASSERTION_FAILURE");
  });

  it("distinguishes missing dependencies and environmental failures", () => {
    expect(classifyAuditFailure(failed("sh: opengrep: command not found"))).toBe("MISSING_DEPENDENCY");
    expect(classifyAuditFailure(failed("command timed out after 30s"))).toBe("ENVIRONMENT_FAILURE");
  });

  it("uses NONE for passing checks", () => {
    expect(classifyAuditFailure({ id: "ok", category: "command", status: "PASS", message: "ok" })).toBe("NONE");
  });
});
