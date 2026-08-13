import { describe, expect, it } from "vitest";
import { validateCapturedAgentContract } from "../src/workers/agentPrompt.js";

describe("captured reviewer contract delivery", () => {
  it("accepts a valid reviewer payload", () => {
    const payload = JSON.stringify({
      verdict: "PASS",
      findings: [],
      finalizationSafety: "SAFE",
      followUp: []
    });

    expect(validateCapturedAgentContract("reviewer", payload)).toEqual({ ok: true });
  });

  it("keeps invalid smart-quote markers strict so the bounded repair path can handle them", () => {
    const result = validateCapturedAgentContract(
      "reviewer",
      'AEH_RESULT_JSON={“verdict”:“PASS”,“findings”:[],“finalizationSafety”:“SAFE”,“followUp”:[]}'
    );

    expect(result.ok).toBe(false);
    expect(result.failure).toContain("MARKER_INVALID_JSON");
  });

  it("distinguishes schema validation from transport parsing", () => {
    const result = validateCapturedAgentContract(
      "reviewer",
      JSON.stringify({ verdict: "PASS", findings: [] })
    );

    expect(result.ok).toBe(false);
    expect(result.failure).toContain("SCHEMA_VALIDATION_FAILED");
  });
});
