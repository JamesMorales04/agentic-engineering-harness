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

  it("normalizes typographic JSON quotes before schema validation", () => {
    const result = validateCapturedAgentContract(
      "reviewer",
      'AEH_RESULT_JSON={\u201cverdict\u201d:\u201cPASS\u201d,\u201cfindings\u201d:[],\u201cfinalizationSafety\u201d:\u201cSAFE\u201d,\u201cfollowUp\u201d:[]}'
    );

    expect(result).toEqual({ ok: true });
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
